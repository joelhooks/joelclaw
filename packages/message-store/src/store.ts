import { createHash } from "node:crypto";
import type Redis from "ioredis";
import {
  type CandidateMessage,
  type DrainByPriorityOptions,
  type InboundMessage,
  type PersistResult,
  Priority,
  type StoredMessage,
  type TelemetryEmitter,
} from "./types";

const STREAM_KEY = "joelclaw:gateway:messages";
const PRIORITY_KEY = "joelclaw:gateway:priority";
const DEDUP_KEY_PREFIX = "joelclaw:gateway:dedup:";
const CONSUMER_GROUP = "gateway-session";
const CONSUMER_NAME = "daemon";
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FETCH_BATCH_SIZE = 100;
const PRIORITY_FACTOR = 1_000_000_000_000;
const DEDUP_WINDOW_SECONDS = 30;
const AGING_PROMOTION_MS = 5 * 60 * 1000;
const P3_AUTO_ACK_MS = 60 * 1000;
const P3_COALESCE_MS = 60 * 1000;
const DRAIN_SCAN_LIMIT = 256;

let redisClient: Redis | undefined;
let p0DrainStreak = 0;
let telemetryEmitter: TelemetryEmitter = {
  emit: () => {},
};

function emitMessageStoreTelemetry(action: string, detail: string, extra?: Record<string, unknown>): void {
  telemetryEmitter.emit(action, detail, {
    ...(extra ?? {}),
  });
}

function getClient(): Redis {
  if (!redisClient) {
    throw new Error("[gateway:store] redis client not initialized");
  }
  return redisClient;
}

function toPriority(value: number): Priority {
  if (value <= Priority.P0) return Priority.P0;
  if (value === Priority.P1) return Priority.P1;
  if (value === Priority.P2) return Priority.P2;
  return Priority.P3;
}

function priorityName(priority: Priority): "P0" | "P1" | "P2" | "P3" {
  if (priority === Priority.P0) return "P0";
  if (priority === Priority.P1) return "P1";
  if (priority === Priority.P2) return "P2";
  return "P3";
}

function scoreForPriority(priority: Priority, timestamp: number): number {
  return (priority * PRIORITY_FACTOR) + timestamp;
}

function parseFields(fields: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(fields)) return out;

  for (let i = 0; i < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (typeof key === "string" && typeof value === "string") {
      out[key] = value;
    }
  }

  return out;
}

function parseMetadata(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed metadata
  }

  return undefined;
}

function extractEventHints(metadata?: Record<string, unknown>): string[] {
  if (!metadata) return [];
  const out: string[] = [];

  const pushEvent = (value: unknown): void => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) out.push(trimmed);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          const trimmed = item.trim();
          if (trimmed.length > 0) out.push(trimmed);
        }
      }
    }
  };

  pushEvent(metadata.event);
  pushEvent(metadata.eventType);
  pushEvent(metadata.type);
  pushEvent(metadata.eventTypes);

  const digestTypes = metadata.digestTypes;
  if (digestTypes && typeof digestTypes === "object" && !Array.isArray(digestTypes)) {
    out.push(...Object.keys(digestTypes));
  }

  return out;
}

function hashDedupKey(source: string, prompt: string): string {
  const contentPrefix = prompt.slice(0, 100);
  return createHash("sha256")
    .update(source)
    .update("\n")
    .update(contentPrefix)
    .digest("hex");
}

