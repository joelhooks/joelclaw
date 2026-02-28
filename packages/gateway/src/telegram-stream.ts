/**
 * Telegram progressive streaming — sends response text as it's generated,
 * using sendMessage + editMessageText with a cursor indicator.
 *
 * Lifecycle per turn:
 *   1. begin() — starts typing indicator loop (sendChatAction every 4s)
 *   2. pushDelta(text) — accumulates text, throttles edits (~800ms)
 *   3. onToolCall(name) — shows tool status in streaming message
 *   4. finish(buttons?) — final edit without cursor, returns true if streaming was active
 *   5. abort() — cancel without finalizing (e.g. on error)
 *
 * Handles 4096-char Telegram limit by splitting into multiple messages.
 */

import { TelegramConverter } from "@joelclaw/markdown-formatter";
import { emitGatewayOtel } from "@joelclaw/telemetry";
import type { Bot } from "grammy";

const converter = new TelegramConverter();

const TELEGRAM_MAX_CHARS = 4096;
const THROTTLE_MS = 800;
const TYPING_INTERVAL_MS = 4500; // sendChatAction expires after ~5s
const CURSOR = " ▌";

// Minimum text length before we send the first message.
// Avoids sending a tiny fragment that immediately gets edited.
const MIN_FIRST_SEND = 20;

export type TelegramStreamOptions = {
  chatId: number;
  bot: Bot;
  replyTo?: number;
};

type StreamState = {
  chatId: number;
  bot: Bot;
  replyTo?: number;

  // Typing indicator
  typingTimer: ReturnType<typeof setInterval> | undefined;

  // Message tracking
  messageId: number | undefined;
  sentMessageIds: number[]; // all messages sent during this stream
  fullText: string;
  lastEditedText: string;
  lastEditAt: number;

  // Throttle
  pendingEditTimer: ReturnType<typeof setTimeout> | undefined;

  // State
  started: boolean;
  finished: boolean;
  toolStatus: string | undefined;
  sendingInitial: boolean; // guards against duplicate initial sends
};

let activeStream: StreamState | undefined;

// Remember the last stream config so we can auto-restart for multi-message turns
let lastStreamConfig: TelegramStreamOptions | undefined;

/**
 * Start streaming for a new turn. Call this when a Telegram message
 * enters the drain loop (before session.prompt()).
 */
export function begin(options: TelegramStreamOptions): void {
  // Clean up any stale stream
  if (activeStream) {
    cleanup(activeStream);
  }

  const state: StreamState = {
    chatId: options.chatId,
    bot: options.bot,
    replyTo: options.replyTo,
    typingTimer: undefined,
    messageId: undefined,
    sentMessageIds: [],
    fullText: "",
    lastEditedText: "",
    lastEditAt: 0,
    pendingEditTimer: undefined,
    started: true,
    finished: false,
    toolStatus: undefined,
    sendingInitial: false,
  };

  // Start typing indicator loop immediately
  sendTyping(state);
  state.typingTimer = setInterval(() => sendTyping(state), TYPING_INTERVAL_MS);

  activeStream = state;
  lastStreamConfig = options;

  console.log("[telegram-stream] begin", { chatId: options.chatId });
}

/**
 * Push a text delta from the model. Accumulates and throttles edits.
 * If the previous stream was finished (multi-message turn), auto-restarts.
 */
export function pushDelta(delta: string): void {
  // Auto-restart for multi-message turns: previous message_end finished the stream
  // but turn isn't over — new text is coming from the next assistant message
  if (!activeStream && lastStreamConfig) {
    console.log("[telegram-stream] auto-restart for next message segment");
    begin(lastStreamConfig);
  }

  const state = activeStream;
  if (!state || state.finished) return;

  state.fullText += delta;
  // Clear tool status once real text is flowing
  state.toolStatus = undefined;

  scheduleEdit(state);
}

/**
 * Show a tool call status in the streaming message.
 */
