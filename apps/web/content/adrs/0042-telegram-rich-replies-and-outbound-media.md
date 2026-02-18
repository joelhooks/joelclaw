---
status: accepted
date: 2026-02-18
decision-makers: joel
tags:
  - telegram
  - gateway
  - media
  - channels
  - voice
  - identity
supersedes:
related:
  - "0041-first-class-media-from-channels"
  - "0038-embedded-pi-gateway-daemon"
  - "0018-pi-native-gateway-redis-event-bridge"
---

# ADR-0042: Telegram Rich Replies, Outbound Media, and Agent Voice

## Context

The Telegram channel is text-only in both directions. Three problems:

**Inbound:** Photos, voice messages, audio, video, and documents arrive but are reduced to placeholder text (`[User sent a photo]`). The agent never sees the actual content. ADR-0041 built the `media/received` Inngest pipeline to process media — but the Telegram handler doesn't download files or emit events yet.

**Outbound:** Agent responses are always `sendMessage` with HTML text. The agent can't:
- Reply to a specific message (threading context)
- Send images (screenshots, generated charts, diagrams)
- Send audio (TTS, audio clips)
- Send video (screen recordings, processed clips)
- Send documents (PDFs, spreadsheets, exports)

**Voice:** Each joelclaw agent node should have a refined voice — a TTS voice that the human who runs that node has tuned to be pleasant to talk to. Voice is part of agent identity, same tier as name, writing style, and personality.

OpenClaw's channel plugins support full bidirectional media and TTS. Their implementation is the reference for how to do this right.

## Decision

Upgrade the Telegram channel to support rich inbound media (download + pipeline), outbound media (reply-to + send files), and per-agent voice identity (TTS).

---

## Part 1: Inbound Media — Download and Pipeline

### How OpenClaw Does It (Reference Implementation)

OpenClaw's `resolveMedia()` in `src/telegram/bot/delivery.ts` handles all inbound media types. Key patterns:

**1. Media resolution** — A single function handles all types with priority order:
```typescript
// OpenClaw: src/telegram/bot/delivery.ts → resolveMedia()
const m =
  msg.photo?.[msg.photo.length - 1] ??  // highest resolution photo
  msg.video ??
  msg.video_note ??
  msg.document ??
  msg.audio ??
  msg.voice;
if (!m?.file_id) return null;
```

**2. File download** — `ctx.getFile()` (grammY) with 3 retries, then fetch from Bot API:
```typescript
const file = await retryAsync(() => ctx.getFile(), {
  attempts: 3,
  minDelayMs: 1000,
  maxDelayMs: 4000,
  jitter: 0.2,
  shouldRetry: (err) => !isFileTooBigError(err), // don't retry permanent errors
});
const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
const fetched = await fetchRemoteMedia({ url, fetchImpl, filePathHint: file.file_path });
```

**3. Save to disk** — UUID-named files with original name preserved:
```typescript
// Pattern: {sanitized-original}---{uuid}.{ext}
// e.g., vacation-photo---a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg
const saved = await saveMediaBuffer(fetched.buffer, fetched.contentType, "inbound", maxBytes, originalName);
// Returns: { id, path, size, contentType }
```

**4. Pass as local path** — not base64, not URL. File paths go into agent context:
```typescript
MediaPath: allMedia[0]?.path,           // first file
MediaPaths: allMedia.map(m => m.path),  // all files  
MediaTypes: allMedia.map(m => m.contentType),
```

**5. Media groups** — Multiple photos sent together are buffered with a timeout (`MEDIA_GROUP_TIMEOUT_MS`), then flushed as a batch so the agent sees all images at once.

**6. Special handling per type:**
- **Stickers:** Only static (WEBP). Animated/video stickers skipped. Sticker cache avoids re-processing known stickers.
- **Voice/audio:** Content type preserved. Audio preflight transcription for mention detection in groups.
- **Documents:** Generic handler, MIME sniffing from file header.
- **Oversize files:** Bot API has 20MB download limit. Handled gracefully — warning to user, message still processed without attachment.

**7. Cleanup** — `cleanOldMedia()` with 2-minute TTL deletes processed files automatically.

### joelclaw Implementation

For joelclaw, inbound media follows the same download pattern but routes through the Inngest pipeline (ADR-0041) instead of passing paths directly to the agent.

