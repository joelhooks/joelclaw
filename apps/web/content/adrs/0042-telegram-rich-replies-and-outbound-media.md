---
status: proposed
date: 2026-02-18
decision-makers: joel
tags:
  - telegram
  - gateway
  - media
  - channels
supersedes:
related:
  - "0041-first-class-media-from-channels"
  - "0038-embedded-pi-gateway-daemon"
  - "0018-pi-native-gateway-redis-event-bridge"
---

# ADR-0042: Telegram Rich Replies and Outbound Media

## Context

The Telegram channel is text-only in both directions. Two problems:

**Inbound:** Photos, voice messages, audio, video, and documents arrive but are reduced to placeholder text (`[User sent a photo]`). The agent never sees the actual content. ADR-0041 built the `media/received` Inngest pipeline to process media — but the Telegram handler doesn't download files or emit events yet.

**Outbound:** Agent responses are always `sendMessage` with HTML text. The agent can't:
- Reply to a specific message (threading context)
- Send images (screenshots, generated charts, diagrams)
- Send audio (TTS, audio clips)
- Send video (screen recordings, processed clips)
- Send documents (PDFs, spreadsheets, exports)

OpenClaw's channel plugins support full bidirectional media — each channel adapter handles inbound media normalization and outbound media dispatch. Their Telegram extension uses grammY's full API surface.

## Decision

Upgrade the Telegram channel to support rich inbound media (download + pipeline) and outbound media (reply-to + send files).

### Inbound: Download → Pipeline

When the bot receives media, download via Bot API `getFile`, save to `/tmp/joelclaw-media/`, and emit `media/received` to trigger the ADR-0041 Inngest pipeline.

```typescript
bot.on("message:photo", async (ctx) => {
  const photo = ctx.message.photo;
  const largest = photo[photo.length - 1]; // highest resolution
  const file = await ctx.api.getFile(largest.file_id);
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

  const localPath = `/tmp/joelclaw-media/${crypto.randomUUID()}${extname(file.file_path ?? ".jpg")}`;
  const response = await fetch(url);
  await Bun.write(localPath, await response.arrayBuffer());

  // Emit to Inngest pipeline (ADR-0041)
  await inngestSend("media/received", {
    source: "telegram",
    type: "image",
    localPath,
    mimeType: "image/jpeg",
    fileName: file.file_path,
    fileSize: largest.file_size ?? 0,
    caption: ctx.message.caption,
    originSession: `telegram:${ctx.chat.id}`,
    metadata: {
      telegramFileId: largest.file_id,
      width: largest.width,
      height: largest.height,
    },
  });

  // Also enqueue the caption as text (if any) so the agent has context
  if (ctx.message.caption) {
    enqueue(`telegram:${ctx.chat.id}`, ctx.message.caption, {
      telegramChatId: ctx.chat.id,
      telegramMessageId: ctx.message.message_id,
    });
  }
});
```

Same pattern for voice, audio, video, documents — each handler downloads the file and emits `media/received` with the correct type and MIME.

### Outbound: Reply-to and Media Sending

**Reply-to specific messages:** Track the `message_id` from inbound messages. When the agent responds, use `reply_parameters` to thread the reply:

```typescript
await bot.api.sendMessage(chatId, html, {
  parse_mode: "HTML",
  reply_parameters: { message_id: originalMessageId },
});
```

The command queue already stores `telegramMessageId` in metadata. Thread it through to the outbound router.

**Send media:** Extend the `send` function to detect media references in agent responses and dispatch appropriately:

```typescript
export async function sendMedia(
  chatId: number,
  type: "photo" | "audio" | "video" | "document",
  filePath: string,
  options?: { caption?: string; replyTo?: number },
): Promise<void> {
  const file = new InputFile(filePath);
  const params = {
    caption: options?.caption,
    reply_parameters: options?.replyTo ? { message_id: options.replyTo } : undefined,
  };

  switch (type) {
    case "photo": await bot.api.sendPhoto(chatId, file, params); break;
    case "audio": await bot.api.sendAudio(chatId, file, params); break;
    case "video": await bot.api.sendVideo(chatId, file, params); break;
    case "document": await bot.api.sendDocument(chatId, file, params); break;
  }
}
```

### Architecture

**Inbound media flow:**
```
Telegram photo → grammY handler → getFile → download to /tmp →
  emit media/received → Inngest pipeline (ADR-0041) →
  vision/transcribe → gateway notification → agent sees description
```

**Outbound media flow:**
```
Agent response with file reference → outbound router detects media →
  sendPhoto/sendAudio/sendVideo/sendDocument → Telegram
```

**Reply threading:**
```
Inbound message (message_id=42) → command queue (metadata.telegramMessageId=42) →
  agent processes → response → outbound router →
  sendMessage(reply_parameters: { message_id: 42 })
```

### Media Detection in Outbound

The agent can signal media to send via structured markers in its response:

```
Here's the screenshot you asked for.

[MEDIA:photo:/tmp/joelclaw-media/screenshot.png]
```

Or via a tool call that returns a file path. The outbound router parses these markers and dispatches the appropriate grammY method.

### Phases

**Phase 1: Inbound media wiring**
- Photo download → `media/received` event
- Voice message download (`.ogg`) → `media/received` with type=audio
- Audio/video/document handlers

**Phase 2: Reply threading**
- Thread `telegramMessageId` through command queue → outbound router
- `reply_parameters` on all outbound messages

**Phase 3: Outbound media**
- `sendMedia()` function in telegram.ts
- `[MEDIA:type:path]` marker parsing in outbound router
- grammY `InputFile` for local files
- Caption support

**Phase 4: Typing indicators + read receipts**
- `sendChatAction("typing")` during processing (already partial)
- `sendChatAction("upload_photo")` before media send
- Progress updates during long pipeline runs

## Consequences

- **Photos actually work.** Joel sends a photo, agent sees the content, can reply threaded.
- **Bidirectional media.** Agent can send files back — screenshots, PDFs, audio clips.
- **Telegram becomes a real channel**, not a text pipe with media holes.
- **Privacy:** Photos go to Claude API for vision (same as ADR-0041). Voice stays local (mlx-whisper).
- **Bot API file size limits:** Photos up to 20MB download, 10MB upload. Videos up to 20MB. Documents up to 50MB.
- **Cost:** Vision API per inbound image. No cost for outbound.

## Credits

- OpenClaw `extensions/telegram/` — full bidirectional channel pattern
- grammY — Bot API wrapper, `InputFile`, `reply_parameters`
- ADR-0041 — media processing pipeline (Inngest functions)
