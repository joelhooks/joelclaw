import crypto from "node:crypto";
import { mkdir } from "node:fs/promises";
import { extname } from "node:path";
import { Bot, InputFile } from "grammy";
import type { EnqueueFn } from "./redis";
import type { OutboundEnvelope } from "../outbound/envelope";
import { enrichPromptWithVaultContext } from "../vault-read";
import { emitGatewayOtel } from "../observability";

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

// ── Inline keyboard types (ADR-0070) ───────────────────
export interface InlineButton {
  text: string;
  action?: string;   // callback_data (max 64 bytes, mutually exclusive with url)
  url?: string;       // URL button
}

export interface RichSendOptions {
  replyTo?: number;
  buttons?: InlineButton[][];  // rows of buttons
  silent?: boolean;            // disable_notification
  noPreview?: boolean;         // disable_web_page_preview
}

export type TelegramStartOptions = {
  configureBot?: (bot: Bot) => void | Promise<void>;
}

function resolveSendInput(
  message: string | OutboundEnvelope,
  options?: RichSendOptions,
): { text: string; options?: RichSendOptions; format?: OutboundEnvelope["format"] } {
  if (typeof message === "string") {
    return { text: message, options };
  }

  const mergedOptions: RichSendOptions = {
    ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
    ...(message.buttons ? { buttons: message.buttons } : {}),
    ...(message.silent !== undefined ? { silent: message.silent } : {}),
    ...(options ?? {}),
  };

  return {
    text: message.text,
    options: mergedOptions,
    format: message.format,
  };
}

function formatByEnvelope(text: string, format: OutboundEnvelope["format"] | undefined): string {
  if (format === "html") return text;
  if (format === "plain") return escapeHtml(text);
  return mdToTelegramHtml(text);
}

const TELEGRAM_ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "code",
  "em",
  "i",
  "pre",
  "s",
  "strong",
  "tg-spoiler",
  "u",
]);

function isWellFormedTelegramHtml(html: string): boolean {
  const stack: string[] = [];
  const tagPattern = /<\/?([a-zA-Z0-9-]+)(?:\s+[^<>]*?)?>/g;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(html)) !== null) {
    const fullTag = match[0] ?? "";
    const tagName = (match[1] ?? "").toLowerCase();
    if (!tagName) continue;
    if (!TELEGRAM_ALLOWED_TAGS.has(tagName)) return false;

    const isClosing = fullTag.startsWith("</");
    const isSelfClosing = fullTag.endsWith("/>");
    if (isClosing) {
      const lastOpen = stack.pop();
      if (lastOpen !== tagName) return false;
      continue;
    }
    if (!isSelfClosing) {
      stack.push(tagName);
    }
  }

  return stack.length === 0;
}

function stripHtmlTags(input: string): string {
  return input
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .trim();
}

