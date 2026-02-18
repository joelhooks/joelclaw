import { Bot } from "grammy";
import type { EnqueueFn } from "./redis";

// ── Telegram HTML formatting ───────────────────────────
// Telegram's HTML mode supports: <b>, <i>, <code>, <pre>, <a href="">
// Max message length: 4096 chars. We chunk at 4000 to leave room.
const CHUNK_MAX = 4000;

/**
 * Convert basic markdown to Telegram HTML.
 * Handles: **bold**, `code`, ```pre```, [link](url), *italic*
 */
function mdToTelegramHtml(md: string): string {
  let html = md;

  // Code blocks first (``` ... ```)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
    return `<pre>${escapeHtml(code.trim())}</pre>`;
  });

  // Inline code (`...`)
  html = html.replace(/`([^`]+)`/g, (_match, code) => {
    return `<code>${escapeHtml(code)}</code>`;
  });

  // Bold (**...**)
  html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Italic (*...*)  — but not inside <b> tags
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<i>$1</i>");

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  return html;
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

  // Photo messages → describe what was sent
  bot.on("message:photo", (ctx) => {
    const caption = ctx.message.caption ?? "";
    const chatId = ctx.chat.id;

    enqueuePrompt!(`telegram:${chatId}`, `[User sent a photo${caption ? `: ${caption}` : ""}]`, {
      telegramChatId: chatId,
    });
  });

  // Voice messages → note for now (future: whisper transcription)
  bot.on("message:voice", (ctx) => {
    const chatId = ctx.chat.id;

    enqueuePrompt!(`telegram:${chatId}`, "[User sent a voice message — voice transcription not yet supported]", {
      telegramChatId: chatId,
    });
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
 * Send a message back to a Telegram chat.
 * Handles markdown→HTML conversion and chunking.
 */
export async function send(
  chatId: number,
  message: string,
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
      await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" });
    } catch (error) {
      // Fallback: send as plain text if HTML parsing fails
      console.warn("[gateway:telegram] HTML send failed, trying plain text", { error });
      try {
        await bot.api.sendMessage(chatId, message.slice(0, CHUNK_MAX));
      } catch (fallbackError) {
        console.error("[gateway:telegram] send failed completely", { fallbackError });
      }
      break; // don't continue chunking if we had to fallback
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
