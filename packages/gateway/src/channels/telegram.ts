import { execSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdir } from "node:fs/promises";
import { extname } from "node:path";
import type { FormatConverter } from "@joelclaw/markdown-formatter";
import { escapeText, TelegramConverter } from "@joelclaw/markdown-formatter";
import {
  type ChannelAuditSeed,
  type ChannelDeliveryAudit,
  createChannelDeliveryAudit,
  emitGatewayOtel,
  summarizeChannelError,
} from "@joelclaw/telemetry";
import { enrichPromptWithVaultContext } from "@joelclaw/vault-reader";
import { Bot, InputFile } from "grammy";
import Redis from "ioredis";
import {
  acknowledgeCallbackTrace,
  applyExternalOperatorTraceResult,
  completeCallbackTrace,
  failCallbackTrace,
  markCallbackTraceDispatched,
  startCallbackTrace,
} from "../callback-trace";
import { tapTelegramUpdate } from "../chat-sdk-inbound/taps";
import { loadGatewayInngestEventConfig } from "../lib/inngest-event";
import {
  journalMessage,
  rememberTelegramMessageFlow,
  resolveTelegramMessageFlow,
} from "../message-journal";
import type { OutboundEnvelope } from "../outbound/envelope";
import {
  normalizeTelegramBulletLines,
  prepareTelegramMarkdown,
} from "../telegram-markdown";
import {
  routeTelegramOutbound,
  type TelegramOutboundPolicyContext,
  type TelegramOutboundRoute,
} from "../telegram-outbound-policy";
import type { EnqueueFn } from "./redis";
import type {
  Channel,
  ChannelPlatform,
  InboundMessage,
  MessageHandler,
  SendMediaPayload,
  SendOptions,
} from "./types";

// ── Telegram formatting ────────────────────────────────
// Explicit HTML and streaming retain the legacy converter. Default/markdown
// envelopes use the Chat SDK's MarkdownV2 converter via telegram-markdown.ts.
const telegramConverter: FormatConverter = new TelegramConverter();
const CHUNK_MAX = telegramConverter.maxLength;

type TelegramFormattedOutput = {
  text: string;
  plainText: string;
  parseMode?: "HTML" | "MarkdownV2";
  fallbackReason?: "conversion_failed" | "message_too_long";
};

// ── Media download (ADR-0042) ──────────────────────────
const MEDIA_DIR = "/tmp/joelclaw-media";
const MAX_DOWNLOAD_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const TELEGRAM_POLL_RETRY_BASE_MS = 5_000;
const TELEGRAM_POLL_RETRY_MAX_MS = 60_000;
const TELEGRAM_POLL_LEASE_ENABLED = process.env.TELEGRAM_POLL_LEASE_ENABLED !== "0";
const TELEGRAM_POLL_LEASE_TTL_MS = 30_000;
const TELEGRAM_POLL_LEASE_RENEW_MS = 10_000;
const TELEGRAM_POLL_LEASE_RETRY_BASE_MS = 5_000;
const TELEGRAM_POLL_LEASE_RETRY_MAX_MS = 60_000;
const TELEGRAM_POLL_STATUS_TTL_MS = 2 * 60_000;

let _botToken: string | undefined;

// ADR-0209: Callback to record outbound message IDs for thread tracking
let _onOutboundMessageId: ((messageId: number) => void) | undefined;

export function setOutboundMessageIdCallback(cb: (messageId: number) => void): void {
  _onOutboundMessageId = cb;
}

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
  audit?: ChannelAuditSeed;
  outboundPolicy?: TelegramOutboundPolicyContext;
}

export type TelegramDeliveryReceipt =
  | {
      status: "confirmed";
      audit: ChannelDeliveryAudit;
      telegramMessageIds: number[];
      usedFallback: boolean;
    }
  | {
      status: "routed";
      audit: ChannelDeliveryAudit;
      telegramMessageIds: [];
      usedFallback: false;
      policy: TelegramOutboundRoute;
    };

export type TelegramStartOptions = {
  configureBot?: (bot: Bot) => void | Promise<void>;
  abortCurrentTurn?: () => Promise<void>;
}

type PollLeaseState = "owner" | "passive" | "fallback" | "stopped";

type PollLeaseStatus = {
  state: PollLeaseState;
  instanceId: string;
  ownerId?: string;
  tokenHash?: string;
  updatedAt: string;
  reason?: string;
  attempt?: number;
  retryDelayMs?: number;
};