// Human-readable labels shown after button press
const ACTION_LABELS: Record<string, string> = {
  archive: "📦 <b>Archived</b>",
  flag: "🚩 <b>Flagged for follow-up</b>",
  reply_later: "⏰ <b>Marked for reply</b>",
  approve: "✅ <b>Approved</b>",
  reject: "❌ <b>Rejected</b>",
  skip: "⏭ <b>Skipped</b>",
  ack: "👍 <b>Acknowledged</b>",
  investigate: "🔍 <b>Investigating...</b>",
  s4h: "⏰ <b>Snoozed for 4h</b>",
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
        void emitGatewayOtel({
          level: "warn",
          component: "telegram-channel",
          action: "telegram.media.too_big",
          success: false,
          metadata: { fileId },
        });
        return null;
      }
      if (attempt === MAX_DOWNLOAD_RETRIES) {
        console.error("[gateway:telegram] getFile failed after retries", { fileId, error: msg });
        void emitGatewayOtel({
          level: "error",
          component: "telegram-channel",
          action: "telegram.media.get_file_failed",
          success: false,
          error: msg,
          metadata: { fileId },
        });
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
      void emitGatewayOtel({
        level: "error",
        component: "telegram-channel",
        action: "telegram.media.download_http_error",
        success: false,
        error: `http_${response.status}`,
        metadata: { fileId },
      });
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
    void emitGatewayOtel({
      level: "debug",
      component: "telegram-channel",
      action: "telegram.media.downloaded",
      success: true,
      metadata: {
        mimeType,
        fileSize,
      },
    });
    return { localPath, mimeType, fileSize };
  } catch (err) {
    console.error("[gateway:telegram] file download failed", { error: String(err) });
    void emitGatewayOtel({
      level: "error",
      component: "telegram-channel",
      action: "telegram.media.download_failed",
      success: false,
      error: String(err),
      metadata: { fileId },
    });
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
    void emitGatewayOtel({
      level: "warn",
      component: "telegram-channel",
      action: "telegram.media.emit_skipped",
      success: false,
      error: "missing_inngest_event_key",
    });
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
      void emitGatewayOtel({
        level: "error",
        component: "telegram-channel",
        action: "telegram.media.emit_failed",
        success: false,
        error: `http_${res.status}`,
        metadata: { type: data.type },
      });
      return false;
    }
    console.log("[gateway:telegram] media/received event sent", { type: data.type });
    void emitGatewayOtel({
      level: "info",
      component: "telegram-channel",
      action: "telegram.media.emit_sent",
      success: true,
      metadata: {
        type: data.type,
        source: data.source,
      },
    });
    return true;
  } catch (err) {
    console.error("[gateway:telegram] inngest event error", { error: String(err) });
    void emitGatewayOtel({
      level: "error",
      component: "telegram-channel",
      action: "telegram.media.emit_error",
      success: false,
      error: String(err),
      metadata: { type: data.type },
    });
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

  // Protect links before escaping (extract URL hrefs)
  const links: string[] = [];
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, url) => {
    const idx = links.length;
    links.push(`<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`);
    return `\x00LINK${idx}\x00`;
  });

  // CRITICAL: Escape <, >, & in body text BEFORE markdown transforms.
  // Telegram's HTML parser is strict — unescaped entities cause 400 errors
  // which trigger our fallback to plain text (raw markdown shown).
  html = escapeHtml(html);

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

  // Links already extracted and protected above (before HTML escaping)

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

  // Restore protected elements
  html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_match, idx) => codeBlocks[parseInt(idx)] ?? "");
  html = html.replace(/\x00INLINE(\d+)\x00/g, (_match, idx) => inlineCodes[parseInt(idx)] ?? "");
  html = html.replace(/\x00LINK(\d+)\x00/g, (_match, idx) => links[parseInt(idx)] ?? "");

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
  options?: TelegramStartOptions,
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

  if (options?.configureBot) {
    await options.configureBot(bot);
  }

  // Text messages → command queue
  bot.on("message:text", async (ctx) => {
    const receivedAt = Date.now();
    const text = ctx.message.text;
    const chatId = ctx.chat.id;

    console.log("[gateway:telegram] message received", {
      chatId,
      length: text.length,
    });

    const prompt = await enrichPromptWithVaultContext(text);
    void emitGatewayOtel({
      level: "debug",
      component: "telegram-channel",
      action: "telegram.message.received",
      success: true,
      duration_ms: Date.now() - receivedAt,
      metadata: {
        chatId,
        length: text.length,
      },
    });

    enqueuePrompt!(`telegram:${chatId}`, prompt, {
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

  // Callback query handler — inline keyboard button presses (ADR-0070)
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.callbackQuery.message?.chat.id;
    const messageId = ctx.callbackQuery.message?.message_id;

    console.log("[gateway:telegram] callback_query", { data, chatId, messageId });
    void emitGatewayOtel({
      level: "info",
      component: "telegram-channel",
      action: "telegram.callback.received",
      success: true,
      metadata: {
        action: data,
        chatId,
      },
    });

    // Always answer within 10s or button shows loading spinner
    try {
      await ctx.answerCallbackQuery({ text: "Processing..." });
    } catch {
      // non-critical
    }

    // Parse callback_data — format: "action:context" (max 64 bytes)
    const colonIdx = data.indexOf(":");
    const action = colonIdx > 0 ? data.slice(0, colonIdx) : data;
    const context = colonIdx > 0 ? data.slice(colonIdx + 1) : "";

    // Fire Inngest event for the callback action
    try {
      const eventKey = INNGEST_EVENT_KEY || "37aa349b89692d657d276a40e0e47a15";
      const res = await fetch(`${INNGEST_URL}/e/${eventKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "telegram/callback.received",
          data: {
            action,
            context,
            rawData: data,
            chatId,
            messageId,
          },
        }),
      });
      if (!res.ok) {
        console.error("[gateway:telegram] callback inngest event failed", { status: res.status });
      }
    } catch (err) {
      console.error("[gateway:telegram] callback inngest error", { error: String(err) });
    }

    // Edit the original message to show action taken
    if (chatId && messageId) {
      const actionLabel = ACTION_LABELS[action] ?? `✅ ${action}`;
      try {
        await bot!.api.editMessageReplyMarkup(chatId, messageId, {
          reply_markup: { inline_keyboard: [] }, // remove buttons
        });
        // Append action indicator to message
        const original = ctx.callbackQuery.message && "text" in ctx.callbackQuery.message
          ? (ctx.callbackQuery.message as any).text ?? ""
          : "";
        if (original) {
          await bot!.api.editMessageText(chatId, messageId, `${original}\n\n${actionLabel}`, {
            parse_mode: "HTML",
          }).catch(() => {
            // editMessageText can fail if content unchanged — ignore
          });
        }
      } catch (err) {
        console.error("[gateway:telegram] edit after callback failed", { error: String(err) });
      }
    }
  });

  // Start long polling (non-blocking). Startup failures should not crash gateway.
  void bot.start({
    onStart: (botInfo) => {
      console.log("[gateway:telegram] started", {
        botId: botInfo.id,
        botUsername: botInfo.username,
        allowedUserId,
      });
      void emitGatewayOtel({
        level: "info",
        component: "telegram-channel",
        action: "telegram.channel.started",
        success: true,
        metadata: {
          botId: botInfo.id,
          botUsername: botInfo.username,
        },
      });
    },
  }).catch((error) => {
    started = false;
    console.error("[gateway:telegram] failed to start polling; telegram channel disabled", { error: String(error) });
    void emitGatewayOtel({
      level: "error",
      component: "telegram-channel",
      action: "telegram.channel.start_failed",
      success: false,
      error: String(error),
    });
  });

  started = true;
}

/**
 * Send a text message back to a Telegram chat.
 * Handles markdown→HTML conversion, chunking, and optional reply threading.
 */
export async function send(
  chatId: number,
  message: string | OutboundEnvelope,
  options?: RichSendOptions,
): Promise<void> {
  if (!bot) {
    console.error("[gateway:telegram] bot not started, can't send");
    void emitGatewayOtel({
      level: "warn",
      component: "telegram-channel",
      action: "telegram.send.skipped",
      success: false,
      error: "bot_not_started",
    });
    return;
  }

  // Show typing indicator
  try {
    await bot.api.sendChatAction(chatId, "typing");
  } catch {
    // non-critical
  }

  const sendInput = resolveSendInput(message, options);
  const text = sendInput.text;
  const mergedOptions = sendInput.options;

  // Build inline keyboard if buttons provided
  const replyMarkup = mergedOptions?.buttons
    ? {
        inline_keyboard: mergedOptions.buttons.map(row =>
          row.map(btn => btn.url
            ? { text: btn.text, url: btn.url }
            : { text: btn.text, callback_data: btn.action ?? btn.text }
          )
        ),
      }
    : undefined;

  const html = formatByEnvelope(text, sendInput.format);
  const htmlIsValid = isWellFormedTelegramHtml(html);
  const parseAsHtml = htmlIsValid;
  const outboundText = htmlIsValid ? html : stripHtmlTags(html);
  if (!htmlIsValid) {
    void emitGatewayOtel({
      level: "warn",
      component: "telegram-channel",
      action: "telegram.send.html_invalid",
      success: false,
      metadata: {
        chatId,
      },
    });
  }
  const chunks = chunkMessage(outboundText);
  const sendStartedAt = Date.now();

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const isLast = i === chunks.length - 1;

    try {
      await bot.api.sendMessage(chatId, chunk, {
        ...(parseAsHtml ? { parse_mode: "HTML" as const } : {}),
        // Only attach buttons to the last chunk
        ...(isLast && replyMarkup ? { reply_markup: replyMarkup } : {}),
        ...(mergedOptions?.replyTo ? { reply_parameters: { message_id: mergedOptions.replyTo } } : {}),
        ...(mergedOptions?.silent ? { disable_notification: true } : {}),
        ...(mergedOptions?.noPreview ? { link_preview_options: { is_disabled: true } } : {}),
      });
    } catch (error) {
      if (!parseAsHtml) {
        console.error("[gateway:telegram] plain send failed", { error });
        void emitGatewayOtel({
          level: "error",
          component: "telegram-channel",
          action: "telegram.send.failed",
          success: false,
          error: String(error),
          metadata: { chatId },
        });
        break;
      }

      // Fallback: send as plain text if HTML parsing fails
      console.warn("[gateway:telegram] HTML send failed, trying plain text", { error });
      void emitGatewayOtel({
        level: "warn",
        component: "telegram-channel",
        action: "telegram.send.html_failed",
        success: false,
        error: String(error),
        metadata: { chatId },
      });
      try {
        await bot.api.sendMessage(chatId, stripHtmlTags(text).slice(0, CHUNK_MAX), {
          ...(mergedOptions?.replyTo ? { reply_parameters: { message_id: mergedOptions.replyTo } } : {}),
          ...(mergedOptions?.silent ? { disable_notification: true } : {}),
          ...(isLast && replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
      } catch (fallbackError) {
        console.error("[gateway:telegram] send failed completely", { fallbackError });
        void emitGatewayOtel({
          level: "error",
          component: "telegram-channel",
          action: "telegram.send.failed",
          success: false,
          error: String(fallbackError),
          metadata: { chatId },
        });
      }
      break; // don't continue chunking if we had to fallback
    }
  }
  void emitGatewayOtel({
    level: "debug",
    component: "telegram-channel",
    action: "telegram.send.completed",
    success: true,
    duration_ms: Date.now() - sendStartedAt,
    metadata: {
      chatId,
      chunks: chunks.length,
      length: text.length,
    },
  });
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
    void emitGatewayOtel({
      level: "warn",
      component: "telegram-channel",
      action: "telegram.send_media.skipped",
      success: false,
      error: "bot_not_started",
    });
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
    void emitGatewayOtel({
      level: "info",
      component: "telegram-channel",
      action: "telegram.send_media.completed",
      success: true,
      metadata: { chatId, kind },
    });
  } catch (error) {
    console.error("[gateway:telegram] sendMedia failed, trying as document", { kind, error });
    void emitGatewayOtel({
      level: "error",
      component: "telegram-channel",
      action: "telegram.send_media.failed",
      success: false,
      error: String(error),
      metadata: { chatId, kind },
    });
    try {
      await bot.api.sendDocument(chatId, file, params);
    } catch (fallbackErr) {
      console.error("[gateway:telegram] sendMedia fallback failed", { fallbackErr });
      void emitGatewayOtel({
        level: "error",
        component: "telegram-channel",
        action: "telegram.send_media.fallback_failed",
        success: false,
        error: String(fallbackErr),
        metadata: { chatId, kind },
      });
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
  void emitGatewayOtel({
    level: "info",
    component: "telegram-channel",
    action: "telegram.channel.stopped",
    success: true,
  });
}