```typescript
// packages/gateway/src/channels/telegram.ts

import crypto from "node:crypto";
import { extname } from "node:path";
import { mkdir } from "node:fs/promises";

const MEDIA_DIR = "/tmp/joelclaw-media";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

async function downloadTelegramFile(
  fileId: string,
  token: string,
): Promise<{ localPath: string; mimeType: string; fileSize: number } | null> {
  await mkdir(MEDIA_DIR, { recursive: true });

  let file: { file_path?: string; file_size?: number };
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      file = await bot!.api.getFile(fileId);
      break;
    } catch (err) {
      if (String(err).includes("file is too big")) return null; // permanent
      if (attempt === MAX_RETRIES) {
        console.error("[gateway:telegram] getFile failed after retries", { fileId, err });
        return null;
      }
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }

  if (!file!.file_path) return null;

  const url = `https://api.telegram.org/file/bot${token}/${file!.file_path}`;
  const response = await fetch(url);
  if (!response.ok) return null;

  const ext = extname(file!.file_path) || ".bin";
  const localPath = `${MEDIA_DIR}/${crypto.randomUUID()}${ext}`;
  await Bun.write(localPath, await response.arrayBuffer());

  // Infer MIME from content-type header or extension
  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim()
    ?? mimeFromExt(ext);

  return {
    localPath,
    mimeType,
    fileSize: file!.file_size ?? (await Bun.file(localPath).size),
  };
}

