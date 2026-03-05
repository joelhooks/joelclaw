import { execSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdir } from "node:fs/promises";
import { extname } from "node:path";
import type { FormatConverter } from "@joelclaw/markdown-formatter";
import { escapeText, TelegramConverter } from "@joelclaw/markdown-formatter";
import { emitGatewayOtel } from "@joelclaw/telemetry";
import { enrichPromptWithVaultContext } from "@joelclaw/vault-reader";
import { Bot, InputFile } from "grammy";
import Redis from "ioredis";
import type { OutboundEnvelope } from "../outbound/envelope";
import type { EnqueueFn } from "./redis";
import type {
  Channel,
  ChannelPlatform,
  InboundMessage,
  MessageHandler,
  SendMediaPayload,
  SendOptions,
} from "./types";

// ── Telegram HTML formatting ───────────────────────────
// Telegram's HTML mode supports: <b>, <i>, <code>, <pre>, <a href="">
// Max message length is enforced by the converter.
const telegramConverter: FormatConverter = new TelegramConverter();
const CHUNK_MAX = telegramConverter.maxLength;

type TelegramFormattedOutput = {
  text: string;
  parseAsHtml: boolean;
  chunkMode: "markdown" | "raw";
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

// Inngest event API — same config as joelclaw CLI
const INNGEST_URL = process.env.INNGEST_URL ?? "http://localhost:8288";
const INNGEST_EVENT_KEY = process.env.INNGEST_EVENT_KEY ?? "";

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
}

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
    return {
      text: escapeText(text),
      parseAsHtml: false,
      chunkMode: "raw",
    };
  }

  if (format === "html") {
    const validation = telegramConverter.validate(text);
    if (!validation.valid) {
      console.warn("[telegram] HTML formatter validation failed, falling back to plain:", validation.errors);
      return {
        text: stripHtmlTags(text),
        parseAsHtml: false,
        chunkMode: "raw",
      };
    }
    return {
      text,
      parseAsHtml: true,
      chunkMode: "raw",
    };
  }

  const result = telegramConverter.convert(text);
  const validation = telegramConverter.validate(result);
  if (!validation.valid) {
    console.warn("[telegram] AST formatter validation failed, falling back to plain:", validation.errors);
    return {
      text: escapeText(text),
      parseAsHtml: false,
      chunkMode: "raw",
    };
  }

  return {
    text: result,
    parseAsHtml: true,
    chunkMode: "markdown",
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

const pollLeaseInstanceId = crypto.randomUUID();
let pollLeaseClient: Redis | undefined;
let pollLeaseOwned = false;
let pollLeaseOwnerKey: string | undefined;
let pollLeaseStatusKey: string | undefined;
let pollLeaseTokenHash: string | undefined;
let pollLeaseRenewTimer: ReturnType<typeof setInterval> | undefined;
let pollLeaseRetryTimer: ReturnType<typeof setTimeout> | undefined;
let pollLeaseRetryAttempts = 0;

/** Expose the raw grammy Bot instance for streaming (telegram-stream.ts). */
export function getBot(): Bot | undefined {
  return bot;
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
  ): Promise<void> {
    const chatId = resolveTargetChatId(target);
    if (chatId === undefined) {
      console.error("[gateway:telegram] cannot send telegram message: invalid target", { target });
      return;
    }
    const resolved = resolveSendInput(message, options);
    const payload = resolved.format ? { text: resolved.text, format: resolved.format } : resolved.text;
    await sendTelegramMessage(chatId, payload, resolved.options);
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

    await sendTelegramMedia(chatId, media, { replyTo });
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

    console.log("[gateway:telegram] message received", {
      chatId,
      length: text.length,
    });

    const prompt = await enrichPromptWithVaultContext(text);
    emitInboundMessage({
      source: "telegram",
      prompt,
      metadata: {
        telegramChatId: chatId,
        telegramMessageId: ctx.message.message_id,
      },
      replyTo: ctx.message.reply_to_message ? String(ctx.message.reply_to_message.message_id) : undefined,
    });
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
  // NOTE: pitch: and mcq: prefixed callbacks are handled by dedicated handlers
  // registered in telegram-handler.ts via configureBot(). Pass them through.
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.callbackQuery.message?.chat.id;
    const messageId = ctx.callbackQuery.message?.message_id;

    console.log("[gateway:telegram] callback_query", { data, chatId, messageId });

    // Let dedicated handlers process their own prefixes
    if (data.startsWith("pitch:") || data.startsWith("mcq:")) {
      console.log(`[gateway:telegram] delegating ${data.split(":")[0]}: callback to dedicated handler`);
      await next();
      return;
    }
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

  const startPolling = (): void => {
    if (!bot || !started) return;
    if (pollingActive || pollingStarting) return;
    if (TELEGRAM_POLL_LEASE_ENABLED && !pollLeaseOwned) return;

    // Long polling is single-consumer per bot token. If another process currently
    // owns getUpdates, Telegram returns 409. Retry with backoff instead of
    // permanently disabling the channel on first conflict.
    pollingStarting = true;
    void bot.start({
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
    }).catch((error) => {
      pollingStarting = false;
      pollingActive = false;

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

  const formattedOutput = formatByEnvelope(text, sendInput.format);
  const { text: formattedText, parseAsHtml, chunkMode } = formattedOutput;
  if (!parseAsHtml) {
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
  const chunks = chunkMode === "markdown"
    ? telegramConverter.chunk(text)
    : chunkMessage(formattedText);
  const sendStartedAt = Date.now();

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const isLast = i === chunks.length - 1;

    try {
      const sent = await bot.api.sendMessage(chatId, chunk, {
        ...(parseAsHtml ? { parse_mode: "HTML" as const } : {}),
        // Only attach buttons to the last chunk
        ...(isLast && replyMarkup ? { reply_markup: replyMarkup } : {}),
        ...(mergedOptions?.replyTo ? { reply_parameters: { message_id: mergedOptions.replyTo } } : {}),
        ...(mergedOptions?.silent ? { disable_notification: true } : {}),
        ...(mergedOptions?.noPreview ? { link_preview_options: { is_disabled: true } } : {}),
      });
      // ADR-0209: Record outbound message ID for thread reply-to tracking
      if (isLast && sent?.message_id && _onOutboundMessageId) {
        _onOutboundMessageId(sent.message_id);
      }
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
        await bot.api.sendMessage(chatId, stripHtmlTags(formattedText).slice(0, CHUNK_MAX), {
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
 * Detects kind from MIME type and dispatches to appropriate Bot API method.
 */
async function sendTelegramMedia(
  chatId: number,
  media: SendMediaPayload,
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

  const source = media.path ?? media.url;
  if (!source) {
    console.error("[gateway:telegram] sendMedia requires media.path or media.url", { chatId });
    return;
  }

  const mimeType = media.mimeType || (media.path ? mimeFromExt(extname(media.path) || ".bin") : "application/octet-stream");
  const kind = mediaKindFromMimeType(mimeType, media.path);
  const sendAsVoice = options?.asVoice ?? mimeType === "audio/ogg";

  // Show appropriate typing indicator
  const action = kind === "photo" ? "upload_photo"
    : kind === "video" ? "upload_video"
    : kind === "audio" ? "upload_voice"
    : "upload_document";
  try { await bot.api.sendChatAction(chatId, action); } catch {}

  const file = media.path ? new InputFile(media.path) : media.url!;
  const caption = media.caption ?? options?.caption;
  const params = {
    ...(caption ? { caption, parse_mode: "HTML" as const } : {}),
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
        if (sendAsVoice) {
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
    console.log("[gateway:telegram] media sent", { chatId, kind, mimeType, source });
    void emitGatewayOtel({
      level: "info",
      component: "telegram-channel",
      action: "telegram.send_media.completed",
      success: true,
      metadata: { chatId, kind, mimeType },
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
): Promise<void> {
  const instance = getDefaultTelegramChannel();
  await instance.sendWithLegacy(String(chatId), message, options);
}

export async function sendMedia(
  chatId: number,
  filePath: string,
  options?: { caption?: string; replyTo?: number; asVoice?: boolean },
): Promise<void> {
  const mimeType = mimeFromExt(extname(filePath) || ".bin");
  await sendTelegramMedia(chatId, {
    path: filePath,
    mimeType,
    caption: options?.caption,
  }, options);
}

export async function shutdown(): Promise<void> {
  const instance = getDefaultTelegramChannel();
  await instance.stop();
}

async function shutdownTelegramChannel(): Promise<void> {
  started = false;
  clearPollLeaseRetryTimer();
  clearPollLeaseRenewTimer();
  stopPolling();

  await writePollLeaseStatus("stopped", {
    reason: "shutdown",
  });
  await releasePollLease();
  await closePollLeaseClient();

  pollLeaseOwned = false;
  pollLeaseRetryAttempts = 0;
  pollLeaseOwnerKey = undefined;
  pollLeaseStatusKey = undefined;
  pollLeaseTokenHash = undefined;

  if (bot) {
    bot.stop();
    bot = undefined;
  }

  console.log("[gateway:telegram] stopped");
  void emitGatewayOtel({
    level: "info",
    component: "telegram-channel",
    action: "telegram.channel.stopped",
    success: true,
  });
}