function streamIdToTimestamp(streamId: string): number {
  const first = streamId.split("-")[0];
  const parsed = Number.parseInt(first ?? "", 10);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function classifyPriority(msg: InboundMessage): Priority {
  const prompt = msg.prompt.trim();
  const lowerSource = msg.source.toLowerCase();
  const eventHints = Array.isArray(msg.event)
    ? msg.event
    : (typeof msg.event === "string" ? [msg.event] : []);
  const lowerHints = eventHints.map((event) => event.toLowerCase());

  if (prompt.startsWith("/")) return Priority.P0;
  if (msg.source === "callback_query") return Priority.P0;

  if (lowerSource === "telegram" || lowerSource.startsWith("telegram:") || lowerSource.startsWith("telegram.") || lowerHints.some((event) => event.includes("telegram.human"))) {
    return Priority.P1;
  }
  if (lowerHints.some((event) => /deploy\.failed|friction-fix/u.test(event))) {
    return Priority.P1;
  }
  if (lowerSource === "heartbeat" || lowerHints.some((event) => /heartbeat|cron\.heartbeat/u.test(event))) {
    return Priority.P2;
  }

  return Priority.P3;
}

function entryToStoredMessage(entry: [string, unknown], acked: boolean): StoredMessage {
  const [id, fieldList] = entry;
  const fields = parseFields(fieldList);
  const timestampFromField = Number.parseInt(fields.timestamp ?? "", 10);
  const metadata = parseMetadata(fields.metadata);
  const priorityFromField = Number.parseInt(fields.priority ?? "", 10);
  const inferredPriority = classifyPriority({
    source: fields.source ?? "unknown",
    prompt: fields.prompt ?? "",
    metadata,
    event: extractEventHints(metadata),
  });
  const priority = Number.isFinite(priorityFromField)
    ? toPriority(priorityFromField)
    : inferredPriority;

  return {
    id,
    source: fields.source ?? "unknown",
    prompt: fields.prompt ?? "",
    metadata,
    timestamp: Number.isFinite(timestampFromField) ? timestampFromField : streamIdToTimestamp(id),
    priority,
    acked,
  };
}

export async function init(redis: Redis, telemetry?: TelemetryEmitter): Promise<void> {
  telemetryEmitter = telemetry ?? { emit: () => {} };
  redisClient = redis;

  try {
    await redis.xgroup("CREATE", STREAM_KEY, CONSUMER_GROUP, "$", "MKSTREAM");
    console.log("[gateway:store] initialized stream + consumer group", {
      stream: STREAM_KEY,
      group: CONSUMER_GROUP,
      consumer: CONSUMER_NAME,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("BUSYGROUP")) {
      console.log("[gateway:store] consumer group exists", {
        stream: STREAM_KEY,
        group: CONSUMER_GROUP,
        consumer: CONSUMER_NAME,
      });
      return;
    }
    throw error;
  }
}

export async function persist(msg: {
  source: string;
  prompt: string;
  metadata?: Record<string, unknown>;
}): Promise<PersistResult | null> {
  const redis = getClient();
  const timestamp = Date.now();
  const metadata = msg.metadata ? JSON.stringify(msg.metadata) : "";
  const priority = classifyPriority({
    source: msg.source,
    prompt: msg.prompt,
    metadata: msg.metadata,
    event: extractEventHints(msg.metadata),
  });

  const streamId = await redis.xadd(
    STREAM_KEY,
    "*",
    "source",
    msg.source,
    "prompt",
    msg.prompt,
    "metadata",
    metadata,
    "timestamp",
    `${timestamp}`,
    "priority",
    `${priority}`,
  );

  if (!streamId) {
    throw new Error("[gateway:store] xadd returned empty stream id");
  }

  await redis.zadd(PRIORITY_KEY, `${scoreForPriority(priority, timestamp)}`, streamId);

  const dedupKey = `${DEDUP_KEY_PREFIX}${hashDedupKey(msg.source, msg.prompt)}`;
  const dedupResult = await redis.set(dedupKey, streamId, "EX", DEDUP_WINDOW_SECONDS, "NX");
  if (dedupResult !== "OK") {
    await redis.zrem(PRIORITY_KEY, streamId);
    await redis.xdel(STREAM_KEY, streamId);
    console.log("[gateway:store] dropped duplicate inbound message", {
      streamId,
      source: msg.source,
      dedupWindowSeconds: DEDUP_WINDOW_SECONDS,
    });
    return null;
  }

  emitMessageStoreTelemetry("message.queued", "debug", {
      source: msg.source,
      streamId,
      priority,
      priority_label: priorityName(priority),
      wait_time_ms: 0,
  });

  console.log("[gateway:store] persisted inbound message", {
    streamId,
    source: msg.source,
    priority: priorityName(priority),
  });

  return { streamId, priority };
}

/**
 * Mark a message as resolved — removes it from the stream entirely.
 *
 * We use XDEL (not XACK) because inline messages go through persist() → XADD
 * but are never claimed via XREADGROUP, so they're not in the consumer group's
 * Pending Entries List. XACK on an unclaimed message is a silent no-op (returns 0).
 * XDEL actually removes the entry, preventing replay on restart.
 *
 * For messages that WERE claimed (via replayUnacked → readNeverClaimed → XREADGROUP),
 * we also XACK to clean up the PEL before deleting.
 */
export async function ack(streamId: string): Promise<void> {
  const redis = getClient();

  // XACK first (cleans PEL if message was claimed; no-op if not)
  await redis.xack(STREAM_KEY, CONSUMER_GROUP, streamId);
  // XDEL actually removes the entry from the stream
  const deleted = await redis.xdel(STREAM_KEY, streamId);
  await redis.zrem(PRIORITY_KEY, streamId);

  console.log("[gateway:store] resolved", {
    streamId,
    deleted,
  });
}

async function loadByStreamId(streamId: string): Promise<StoredMessage | undefined> {
  const redis = getClient();
  const raw = (await redis.xrange(
    STREAM_KEY,
    streamId,
    streamId,
    "COUNT",
    "1",
  )) as unknown;

  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const entry = raw[0];
  if (!Array.isArray(entry) || typeof entry[0] !== "string") return undefined;
  return entryToStoredMessage(entry as [string, unknown], false);
}

async function autoAckExpiredP3(now: number): Promise<number> {
  const redis = getClient();
  const ids = await redis.zrevrange(PRIORITY_KEY, 0, DRAIN_SCAN_LIMIT - 1);
  if (ids.length === 0) return 0;

  let autoAcked = 0;
  for (const streamId of ids) {
    const msg = await loadByStreamId(streamId);
    if (!msg) {
      await redis.zrem(PRIORITY_KEY, streamId);
      continue;
    }
    if (msg.priority !== Priority.P3) {
      break;
    }

    const waitTimeMs = Math.max(0, now - msg.timestamp);
    if (waitTimeMs <= P3_AUTO_ACK_MS) {
      continue;
    }

    await ack(streamId);
    autoAcked += 1;
    emitMessageStoreTelemetry("message.auto_acked", "info", {
      streamId,
      source: msg.source,
      priority: msg.priority,
      priority_label: priorityName(msg.priority),
      wait_time_ms: waitTimeMs,
    });
  }

  return autoAcked;
}

function candidateComparator(a: CandidateMessage, b: CandidateMessage): number {
  if (a.effectivePriority !== b.effectivePriority) {
    return a.effectivePriority - b.effectivePriority;
  }
  if (a.message.timestamp !== b.message.timestamp) {
    return a.message.timestamp - b.message.timestamp;
  }
  return a.message.id.localeCompare(b.message.id);
}

function chooseCandidate(candidates: CandidateMessage[]): CandidateMessage | undefined {
  if (candidates.length === 0) return undefined;
  const sorted = [...candidates].sort(candidateComparator);
  const highest = sorted[0];
  if (!highest) return undefined;

  if (highest.effectivePriority !== Priority.P0) {
    p0DrainStreak = 0;
    return highest;
  }

  const lower = sorted.find((candidate) => candidate.effectivePriority !== Priority.P0);
  if (!lower) {
    p0DrainStreak += 1;
    return highest;
  }

  if (p0DrainStreak >= 3) {
    p0DrainStreak = 0;
    return lower;
  }

  p0DrainStreak += 1;
  return highest;
}

async function loadPriorityCandidates(
  excludeIds: Set<string>,
  now: number,
): Promise<CandidateMessage[]> {
  const redis = getClient();
  const ids = await redis.zrange(PRIORITY_KEY, 0, DRAIN_SCAN_LIMIT - 1);
  if (ids.length === 0) return [];

  const candidates: CandidateMessage[] = [];
  for (const streamId of ids) {
    if (excludeIds.has(streamId)) continue;

    const msg = await loadByStreamId(streamId);
    if (!msg) {
      await redis.zrem(PRIORITY_KEY, streamId);
      continue;
    }

    const waitTimeMs = Math.max(0, now - msg.timestamp);
    if (msg.priority === Priority.P3 && waitTimeMs > P3_AUTO_ACK_MS) {
      await ack(streamId);
      emitMessageStoreTelemetry("message.auto_acked", "info", {
        streamId,
        source: msg.source,
        priority: msg.priority,
        priority_label: priorityName(msg.priority),
        wait_time_ms: waitTimeMs,
      });
      continue;
    }

    const shouldPromote = (msg.priority === Priority.P2 || msg.priority === Priority.P3)
      && waitTimeMs >= AGING_PROMOTION_MS;
    const effectivePriority = shouldPromote
      ? toPriority(msg.priority - 1)
      : msg.priority;

    candidates.push({
      message: msg,
      waitTimeMs,
      effectivePriority,
      ...(shouldPromote ? { promotedFrom: msg.priority } : {}),
    });
  }

  return candidates;
}

async function coalesceP3Message(
  selected: CandidateMessage,
  candidates: CandidateMessage[],
  now: number,
): Promise<StoredMessage> {
  if (selected.message.priority !== Priority.P3) return selected.message;

  const coalescible = candidates
    .filter((candidate) =>
      candidate.message.priority === Priority.P3
      && Math.max(0, now - candidate.message.timestamp) <= P3_COALESCE_MS,
    )
    .sort((a, b) => a.message.timestamp - b.message.timestamp);

  if (coalescible.length <= 1) return selected.message;

  const keeper = coalescible[0];
  if (!keeper) return selected.message;

  const suppressed = coalescible.filter((candidate) => candidate.message.id !== keeper.message.id);
  for (const item of suppressed) {
    await ack(item.message.id);
  }

  const coalescedCount = coalescible.length;
  const summary: StoredMessage = {
    ...keeper.message,
    prompt: `${coalescedCount} probe events suppressed`,
    metadata: {
      ...(keeper.message.metadata ?? {}),
      coalescedCount,
      coalescedIds: coalescible.map((candidate) => candidate.message.id),
    },
  };

  emitMessageStoreTelemetry("message.coalesced", "info", {
      streamId: keeper.message.id,
      priority: keeper.message.priority,
      priority_label: priorityName(keeper.message.priority),
      wait_time_ms: Math.max(0, now - keeper.message.timestamp),
      coalescedCount,
  });

  return summary;
}

export async function drainByPriority(options?: DrainByPriorityOptions): Promise<StoredMessage[]> {
  const excludeIds = new Set<string>(options?.excludeIds ?? []);
  const limit = Math.max(1, options?.limit ?? 1);
  const drained: StoredMessage[] = [];

  while (drained.length < limit) {
    const now = Date.now();
    await autoAckExpiredP3(now);

    const candidates = await loadPriorityCandidates(excludeIds, now);
    const selected = chooseCandidate(candidates);
    if (!selected) break;

    const message = await coalesceP3Message(selected, candidates, now);
    const finalCandidate = candidates.find((candidate) => candidate.message.id === message.id) ?? selected;

    if (finalCandidate.promotedFrom !== undefined) {
      emitMessageStoreTelemetry("message.promoted", "info", {
        streamId: finalCandidate.message.id,
        source: finalCandidate.message.source,
        priority: finalCandidate.effectivePriority,
        priority_label: priorityName(finalCandidate.effectivePriority),
        previous_priority: finalCandidate.promotedFrom,
        previous_priority_label: priorityName(finalCandidate.promotedFrom),
        wait_time_ms: finalCandidate.waitTimeMs,
      });
    }

    drained.push({
      ...message,
      priority: finalCandidate.effectivePriority,
    });
    excludeIds.add(message.id);
  }

  return drained;
}

export async function indexMessagesByPriority(messages: StoredMessage[]): Promise<number> {
  const redis = getClient();
  let indexed = 0;

  for (const message of messages) {
    const added = await redis.zadd(
      PRIORITY_KEY,
      "NX",
      `${scoreForPriority(message.priority, message.timestamp)}`,
      message.id,
    );
    if (typeof added === "number") indexed += added;
  }

  return indexed;
}

async function getPendingIds(): Promise<string[]> {
  const redis = getClient();
  const summary = (await redis.xpending(STREAM_KEY, CONSUMER_GROUP)) as unknown;
  if (!Array.isArray(summary) || summary.length === 0) return [];

  const total = Number.parseInt(String(summary[0] ?? "0"), 10);
  if (!Number.isFinite(total) || total <= 0) return [];

  const pending = (await redis.xpending(
    STREAM_KEY,
    CONSUMER_GROUP,
    "-",
    "+",
    total,
  )) as unknown;

  if (!Array.isArray(pending)) return [];

  return pending
    .map((item) => (Array.isArray(item) && typeof item[0] === "string" ? item[0] : undefined))
    .filter((id): id is string => typeof id === "string");
}

async function claimPendingEntries(ids: string[]): Promise<StoredMessage[]> {
  if (ids.length === 0) return [];

  const redis = getClient();
  const claimed = (await redis.xclaim(
    STREAM_KEY,
    CONSUMER_GROUP,
    CONSUMER_NAME,
    0,
    ...ids,
  )) as unknown;

  if (!Array.isArray(claimed)) return [];

  const out: StoredMessage[] = [];
  for (const entry of claimed) {
    if (Array.isArray(entry) && typeof entry[0] === "string") {
      out.push(entryToStoredMessage(entry as [string, unknown], false));
    }
  }

  return out;
}

async function readNeverClaimed(): Promise<StoredMessage[]> {
  const redis = getClient();
  const out: StoredMessage[] = [];

  // Read all available never-delivered records for this consumer group.
  // xreadgroup with ">" both returns and claims them pending until acked.
  while (true) {
    const raw = (await redis.xreadgroup(
      "GROUP",
      CONSUMER_GROUP,
      CONSUMER_NAME,
      "COUNT",
      `${FETCH_BATCH_SIZE}`,
      "STREAMS",
      STREAM_KEY,
      ">",
    )) as unknown;

    if (!Array.isArray(raw) || raw.length === 0) break;
    const streamRows = raw[0];
    if (!Array.isArray(streamRows) || !Array.isArray(streamRows[1])) break;

    const entries = streamRows[1] as unknown[];
    if (entries.length === 0) break;

    for (const entry of entries) {
      if (Array.isArray(entry) && typeof entry[0] === "string") {
        out.push(entryToStoredMessage(entry as [string, unknown], false));
      }
    }

    if (entries.length < FETCH_BATCH_SIZE) break;
  }

  return out;
}

/**
 * Get unacked messages, filtering by max age to prevent replay floods.
 * Messages older than maxAgeMs are immediately acked (marked resolved)
 * so they never appear again on future restarts.
 *
 * Without this, every gateway restart replays the ENTIRE stream history.
 */
export async function getUnacked(maxAgeMs: number = 10 * 60 * 1000): Promise<StoredMessage[]> {
  const pendingIds = await getPendingIds();
  const [pendingMessages, newMessages] = await Promise.all([
    claimPendingEntries(pendingIds),
    readNeverClaimed(),
  ]);

  const seen = new Set<string>();
  const allMessages: StoredMessage[] = [];

  for (const message of [...pendingMessages, ...newMessages]) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    allMessages.push(message);
  }

  // Split into recent (replay-worthy) and stale (ack and discard)
  const cutoff = Date.now() - maxAgeMs;
  const recent: StoredMessage[] = [];
  const stale: StoredMessage[] = [];

  for (const msg of allMessages) {
    if (msg.timestamp >= cutoff) {
      recent.push(msg);
    } else {
      stale.push(msg);
    }
  }

  // Delete stale messages from stream so they never replay again
  if (stale.length > 0) {
    const redis = getClient();
    for (const msg of stale) {
      await redis.xack(STREAM_KEY, CONSUMER_GROUP, msg.id);
      await redis.xdel(STREAM_KEY, msg.id);
      await redis.zrem(PRIORITY_KEY, msg.id);
    }
    console.log("[gateway:store] deleted stale messages on load (won't replay)", {
      staleCount: stale.length,
      maxAgeMs,
      oldestAge: `${Math.round((Date.now() - Math.min(...stale.map((m) => m.timestamp))) / 1000)}s`,
    });
  }

  recent.sort((a, b) => a.timestamp - b.timestamp);

  console.log("[gateway:store] loaded unacked messages", {
    replayable: recent.length,
    staleAcked: stale.length,
    pending: pendingMessages.length,
    fresh: newMessages.length,
    maxAgeMs,
  });

  return recent;
}

export async function trimOld(maxAge: number = DEFAULT_MAX_AGE_MS): Promise<number> {
  const redis = getClient();
  const now = Date.now();
  const cutoffTs = now - maxAge;
  const cutoffId = `${cutoffTs}-999999`;

  const pendingIds = new Set(await getPendingIds());
  let deleted = 0;
  let minId = "-";

  while (true) {
    const rows = (await redis.xrange(
      STREAM_KEY,
      minId,
      cutoffId,
      "COUNT",
      `${FETCH_BATCH_SIZE}`,
    )) as unknown;

    if (!Array.isArray(rows) || rows.length === 0) break;

    const toDelete: string[] = [];
    let lastId = "";

    for (const row of rows) {
      if (!Array.isArray(row) || typeof row[0] !== "string") continue;
      const streamId = row[0];
      lastId = streamId;
      if (!pendingIds.has(streamId)) {
        toDelete.push(streamId);
      }
    }

    if (toDelete.length > 0) {
      const removed = await redis.xdel(STREAM_KEY, ...toDelete);
      await redis.zrem(PRIORITY_KEY, ...toDelete);
      deleted += removed;
    }

    if (!lastId || rows.length < FETCH_BATCH_SIZE) break;
    minId = `(${lastId}`;
  }

  if (deleted > 0) {
    console.log("[gateway:store] trimmed old acked messages", {
      deleted,
      maxAge,
    });
  } else {
    console.log("[gateway:store] trim found no old acked messages", {
      maxAge,
    });
  }

  return deleted;
}
