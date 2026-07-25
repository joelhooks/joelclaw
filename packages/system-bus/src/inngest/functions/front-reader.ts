/**
 * Front poll reader — reliable backstop for channel email projection.
 *
 * Webhooks stay as the fast path. This cron pulls Front events with the private
 * API token and emits the same `channel/message.received` seam so ingest,
 * classification, thread aggregation, and Front Projection health stay green
 * even when Front stops delivering webhooks.
 */

import { NonRetriableError } from "inngest";
import { getRedisClient } from "../../lib/redis";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

export const FRONT_API = "https://api2.frontapp.com";
export const FRONT_READER_WATERMARK_KEY = "health:front-reader:watermark_emitted_at_ms";
/** Hourly backstop; webhooks remain the fast path. */
export const FRONT_READER_CRON = "0 * * * *";

/** Re-read a little so clock skew / late index cannot drop a message. Independent of cron cadence. */
export const FRONT_READER_OVERLAP_MS = 5 * 60 * 1000;

/**
 * First run (or empty watermark) only reaches back this far.
 * The 2026-07-21 outage is inside a 7d window; older history is reported skipped.
 */
export const FRONT_READER_MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export const FRONT_READER_PAGE_SIZE = 100;
export const FRONT_READER_MAX_PAGES = 15;
export const FRONT_READER_TIMEOUT_MS = Number(process.env.JOELCLAW_FRONT_READER_TIMEOUT_MS ?? "8000");
export const FRONT_READER_MAX_RETRIES = 4;
export const RETRYABLE_FRONT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const MESSAGE_EVENT_TYPES = ["inbound", "outbound"] as const;

export type FrontReaderWatermarkStore = {
  get: () => Promise<number | null>;
  set: (watermarkMs: number) => Promise<void>;
};

export type FrontReaderFetchResult = {
  events: FrontEventRecord[];
  truncated: boolean;
  pagesFetched: number;
};

export type FrontReaderDependencies = {
  now: () => number;
  getToken: () => string | undefined;
  watermark: FrontReaderWatermarkStore;
  fetchEvents: (input: {
    token: string;
    afterMs: number;
    maxPages: number;
  }) => Promise<FrontReaderFetchResult>;
  send: (events: Array<{ name: string; data: Record<string, unknown> }>) => Promise<unknown>;
  emit: (input: Parameters<typeof emitOtelEvent>[0]) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
};

export type FrontEventRecord = {
  id: string;
  type: string;
  emittedAtMs: number;
  conversationId: string;
  subject: string;
  messageId: string;
  from: string;
  fromName: string;
  text: string;
  isInbound: boolean;
  createdAtMs: number;
};

export type ChannelMessageReceivedData = {
  channelType: "email";
  channelId: string;
  channelName: string;
  threadId: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: number;
  sourceUrl?: string;
  frontMessageId?: string;
  frontEventId?: string;
};

export type FrontReaderRunResult = {
  status: "ok" | "empty";
  watermarkBeforeMs: number | null;
  watermarkAfterMs: number | null;
  afterMs: number;
  lookbackBounded: boolean;
  skippedBeforeMs: number | null;
  conversationsScanned: number;
  eventsScanned: number;
  messagesEmitted: number;
  truncated: boolean;
  pagesFetched: number;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function stripHtmlToText(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/<br\s*\/?>/giu, "\n")
      .replace(/<\/p>/giu, "\n")
      .replace(/<script[\s\S]*?<\/script>/giu, " ")
      .replace(/<style[\s\S]*?<\/style>/giu, " ")
      .replace(/<[^>]+>/gu, " ")
      .replace(/&nbsp;/gu, " ")
      .replace(/&amp;/gu, "&")
      .replace(/&lt;/gu, "<")
      .replace(/&gt;/gu, ">"),
  );
}

export function toTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? Math.trunc(value) : Math.trunc(value * 1000);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric > 1_000_000_000_000 ? Math.trunc(numeric) : Math.trunc(numeric * 1000);
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function requireFrontApiToken(token: string | undefined): string {
  const normalized = token?.trim() ?? "";
  if (!normalized) {
    throw new NonRetriableError("FRONT_API_TOKEN missing — front reader cannot poll without credentials");
  }
  return normalized;
}

/**
 * Resolve the inclusive lower bound for this poll.
 * Empty watermark → bound first run to max lookback and report the clamp.
 */
