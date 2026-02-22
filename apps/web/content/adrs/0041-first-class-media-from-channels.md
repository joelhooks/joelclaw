---
status: deferred
date: 2026-02-18
decision-makers: joel
consulted: openclaw/openclaw media-understanding system
tags:
  - media
  - gateway
  - inngest
  - telegram
---

# ADR-0041: First-Class Media Handling from Connected Channels

## Context

Photos, audio, and video sent through connected channels (Telegram, future: iMessage, Slack) are silently dropped. The gateway extension only handles text events — any media attachment vanishes.

This is a real problem: Joel sends a photo from Telegram, the agent sees nothing. The system pretends it didn't happen.

OpenClaw handles this comprehensively via `src/media-understanding/` — a pipeline that normalizes attachments from any channel, classifies them (image/audio/video/document), runs appropriate processing (vision description, audio transcription, video description), and injects the results back into the conversation context. Their `MsgContext` carries `MediaPaths`, `MediaUrls`, `MediaTypes` arrays alongside the text body.

We don't need OpenClaw's full multi-provider abstraction. We need: **receive media → store it → process it → notify the agent with results.**

## Decision

Build a media processing pipeline as Inngest durable functions, triggered by a new `media/received` event. The gateway extension and channel adapters (Telegram bot) detect media attachments, download them to local storage, and emit the event. Inngest handles the rest.

### Option A: Inline Processing (rejected)

Process media directly in the gateway extension or Telegram handler. Fast for small images, but:
- Blocks the event loop
- No retry on failure
- No observability
- Can't reuse for other channels

### Option B: Inngest Pipeline (chosen)

Media follows the same pattern as video ingest: event-driven, step-level retry, claim-check for large files.

```
Channel → download to /tmp → emit media/received → Inngest pipeline:
  1. classify (mime sniffing + extension)
  2. process (vision/transcribe/OCR depending on type)
  3. store (NAS archive + vault note if significant)
  4. notify gateway (inject results into agent session)
```

### Architecture

**Event schema:**
```typescript
"media/received": {
  data: {
    source: "telegram" | "imessage" | "slack" | "cli";
    type: "image" | "audio" | "video" | "document";
    localPath: string;        // downloaded to /tmp already
    mimeType: string;
    fileName?: string;
    fileSize: number;
    caption?: string;         // user text accompanying the media
    originSession?: string;   // route response back to sender
    metadata?: {
      telegramFileId?: string;
      width?: number;
      height?: number;
      duration?: number;      // audio/video seconds
    };
  };
};

"media/processed": {
  data: {
    source: string;
    type: string;
    localPath: string;
    description?: string;     // vision/transcription output
    transcript?: string;      // audio transcription
    archivePath?: string;     // NAS path if archived
    vaultNotePath?: string;   // vault note if created
    originSession?: string;
  };
};
```

**Processing by type:**

| Type | Processing | Tool |
|------|-----------|------|
| image | Vision description → text summary | Claude vision API (base64) |
| audio | Transcription → text | mlx-whisper (local, same as video pipeline) |
| video | Extract audio → transcribe + frame sample → describe | mlx-whisper + vision |
| document | Text extraction (PDF, etc.) | defuddle / pdf-parse |

**Storage:**
- `/tmp/joelclaw-media/{uuid}.{ext}` — ephemeral processing
- `joel@three-body:/volume1/home/joel/media/{year}/{source}/` — NAS archive
- `~/Vault/Resources/media/` — vault note with description/transcript (optional, only for significant content)

**Gateway integration:**
The `media/processed` event routes through the existing gateway middleware. The agent receives a formatted message:

```
## 📎 Media received (image from Telegram)

[Description of what's in the image]

Caption: "personal note re kristina's upcoming surgery"
Source: /tmp/joelclaw-media/abc123.jpg
```

### Phases

**Phase 1: Images from Telegram** (this ADR)
- Telegram bot downloads photo via Bot API `getFile`
- Saves to `/tmp/joelclaw-media/`
- Emits `media/received` with type=image
- Inngest function: base64 encode → Claude vision → description text
- Gateway notification with description + original caption

**Phase 2: Audio + Voice Messages**
- Telegram voice messages (`.ogg`) and audio files
- Reuse existing mlx-whisper transcription from video pipeline
- Inngest function: convert if needed → transcribe → text

**Phase 3: Video + Documents**
- Short video clips: frame extraction + audio transcription
- Documents: text extraction via defuddle/pdf-parse
- Archive to NAS

**Phase 4: Multi-Channel**
- Abstract the download step per channel
- iMessage attachments (via BlueBubbles or imessage extension pattern from OpenClaw)
- Slack file uploads

## Consequences

- **Media stops being silently dropped.** The agent sees what Joel sends.
- **Durable processing.** Large audio files or slow vision API calls retry independently.
- **Claim-check pattern.** File paths passed between steps, not base64 blobs in event payloads.
- **Channel-agnostic.** Any channel that can download a file and emit `media/received` works.
- **Cost.** Vision API calls per image. Local mlx-whisper for audio (free but GPU-bound).
- **Privacy.** Images go to Claude API for vision. Audio stays local (mlx-whisper). This matches existing video pipeline behavior.

## Credits

- OpenClaw `src/media-understanding/` — attachment normalization, capability-based processing, provider abstraction pattern
- OpenClaw `src/media/input-files.ts` — MIME detection, size limits, PDF extraction
- Existing joelclaw video pipeline — claim-check pattern, mlx-whisper integration, NAS archival