export function onToolCall(toolName: string): void {
  const state = activeStream;
  if (!state || state.finished) return;

  // Friendly tool labels
  const labels: Record<string, string> = {
    bash: "🔧 running command…",
    read: "📖 reading file…",
    edit: "✏️ editing file…",
    write: "📝 writing file…",
    web_search: "🔍 searching…",
    mcp: "🔌 using tool…",
    recall: "🧠 searching memory…",
  };

  state.toolStatus = labels[toolName] ?? `🔧 ${toolName}…`;

  // Force an immediate edit to show the tool status
  flushEdit(state);
}

/**
 * Finalize the stream. Sends the last edit without cursor.
 * Returns true if streaming was active (caller should skip normal routeResponse).
 */
export async function finish(
  fullText?: string,
): Promise<boolean> {
  const state = activeStream;
  if (!state || !state.started) return false;

  state.finished = true;
  stopTyping(state);

  if (state.pendingEditTimer) {
    clearTimeout(state.pendingEditTimer);
    state.pendingEditTimer = undefined;
  }

  // Use provided fullText (from message_end) or accumulated text
  const finalText = fullText ?? state.fullText;
  if (!finalText.trim()) {
    cleanup(state);
    activeStream = undefined;
    return false;
  }

  // If we never sent an initial message, this wasn't really "streaming"
  // (e.g. very short response) — let the normal send path handle it
  if (!state.messageId) {
    cleanup(state);
    activeStream = undefined;
    return false;
  }

  // Final edit without cursor — convert to HTML
  try {
    const html = toHtml(finalText);
    const displayText = truncateForTelegram(html);
    await state.bot.api.editMessageText(
      state.chatId,
      state.messageId,
      displayText,
      { parse_mode: "HTML" as const },
    );
    console.log("[telegram-stream] finalized", {
      chatId: state.chatId,
      messageId: state.messageId,
      textLength: finalText.length,
      messageCount: state.sentMessageIds.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("message is not modified")) {
      console.warn("[telegram-stream] final edit failed", { error: msg });
    }
  }

  // If the HTML exceeded one message, send remaining chunks
  const html = toHtml(finalText);
  if (html.length > TELEGRAM_MAX_CHARS) {
    const chunks = converter.chunk(finalText);
    // First chunk was already sent via editMessageText above, send the rest
    if (chunks.length > 1) {
      await sendOverflowHtmlChunks(state, chunks.slice(1));
    }
  }

  void emitGatewayOtel({
    level: "info",
    component: "telegram-stream",
    action: "telegram.stream.completed",
    success: true,
    metadata: {
      chatId: state.chatId,
      totalLength: finalText.length,
      messageCount: state.sentMessageIds.length,
      durationMs: Date.now() - state.lastEditAt,
    },
  });

  cleanup(state);
  activeStream = undefined;
  return true;
}

/**
 * Signal that the turn has ended. Clears auto-restart config.
 * Call this on turn_end events.
 */
export function turnEnd(): void {
  lastStreamConfig = undefined;
  // If somehow still active, abort
  if (activeStream && !activeStream.finished) {
    abort();
  }
}

/**
 * Abort streaming without finalizing (e.g. on API error).
 */
export function abort(): void {
  const state = activeStream;
  if (!state) return;

  state.finished = true;
  stopTyping(state);
  cleanup(state);
  activeStream = undefined;

  console.log("[telegram-stream] aborted", { chatId: state?.chatId });
}

/**
 * Check if streaming is currently active for a Telegram source.
 */
export function isActive(): boolean {
  return activeStream !== undefined && activeStream.started && !activeStream.finished;
}

/**
 * Get the chat ID of the active stream (for source matching).
 */
export function getActiveChatId(): number | undefined {
  return activeStream?.chatId;
}

// ── Internal helpers ───────────────────────────────────

function sendTyping(state: StreamState): void {
  state.bot.api.sendChatAction(state.chatId, "typing").catch(() => {
    // non-critical
  });
}

function stopTyping(state: StreamState): void {
  if (state.typingTimer) {
    clearInterval(state.typingTimer);
    state.typingTimer = undefined;
  }
}

function truncateForTelegram(text: string): string {
  if (text.length <= TELEGRAM_MAX_CHARS) return text;
  return text.slice(0, TELEGRAM_MAX_CHARS - 4) + " …";
}

function toHtml(markdown: string): string {
  try {
    return converter.convert(markdown);
  } catch {
    // If conversion fails, return escaped plain text
    return markdown.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

/**
 * Build display text for streaming updates.
 * Sends PLAIN TEXT (no parse_mode, no HTML) during streaming to avoid:
 * - markdown→HTML conversion overhead on every throttled edit
 * - broken HTML tags when truncating for the 4096 char limit
 * - HTML escaping issues with partial content (<, >, & in code blocks)
 *
 * The final message gets full HTML formatting via finish().
 */
function buildDisplayText(state: StreamState): string {
  let text = state.fullText;

  // Append tool status on a new line if active
  if (state.toolStatus && text.length > 0) {
    text = text + "\n\n" + state.toolStatus;
  }

  // Add cursor
  text = text + CURSOR;

  // Plain text truncation — no HTML tags to worry about
  return truncateForTelegram(text);
}

function scheduleEdit(state: StreamState): void {
  // Already have a pending edit scheduled
  if (state.pendingEditTimer) return;

  const elapsed = Date.now() - state.lastEditAt;
  if (elapsed >= THROTTLE_MS) {
    // Enough time has passed, edit now
    flushEdit(state);
  } else {
    // Schedule for the remaining time
    const remaining = THROTTLE_MS - elapsed;
    state.pendingEditTimer = setTimeout(() => {
      state.pendingEditTimer = undefined;
      if (!state.finished) {
        flushEdit(state);
      }
    }, remaining);
  }
}

function flushEdit(state: StreamState): void {
  if (state.finished) return;

  const displayText = buildDisplayText(state);

  // Skip if nothing changed
  if (displayText === state.lastEditedText) return;

  state.lastEditedText = displayText;
  state.lastEditAt = Date.now();

  if (!state.messageId) {
    // First message — only send if we have enough text
    if (state.fullText.length < MIN_FIRST_SEND && !state.toolStatus) return;

    // Guard against duplicate initial sends (async race)
    if (state.sendingInitial) return;
    state.sendingInitial = true;

    // Stop typing indicator once we start showing text
    stopTyping(state);

    // Send plain text — no parse_mode during streaming
    state.bot.api
      .sendMessage(state.chatId, displayText, {
        ...(state.replyTo ? { reply_parameters: { message_id: state.replyTo } } : {}),
      })
      .then((msg) => {
        state.messageId = msg.message_id;
        state.sentMessageIds.push(msg.message_id);
      })
      .catch((err) => {
        console.warn("[telegram-stream] initial send failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        // Allow retry on failure
        state.sendingInitial = false;
      });
  } else {
    // Edit existing message — plain text, no parse_mode during streaming
    state.bot.api
      .editMessageText(state.chatId, state.messageId, displayText)
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("message is not modified")) return;
        // Rate limit — back off
        if (msg.includes("Too Many Requests") || msg.includes("429")) {
          console.warn("[telegram-stream] rate limited, backing off");
          return;
        }
        console.warn("[telegram-stream] edit failed", { error: msg });
      });
  }
}

async function sendOverflowHtmlChunks(
  state: StreamState,
  chunks: string[],
): Promise<void> {
  for (const chunk of chunks) {
    try {
      const msg = await state.bot.api.sendMessage(state.chatId, chunk, {
        parse_mode: "HTML" as const,
      });
      state.sentMessageIds.push(msg.message_id);
    } catch (err) {
      console.warn("[telegram-stream] overflow chunk failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }
  }
}

function cleanup(state: StreamState): void {
  stopTyping(state);
  if (state.pendingEditTimer) {
    clearTimeout(state.pendingEditTimer);
    state.pendingEditTimer = undefined;
  }
}