export function resolvePollWindow(input: {
  nowMs: number;
  watermarkMs: number | null;
  overlapMs?: number;
  maxLookbackMs?: number;
}): {
  afterMs: number;
  watermarkBeforeMs: number | null;
  lookbackBounded: boolean;
  skippedBeforeMs: number | null;
} {
  const overlapMs = input.overlapMs ?? FRONT_READER_OVERLAP_MS;
  const maxLookbackMs = input.maxLookbackMs ?? FRONT_READER_MAX_LOOKBACK_MS;
  const floorMs = input.nowMs - maxLookbackMs;

  if (input.watermarkMs == null || !Number.isFinite(input.watermarkMs) || input.watermarkMs <= 0) {
    return {
      afterMs: floorMs,
      watermarkBeforeMs: null,
      lookbackBounded: true,
      skippedBeforeMs: floorMs,
    };
  }

  const afterMs = Math.max(floorMs, input.watermarkMs - overlapMs);
  return {
    afterMs,
    watermarkBeforeMs: input.watermarkMs,
    lookbackBounded: afterMs === floorMs && input.watermarkMs - overlapMs < floorMs,
    skippedBeforeMs: afterMs === floorMs && input.watermarkMs - overlapMs < floorMs ? floorMs : null,
  };
}

export function advanceWatermark(input: {
  previousWatermarkMs: number | null;
  maxEmittedAtMs: number | null;
}): number | null {
  if (input.maxEmittedAtMs == null || !Number.isFinite(input.maxEmittedAtMs) || input.maxEmittedAtMs <= 0) {
    return input.previousWatermarkMs;
  }

  if (input.previousWatermarkMs == null || input.maxEmittedAtMs > input.previousWatermarkMs) {
    return input.maxEmittedAtMs;
  }

  return input.previousWatermarkMs;
}

function deriveMessageText(messageData: Record<string, unknown>): string {
  const text = normalizeWhitespace(String(messageData.text ?? ""));
  if (text) return text;

  const blurb = normalizeWhitespace(String(messageData.blurb ?? ""));
  if (blurb) return blurb;

  const body = stripHtmlToText(String(messageData.body ?? ""));
  if (body) return body;

  const attachmentCount = Array.isArray(messageData.attachments) ? messageData.attachments.length : 0;
  if (attachmentCount > 0) {
    return `[Attachment-only message: ${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}]`;
  }

  return "";
}

function normalizeFrontSender(messageData: Record<string, unknown>): { from: string; fromName: string } {
  const author = (messageData.author ?? {}) as Record<string, unknown>;
  const recipients = Array.isArray(messageData.recipients)
    ? messageData.recipients.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
  const fromRecipient = recipients.find((recipient) => String(recipient.role ?? "") === "from");

  const from = String(fromRecipient?.handle ?? author.email ?? author.username ?? "").trim();
  const fromName = normalizeWhitespace(
    String(
      fromRecipient?.name
        || [author.first_name, author.last_name].filter(Boolean).join(" ")
        || author.username
        || author.email
        || from
        || "unknown",
    ),
  );

  return {
    from: from || "unknown",
    fromName: fromName || from || "unknown",
  };
}

export function normalizeFrontEvent(raw: Record<string, unknown>): FrontEventRecord | null {
  const type = String(raw.type ?? "").trim();
  if (type !== "inbound" && type !== "outbound") return null;

  const conversation = (raw.conversation ?? {}) as Record<string, unknown>;
  const target = (raw.target ?? {}) as Record<string, unknown>;
  const messageData = (target.data ?? {}) as Record<string, unknown>;

  const conversationId = String(conversation.id ?? "").trim();
  const messageId = String(messageData.id ?? "").trim();
  if (!conversationId || !messageId) return null;

  const emittedAtMs = toTimestampMs(raw.emitted_at ?? raw.emittedAt) ?? null;
  const createdAtMs =
    toTimestampMs(messageData.created_at ?? messageData.createdAt ?? messageData.received_at)
    ?? emittedAtMs;
  if (emittedAtMs == null || createdAtMs == null) return null;

  const text = deriveMessageText(messageData);
  if (!text) return null;

  const sender = normalizeFrontSender(messageData);
  return {
    id: String(raw.id ?? `${type}:${messageId}`),
    type,
    emittedAtMs,
    conversationId,
    subject: String(messageData.subject ?? conversation.subject ?? "").trim() || "email",
    messageId,
    from: sender.from,
    fromName: sender.fromName,
    text,
    isInbound: type === "inbound" || Boolean(messageData.is_inbound ?? messageData.isInbound),
    createdAtMs,
  };
}

export function buildChannelMessageData(event: FrontEventRecord): ChannelMessageReceivedData {
  const senderLabel =
    event.fromName && event.from && event.fromName.toLowerCase() !== event.from.toLowerCase()
      ? `${event.fromName} (${event.from})`
      : event.fromName || event.from;

  return {
    channelType: "email",
    channelId: event.conversationId,
    channelName: event.subject,
    threadId: event.conversationId,
    userId: event.from,
    userName: senderLabel,
    text: event.text.slice(0, 2000),
    timestamp: event.createdAtMs,
    sourceUrl: `https://app.frontapp.com/open/${event.conversationId}`,
    frontMessageId: event.messageId,
    frontEventId: event.id,
  };
}