function resolveSendInput(
  message: string | OutboundEnvelope,
  options?: RichSendOptions,
): { text: string; options?: RichSendOptions; format?: OutboundEnvelope["format"] } {
  if (typeof message === "string") {
    return { text: message, options };
  }

  // ADR-0209: Coerce string anchor to number for Telegram API
  const resolvedReplyTo = message.replyTo !== undefined
    ? (typeof message.replyTo === "string" ? Number.parseInt(message.replyTo, 10) : message.replyTo)
    : undefined;

  const mergedOptions: RichSendOptions = {
    ...(resolvedReplyTo !== undefined && !Number.isNaN(resolvedReplyTo) ? { replyTo: resolvedReplyTo } : {}),
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

function formatByEnvelope(
  text: string,
  format: OutboundEnvelope["format"] | undefined,
): TelegramFormattedOutput {
  if (format === "plain") {
    const plainText = normalizeTelegramBulletLines(text);
    return {
      text: plainText,
      plainText,
    };
  }

  if (format === "html") {
    const validation = telegramConverter.validate(text);
    if (!validation.valid) {
      console.warn("[telegram] HTML formatter validation failed, falling back to plain:", validation.errors);
      const plainText = stripHtmlTags(text);
      return {
        text: plainText,
        plainText,
        fallbackReason: "conversion_failed",
      };
    }
    return {
      text,
      plainText: stripHtmlTags(text),
      parseMode: "HTML",
    };
  }

  const prepared = prepareTelegramMarkdown(text);
  if (!prepared.ok) {
    console.warn("[telegram] MarkdownV2 conversion failed, falling back to plain:", prepared.error);
    return {
      text: prepared.plainText,
      plainText: prepared.plainText,
      fallbackReason: "conversion_failed",
    };
  }
  if (prepared.markdownV2.length > CHUNK_MAX) {
    console.warn("[telegram] MarkdownV2 message exceeds safe chunk size, falling back to plain");
    return {
      text: prepared.plainText,
      plainText: prepared.plainText,
      fallbackReason: "message_too_long",
    };
  }

  return {
    text: prepared.markdownV2,
    plainText: prepared.plainText,
    parseMode: "MarkdownV2",
  };
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

function isDefinitiveTelegramRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as Record<string, unknown>).error_code;
  return code === 400 || code === "400";
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

async function sendCallbackTimeoutMessage(chatId: number, route: string, traceId: string): Promise<void> {
  await sendTelegramMessage(chatId, {
    text: [
      "⚠️ <b>Callback timed out</b>",
      `Route: <code>${escapeText(route)}</code>`,
      `Trace: <code>${escapeText(traceId)}</code>`,
    ].join("\n"),
    format: "html",
  }, {
    audit: {
      flowId: traceId,
      producer: "telegram-callback-timeout",
      route,
    },
  });
}

async function sendCallbackFailureMessage(chatId: number, route: string, traceId: string, error: string): Promise<void> {
  await sendTelegramMessage(chatId, {
    text: [
      "❌ <b>Callback failed</b>",
      `Route: <code>${escapeText(route)}</code>`,
      `Trace: <code>${escapeText(traceId)}</code>`,
      `Error: <code>${escapeText(error)}</code>`,
    ].join("\n"),
    format: "html",
  }, {
    audit: {
      flowId: traceId,
      producer: "telegram-callback-failure",
      route,
    },
  });
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

function mediaKindFromMimeType(mimeType: string, path?: string): "photo" | "video" | "audio" | "document" {
  if (mimeType.startsWith("image/")) return "photo";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (path) return mediaKindFromExt(extname(path));
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
  const config = loadGatewayInngestEventConfig();
  if (!config) {
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

    const res = await fetch(config.eventApi, {
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
let pollingActive = false;
let pollingStarting = false;
let pollRetryTimer: ReturnType<typeof setTimeout> | undefined;
let pollRetryAttempts = 0;
let pollConflictStreak = 0;

// ── Callback routing (ADR-0215) ──────────────────────────────────
// External services register prefixes in Redis hash. Matching callbacks
// are published to a Redis channel instead of firing Inngest events.
const CALLBACK_ROUTES_KEY = "joelclaw:telegram:callback-routes";
const CALLBACK_TRACE_EVENTS_CHANNEL = "joelclaw:telegram:callback-trace-events";
const EXTERNAL_CALLBACK_TRACE_TIMEOUT_MS = 120_000;

type CallbackTraceResultEvent = {
  traceId: string;
  status: "completed" | "failed";
  detail?: string | null;
  error?: string | null;
  source?: string | null;
  route?: string | null;
};

/**
 * Load registered callback routes from Redis.
 * Hash: prefix → Redis pub/sub channel name.
 * Returns an array sorted longest-prefix-first for greedy matching.
 */
async function loadCallbackRoutes(
  redis: Redis | undefined,
): Promise<Array<{ prefix: string; channel: string }>> {
  if (!redis) return [];
  try {
    const hash = await redis.hgetall(CALLBACK_ROUTES_KEY);
    return Object.entries(hash)
      .map(([prefix, channel]) => ({ prefix, channel }))
      .sort((a, b) => b.prefix.length - a.prefix.length);
  } catch {
    return [];
  }
}

function createCallbackTraceSubscriber(): Redis {
  return new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
    lazyConnect: true,
    maxRetriesPerRequest: null,
    retryStrategy: (times: number) => Math.min(times * 500, 30_000),
  });
}

async function handleCallbackTraceResult(message: string): Promise<void> {
  let parsed: CallbackTraceResultEvent;
  try {
    parsed = JSON.parse(message) as CallbackTraceResultEvent;
  } catch (error) {
    console.warn("[gateway:telegram] invalid callback trace result payload", { error: String(error) });
    void emitGatewayOtel({
      level: "warn",
      component: "telegram-channel",
      action: "telegram.callback.trace_result.invalid",
      success: false,
      error: String(error),
    });
    return;
  }

  if (!parsed || typeof parsed.traceId !== "string" || (parsed.status !== "completed" && parsed.status !== "failed")) {
    console.warn("[gateway:telegram] callback trace result missing required fields", { parsed });
    void emitGatewayOtel({
      level: "warn",
      component: "telegram-channel",
      action: "telegram.callback.trace_result.invalid",
      success: false,
      error: "missing_required_fields",
      metadata: {
        hasTraceId: typeof parsed?.traceId === "string",
        status: parsed?.status ?? null,
      },
    });
    return;
  }

  const applied = applyExternalOperatorTraceResult({
    traceId: parsed.traceId,
    status: parsed.status,
    detail: typeof parsed.detail === "string" ? parsed.detail : undefined,
    error: typeof parsed.error === "string" ? parsed.error : undefined,
  });

  void emitGatewayOtel({
    level: applied ? (parsed.status === "failed" ? "warn" : "info") : "info",
    component: "telegram-channel",
    action: applied ? "telegram.callback.trace_result.applied" : "telegram.callback.trace_result.ignored",
    success: applied && parsed.status === "completed",
    ...(parsed.status === "failed" && typeof parsed.error === "string" ? { error: parsed.error } : {}),
    metadata: {
      traceId: parsed.traceId,
      status: parsed.status,
      route: parsed.route ?? null,
      source: parsed.source ?? null,
      applied,
    },
  });
}

async function ensureCallbackTraceSubscriber(): Promise<void> {
  if (callbackTraceSubscriber && callbackTraceSubscriber.status !== "end") {
    return;
  }

  const subscriber = createCallbackTraceSubscriber();
  subscriber.on("error", () => {});
  await subscriber.connect();
  await subscriber.subscribe(CALLBACK_TRACE_EVENTS_CHANNEL);
  subscriber.on("message", (_channel, message) => {
    void handleCallbackTraceResult(message);
  });
  callbackTraceSubscriber = subscriber;
}

async function closeCallbackTraceSubscriber(): Promise<void> {
  if (!callbackTraceSubscriber) return;
  try {
    await callbackTraceSubscriber.unsubscribe(CALLBACK_TRACE_EVENTS_CHANNEL);
    await callbackTraceSubscriber.quit();
  } catch {
    callbackTraceSubscriber.disconnect();
  } finally {
    callbackTraceSubscriber = undefined;
  }
}

let callbackRoutes: Array<{ prefix: string; channel: string }> = [];
let callbackTraceSubscriber: Redis | undefined;

const pollLeaseInstanceId = crypto.randomUUID();
let pollLeaseClient: Redis | undefined;
let pollLeaseOwned = false;
let pollLeaseOwnerKey: string | undefined;
let pollLeaseStatusKey: string | undefined;
let pollLeaseTokenHash: string | undefined;
let pollLeaseRenewTimer: ReturnType<typeof setInterval> | undefined;
let pollLeaseRetryTimer: ReturnType<typeof setTimeout> | undefined;
let pollLeaseRetryAttempts = 0;
let lastPollLeaseStatus: PollLeaseStatus | null = null;

export type TelegramRuntimeState = {
  configured: boolean;
  started: boolean;
  pollingActive: boolean;
  pollingStarting: boolean;
  pollRetryAttempts: number;
  pollConflictStreak: number;
  pollLeaseEnabled: boolean;
  pollLeaseOwned: boolean;
  pollLeaseState: PollLeaseState;
  pollLeaseStatus: PollLeaseStatus | null;
};

/** Expose the raw grammy Bot instance for streaming (telegram-stream.ts). */
export function getBot(): Bot | undefined {
  return bot;
}

export function getRuntimeState(): TelegramRuntimeState {
  const pollLeaseState = lastPollLeaseStatus?.state
    ?? (started
      ? (pollLeaseOwned ? "owner" : TELEGRAM_POLL_LEASE_ENABLED ? "passive" : "fallback")
      : "stopped");

  return {
    configured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_USER_ID),
    started,
    pollingActive,
    pollingStarting,
    pollRetryAttempts,
    pollConflictStreak,
    pollLeaseEnabled: TELEGRAM_POLL_LEASE_ENABLED,
    pollLeaseOwned,
    pollLeaseState,
    pollLeaseStatus: lastPollLeaseStatus,
  };
}
let defaultInstance: TelegramChannel | undefined;
let inboundMessageHandler: MessageHandler | undefined;

function getDefaultTelegramChannel(): TelegramChannel {
  if (!defaultInstance) {
    defaultInstance = new TelegramChannel();
  }
  return defaultInstance;
}

function emitInboundMessage(message: InboundMessage): void {
  if (!inboundMessageHandler) return;
  void Promise.resolve(inboundMessageHandler(message))
    .catch((error) => {
      console.error("[gateway:telegram] inbound message handler failed", { error: String(error) });
    });
}

async function journalInboundText(input: {
  text: string;
  chatId: number;
  messageId: number;
  updateId: number;
  receivedAt: number;
  audit: ChannelDeliveryAudit;
}): Promise<void> {
  await journalMessage({
    messageKey: `telegram:${input.chatId}:${input.messageId}`,
    flowId: input.audit.flowId,
    direction: "inbound",
    eventType: "message.received",
    producer: input.audit.producer,
    originSystemId: input.audit.originSystemId,
    sourceRef: "telegram.message.text",
    route: input.audit.route,
    telegramChatId: input.chatId,
    telegramMessageId: input.messageId,
    telegramUpdateId: input.updateId,
    inReplyToMessageId: input.audit.inReplyToMessageId,
    occurredAt: new Date(input.receivedAt),
    text: input.text,
    transportText: input.text,
    deliveryState: "received",
  });
  await rememberTelegramMessageFlow(input.chatId, input.messageId, input.audit.flowId);
}

function resolveTargetChatId(target: string): number | undefined {
  const trimmed = target.trim();
  const fromSource = parseChatId(target);
  if (fromSource !== undefined) return fromSource;
  if (/^-?\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  return undefined;
}

function convertButtonsFromSendOptions(buttons?: SendOptions["buttons"]): InlineButton[][] | undefined {
  if (!buttons) return undefined;
  return buttons.map((button) => [{
    text: button.text,
    ...(button.url ? { url: button.url } : { action: button.callbackData }),
  }]);
}

function mapOutboundFromSendOptions(target: string, text: string, options?: SendOptions): {
  targetId?: number;
  message: string | OutboundEnvelope;
  options?: RichSendOptions;
} {
  const resolvedTarget = resolveTargetChatId(target);
  if (resolvedTarget === undefined) {
    return { message: text };
  }

  const replyTo = options?.replyTo;
  const hasValidReplyTo = typeof replyTo === "string" && /^-?\d+$/.test(replyTo.trim());
  const mappedButtons = convertButtonsFromSendOptions(options?.buttons);

  const richOptions: RichSendOptions = {
    ...(hasValidReplyTo ? { replyTo: Number.parseInt(replyTo, 10) } : {}),
    ...(mappedButtons ? { buttons: mappedButtons } : {}),
    ...(options?.silent !== undefined ? { silent: options.silent } : {}),
    ...(options?.noPreview !== undefined ? { noPreview: options.noPreview } : {}),
    ...(options?.audit ? { audit: options.audit } : {}),
    ...(options?.outboundPolicy ? { outboundPolicy: options.outboundPolicy } : {}),
  };

  const payload = options?.format ? { text, format: options.format } : text;
  return { targetId: resolvedTarget, message: payload, options: richOptions };
}

export class TelegramChannel implements Channel {
  readonly platform: ChannelPlatform = "telegram";

  async start(..._args: unknown[]): Promise<void> {
    const [token, userId, enqueue, options] = _args;
    await startTelegramChannel(
      token as string,
      userId as number,
      enqueue as EnqueueFn,
      options as TelegramStartOptions | undefined,
    );
  }

  async stop(): Promise<void> {
    await shutdownTelegramChannel();
  }

  async send(target: string, text: string, options?: SendOptions): Promise<void> {
    const resolved = mapOutboundFromSendOptions(target, text, options);
    if (resolved.targetId === undefined) {
      console.error("[gateway:telegram] cannot send telegram message: invalid target", { target });
      return;
    }
    await sendTelegramMessage(resolved.targetId, resolved.message, resolved.options);
  }

  onMessage(handler: MessageHandler): void {
    inboundMessageHandler = handler;
  }

  async sendWithLegacy(
    target: string,
    message: string | OutboundEnvelope,
    options?: RichSendOptions,
  ): Promise<TelegramDeliveryReceipt> {
    const chatId = resolveTargetChatId(target);
    if (chatId === undefined) {
      console.error("[gateway:telegram] cannot send telegram message: invalid target", { target });
      throw new Error("invalid_telegram_target");
    }
    const resolved = resolveSendInput(message, options);
    const payload = resolved.format ? { text: resolved.text, format: resolved.format } : resolved.text;
    return sendTelegramMessage(chatId, payload, resolved.options);
  }

  async sendMedia(target: string, media: SendMediaPayload, options?: SendOptions): Promise<void> {
    const chatId = resolveTargetChatId(target);
    if (chatId === undefined) {
      console.error("[gateway:telegram] cannot send telegram media: invalid target", { target });
      return;
    }

    const replyTo = options?.replyTo && /^-?\d+$/.test(options.replyTo.trim())
      ? Number.parseInt(options.replyTo, 10)
      : undefined;

    await sendTelegramMedia(chatId, media, {
      replyTo,
      audit: options?.audit,
      outboundPolicy: options?.outboundPolicy,
    });
  }
}

function clearPollRetryTimer(): void {
  if (pollRetryTimer) {
    clearTimeout(pollRetryTimer);
    pollRetryTimer = undefined;
  }
}

function clearPollLeaseRetryTimer(): void {
  if (pollLeaseRetryTimer) {
    clearTimeout(pollLeaseRetryTimer);
    pollLeaseRetryTimer = undefined;
  }
}

function clearPollLeaseRenewTimer(): void {
  if (pollLeaseRenewTimer) {
    clearInterval(pollLeaseRenewTimer);
    pollLeaseRenewTimer = undefined;
  }
}

function unrefTimer(timer: unknown): void {
  if (!timer || typeof timer !== "object" || !("unref" in timer)) return;
  (timer as NodeJS.Timeout).unref();
}

function isGetUpdatesConflict(errorText: string): boolean {
  const normalized = errorText.toLowerCase();
  return normalized.includes("getupdates") && normalized.includes("409");
}

function nextPollRetryDelayMs(attempt: number): number {
  const exp = Math.max(0, Math.min(attempt, 8));
  return Math.min(TELEGRAM_POLL_RETRY_BASE_MS * 2 ** exp, TELEGRAM_POLL_RETRY_MAX_MS);
}

function nextPollLeaseRetryDelayMs(attempt: number): number {
  const exp = Math.max(0, Math.min(attempt, 8));
  return Math.min(TELEGRAM_POLL_LEASE_RETRY_BASE_MS * 2 ** exp, TELEGRAM_POLL_LEASE_RETRY_MAX_MS);
}

function stableTokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function stopPolling(): void {
  clearPollRetryTimer();
  pollRetryAttempts = 0;
  pollConflictStreak = 0;

  if (bot && (pollingActive || pollingStarting)) {
    try {
      bot.stop();
    } catch {
      // best-effort
    }
  }

  pollingStarting = false;
  pollingActive = false;
}

async function ensurePollLeaseClient(): Promise<Redis | undefined> {
  if (!TELEGRAM_POLL_LEASE_ENABLED) return undefined;
  if (pollLeaseClient && pollLeaseClient.status !== "end") {
    return pollLeaseClient;
  }

  const client = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number.parseInt(process.env.REDIS_PORT ?? "6379", 10),
    lazyConnect: true,
    maxRetriesPerRequest: null,
    retryStrategy: (times: number) => Math.min(times * 500, 30_000),
  });

  client.on("error", (error) => {
    console.warn("[gateway:telegram] poll lease redis error", { error: String(error) });
  });

  try {
    await client.connect();
    pollLeaseClient = client;
    return pollLeaseClient;
  } catch (error) {
    client.disconnect();
    console.warn("[gateway:telegram] poll lease redis unavailable", { error: String(error) });
    void emitGatewayOtel({
      level: "warn",
      component: "telegram-channel",
      action: "telegram.channel.poll_owner.redis_unavailable",
      success: false,
      error: String(error),
    });
    return undefined;
  }
}

async function closePollLeaseClient(): Promise<void> {
  if (!pollLeaseClient) return;
  try {
    await pollLeaseClient.quit();
  } catch {
    pollLeaseClient.disconnect();
  } finally {
    pollLeaseClient = undefined;
  }
}

async function writePollLeaseStatus(
  state: PollLeaseState,
  detail?: Partial<Omit<PollLeaseStatus, "state" | "instanceId" | "updatedAt">>,
): Promise<void> {
  const status: PollLeaseStatus = {
    state,
    instanceId: pollLeaseInstanceId,
    updatedAt: new Date().toISOString(),
    ...(pollLeaseTokenHash ? { tokenHash: pollLeaseTokenHash } : {}),
    ...(detail ?? {}),
  };
  lastPollLeaseStatus = status;

  const client = await ensurePollLeaseClient();
  if (!client || !pollLeaseStatusKey) return;

  try {
    await client.set(pollLeaseStatusKey, JSON.stringify(status), "PX", TELEGRAM_POLL_STATUS_TTL_MS);
  } catch (error) {
    console.warn("[gateway:telegram] failed to write poll lease status", { error: String(error), state });
  }
}

async function acquirePollLease(): Promise<{ acquired: boolean; ownerId?: string; fallback: boolean }> {
  if (!TELEGRAM_POLL_LEASE_ENABLED) {
    return { acquired: true, ownerId: pollLeaseInstanceId, fallback: true };
  }

  const client = await ensurePollLeaseClient();
  if (!client || !pollLeaseOwnerKey) {
    return { acquired: true, ownerId: pollLeaseInstanceId, fallback: true };
  }

  try {
    const setResult = await client.set(
      pollLeaseOwnerKey,
      pollLeaseInstanceId,
      "PX",
      TELEGRAM_POLL_LEASE_TTL_MS,
      "NX",
    );

    if (setResult === "OK") {
      pollLeaseOwned = true;
      return { acquired: true, ownerId: pollLeaseInstanceId, fallback: false };
    }

    const ownerId = await client.get(pollLeaseOwnerKey) ?? undefined;
    if (ownerId === pollLeaseInstanceId) {
      pollLeaseOwned = true;
      await client.pexpire(pollLeaseOwnerKey, TELEGRAM_POLL_LEASE_TTL_MS);
      return { acquired: true, ownerId, fallback: false };
    }

    pollLeaseOwned = false;
    return { acquired: false, ownerId, fallback: false };
  } catch (error) {
    console.warn("[gateway:telegram] poll lease acquisition failed; falling back to direct polling", {
      error: String(error),
    });
    void emitGatewayOtel({
      level: "warn",
      component: "telegram-channel",
      action: "telegram.channel.poll_owner.acquire_failed",
      success: false,
      error: String(error),
    });
    return { acquired: true, ownerId: pollLeaseInstanceId, fallback: true };
  }
}

async function renewPollLease(): Promise<boolean> {
  if (!TELEGRAM_POLL_LEASE_ENABLED || !pollLeaseOwned) return true;
  const client = await ensurePollLeaseClient();
  if (!client || !pollLeaseOwnerKey) return false;

  try {
    const renewed = await client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
      1,
      pollLeaseOwnerKey,
      pollLeaseInstanceId,
      String(TELEGRAM_POLL_LEASE_TTL_MS),
    );
    return Number(renewed) === 1;
  } catch (error) {
    console.warn("[gateway:telegram] poll lease renewal failed", { error: String(error) });
    void emitGatewayOtel({
      level: "warn",
      component: "telegram-channel",
      action: "telegram.channel.poll_owner.renew_failed",
      success: false,
      error: String(error),
    });
    return false;
  }
}

async function releasePollLease(): Promise<void> {
  if (!TELEGRAM_POLL_LEASE_ENABLED || !pollLeaseOwned) return;
  const client = await ensurePollLeaseClient();
  if (!client || !pollLeaseOwnerKey) return;

  try {
    await client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      pollLeaseOwnerKey,
      pollLeaseInstanceId,
    );
  } catch (error) {
    console.warn("[gateway:telegram] poll lease release failed", { error: String(error) });
  } finally {
    pollLeaseOwned = false;
  }
}

async function startTelegramChannel(
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
    tapTelegramUpdate(ctx.update, allowedUserId, bot?.botInfo?.id);
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

  // /stop|/esc — abort current turn without killing the daemon
  const handleAbortCommand = async (ctx: any, command: "stop" | "esc") => {
    const chatId = ctx.chat.id;

    if (!options?.abortCurrentTurn) {
      void emitGatewayOtel({
        level: "warn",
        component: "telegram-channel",
        action: "telegram.command.stop_unavailable",
        success: false,
        metadata: { chatId, command },
      });
      await ctx.reply("⚠️ Stop is unavailable in this gateway build.");
      return;
    }

    try {
      await options.abortCurrentTurn();
      void emitGatewayOtel({
        level: "info",
        component: "telegram-channel",
        action: "telegram.command.stop",
        success: true,
        metadata: { chatId, command },
      });
      await ctx.reply("🛑 Stopped current operation.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[gateway:telegram] /${command} failed`, { error: message });
      void emitGatewayOtel({
        level: "error",
        component: "telegram-channel",
        action: "telegram.command.stop_failed",
        success: false,
        error: message,
        metadata: { chatId, command },
      });
      await ctx.reply(`❌ Stop failed: ${message}`);
    }
  };

  bot.command("stop", async (ctx) => {
    await handleAbortCommand(ctx, "stop");
  });

  bot.command("esc", async (ctx) => {
    await handleAbortCommand(ctx, "esc");
  });

  // /kill — hard stop: disable launchd + kill process
  bot.command("kill", async (ctx) => {
    const chatId = ctx.chat.id;
    console.warn("[gateway:telegram] /kill command received — hard stopping");
    void emitGatewayOtel({
      level: "warn",
      component: "telegram-channel",
      action: "telegram.command.kill",
      success: true,
      metadata: { chatId },
    });
    try {
      await ctx.reply("🛑 Gateway hard stopping. launchd disabled — won't restart.");
    } catch { /* best-effort */ }
    try {
      const uid = process.getuid?.() ?? 501;
      execSync(`launchctl disable gui/${uid}/com.joel.gateway`, { timeout: 3000 });
    } catch (err) {
      console.error("[gateway:telegram] launchctl disable failed", { err });
    }
    process.kill(process.pid, "SIGKILL");
  });

  // Text messages → command queue
  bot.on("message:text", async (ctx) => {
    const receivedAt = Date.now();
    const text = ctx.message.text;
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;
    const audit = createChannelDeliveryAudit(text, {
      flowId: `telegram-inbound:${chatId}:${messageId}`,
      producer: "telegram-user",
      requestedAtMs: receivedAt,
      route: `telegram:${chatId}`,
      inReplyToMessageId: ctx.message.reply_to_message?.message_id,
    }, receivedAt);

    console.log("[gateway:telegram] message received", {
      chatId,
      messageId,
      flowId: audit.flowId,
      length: text.length,
    });

    await journalInboundText({
      text,
      chatId,
      messageId,
      updateId: ctx.update.update_id,
      receivedAt,
      audit,
    });

    const prompt = await enrichPromptWithVaultContext(text);
    emitInboundMessage({
      source: "telegram",
      prompt,
      metadata: {
        telegramChatId: chatId,
        telegramMessageId: messageId,
        telegramFlowId: audit.flowId,
        channelAudit: audit,
      },
      replyTo: ctx.message.reply_to_message ? String(ctx.message.reply_to_message.message_id) : undefined,
    });
    await enqueuePrompt!(`telegram:${chatId}`, prompt, {
      telegramChatId: chatId,
      telegramMessageId: messageId,
      telegramFlowId: audit.flowId,
      channelAudit: audit,
      trustedTelegramInbound: true,
    });

    await emitGatewayOtel({
      level: "info",
      component: "telegram-channel",
      action: "telegram.inbound.accepted",
      success: true,
      critical: true,
      duration_ms: Date.now() - receivedAt,
      metadata: {
        ...audit,
        chatId,
        telegramMessageId: messageId,
      },
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
        { telegramChatId: chatId, telegramMessageId: ctx.message.message_id, trustedTelegramInbound: true });
      return;
    }

    const result = await downloadTelegramFile(largest.file_id);
    if (!result) {
      enqueuePrompt!(`telegram:${chatId}`,
        `[User sent a photo${caption ? `: ${caption}` : ""} — download failed]`,
        { telegramChatId: chatId, telegramMessageId: ctx.message.message_id, trustedTelegramInbound: true });
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
      { telegramChatId: chatId, telegramMessageId: ctx.message.message_id, trustedTelegramInbound: true });
  });

  // Voice messages → download + transcription pipeline (ADR-0042)
  bot.on("message:voice", async (ctx) => {
    const chatId = ctx.chat.id;
    const voice = ctx.message.voice;

    const result = await downloadTelegramFile(voice.file_id);
    if (!result) {
      enqueuePrompt!(`telegram:${chatId}`,
        "[User sent a voice message — download failed]",
        { telegramChatId: chatId, telegramMessageId: ctx.message.message_id, trustedTelegramInbound: true });
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
      { telegramChatId: chatId, telegramMessageId: ctx.message.message_id, trustedTelegramInbound: true });
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
        { telegramChatId: chatId, telegramMessageId: ctx.message.message_id, trustedTelegramInbound: true });
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
      { telegramChatId: chatId, telegramMessageId: ctx.message.message_id, trustedTelegramInbound: true });
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
        { telegramChatId: chatId, telegramMessageId: ctx.message.message_id, trustedTelegramInbound: true });
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
      { telegramChatId: chatId, telegramMessageId: ctx.message.message_id, trustedTelegramInbound: true });
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
        { telegramChatId: chatId, telegramMessageId: ctx.message.message_id, trustedTelegramInbound: true });
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
      { telegramChatId: chatId, telegramMessageId: ctx.message.message_id, trustedTelegramInbound: true });
  });

  // Callback query handler — inline keyboard button presses (ADR-0070)
  // NOTE: pitch:, mcq:, worktree:, and cmd: prefixed callbacks are handled by dedicated handlers.
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.callbackQuery.message?.chat.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const callbackQueryId = ctx.callbackQuery.id;
    const interactionAction = data.split(":", 1)[0] || data;
    const originalText = ctx.callbackQuery.message && "text" in ctx.callbackQuery.message
      ? String(ctx.callbackQuery.message.text ?? "")
      : "";
    const flowId = await resolveTelegramMessageFlow(chatId, messageId)
      ?? `telegram-callback:${chatId ?? "unknown"}:${messageId ?? callbackQueryId}`;
    let interactionOutcome = /(^|:)ignore(?:$|:)/u.test(data)
      ? "ignored"
      : /(^|:)(?:s4h|snooze)(?:$|:)/u.test(data)
        ? "snoozed"
        : "completed";

    await journalMessage({
      messageKey: `telegram:${chatId ?? 0}:${messageId ?? callbackQueryId}`,
      flowId,
      direction: "interaction",
      eventType: "interaction.received",
      producer: "telegram-callback",
      originSystemId: process.env.SLOG_SYSTEM_ID ?? "gateway",
      sourceRef: "telegram.callback_query",
      route: "telegram.callback",
      classification: "interaction",
      reason: "telegram.callback.received",
      telegramChatId: chatId ?? 0,
      telegramMessageId: messageId,
      callbackQueryId,
      interactionAction,
      interactionPayload: data,
      interactionOutcome: "received",
      text: originalText,
      transportText: originalText,
      deliveryState: "received",
    });

    try {
      console.log("[gateway:telegram] callback_query", { data, chatId, messageId });

    if (data.startsWith("replygrant:")) {
      const [, actionName, approvalId, ...restParts] = data.split(":");
      try {
        const { getRedisClient, pushGatewayEvent } = await import("./redis");
        const redis = getRedisClient();
        if (!redis || !approvalId) throw new Error("reply grant approval state unavailable");
        if (actionName === "close") {
          const threadTs = restParts.join(":");
          if (!threadTs) throw new Error("reply grant close missing thread");
          await redis.del(`replyGrant:slack:${approvalId}:${threadTs}`);
          await ctx.answerCallbackQuery({ text: "Grant closed" });
          if (chatId && messageId) {
            await bot!.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
          }
          void emitGatewayOtel({
            level: "info",
            component: "telegram-channel",
            action: "reply_grant.closed",
            success: true,
            metadata: { channelId: approvalId, threadTs },
          });
          return;
        }
        const key = `replyGrantApproval:${approvalId}`;
        const raw = await redis.get(key);
        if (!raw) throw new Error("reply grant approval expired");
        const approval = JSON.parse(raw) as {
          channelId: string;
          threadTs: string;
          messageTs?: string;
          userId?: string;
          text?: string;
        };
        if (actionName === "edit") {
          await pushGatewayEvent({
            type: "telegram.message.received",
            source: chatId ? `telegram:${chatId}` : "telegram:replygrant-edit",
            payload: {
              originSession: chatId ? `telegram:${chatId}` : undefined,
              prompt: [
                "Draft a concise Slack reply for Joel to edit before sending.",
                "Do not send anything to Slack. Do not create or close the Reply Grant. Return only the proposed reply text and remind Joel he can tap Send suggested or Grant on the original approval when ready.",
                "Original Slack message:",
                approval.text ?? "",
              ].join("\n"),
            },
          });
          await ctx.answerCallbackQuery({ text: "Draft queued" });
          void emitGatewayOtel({
            level: "info",
            component: "telegram-channel",
            action: "reply_grant.edit_requested",
            success: true,
            metadata: { approvalId, channelId: approval.channelId, threadTs: approval.threadTs },
          });
          return;
        }
        if (actionName === "ignore") {
          await redis.del(key);
          await ctx.answerCallbackQuery({ text: "Ignored" });
          void emitGatewayOtel({
            level: "info",
            component: "telegram-channel",
            action: "reply_grant.approval_ignored",
            success: true,
            metadata: { approvalId, channelId: approval.channelId, threadTs: approval.threadTs },
          });
          return;
        }
        if (actionName === "grant" || actionName === "send") {
          const { resolveReplyGrantApproval } = await import("@joelclaw/channel-routing");
          const decision = resolveReplyGrantApproval({
            action: "grant",
            grantedByUserId: process.env.SLACK_ALLOWED_USER_ID ?? "telegram-operator",
            now: Date.now(),
            approval: {
              platform: "slack",
              channelId: approval.channelId,
              threadTs: approval.threadTs,
              messageTs: approval.messageTs ?? approval.threadTs,
              userId: approval.userId,
              text: approval.text ?? "",
              createdAt: Date.now(),
            },
          });
          if (decision.type !== "granted") throw new Error("reply grant approval did not grant");
          const grant = decision.grant;
          await redis.psetex(`replyGrant:slack:${approval.channelId}:${approval.threadTs}`, Math.max(1_000, grant.absoluteExpiresAt - Date.now()), JSON.stringify(grant));
          await redis.del(key);
          if (actionName === "send") {
            await pushGatewayEvent({
              type: "slack.message.received",
              source: `slack:${approval.channelId}:${approval.threadTs}`,
              payload: {
                originSession: `slack:${approval.channelId}:${approval.threadTs}`,
                prompt: [
                  "Joel approved a public Slack reply via Reply Grant.",
                  "Reply in the Slack thread with a concise, useful answer. Do not mention internal routing, Reply Grants, Telegram, Redis, or this approval workflow.",
                  "Original Slack message:",
                  approval.text ?? "",
                ].join("\n"),
              },
            });
          }
          await ctx.answerCallbackQuery({ text: actionName === "send" ? "Grant created + queued" : "Grant created" });
          if (chatId && messageId) {
            await bot!.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
          }
          void emitGatewayOtel({
            level: "info",
            component: "telegram-channel",
            action: actionName === "send" ? "reply_grant.approved_and_queued" : "reply_grant.approved",
            success: true,
            metadata: { approvalId, channelId: approval.channelId, threadTs: approval.threadTs, invokerCount: grant.invokerUserIds.length },
          });
          return;
        }
        throw new Error(`unknown replygrant action: ${actionName}`);
      } catch (error) {
        interactionOutcome = "failed";
        await ctx.answerCallbackQuery({ text: "Reply Grant failed" }).catch(() => {});
        void emitGatewayOtel({
          level: "error",
          component: "telegram-channel",
          action: "reply_grant.callback_failed",
          success: false,
          error: String(error),
          metadata: { data },
        });
        return;
      }
    }

    // Let dedicated grammy middleware handlers process their own prefixes.
    if (data.startsWith("pitch:") || data.startsWith("mcq:") || data.startsWith("worktree:") || data.startsWith("cmd:")) {
      console.log(`[gateway:telegram] delegating ${data.split(":")[0]}: callback to dedicated handler`);
      await next();
      return;
    }

    const colonIdx = data.indexOf(":");
    const action = colonIdx > 0 ? data.slice(0, colonIdx) : data;
    const context = colonIdx > 0 ? data.slice(colonIdx + 1) : "";
    const matchedRoute = callbackRoutes.find((r) => data.startsWith(r.prefix));
    const route = matchedRoute ? `external:${matchedRoute.prefix}` : `event:${action}`;
    const traceId = startCallbackTrace(
      {
        handler: "telegram.callback",
        route,
        rawData: data,
        chatId,
        messageId,
      },
      {
        timeoutMs: matchedRoute ? EXTERNAL_CALLBACK_TRACE_TIMEOUT_MS : undefined,
        onTimeout: async (trace) => {
          if (!chatId) return;
          await sendCallbackTimeoutMessage(chatId, trace.route, trace.traceId).catch(() => {});
        },
      },
    );

    void emitGatewayOtel({
      level: "info",
      component: "telegram-channel",
      action: "telegram.callback.received",
      success: true,
      metadata: {
        action: data,
        chatId,
        traceId,
        route,
      },
    });

    const answerWithTrace = async (text: string): Promise<void> => {
      try {
        await ctx.answerCallbackQuery({ text });
        acknowledgeCallbackTrace(traceId, { text });
      } catch (error) {
        acknowledgeCallbackTrace(traceId, { text, error: String(error) });
      }
    };

    if (matchedRoute) {
      console.log("[gateway:telegram] routing callback to external consumer", {
        prefix: matchedRoute.prefix,
        channel: matchedRoute.channel,
        data,
        traceId,
      });

      try {
        const { getRedisClient } = await import("./redis");
        const redis = getRedisClient();
        if (!redis) {
          throw new Error("redis client unavailable for callback route publish");
        }

        await redis.publish(
          matchedRoute.channel,
          JSON.stringify({
            data,
            chatId,
            messageId,
            traceId,
            traceResultChannel: CALLBACK_TRACE_EVENTS_CHANNEL,
          }),
        );
        await answerWithTrace("Routed");
        markCallbackTraceDispatched(traceId, `published to ${matchedRoute.channel}; waiting for downstream completion`);
        void emitGatewayOtel({
          level: "info",
          component: "telegram-channel",
          action: "telegram.callback.routed",
          success: true,
          metadata: {
            prefix: matchedRoute.prefix,
            channel: matchedRoute.channel,
            traceId,
            traceResultChannel: CALLBACK_TRACE_EVENTS_CHANNEL,
            waitingForDownstreamCompletion: true,
          },
        });
      } catch (err) {
        interactionOutcome = "failed";
        const message = String(err);
        console.error("[gateway:telegram] callback route publish failed", {
          error: message,
          channel: matchedRoute.channel,
          traceId,
        });
        await answerWithTrace("Route failed");
        failCallbackTrace(traceId, message, `route publish failed for ${matchedRoute.channel}`);
        if (chatId) {
          await sendCallbackFailureMessage(chatId, route, traceId, message).catch(() => {});
        }
      }
      return;
    }

    try {
      const config = loadGatewayInngestEventConfig();
      if (!config) {
        throw new Error("missing INNGEST_EVENT_KEY");
      }
      const res = await fetch(config.eventApi, {
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
            traceId,
          },
        }),
      });
      if (!res.ok) {
        throw new Error(`callback event dispatch failed with ${res.status}`);
      }

      await answerWithTrace("Queued");
      markCallbackTraceDispatched(traceId, `accepted telegram/callback.received for ${action}`);

      if (chatId && messageId) {
        const actionLabel = ACTION_LABELS[action] ?? `✅ ${action}`;
        await bot!.api.editMessageReplyMarkup(chatId, messageId, {
          reply_markup: { inline_keyboard: [] },
        });
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
      }

      completeCallbackTrace(traceId, `accepted callback event and updated message for ${action}`);
    } catch (err) {
      interactionOutcome = "failed";
      const message = String(err);
      console.error("[gateway:telegram] callback handling failed", { error: message, traceId });
      await answerWithTrace("Action failed");
      failCallbackTrace(traceId, message, `callback handling failed for ${action}`);
      if (chatId) {
        await sendCallbackFailureMessage(chatId, route, traceId, message).catch(() => {});
      }
    }
    } catch (error) {
      interactionOutcome = "failed";
      throw error;
    } finally {
      await journalMessage({
        messageKey: `telegram:${chatId ?? 0}:${messageId ?? callbackQueryId}`,
        flowId,
        direction: "interaction",
        eventType: "interaction.completed",
        producer: "telegram-callback",
        originSystemId: process.env.SLOG_SYSTEM_ID ?? "gateway",
        sourceRef: "telegram.callback_query",
        route: "telegram.callback",
        classification: "interaction",
        reason: `telegram.callback.${interactionOutcome}`,
        telegramChatId: chatId ?? 0,
        telegramMessageId: messageId,
        callbackQueryId,
        interactionAction,
        interactionPayload: data,
        interactionOutcome,
        text: originalText,
        transportText: originalText,
        deliveryState: interactionOutcome === "failed" ? "failed" : "confirmed",
      });
    }
  });

  const startPolling = (): void => {
    if (!bot || !started) return;
    if (pollingActive || pollingStarting) return;
    if (TELEGRAM_POLL_LEASE_ENABLED && !pollLeaseOwned) return;

    // Long polling is single-consumer per bot token. If another process currently
    // owns getUpdates, Telegram returns 409. Retry with backoff instead of
    // permanently disabling the channel on first conflict.
    pollingStarting = true;
    void bot.start({
      // Telegram excludes message_reaction unless explicitly requested —
      // without it, Joel's emoji reactions never reach the gateway or the
      // shadow tap (reactions-teach-taste plumbing).
      allowed_updates: ["message", "edited_message", "callback_query", "message_reaction"],
      onStart: (botInfo) => {
        const recovered = pollRetryAttempts > 0 || pollConflictStreak > 0;
        pollRetryAttempts = 0;
        pollConflictStreak = 0;
        clearPollRetryTimer();
        pollingStarting = false;
        pollingActive = true;

        console.log("[gateway:telegram] started", {
          botId: botInfo.id,
          botUsername: botInfo.username,
          allowedUserId,
          recovered,
          pollLeaseOwned,
        });
        void emitGatewayOtel({
          level: "info",
          component: "telegram-channel",
          action: "telegram.channel.started",
          success: true,
          metadata: {
            botId: botInfo.id,
            botUsername: botInfo.username,
            recovered,
            pollLeaseOwned,
          },
        });

        if (recovered) {
          void emitGatewayOtel({
            level: "info",
            component: "telegram-channel",
            action: "telegram.channel.polling_recovered",
            success: true,
          });
        }
      },
    }).catch(async (error) => {
      pollingStarting = false;
      pollingActive = false;

      // grammy may leave an in-flight getUpdates request after error.
      // Stop the bot to cancel it before we retry, otherwise the next
      // bot.start() races with the stale request → perpetual 409.
      try { await bot?.stop(); } catch { /* ignore */ }

      const errorText = String(error);
      const conflict = isGetUpdatesConflict(errorText);
      if (conflict) {
        pollConflictStreak += 1;
      } else {
        pollConflictStreak = 0;
      }

      const delayMs = nextPollRetryDelayMs(pollRetryAttempts);
      const attempt = pollRetryAttempts + 1;
      pollRetryAttempts = attempt;

      const level: "warn" | "error" = conflict ? "warn" : "error";
      console[conflict ? "warn" : "error"](
        "[gateway:telegram] polling start failed; retry scheduled",
        {
          error: errorText,
          conflict,
          attempt,
          delayMs,
          pollLeaseOwned,
        },
      );

      void emitGatewayOtel({
        level,
        component: "telegram-channel",
        action: "telegram.channel.start_failed",
        success: false,
        error: errorText,
        metadata: {
          conflict,
          attempt,
          retryDelayMs: delayMs,
          pollLeaseOwned,
        },
      });

      void emitGatewayOtel({
        level: "warn",
        component: "telegram-channel",
        action: "telegram.channel.retry_scheduled",
        success: true,
        metadata: {
          conflict,
          attempt,
          retryDelayMs: delayMs,
          pollLeaseOwned,
        },
      });

      clearPollRetryTimer();
      pollRetryTimer = setTimeout(() => {
        pollRetryTimer = undefined;
        if (!started) return;
        if (TELEGRAM_POLL_LEASE_ENABLED && !pollLeaseOwned) return;
        startPolling();
      }, delayMs);
      unrefTimer(pollRetryTimer);
    });
  };

  const schedulePollLeaseRetry = (reason: string): void => {
    if (!started || !TELEGRAM_POLL_LEASE_ENABLED) return;
    if (pollLeaseRetryTimer) return;

    const delayMs = nextPollLeaseRetryDelayMs(pollLeaseRetryAttempts);
    const attempt = pollLeaseRetryAttempts + 1;
    pollLeaseRetryAttempts = attempt;

    void emitGatewayOtel({
      level: "info",
      component: "telegram-channel",
      action: "telegram.channel.poll_owner.retry_scheduled",
      success: true,
      metadata: {
        attempt,
        retryDelayMs: delayMs,
        reason,
      },
    });

    pollLeaseRetryTimer = setTimeout(() => {
      pollLeaseRetryTimer = undefined;
      void attemptPollOwnership("retry");
    }, delayMs);
    unrefTimer(pollLeaseRetryTimer);
  };

  const startPollLeaseRenewLoop = (): void => {
    clearPollLeaseRenewTimer();
    if (!started || !TELEGRAM_POLL_LEASE_ENABLED || !pollLeaseOwned) return;

    pollLeaseRenewTimer = setInterval(() => {
      if (!started || !pollLeaseOwned) return;

      void renewPollLease().then((renewed) => {
        if (renewed) return;

        pollLeaseOwned = false;
        stopPolling();
        clearPollLeaseRenewTimer();

        void emitGatewayOtel({
          level: "warn",
          component: "telegram-channel",
          action: "telegram.channel.poll_owner.lost",
          success: false,
        });
        void writePollLeaseStatus("passive", {
          reason: "lease_lost",
        });

        schedulePollLeaseRetry("lease_lost");
      });
    }, TELEGRAM_POLL_LEASE_RENEW_MS);
    unrefTimer(pollLeaseRenewTimer);
  };

  const attemptPollOwnership = async (reason: string): Promise<void> => {
    if (!started || !bot) return;

    const previouslyOwned = pollLeaseOwned;
    const { acquired, ownerId, fallback } = await acquirePollLease();
    if (!started || !bot) return;

    if (acquired) {
      clearPollLeaseRetryTimer();
      pollLeaseRetryAttempts = 0;

      if (fallback) {
        pollLeaseOwned = true;
        clearPollLeaseRenewTimer();
        const fallbackReason = TELEGRAM_POLL_LEASE_ENABLED ? "lease_unavailable" : "lease_disabled";
        console.warn("[gateway:telegram] poll lease unavailable; running direct polling", {
          reason: fallbackReason,
        });
        void emitGatewayOtel({
          level: "warn",
          component: "telegram-channel",
          action: "telegram.channel.poll_owner.fallback",
          success: true,
          metadata: { reason: fallbackReason },
        });
        void writePollLeaseStatus("fallback", {
          reason: fallbackReason,
        });
      } else {
        const fromPassive = !previouslyOwned;
        pollLeaseOwned = true;
        startPollLeaseRenewLoop();

        console.log("[gateway:telegram] poll owner acquired", {
          instanceId: pollLeaseInstanceId,
          tokenHash: pollLeaseTokenHash,
          ownerId,
          fromPassive,
          reason,
        });
        void emitGatewayOtel({
          level: "info",
          component: "telegram-channel",
          action: "telegram.channel.poll_owner.acquired",
          success: true,
          metadata: {
            instanceId: pollLeaseInstanceId,
            ownerId,
            tokenHash: pollLeaseTokenHash,
            fromPassive,
            reason,
          },
        });
        void writePollLeaseStatus("owner", {
          ownerId: pollLeaseInstanceId,
        });
      }

      startPolling();
      return;
    }

    pollLeaseOwned = false;
    clearPollLeaseRenewTimer();
    stopPolling();

    console.log("[gateway:telegram] passive mode (another poll owner active)", {
      ownerId,
      tokenHash: pollLeaseTokenHash,
      reason,
    });
    void emitGatewayOtel({
      level: "info",
      component: "telegram-channel",
      action: "telegram.channel.poll_owner.passive",
      success: true,
      metadata: {
        ownerId,
        tokenHash: pollLeaseTokenHash,
        reason,
      },
    });
    void writePollLeaseStatus("passive", {
      ownerId,
      reason,
      attempt: pollLeaseRetryAttempts + 1,
    });

    schedulePollLeaseRetry(reason);
  };

  started = true;
  pollLeaseTokenHash = stableTokenHash(token);
  pollLeaseOwnerKey = `joelclaw:gateway:telegram:poll-owner:${pollLeaseTokenHash}`;
  pollLeaseStatusKey = `joelclaw:gateway:telegram:poll-status:${pollLeaseTokenHash}`;

  // Load callback routes for external consumers (ADR-0215)
  const { getRedisClient } = await import("./redis");
  callbackRoutes = await loadCallbackRoutes(getRedisClient());
  if (callbackRoutes.length > 0) {
    console.log("[gateway:telegram] callback routes loaded", {
      routes: callbackRoutes.map((r) => `${r.prefix} → ${r.channel}`),
    });
  }

  try {
    await ensureCallbackTraceSubscriber();
  } catch (error) {
    console.warn("[gateway:telegram] callback trace subscriber failed to start", { error: String(error) });
    void emitGatewayOtel({
      level: "warn",
      component: "telegram-channel",
      action: "telegram.callback.trace_result.subscriber_failed",
      success: false,
      error: String(error),
    });
  }

  void attemptPollOwnership("startup");
}

