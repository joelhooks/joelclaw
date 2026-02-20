import crypto from "node:crypto";
import { mkdir } from "node:fs/promises";
import { extname } from "node:path";
import { Bot, InputFile } from "grammy";
import type { EnqueueFn } from "./redis";

// ── Telegram HTML formatting ───────────────────────────
// Telegram's HTML mode supports: <b>, <i>, <code>, <pre>, <a href="">
// Max message length: 4096 chars. We chunk at 4000 to leave room.
const CHUNK_MAX = 4000;

// ── Media download (ADR-0042) ──────────────────────────
const MEDIA_DIR = "/tmp/joelclaw-media";
const MAX_DOWNLOAD_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Inngest event API — same config as joelclaw CLI
const INNGEST_URL = process.env.INNGEST_URL ?? "http://localhost:8288";
const INNGEST_EVENT_KEY = process.env.INNGEST_EVENT_KEY ?? "";

let _botToken: string | undefined;

function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".mp4": "video/mp4",
    ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/opus",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".pdf": "application/pdf",
  };
  return map[ext.toLowerCase()] ?? "application/octet-stream";
}

function mediaKindFromExt(ext: string): "photo" | "video" | "audio" | "document" {
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) return "photo";
  if ([".mp4", ".mov", ".avi", ".webm", ".mkv"].includes(ext)) return "video";
  if ([".mp3", ".ogg", ".opus", ".wav", ".m4a", ".flac", ".oga"].includes(ext)) return "audio";
  return "document";
}

/**
 * Download a file from Telegram Bot API to local disk.
 * Retries on transient errors. Returns null if file is too big or permanently fails.
 */
async function downloadTelegramFile(
  fileId: string,
): Promise<{ localPath: string; mimeType: string; fileSize: number } | null> {
  if (!bot || !_botToken) return null;
  await mkdir(MEDIA_DIR, { recursive: true });

  let file: { file_path?: string; file_size?: number } | undefined;
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
    try {
      file = await bot.api.getFile(fileId);
      break;
    } catch (err) {
      const msg = String(err);
      if (msg.includes("file is too big")) {
        console.warn("[gateway:telegram] file too big for Bot API download", { fileId });
        return null;
      }
      if (attempt === MAX_DOWNLOAD_RETRIES) {
        console.error("[gateway:telegram] getFile failed after retries", { fileId, error: msg });
        return null;
      }
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }

  if (!file?.file_path) return null;

  const url = `https://api.telegram.org/file/bot${_botToken}/${file.file_path}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error("[gateway:telegram] file download HTTP error", { status: response.status });
      return null;
    }

    const ext = extname(file.file_path) || ".bin";
    const localPath = `${MEDIA_DIR}/${crypto.randomUUID()}${ext}`;
    await Bun.write(localPath, await response.arrayBuffer());

    // Prefer extension-based mime — Telegram's Content-Type header often returns
    // application/octet-stream for images, which breaks downstream vision processing
    const headerMime = response.headers.get("content-type")?.split(";")[0]?.trim();
    const extMime = mimeFromExt(ext);
    const mimeType = extMime !== "application/octet-stream" ? extMime : (headerMime ?? extMime);
    const fileSize = file.file_size ?? (await Bun.file(localPath).size);

    console.log("[gateway:telegram] file downloaded", { localPath, mimeType, fileSize });
    return { localPath, mimeType, fileSize };
  } catch (err) {
    console.error("[gateway:telegram] file download failed", { error: String(err) });
    return null;
  }
}

/**
 * Emit a media/received event to Inngest for processing (ADR-0041 pipeline).
 */
async function emitMediaReceived(data: {
  source: string;
  type: string;
  localPath: string;
  mimeType: string;
  fileSize: number;
  caption?: string;
  originSession?: string;
  fileName?: string;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  if (!INNGEST_EVENT_KEY) {
    console.warn("[gateway:telegram] no INNGEST_EVENT_KEY — can't emit media/received");
    return false;
  }
  try {
    // Derive stable idempotency key from source + telegram message ID
    const msgId = (data.metadata as any)?.telegramMessageId ?? "";
    const chatId = (data.metadata as any)?.telegramChatId ?? "";
    const eventId = `media-${data.source}-${chatId}-${msgId}`;

    const res = await fetch(`${INNGEST_URL}/e/${INNGEST_EVENT_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "media/received", data, id: eventId }),
    });
    if (!res.ok) {
      console.error("[gateway:telegram] inngest event failed", { status: res.status });
      return false;
    }
    console.log("[gateway:telegram] media/received event sent", { type: data.type });
    return true;
  } catch (err) {
    console.error("[gateway:telegram] inngest event error", { error: String(err) });
    return false;
  }
}