/**
 * Stable channel message identity inputs for a Front message.
 * Overlap polls must produce the same document id for the same Front message.
 */
export function stableChannelMessageIdentity(event: FrontEventRecord): {
  channelType: "email";
  channelId: string;
  threadId: string;
  userId: string;
  timestamp: number;
  text: string;
} {
  const data = buildChannelMessageData(event);
  return {
    channelType: data.channelType,
    channelId: data.channelId,
    threadId: data.threadId,
    userId: data.userId,
    timestamp: data.timestamp,
    text: data.text,
  };
}

function extractPageToken(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    return new URL(value).searchParams.get("page_token");
  } catch {
    return null;
  }
}

function retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(30_000, Math.max(250, Math.trunc(seconds * 1000)));
    }
  }
  // 500, 1000, 2000, 4000...
  return Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 1));
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchFrontEventsPage(input: {
  token: string;
  afterMs: number;
  pageToken?: string | null;
  limit?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}): Promise<{ events: FrontEventRecord[]; nextPageToken: string | null }> {
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const fetchImpl = input.fetchImpl ?? fetch;
  const limit = input.limit ?? FRONT_READER_PAGE_SIZE;
  const timeoutMs = input.timeoutMs ?? FRONT_READER_TIMEOUT_MS;

  const url = new URL(`${FRONT_API}/events`);
  url.searchParams.set("limit", String(limit));
  // Front q[after] is unix seconds (fractional ok).
  url.searchParams.set("q[after]", (input.afterMs / 1000).toFixed(3));
  for (const type of MESSAGE_EVENT_TYPES) {
    url.searchParams.append("q[types]", type);
  }
  if (input.pageToken) {
    url.searchParams.set("page_token", input.pageToken);
  }

  const headers = {
    Authorization: `Bearer ${input.token}`,
    Accept: "application/json",
  };

  let attempt = 0;
  while (true) {
    attempt += 1;
    const response = await fetchJsonWithTimeout(
      url.toString(),
      { headers, method: "GET" },
      timeoutMs,
      fetchImpl,
    );

    if (response.ok) {
      const body = (await response.json()) as Record<string, unknown>;
      const results = Array.isArray(body._results) ? body._results : [];
      const events: FrontEventRecord[] = [];
      for (const item of results) {
        if (!item || typeof item !== "object") continue;
        const normalized = normalizeFrontEvent(item as Record<string, unknown>);
        if (normalized) events.push(normalized);
      }
      const nextPageToken = extractPageToken((body._pagination as Record<string, unknown> | undefined)?.next);
      return { events, nextPageToken };
    }

    const status = response.status;
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    if (!RETRYABLE_FRONT_STATUSES.has(status) || attempt > FRONT_READER_MAX_RETRIES) {
      throw new Error(`front events ${status}${detail ? `: ${detail}` : ""}`);
    }

    await sleep(retryDelayMs(attempt, response.headers.get("retry-after")));
  }
}

export async function fetchFrontEventsSince(input: {
  token: string;
  afterMs: number;
  maxPages?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}): Promise<FrontReaderFetchResult> {
  const maxPages = input.maxPages ?? FRONT_READER_MAX_PAGES;
  const events: FrontEventRecord[] = [];
  let pageToken: string | null = null;
  let pagesFetched = 0;
  let truncated = false;

  while (pagesFetched < maxPages) {
    const page = await fetchFrontEventsPage({
      token: input.token,
      afterMs: input.afterMs,
      pageToken,
      sleep: input.sleep,
      fetchImpl: input.fetchImpl,
    });
    pagesFetched += 1;
    events.push(...page.events);

    if (!page.nextPageToken) {
      truncated = false;
      break;
    }

    pageToken = page.nextPageToken;
    if (pagesFetched >= maxPages) {
      truncated = true;
      break;
    }
  }

  return { events, truncated, pagesFetched };
}

function defaultWatermarkStore(): FrontReaderWatermarkStore {
  return {
    async get() {
      const raw = await getRedisClient().get(FRONT_READER_WATERMARK_KEY);
      if (!raw) return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    },
    async set(watermarkMs: number) {
      await getRedisClient().set(FRONT_READER_WATERMARK_KEY, String(watermarkMs));
    },
  };
}