/**
 * Send a text message back to a Telegram chat.
 * Handles markdown→HTML conversion, chunking, and optional reply threading.
 */
async function sendTelegramMessage(
  chatId: number,
  message: string | OutboundEnvelope,
  options?: RichSendOptions,
): Promise<TelegramDeliveryReceipt> {
  const sendInput = resolveSendInput(message, options);
  const text = sendInput.text;
  const mergedOptions = sendInput.options;
  const audit = createChannelDeliveryAudit(text, mergedOptions?.audit);
  const policy = await routeTelegramOutbound({
    chatId,
    content: text,
    audit,
    transportText: text,
    policy: mergedOptions?.outboundPolicy,
  });
  if (policy.disposition !== "deliver") {
    return {
      status: "routed",
      audit,
      telegramMessageIds: [],
      usedFallback: false,
      policy,
    };
  }
  const sendStartedAt = Date.now();
  const journalPolicy = {
    classification: policy.decision.category,
    reason: policy.decision.reason,
    investigationState: policy.lifecycleState ?? policy.disposition,
    metadata: {
      policyDisposition: policy.disposition,
      sourceClassification: mergedOptions?.outboundPolicy?.sourceClassification,
      sourceReason: mergedOptions?.outboundPolicy?.sourceReason,
    },
  };
  const messageKey = `telegram:${chatId}:${audit.flowId}`;

  await journalMessage({
    messageKey,
    flowId: audit.flowId,
    direction: "outbound",
    eventType: "outbound.requested",
    producer: audit.producer,
    originSystemId: audit.originSystemId,
    sourceEventId: audit.eventId,
    route: audit.route,
    ...journalPolicy,
    telegramChatId: chatId,
    inReplyToMessageId: mergedOptions?.replyTo ?? audit.inReplyToMessageId,
    occurredAt: new Date(audit.requestedAtMs),
    text,
    transportText: text,
    deliveryState: "requested",
  });

  if (!bot) {
    const error = "bot_not_started";
    console.error("[gateway:telegram] bot not started, can't send");
    await journalMessage({
      messageKey,
      flowId: audit.flowId,
      direction: "outbound",
      eventType: "delivery.failed",
      producer: audit.producer,
      originSystemId: audit.originSystemId,
      sourceEventId: audit.eventId,
      route: audit.route,
      ...journalPolicy,
      telegramChatId: chatId,
      inReplyToMessageId: mergedOptions?.replyTo ?? audit.inReplyToMessageId,
      text,
      transportText: text,
      deliveryState: "failed",
      errorCode: error,
    });
    await emitGatewayOtel({
      level: "error",
      component: "telegram-channel",
      action: "telegram.delivery.failed",
      success: false,
      error,
      metadata: { ...audit, chatId, stage: "preflight" },
    });
    throw new Error(error);
  }

  // Show typing indicator. This is UX only, not a delivery hop.
  try {
    await bot.api.sendChatAction(chatId, "typing");
  } catch {
    // non-critical
  }

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

  const formattedOutput = formatByEnvelope(text, sendInput.format);
  const {
    text: formattedText,
    plainText,
    parseMode,
    fallbackReason,
  } = formattedOutput;
  if (fallbackReason) {
    void emitGatewayOtel({
      level: "warn",
      component: "telegram-channel",
      action: "telegram.delivery.format_fallback",
      success: true,
      metadata: { ...audit, chatId, reason: fallbackReason },
    });
  }

  const chunks = chunkMessage(formattedText);
  const telegramMessageIds: number[] = [];
  let usedFallback = Boolean(fallbackReason);

  void emitGatewayOtel({
    level: "info",
    component: "telegram-channel",
    action: "telegram.delivery.attempted",
    success: true,
    metadata: {
      ...audit,
      chatId,
      chunks: chunks.length,
      hasButtons: Boolean(replyMarkup),
    },
  });

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const isLast = i === chunks.length - 1;

    try {
      const sent = await bot.api.sendMessage(chatId, chunk, {
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(isLast && replyMarkup ? { reply_markup: replyMarkup } : {}),
        ...(mergedOptions?.replyTo ? { reply_parameters: { message_id: mergedOptions.replyTo } } : {}),
        ...(mergedOptions?.silent ? { disable_notification: true } : {}),
        ...(mergedOptions?.noPreview ? { link_preview_options: { is_disabled: true } } : {}),
      });
      telegramMessageIds.push(sent.message_id);
      await rememberTelegramMessageFlow(chatId, sent.message_id, audit.flowId);
      await journalMessage({
        messageKey,
        flowId: audit.flowId,
        direction: "outbound",
        eventType: "delivery.confirmed",
        producer: audit.producer,
        originSystemId: audit.originSystemId,
        sourceEventId: audit.eventId,
        route: audit.route,
        ...journalPolicy,
        telegramChatId: chatId,
        telegramMessageId: sent.message_id,
        inReplyToMessageId: mergedOptions?.replyTo ?? audit.inReplyToMessageId,
        chunkIndex: i,
        text: parseMode === "HTML"
          ? stripHtmlTags(chunk)
          : parseMode === "MarkdownV2"
            ? plainText
            : chunk,
        transportText: chunk,
        deliveryState: "confirmed",
      });
      if (isLast && _onOutboundMessageId) {
        _onOutboundMessageId(sent.message_id);
      }
    } catch (error) {
      if (!parseMode) {
        console.error("[gateway:telegram] plain send failed", { error });
        await journalMessage({
          messageKey,
          flowId: audit.flowId,
          direction: "outbound",
          eventType: "delivery.failed",
          producer: audit.producer,
          originSystemId: audit.originSystemId,
          sourceEventId: audit.eventId,
          route: audit.route,
          ...journalPolicy,
          telegramChatId: chatId,
          inReplyToMessageId: mergedOptions?.replyTo ?? audit.inReplyToMessageId,
          chunkIndex: i,
          text,
          transportText: chunk,
          deliveryState: "failed",
          errorCode: summarizeChannelError(error),
        });
        await emitGatewayOtel({
          level: "error",
          component: "telegram-channel",
          action: "telegram.delivery.failed",
          success: false,
          error: summarizeChannelError(error),
          duration_ms: Date.now() - sendStartedAt,
          metadata: {
            ...audit,
            chatId,
            chunkIndex: i,
            stage: "send",
            telegramMessageIds,
          },
        });
        throw error;
      }

      if (!isDefinitiveTelegramRejection(error)) {
        await journalMessage({
          messageKey,
          flowId: audit.flowId,
          direction: "outbound",
          eventType: "delivery.unknown",
          producer: audit.producer,
          originSystemId: audit.originSystemId,
          sourceEventId: audit.eventId,
          route: audit.route,
          ...journalPolicy,
          telegramChatId: chatId,
          inReplyToMessageId: mergedOptions?.replyTo ?? audit.inReplyToMessageId,
          chunkIndex: i,
          text,
          transportText: chunk,
          deliveryState: "unknown",
          errorCode: summarizeChannelError(error),
        });
        await emitGatewayOtel({
          level: "error",
          component: "telegram-channel",
          action: "telegram.delivery.unknown",
          success: false,
          critical: true,
          error: summarizeChannelError(error),
          duration_ms: Date.now() - sendStartedAt,
          metadata: {
            ...audit,
            chatId,
            chunkIndex: i,
            stage: "formatted_send",
            telegramMessageIds,
          },
        });
        throw error;
      }

      console.warn("[gateway:telegram] formatted send rejected, trying plain text", { error });
      void emitGatewayOtel({
        level: "warn",
        component: "telegram-channel",
        action: "telegram.delivery.retrying_plain_text",
        success: true,
        metadata: {
          ...audit,
          chatId,
          chunkIndex: i,
          initialError: summarizeChannelError(error),
        },
      });

      try {
        const fallbackText = (parseMode === "HTML" ? stripHtmlTags(chunk) : plainText).slice(0, CHUNK_MAX);
        const sent = await bot.api.sendMessage(chatId, fallbackText, {
          ...(mergedOptions?.replyTo ? { reply_parameters: { message_id: mergedOptions.replyTo } } : {}),
          ...(mergedOptions?.silent ? { disable_notification: true } : {}),
          ...(isLast && replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
        telegramMessageIds.push(sent.message_id);
        usedFallback = true;
        await rememberTelegramMessageFlow(chatId, sent.message_id, audit.flowId);
        const fallbackTransportText = fallbackText;
        await journalMessage({
          messageKey,
          flowId: audit.flowId,
          direction: "outbound",
          eventType: "delivery.confirmed",
          producer: audit.producer,
          originSystemId: audit.originSystemId,
          sourceEventId: audit.eventId,
          route: audit.route,
          ...journalPolicy,
          telegramChatId: chatId,
          telegramMessageId: sent.message_id,
          inReplyToMessageId: mergedOptions?.replyTo ?? audit.inReplyToMessageId,
          chunkIndex: i,
          attempt: 2,
          text: fallbackTransportText,
          transportText: fallbackTransportText,
          deliveryState: "confirmed",
          metadata: { ...journalPolicy.metadata, fallback: "plain_text" },
        });
        if (isLast && _onOutboundMessageId) {
          _onOutboundMessageId(sent.message_id);
        }
      } catch (fallbackError) {
        console.error("[gateway:telegram] send failed completely", { fallbackError });
        await journalMessage({
          messageKey,
          flowId: audit.flowId,
          direction: "outbound",
          eventType: "delivery.failed",
          producer: audit.producer,
          originSystemId: audit.originSystemId,
          sourceEventId: audit.eventId,
          route: audit.route,
          ...journalPolicy,
          telegramChatId: chatId,
          inReplyToMessageId: mergedOptions?.replyTo ?? audit.inReplyToMessageId,
          chunkIndex: i,
          attempt: 2,
          text,
          transportText: stripHtmlTags(chunk).slice(0, CHUNK_MAX),
          deliveryState: "failed",
          errorCode: summarizeChannelError(fallbackError),
          metadata: { ...journalPolicy.metadata, fallback: "plain_text" },
        });
        await emitGatewayOtel({
          level: "error",
          component: "telegram-channel",
          action: "telegram.delivery.failed",
          success: false,
          error: summarizeChannelError(fallbackError),
          duration_ms: Date.now() - sendStartedAt,
          metadata: {
            ...audit,
            chatId,
            chunkIndex: i,
            stage: "plain_text_fallback",
            telegramMessageIds,
          },
        });
        throw fallbackError;
      }
    }
  }

  await emitGatewayOtel({
    level: "info",
    component: "telegram-channel",
    action: "telegram.delivery.confirmed",
    success: true,
    critical: true,
    duration_ms: Date.now() - sendStartedAt,
    metadata: {
      ...audit,
      chatId,
      chunksRequested: chunks.length,
      chunksConfirmed: telegramMessageIds.length,
      telegramMessageIds,
      usedFallback,
    },
  });

  return {
    status: "confirmed",
    audit,
    telegramMessageIds,
    usedFallback,
  };
}

/**
 * Send a media file to a Telegram chat.
 * Detects kind from MIME type and dispatches to appropriate Bot API method.
 */
async function sendTelegramMedia(
  chatId: number,
  media: SendMediaPayload,
  options?: {
    caption?: string;
    replyTo?: number;
    asVoice?: boolean;
    audit?: ChannelAuditSeed;
    outboundPolicy?: TelegramOutboundPolicyContext;
  },
): Promise<TelegramDeliveryReceipt> {
  const caption = media.caption ?? options?.caption ?? "";
  const audit = createChannelDeliveryAudit(caption, options?.audit);
  const sendStartedAt = Date.now();
  const source = media.path ?? media.url;
  if (!source) {
    const error = "media_source_missing";
    console.error("[gateway:telegram] sendMedia requires media.path or media.url", { chatId });
    await emitGatewayOtel({
      level: "error",
      component: "telegram-channel",
      action: "telegram.delivery.failed",
      success: false,
      error,
      metadata: { ...audit, chatId, media: true, stage: "preflight" },
    });
    throw new Error(error);
  }

  const mimeType = media.mimeType || (media.path ? mimeFromExt(extname(media.path) || ".bin") : "application/octet-stream");
  const kind = mediaKindFromMimeType(mimeType, media.path);
  const policy = await routeTelegramOutbound({
    chatId,
    content: caption || `[${kind} media]`,
    audit,
    contentKind: kind,
    transportText: caption,
    policy: options?.outboundPolicy,
  });
  if (policy.disposition !== "deliver") {
    return {
      status: "routed",
      audit,
      telegramMessageIds: [],
      usedFallback: false,
      policy,
    };
  }

  if (!bot) {
    const error = "bot_not_started";
    console.error("[gateway:telegram] bot not started, can't send media");
    await emitGatewayOtel({
      level: "error",
      component: "telegram-channel",
      action: "telegram.delivery.failed",
      success: false,
      error,
      metadata: { ...audit, chatId, media: true, stage: "preflight" },
    });
    throw new Error(error);
  }
  const sendAsVoice = options?.asVoice ?? mimeType === "audio/ogg";
  const action = kind === "photo" ? "upload_photo"
    : kind === "video" ? "upload_video"
    : kind === "audio" ? "upload_voice"
    : "upload_document";
  try { await bot.api.sendChatAction(chatId, action); } catch {}

  const file = media.path ? new InputFile(media.path) : media.url!;
  const params = {
    ...(caption ? { caption, parse_mode: "HTML" as const } : {}),
    ...(options?.replyTo ? { reply_parameters: { message_id: options.replyTo } } : {}),
  };
  let usedFallback = false;
  let sent: { message_id: number };

  void emitGatewayOtel({
    level: "info",
    component: "telegram-channel",
    action: "telegram.delivery.attempted",
    success: true,
    metadata: { ...audit, chatId, media: true, kind, mimeType },
  });

  try {
    switch (kind) {
      case "photo":
        sent = await bot.api.sendPhoto(chatId, file, params);
        break;
      case "video":
        sent = await bot.api.sendVideo(chatId, file, params);
        break;
      case "audio":
        if (sendAsVoice) {
          try {
            sent = await bot.api.sendVoice(chatId, file, params);
          } catch (error) {
            if (!/VOICE_MESSAGES_FORBIDDEN/.test(String(error))) throw error;
            usedFallback = true;
            sent = await bot.api.sendAudio(chatId, file, params);
          }
        } else {
          sent = await bot.api.sendAudio(chatId, file, params);
        }
        break;
      default:
        sent = await bot.api.sendDocument(chatId, file, params);
    }
  } catch (error) {
    if (!isDefinitiveTelegramRejection(error)) {
      await emitGatewayOtel({
        level: "error",
        component: "telegram-channel",
        action: "telegram.delivery.unknown",
        success: false,
        critical: true,
        error: summarizeChannelError(error),
        duration_ms: Date.now() - sendStartedAt,
        metadata: { ...audit, chatId, media: true, kind, stage: "media_send" },
      });
      throw error;
    }

    console.error("[gateway:telegram] sendMedia rejected, trying as document", { kind, error });
    void emitGatewayOtel({
      level: "warn",
      component: "telegram-channel",
      action: "telegram.delivery.retrying_document",
      success: true,
      metadata: {
        ...audit,
        chatId,
        kind,
        initialError: summarizeChannelError(error),
      },
    });
    try {
      sent = await bot.api.sendDocument(chatId, file, params);
      usedFallback = true;
    } catch (fallbackError) {
      console.error("[gateway:telegram] sendMedia fallback failed", { fallbackError });
      await emitGatewayOtel({
        level: "error",
        component: "telegram-channel",
        action: "telegram.delivery.failed",
        success: false,
        error: summarizeChannelError(fallbackError),
        duration_ms: Date.now() - sendStartedAt,
        metadata: { ...audit, chatId, media: true, kind, stage: "document_fallback" },
      });
      throw fallbackError;
    }
  }

  console.log("[gateway:telegram] media sent", { chatId, kind, mimeType, flowId: audit.flowId });
  await emitGatewayOtel({
    level: "info",
    component: "telegram-channel",
    action: "telegram.delivery.confirmed",
    success: true,
    critical: true,
    duration_ms: Date.now() - sendStartedAt,
    metadata: {
      ...audit,
      chatId,
      media: true,
      kind,
      mimeType,
      telegramMessageIds: [sent.message_id],
      usedFallback,
    },
  });

  return {
    status: "confirmed",
    audit,
    telegramMessageIds: [sent.message_id],
    usedFallback,
  };
}

/**
 * Extract chat ID from a telegram source string like "telegram:12345"
 */
export function parseChatId(source: string): number | undefined {
  const match = source.match(/^telegram:(-?\d+)$/);
  return match?.[1] ? parseInt(match[1], 10) : undefined;
}

export async function start(
  token: string,
  userId: number,
  enqueue: EnqueueFn,
  options?: TelegramStartOptions,
): Promise<void> {
  const instance = getDefaultTelegramChannel();
  await instance.start(token, userId, enqueue, options);
}

export async function send(
  chatId: number,
  message: string | OutboundEnvelope,
  options?: RichSendOptions,
): Promise<TelegramDeliveryReceipt> {
  const instance = getDefaultTelegramChannel();
  return instance.sendWithLegacy(String(chatId), message, options);
}

export async function sendMedia(
  chatId: number,
  filePath: string,
  options?: {
    caption?: string;
    replyTo?: number;
    asVoice?: boolean;
    audit?: ChannelAuditSeed;
    outboundPolicy?: TelegramOutboundPolicyContext;
  },
): Promise<TelegramDeliveryReceipt> {
  const mimeType = mimeFromExt(extname(filePath) || ".bin");
  return sendTelegramMedia(chatId, {
    path: filePath,
    mimeType,
    caption: options?.caption,
  }, options);
}

export const __telegramTestUtils = {
  isDefinitiveTelegramRejection,
  journalInboundText,
  sendTelegramMessage,
  setBotForTest(value: Bot | undefined): void {
    bot = value;
  },
};

export async function shutdown(): Promise<void> {
  const instance = getDefaultTelegramChannel();
  await instance.stop();
}

async function stopTelegramIngress(destroyBot: boolean): Promise<void> {
  started = false;
  clearPollLeaseRetryTimer();
  clearPollLeaseRenewTimer();
  stopPolling();

  await writePollLeaseStatus("stopped", {
    reason: destroyBot ? "shutdown" : "chat_sdk_handover",
  });
  await releasePollLease();
  await closePollLeaseClient();
  await closeCallbackTraceSubscriber();

  pollLeaseOwned = false;
  pollLeaseRetryAttempts = 0;
  pollLeaseOwnerKey = undefined;
  pollLeaseStatusKey = undefined;
  pollLeaseTokenHash = undefined;

  if (destroyBot && bot) {
    bot.stop();
    bot = undefined;
  }

  console.log(
    destroyBot
      ? "[gateway:telegram] stopped"
      : "[gateway:telegram] polling ownership released; send client retained",
  );
  void emitGatewayOtel({
    level: "info",
    component: "telegram-channel",
    action: destroyBot
      ? "telegram.channel.stopped"
      : "telegram.channel.ingress_released",
    success: true,
  });
}

/** Stop polling/lease ownership while retaining the Bot API send client. */
export async function releaseIngressOwnership(): Promise<void> {
  await stopTelegramIngress(false);
}

async function shutdownTelegramChannel(): Promise<void> {
  await stopTelegramIngress(true);
}