/**
 * Convert markdown to Telegram HTML.
 * Telegram supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a href>, <blockquote>, <tg-spoiler>
 * No <br> (use \n), no lists (use manual bullets), no headings (use bold).
 */
function mdToTelegramHtml(md: string): string {
  let html = md;

  // Protect code blocks first — extract and replace with placeholders
  const codeBlocks: string[] = [];
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length;
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    codeBlocks.push(`<pre><code${langAttr}>${escapeHtml(code.trim())}</code></pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Protect inline code
  const inlineCodes: string[] = [];
  html = html.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINE${idx}\x00`;
  });

  // Headings → bold (Telegram has no heading tags)
  // ### heading → \n<b>heading</b>\n
  html = html.replace(/^#{1,6}\s+(.+)$/gm, "\n<b>$1</b>");

  // Horizontal rules → thin line
  html = html.replace(/^[-*_]{3,}\s*$/gm, "───────────────");

  // Blockquotes (> text) → <blockquote>
  // Collect consecutive > lines into one blockquote
  html = html.replace(/(?:^> ?.+\n?)+/gm, (match) => {
    const content = match.replace(/^> ?/gm, "").trim();
    return `<blockquote>${content}</blockquote>\n`;
  });

  // Bold + italic (***text*** or ___text___)
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");

  // Bold (**text** or __text__)
  html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  html = html.replace(/__(.+?)__/g, "<u>$1</u>"); // __ = underline in Telegram convention

  // Strikethrough (~~text~~)
  html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Italic (*text* or _text_) — but not inside other tags or mid-word underscores
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<i>$1</i>");
  html = html.replace(/(?<![_\w])_([^_]+)_(?![_\w])/g, "<i>$1</i>");

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Bullet lists: - item or * item → • item (Telegram has no list tags)
  html = html.replace(/^[\t ]*[-*]\s+/gm, "• ");

  // Numbered lists: 1. item → keep as-is (already readable)

  // Tables: | col | col | → simplified
  // Convert markdown table rows to aligned text
  html = html.replace(/^\|(.+)\|$/gm, (_match, row) => {
    const cells = row.split("|").map((c: string) => c.trim()).filter(Boolean);
    return cells.join("  ·  ");
  });
  // Remove separator rows (|---|---|)
  html = html.replace(/^[-| :]+$/gm, "");

  // Restore code blocks and inline code
  html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_match, idx) => codeBlocks[parseInt(idx)]);
  html = html.replace(/\x00INLINE(\d+)\x00/g, (_match, idx) => inlineCodes[parseInt(idx)]);

  // Clean up excessive blank lines (max 2)
  html = html.replace(/\n{3,}/g, "\n\n");

  return html.trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function chunkMessage(text: string): string[] {
  if (text.length <= CHUNK_MAX) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= CHUNK_MAX) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf("\n", CHUNK_MAX);
    if (splitAt < CHUNK_MAX * 0.5) {
      // No good newline — split at space
      splitAt = remaining.lastIndexOf(" ", CHUNK_MAX);
    }
    if (splitAt < CHUNK_MAX * 0.3) {
      // No good space — hard split
      splitAt = CHUNK_MAX;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

// ── Channel implementation ─────────────────────────────

let bot: Bot | undefined;
let allowedUserId: number | undefined;
let enqueuePrompt: EnqueueFn | undefined;
let started = false;

export async function start(
  token: string,
  userId: number,
  enqueue: EnqueueFn,
): Promise<void> {
  if (started) return;

  enqueuePrompt = enqueue;
  allowedUserId = userId;
  _botToken = token;
  bot = new Bot(token);

  // Error handler
  bot.catch((err) => {
    console.error("[gateway:telegram] bot error", { error: err.message });
  });

  // Only allow Joel
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== allowedUserId) {
      console.warn("[gateway:telegram] unauthorized user", {
        userId: ctx.from?.id,
        username: ctx.from?.username,
      });
      return; // silently drop
    }
    await next();
  });

  // Text messages → command queue
  bot.on("message:text", (ctx) => {
    const text = ctx.message.text;
    const chatId = ctx.chat.id;

    console.log("[gateway:telegram] message received", {
      chatId,
      length: text.length,
    });

    enqueuePrompt!(`telegram:${chatId}`, text, {
      telegramChatId: chatId,
      telegramMessageId: ctx.message.message_id,
    });
  });

  // Photo messages → download + vision pipeline (ADR-0042)
  bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id;
    const caption = ctx.message.caption ?? "";
    const photo = ctx.message.photo;
    const largest = photo[photo.length - 1];
    if (!largest) {
      enqueuePrompt!(`telegram:${chatId}`,
        `[User sent a photo${caption ? `: ${caption}` : ""} — no photo data]`,
        { telegramChatId: chatId, telegramMessageId: ctx.message.message_id });
      return;
    }

    const result = await downloadTelegramFile(largest.file_id);
    if (!result) {
      enqueuePrompt!(`telegram:${chatId}`,
        `[User sent a photo${caption ? `: ${caption}` : ""} — download failed]`,
        { telegramChatId: chatId, telegramMessageId: ctx.message.message_id });
      return;
    }

    await emitMediaReceived({
      source: "telegram",
      type: "image",
      localPath: result.localPath,
      mimeType: result.mimeType,
      fileSize: result.fileSize,
      caption: caption || undefined,
      originSession: `telegram:${chatId}`,
      metadata: {
        telegramFileId: largest.file_id,
        telegramChatId: chatId,
        telegramMessageId: ctx.message.message_id,
        width: largest.width,
        height: largest.height,
      },
    });

    enqueuePrompt!(`telegram:${chatId}`,
      `[User sent a photo${caption ? `: ${caption}` : ""} — processing via vision pipeline, file: ${result.localPath}]`,
      { telegramChatId: chatId, telegramMessageId: ctx.message.message_id });
  });

  // Voice messages → download + transcription pipeline (ADR-0042)
  bot.on("message:voice", async (ctx) => {
    const chatId = ctx.chat.id;
    const voice = ctx.message.voice;

    const result = await downloadTelegramFile(voice.file_id);
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
      `[User sent a voice message — transcribing, file: ${result.localPath}]`,
      { telegramChatId: chatId, telegramMessageId: ctx.message.message_id });
  });

  // Audio files (music, recordings) → download + pipeline
  bot.on("message:audio", async (ctx) => {
    const chatId = ctx.chat.id;
    const audio = ctx.message.audio;
    const caption = ctx.message.caption ?? "";

    const result = await downloadTelegramFile(audio.file_id);
    if (!result) {
      enqueuePrompt!(`telegram:${chatId}`,
        `[User sent an audio file${caption ? `: ${caption}` : ""} — download failed]`,
        { telegramChatId: chatId, telegramMessageId: ctx.message.message_id });
      return;
    }

    await emitMediaReceived({
      source: "telegram",
      type: "audio",
      localPath: result.localPath,
      mimeType: result.mimeType,
      fileSize: result.fileSize,
      caption: caption || undefined,
      originSession: `telegram:${chatId}`,
      metadata: {
        telegramFileId: audio.file_id,
        telegramChatId: chatId,
        telegramMessageId: ctx.message.message_id,
        duration: audio.duration,
        title: audio.title,
        performer: audio.performer,
      },
    });

    enqueuePrompt!(`telegram:${chatId}`,
      `[User sent an audio file${audio.title ? ` "${audio.title}"` : ""}${caption ? `: ${caption}` : ""} — processing, file: ${result.localPath}]`,
      { telegramChatId: chatId, telegramMessageId: ctx.message.message_id });
  });

  // Video messages → download + pipeline
  bot.on("message:video", async (ctx) => {
    const chatId = ctx.chat.id;
    const video = ctx.message.video;
    const caption = ctx.message.caption ?? "";

    const result = await downloadTelegramFile(video.file_id);
    if (!result) {
      enqueuePrompt!(`telegram:${chatId}`,
        `[User sent a video${caption ? `: ${caption}` : ""} — download failed]`,
        { telegramChatId: chatId, telegramMessageId: ctx.message.message_id });
      return;
    }

    await emitMediaReceived({
      source: "telegram",
      type: "video",
      localPath: result.localPath,
      mimeType: result.mimeType,
      fileSize: result.fileSize,
      caption: caption || undefined,
      originSession: `telegram:${chatId}`,
      metadata: {
        telegramFileId: video.file_id,
        telegramChatId: chatId,
        telegramMessageId: ctx.message.message_id,
        duration: video.duration,
        width: video.width,
        height: video.height,
      },
    });

    enqueuePrompt!(`telegram:${chatId}`,
      `[User sent a video${caption ? `: ${caption}` : ""} — processing, file: ${result.localPath}]`,
      { telegramChatId: chatId, telegramMessageId: ctx.message.message_id });
  });

  // Documents (PDF, files, etc.) → download + pipeline
  bot.on("message:document", async (ctx) => {
    const chatId = ctx.chat.id;
    const doc = ctx.message.document;
    const caption = ctx.message.caption ?? "";

    const result = await downloadTelegramFile(doc.file_id);
    if (!result) {
      enqueuePrompt!(`telegram:${chatId}`,
        `[User sent a document "${doc.file_name ?? "file"}"${caption ? `: ${caption}` : ""} — download failed]`,
        { telegramChatId: chatId, telegramMessageId: ctx.message.message_id });
      return;
    }

    await emitMediaReceived({
      source: "telegram",
      type: "document",
      localPath: result.localPath,
      mimeType: doc.mime_type ?? result.mimeType,
      fileSize: result.fileSize,
      caption: caption || undefined,
      originSession: `telegram:${chatId}`,
      metadata: {
        telegramFileId: doc.file_id,
        telegramChatId: chatId,
        telegramMessageId: ctx.message.message_id,
        fileName: doc.file_name,
      },
    });

    enqueuePrompt!(`telegram:${chatId}`,
      `[User sent a document "${doc.file_name ?? "file"}"${caption ? `: ${caption}` : ""} — processing, file: ${result.localPath}]`,
      { telegramChatId: chatId, telegramMessageId: ctx.message.message_id });
  });

  // Start long polling (non-blocking)
  bot.start({
    onStart: (botInfo) => {
      console.log("[gateway:telegram] started", {
        botId: botInfo.id,
        botUsername: botInfo.username,
        allowedUserId,
      });
    },
  });

  started = true;
}