const defaultDependencies: FrontReaderDependencies = {
  now: () => Date.now(),
  getToken: () => process.env.FRONT_API_TOKEN,
  watermark: defaultWatermarkStore(),
  fetchEvents: ({ token, afterMs, maxPages }) =>
    fetchFrontEventsSince({ token, afterMs, maxPages }),
  send: (events) => inngest.send(events as Parameters<typeof inngest.send>[0]),
  emit: emitOtelEvent,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function runFrontReader(deps: FrontReaderDependencies): Promise<FrontReaderRunResult> {
  const token = requireFrontApiToken(deps.getToken());
  const nowMs = deps.now();
  const watermarkBeforeMs = await deps.watermark.get();
  const window = resolvePollWindow({ nowMs, watermarkMs: watermarkBeforeMs });

  let fetchResult: FrontReaderFetchResult;
  try {
    fetchResult = await deps.fetchEvents({
      token,
      afterMs: window.afterMs,
      maxPages: FRONT_READER_MAX_PAGES,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.emit({
      level: "error",
      source: "worker",
      component: "front-reader",
      action: "front.reader.poll",
      success: false,
      error: message.slice(0, 500),
      metadata: {
        watermarkBeforeMs,
        afterMs: window.afterMs,
      },
    });
    throw error;
  }

  // Dedupe by Front message id within the poll (overlap + multi-event).
  const byMessageId = new Map<string, FrontEventRecord>();
  for (const event of fetchResult.events) {
    const prior = byMessageId.get(event.messageId);
    if (!prior || event.emittedAtMs >= prior.emittedAtMs) {
      byMessageId.set(event.messageId, event);
    }
  }

  const uniqueEvents = [...byMessageId.values()].sort((left, right) => left.createdAtMs - right.createdAtMs);
  const channelEvents = uniqueEvents.map((event) => ({
    name: "channel/message.received",
    data: buildChannelMessageData(event) as Record<string, unknown>,
  }));

  if (channelEvents.length > 0) {
    // Batch in chunks to avoid huge payloads.
    const chunkSize = 50;
    for (let index = 0; index < channelEvents.length; index += chunkSize) {
      await deps.send(channelEvents.slice(index, index + chunkSize));
    }
  }

  const maxEmittedAtMs = fetchResult.events.reduce<number | null>((max, event) => {
    if (max == null || event.emittedAtMs > max) return event.emittedAtMs;
    return max;
  }, null);

  const watermarkAfterMs = advanceWatermark({
    previousWatermarkMs: watermarkBeforeMs,
    maxEmittedAtMs,
  });

  if (watermarkAfterMs != null && watermarkAfterMs !== watermarkBeforeMs) {
    await deps.watermark.set(watermarkAfterMs);
  }

  const conversationIds = new Set(uniqueEvents.map((event) => event.conversationId));
  const minFetchedEmittedAtMs = fetchResult.events.reduce<number | null>((min, event) => {
    if (min == null || event.emittedAtMs < min) return event.emittedAtMs;
    return min;
  }, null);

  // Prefer the truncation bound when the page budget cut a window short;
  // otherwise report the first-run lookback clamp.
  const skippedBeforeMs = fetchResult.truncated
    ? (minFetchedEmittedAtMs ?? window.skippedBeforeMs)
    : window.skippedBeforeMs;

  const result: FrontReaderRunResult = {
    status: channelEvents.length > 0 ? "ok" : "empty",
    watermarkBeforeMs,
    watermarkAfterMs,
    afterMs: window.afterMs,
    lookbackBounded: window.lookbackBounded,
    skippedBeforeMs,
    conversationsScanned: conversationIds.size,
    eventsScanned: fetchResult.events.length,
    messagesEmitted: channelEvents.length,
    truncated: fetchResult.truncated,
    pagesFetched: fetchResult.pagesFetched,
  };

  await deps.emit({
    level: fetchResult.truncated ? "warn" : "info",
    source: "worker",
    component: "front-reader",
    action: "front.reader.poll",
    success: true,
    metadata: {
      ...result,
    },
  });

  return result;
}

export function createFrontReaderFunction(dependencies: FrontReaderDependencies = defaultDependencies) {
  return inngest.createFunction(
    {
      id: "front/message-reader",
      name: "Front Message Reader",
      concurrency: { scope: "account", key: "front-api", limit: 1 },
      retries: 2,
    },
    [
      { cron: FRONT_READER_CRON },
      { event: "front/reader.poll" },
    ],
    async ({ step }) => {
      // Fail loud before any step work when credentials are absent.
      requireFrontApiToken(dependencies.getToken());

      return await step.run("poll-front-and-emit", async () => runFrontReader(dependencies));
    },
  );
}

export const frontMessageReader = createFrontReaderFunction();