function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".mp4": "video/mp4",
    ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/opus",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".pdf": "application/pdf",
  };
  return map[ext.toLowerCase()] ?? "application/octet-stream";
}
```

**Photo handler:**
```typescript
bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat.id;
  const photo = ctx.message.photo;
  const largest = photo[photo.length - 1]; // highest resolution

  const result = await downloadTelegramFile(largest.file_id, token);
  if (!result) {
    // Download failed — still enqueue caption text if any
    enqueuePrompt!(`telegram:${chatId}`,
      `[User sent a photo${ctx.message.caption ? `: ${ctx.message.caption}` : ""} — download failed]`,
      { telegramChatId: chatId, telegramMessageId: ctx.message.message_id });
    return;
  }

  // Emit to Inngest pipeline (ADR-0041)
  await emitMediaReceived({
    source: "telegram",
    type: "image",
    localPath: result.localPath,
    mimeType: result.mimeType,
    fileSize: result.fileSize,
    caption: ctx.message.caption ?? undefined,
    originSession: `telegram:${chatId}`,
    metadata: {
      telegramFileId: largest.file_id,
      telegramChatId: chatId,
      telegramMessageId: ctx.message.message_id,
      width: largest.width,
      height: largest.height,
    },
  });

  // Enqueue acknowledgment so agent knows media is being processed
  enqueuePrompt!(`telegram:${chatId}`,
    `[User sent a photo${ctx.message.caption ? `: ${ctx.message.caption}` : ""} — processing via vision pipeline]`,
    { telegramChatId: chatId, telegramMessageId: ctx.message.message_id });
});
```

**Voice message handler:**
```typescript
bot.on("message:voice", async (ctx) => {
  const chatId = ctx.chat.id;
  const voice = ctx.message.voice;

  const result = await downloadTelegramFile(voice.file_id, token);
  if (!result) {
    enqueuePrompt!(`telegram:${chatId}`,
      "[User sent a voice message — download failed]",
      { telegramChatId: chatId, telegramMessageId: ctx.message.message_id });
    return;
  }

  await emitMediaReceived({
    source: "telegram",
    type: "audio",
    localPath: result.localPath,
    mimeType: result.mimeType,
    fileSize: result.fileSize,
    originSession: `telegram:${chatId}`,
    metadata: {
      telegramFileId: voice.file_id,
      telegramChatId: chatId,
      telegramMessageId: ctx.message.message_id,
      duration: voice.duration,
    },
  });

  enqueuePrompt!(`telegram:${chatId}`,
    "[User sent a voice message — transcribing]",
    { telegramChatId: chatId, telegramMessageId: ctx.message.message_id });
});
```

**Video, audio file, and document handlers** follow the same pattern with appropriate `type` and MIME handling.

### Inngest Event Emission

The gateway needs to send events to Inngest. Since the gateway is a separate process from the worker, use the Inngest REST API:

```typescript
async function emitMediaReceived(data: {
  source: string;
  type: string;
  localPath: string;
  mimeType: string;
  fileSize: number;
  caption?: string;
  originSession?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const inngestUrl = process.env.INNGEST_BASE_URL ?? "http://localhost:8288";
  try {
    const res = await fetch(`${inngestUrl}/e/media-received-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "media/received",
        data,
      }),
    });
    if (!res.ok) {
      console.error("[gateway:telegram] failed to emit media/received", { status: res.status });
    }
  } catch (err) {
    console.error("[gateway:telegram] inngest event emission failed", { err });
  }
}
```

---

## Part 2: Reply Threading

### How OpenClaw Does It

OpenClaw tracks reply context through `describeReplyTarget(msg)` and `resolveTelegramReplyId()`:

```typescript
// Inbound: extract reply context
const replyTarget = describeReplyTarget(msg);
// → { kind: "quote"|"reply", sender, id, body }

// Context payload includes:
ReplyToId: replyTarget?.id,
ReplyToBody: replyTarget?.body,
ReplyToSender: replyTarget?.sender,

// Outbound: thread the reply
const replyToId = resolveTelegramReplyId(reply.replyToId);
await bot.api.sendMessage(chatId, html, {
  reply_to_message_id: replyToId,
  ...buildTelegramThreadParams(thread),
});
```

Forum topics (supergroups with topics) get special handling via `message_thread_id`.

### joelclaw Implementation

The command queue already stores `telegramMessageId` in metadata. Thread it through to the outbound `send()`:

```typescript
// Modify send() to accept replyTo
export async function send(
  chatId: number,
  message: string,
  options?: { replyTo?: number },
): Promise<void> {
  // ... existing typing indicator and HTML conversion ...

  for (const chunk of chunks) {
    try {
      await bot.api.sendMessage(chatId, chunk, {
        parse_mode: "HTML",
        ...(options?.replyTo ? {
          reply_parameters: { message_id: options.replyTo }
        } : {}),
      });
    } catch (error) {
      // ... existing fallback ...
    }
  }
}
```

In `daemon.ts`, pass the stored `telegramMessageId` through:
```typescript
if (source.startsWith("telegram:") && TELEGRAM_TOKEN) {
  const chatId = parseChatId(source) ?? TELEGRAM_USER_ID;
  const replyTo = metadata?.telegramMessageId as number | undefined;
  if (chatId) {
    sendTelegram(chatId, fullText, { replyTo });
  }
}
```

---

## Part 3: Outbound Media

### How OpenClaw Does It

OpenClaw's `deliverReplies()` in `bot/delivery.ts` is comprehensive:

**Media kind detection from MIME:**
```typescript
// src/media/constants.ts → mediaKindFromMime()
const kind = mediaKindFromMime(media.contentType);
// → "image" | "video" | "audio" | "document"

// Special cases:
const isGif = isGifMedia({ contentType, fileName });
// Voice vs audio file:
const { useVoice } = resolveTelegramVoiceSend({
  wantsVoice: reply.audioAsVoice === true,
  contentType: media.contentType,
  fileName,
});
```

**Dispatch by kind:**
```typescript
if (isGif)       await bot.api.sendAnimation(chatId, file, params);
else if (kind === "image") await bot.api.sendPhoto(chatId, file, params);
else if (kind === "video") await bot.api.sendVideo(chatId, file, params);
else if (kind === "audio") {
  if (useVoice)  await bot.api.sendVoice(chatId, file, params);   // round bubble
  else           await bot.api.sendAudio(chatId, file, params);   // with metadata
}
else             await bot.api.sendDocument(chatId, file, params);
```

**Caption splitting** — Telegram captions max 1024 chars. If longer, first 1024 goes as caption, rest as follow-up text message:
```typescript
const { caption, followUpText } = splitTelegramCaption(reply.text);
```

**Voice message fallback** — If recipient has voice messages blocked (Telegram Premium privacy), falls back to text:
```typescript
try {
  await bot.api.sendVoice(chatId, file, params);
} catch (voiceErr) {
  if (isVoiceMessagesForbidden(voiceErr)) {
    // Fall back to text
    await sendTelegramText(bot, chatId, fallbackText, ...);
  }
}
```

**HTML parse failures** — If Telegram rejects HTML entities, retries without formatting:
```typescript
try {
  await bot.api.sendMessage(chatId, htmlText, { parse_mode: "HTML" });
} catch (err) {
  if (/can't parse entities/i.test(err)) {
    await bot.api.sendMessage(chatId, plainText); // no parse_mode
  }
}
```

### joelclaw Implementation

```typescript
// packages/gateway/src/channels/telegram.ts

import { InputFile } from "grammy";

export async function sendMedia(
  chatId: number,
  filePath: string,
  options?: {
    caption?: string;
    replyTo?: number;
    asVoice?: boolean; // send audio as voice note (round bubble)
  },
): Promise<void> {
  if (!bot) {
    console.error("[gateway:telegram] bot not started, can't send media");
    return;
  }

  const file = new InputFile(filePath);
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const kind = mediaKindFromExt(ext);

  // Show appropriate typing indicator
  const action = kind === "photo" ? "upload_photo"
    : kind === "video" ? "upload_video"
    : kind === "audio" ? "upload_voice"
    : "upload_document";
  try { await bot.api.sendChatAction(chatId, action); } catch {}

  const params = {
    ...(options?.caption ? { caption: options.caption, parse_mode: "HTML" as const } : {}),
    ...(options?.replyTo ? { reply_parameters: { message_id: options.replyTo } } : {}),
  };

  try {
    switch (kind) {
      case "photo":
        await bot.api.sendPhoto(chatId, file, params);
        break;
      case "video":
        await bot.api.sendVideo(chatId, file, params);
        break;
      case "audio":
        if (options?.asVoice) {
          try {
            await bot.api.sendVoice(chatId, file, params);
          } catch (err) {
            if (/VOICE_MESSAGES_FORBIDDEN/.test(String(err))) {
              // Fallback: send as audio file
              await bot.api.sendAudio(chatId, file, params);
            } else throw err;
          }
        } else {
          await bot.api.sendAudio(chatId, file, params);
        }
        break;
      default:
        await bot.api.sendDocument(chatId, file, params);
    }
  } catch (error) {
    console.error("[gateway:telegram] sendMedia failed", { kind, error });
    // Fallback: send as document
    try {
      await bot.api.sendDocument(chatId, file, params);
    } catch (fallbackErr) {
      console.error("[gateway:telegram] sendMedia fallback failed", { fallbackErr });
    }
  }
}

function mediaKindFromExt(ext: string): "photo" | "video" | "audio" | "document" {
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "photo";
  if (["mp4", "mov", "avi", "webm", "mkv"].includes(ext)) return "video";
  if (["mp3", "ogg", "opus", "wav", "m4a", "flac"].includes(ext)) return "audio";
  return "document";
}
```

**Outbound router integration** — Parse `[MEDIA:type:path]` markers:
```typescript
// In the outbound response handler (daemon.ts)
const MEDIA_MARKER_RE = /\[MEDIA:(\w+):([^\]]+)\]/g;

function extractMediaMarkers(text: string): Array<{ type: string; path: string }> {
  const markers: Array<{ type: string; path: string }> = [];
  let match;
  while ((match = MEDIA_MARKER_RE.exec(text)) !== null) {
    markers.push({ type: match[1], path: match[2] });
  }
  return markers;
}

// In response routing:
const markers = extractMediaMarkers(fullText);
const textWithoutMarkers = fullText.replace(MEDIA_MARKER_RE, "").trim();

if (markers.length > 0 && chatId) {
  // Send text first (if any)
  if (textWithoutMarkers) {
    await sendTelegram(chatId, textWithoutMarkers, { replyTo });
  }
  // Then send each media file
  for (const marker of markers) {
    await sendMedia(chatId, marker.path, { replyTo });
  }
} else if (chatId) {
  await sendTelegram(chatId, fullText, { replyTo });
}
```

---

## Part 4: Agent Voice Identity

### Vision

Each joelclaw agent node should have a distinct voice — one that the human who runs that node has refined through iteration until it feels right. Voice is part of agent identity, same tier as name, writing style, and personality.

"Nice to talk to" is subjective per human. Joel's joelclaw voice won't be the same as someone else's node. It's a pairing — the voice that works is the one that works *for this relationship*.

### How OpenClaw Does It

OpenClaw has a full TTS system in `src/tts/tts.ts` with three providers in fallback order:

**Provider cascade:**
1. **ElevenLabs** — Best quality. Voice cloning from samples. API-based, ~$0.20/1k chars.
2. **OpenAI TTS** (`gpt-4o-mini-tts`) — Good quality. 6 preset voices. API-based.
3. **Edge TTS** — Free. Microsoft neural voices. No custom cloning.

**Per-session configuration:**
```typescript
// User preferences stored in ~/.openclaw/settings/tts.json
type TtsUserPrefs = {
  tts?: {
    auto?: "off" | "always" | "inbound" | "tagged";
    provider?: "elevenlabs" | "openai" | "edge";
    maxLength?: number;
    summarize?: boolean;
  };
};
```

**ElevenLabs voice settings** (tunable per agent):
```typescript
voiceSettings: {
  stability: 0.5,       // 0-1: lower = more expressive, higher = more consistent
  similarityBoost: 0.75, // 0-1: how closely to match the cloned voice
  style: 0.0,           // 0-1: expressiveness
  useSpeakerBoost: true,
  speed: 1.0,
};
```

**Telegram-specific output** — Opus format for voice notes (plays as round bubble):
```typescript
const TELEGRAM_OUTPUT = {
  openai: "opus",
  elevenlabs: "opus_48000_64",
  extension: ".opus",
  voiceCompatible: true, // → sendVoice instead of sendAudio
};
```

**Auto TTS modes:**
- `off` — no TTS
- `always` — every response gets a voice note
- `inbound` — only respond with voice when user sent voice
- `tagged` — only when agent includes `[[tts]]` or `[[tts:text]]` tags

**Long text handling:**
1. If response > `maxLength` chars (default 1500): summarize first
2. Strip markdown (`### Heading` → plain text, not "hashtag hashtag hashtag heading")
3. Feed summary to TTS, send full text as separate message

**Model directive overrides** — The agent can control voice parameters per-message:
```
[[tts:text]]This is what I'll say out loud[[/tts:text]]

And this is the full written response with more detail...
```

### joelclaw Voice Architecture

**Voice as identity config** — stored alongside the agent's DID, name, personality:

```yaml
# Agent identity config
identity:
  name: "joelclaw"
  did: "did:plc:joel"
  personality: "dry, direct, observant"
  
voice:
  provider: elevenlabs
  voiceId: "abc123..."         # cloned from Joel's voice or selected preset
  model: "eleven_multilingual_v2"
  settings:
    stability: 0.6
    similarityBoost: 0.75
    style: 0.2
    speed: 1.05
  auto: inbound                # respond with voice when user sends voice
  maxLength: 1500              # summarize longer responses before TTS
  fallback:
    provider: edge
    voice: "en-US-GuyNeural"
```

**Refinement loop** — the human tunes the voice via Telegram:

```
Human: [sends voice message]
Agent: [responds with voice note using current settings]
Human: "slower, warmer"
Agent: [adjusts speed: 0.9, stability: 0.7, re-synthesizes]
Human: "better, but try a different base voice"
Agent: [switches voiceId, re-synthesizes]
Human: "that's the one"
Agent: [saves to identity config]
```

**TTS Inngest function** — durable, retryable:

```typescript
// media-tts.ts — triggered by agent responses that need voice
inngest.createFunction(
  { id: "media-tts", concurrency: { limit: 2 } },
  { event: "media/tts.requested" },
  async ({ event, step }) => {
    const { text, voiceConfig, replyTo } = event.data;

    // Step 1: Summarize if too long
    const ttsText = await step.run("prepare-text", async () => {
      if (text.length <= voiceConfig.maxLength) return stripMarkdown(text);
      return await summarize(text, voiceConfig.maxLength);
    });

    // Step 2: Synthesize audio
    const audioPath = await step.run("synthesize", async () => {
      return await synthesize(ttsText, voiceConfig);
    });

    // Step 3: Send via Telegram as voice note
    await step.run("send-voice", async () => {
      await sendMedia(replyTo.chatId, audioPath, {
        asVoice: true,
        replyTo: replyTo.messageId,
      });
    });
  }
);
```

**Provider integration:**

| Provider | Voice Cloning | Cost | Latency | Privacy |
|----------|--------------|------|---------|---------|
| ElevenLabs | Yes (30s samples for instant, 30min for pro) | $5-22/mo | ~1-2s streaming | Cloud |
| OpenAI TTS | No (6 presets) | Per-token | ~1s | Cloud |
| Edge TTS | No (Microsoft neural) | Free | ~2-3s | Cloud (free) |
| sherpa-onnx | Yes (ONNX models) | Free | Fast | **Local** |
| Coqui XTTS | Yes (10s samples) | Free | ~3-5s | **Local** |

**Recommended path:** Start with ElevenLabs Starter ($5/mo) for instant voice cloning, fall back to Edge TTS (free) if API is down. Store API key in `agent-secrets`.

---

## Part 5: Telegram Bot API Reference

### File Download Limits
- **Photos:** Up to 20MB via Bot API `getFile`
- **Videos:** Up to 20MB via Bot API `getFile`
- **Documents:** Up to 20MB via Bot API `getFile`
- **Voice/audio:** Up to 20MB via Bot API `getFile`
- Files larger than 20MB return "file is too big" error (permanent, don't retry)

### File Upload Limits
- **sendPhoto:** 10MB (or 50MB via URL)
- **sendVideo:** 50MB (or via URL)
- **sendAudio:** 50MB
- **sendVoice:** 50MB (OGG/OPUS only)
- **sendDocument:** 50MB
- **sendAnimation:** 50MB

### Message Limits
- **Text:** 4096 characters max
- **Caption:** 1024 characters max (split longer captions)
- **Inline keyboard buttons:** 64 bytes per callback data

### Voice Message Format
- Telegram voice messages are OGG with Opus codec
- For `sendVoice` to display as round playable bubble, file must be OGG/OPUS
- Other audio formats via `sendVoice` may fail or display as regular audio

### Typing Indicators
```typescript
await bot.api.sendChatAction(chatId, "typing");       // text response
await bot.api.sendChatAction(chatId, "upload_photo");  // before photo
await bot.api.sendChatAction(chatId, "upload_video");  // before video
await bot.api.sendChatAction(chatId, "record_voice");  // before voice note
await bot.api.sendChatAction(chatId, "upload_voice");  // uploading voice
await bot.api.sendChatAction(chatId, "upload_document"); // before document
```

### Reply Threading
```typescript
// Reply to specific message
await bot.api.sendMessage(chatId, text, {
  reply_parameters: { message_id: originalMessageId },
});

// Works on all send methods
await bot.api.sendPhoto(chatId, file, {
  reply_parameters: { message_id: originalMessageId },
});
```

### Media Groups (Albums)
Telegram sends multi-photo messages as separate updates with the same `media_group_id`. Buffer them with a timeout (~500ms), then process as a batch.

```typescript
// grammY provides media_group_id on the message object
if (msg.media_group_id) {
  // Buffer and flush after timeout
}
```

---

## Implementation Phases

**Phase 1: Inbound media download** ← START HERE
- `downloadTelegramFile()` utility with retries
- Photo handler → download → `media/received` event
- Voice handler → download → `media/received` event  
- Video/audio/document handlers
- Media group buffering for multi-photo sends
- Graceful degradation (download fails → still enqueue text)

**Phase 2: Reply threading**
- Thread `telegramMessageId` from command queue → outbound router → `send()`
- `reply_parameters` on all outbound messages (text + media)
- Reply-chain detection for implicit mentions

**Phase 3: Outbound media**
- `sendMedia()` function with kind detection
- `[MEDIA:type:path]` marker parsing in outbound router
- Caption splitting for long text + media
- Voice message fallback when forbidden
- HTML parse failure recovery

**Phase 4: Agent voice**
- Voice profile in agent identity config
- ElevenLabs integration (voice cloning + synthesis)
- TTS Inngest function (summarize → synthesize → send)
- `inbound` auto mode: respond with voice when user sends voice
- Voice refinement UX via Telegram commands

**Phase 5: Polish**
- Typing indicators matched to media type
- Sticker support (static WEBP only)
- File size warnings before download attempts
- Cleanup of temp media files (TTL-based)
- Media group handling for album sends

## Consequences

- **Photos actually work.** Joel sends a photo, agent sees the content via vision, can reply threaded.
- **Bidirectional media.** Agent can send files back — screenshots, PDFs, audio clips.
- **Voice as identity.** Each agent node has a refined voice tuned by its human.
- **Telegram becomes a real channel**, not a text pipe with media holes.
- **Privacy:** Photos go to Claude API for vision (ADR-0041). Voice stays local (mlx-whisper). TTS goes to provider (ElevenLabs/OpenAI) or stays local (sherpa-onnx).
- **Cost:** Vision API per inbound image. TTS per outbound voice message (~$0.20/1k chars ElevenLabs). Edge TTS is free.

## Credits

- OpenClaw `src/telegram/` — comprehensive Telegram channel implementation (bot handlers, delivery, media resolution, sticker caching, voice formatting, TTS system)
- OpenClaw `src/tts/tts.ts` — three-provider TTS with fallback, per-session prefs, auto modes, text summarization, markdown stripping
- OpenClaw `src/media/` — input file handling, MIME detection, store with UUID naming, size limits
- grammY — Bot API wrapper, `InputFile`, `reply_parameters`, `sendVoice`/`sendPhoto`/etc.
- ADR-0041 — media processing pipeline (Inngest functions, vision, transcription, NAS archive)
- ElevenLabs — voice cloning API, voice settings model