/**
 * Send a text message back to a Telegram chat.
 * Handles markdown→HTML conversion, chunking, and optional reply threading.
 */
export async function send(
  chatId: number,
  message: string,
  options?: { replyTo?: number },
): Promise<void> {
  if (!bot) {
    console.error("[gateway:telegram] bot not started, can't send");
    return;
  }

  // Show typing indicator
  try {
    await bot.api.sendChatAction(chatId, "typing");
  } catch {
    // non-critical
  }

  const html = mdToTelegramHtml(message);
  const chunks = chunkMessage(html);

  for (const chunk of chunks) {
    try {
      await bot.api.sendMessage(chatId, chunk, {
        parse_mode: "HTML",
        ...(options?.replyTo ? { reply_parameters: { message_id: options.replyTo } } : {}),
      });
    } catch (error) {
      // Fallback: send as plain text if HTML parsing fails
      console.warn("[gateway:telegram] HTML send failed, trying plain text", { error });
      try {
        await bot.api.sendMessage(chatId, message.slice(0, CHUNK_MAX), {
          ...(options?.replyTo ? { reply_parameters: { message_id: options.replyTo } } : {}),
        });
      } catch (fallbackError) {
        console.error("[gateway:telegram] send failed completely", { fallbackError });
      }
      break; // don't continue chunking if we had to fallback
    }
  }
}

/**
 * Send a media file to a Telegram chat.
 * Detects kind from extension and dispatches to appropriate Bot API method.
 */
export async function sendMedia(
  chatId: number,
  filePath: string,
  options?: { caption?: string; replyTo?: number; asVoice?: boolean },
): Promise<void> {
  if (!bot) {
    console.error("[gateway:telegram] bot not started, can't send media");
    return;
  }

  const ext = (extname(filePath) || ".bin").toLowerCase();
  const kind = mediaKindFromExt(ext);

  // Show appropriate typing indicator
  const action = kind === "photo" ? "upload_photo"
    : kind === "video" ? "upload_video"
    : kind === "audio" ? "upload_voice"
    : "upload_document";
  try { await bot.api.sendChatAction(chatId, action); } catch {}

  const file = new InputFile(filePath);
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
    console.log("[gateway:telegram] media sent", { chatId, kind, filePath });
  } catch (error) {
    console.error("[gateway:telegram] sendMedia failed, trying as document", { kind, error });
    try {
      await bot.api.sendDocument(chatId, file, params);
    } catch (fallbackErr) {
      console.error("[gateway:telegram] sendMedia fallback failed", { fallbackErr });
    }
  }
}

/**
 * Extract chat ID from a telegram source string like "telegram:12345"
 */
export function parseChatId(source: string): number | undefined {
  const match = source.match(/^telegram:(-?\d+)$/);
  return match?.[1] ? parseInt(match[1], 10) : undefined;
}

export async function shutdown(): Promise<void> {
  if (bot) {
    bot.stop();
    bot = undefined;
  }
  started = false;
  console.log("[gateway:telegram] stopped");
}
