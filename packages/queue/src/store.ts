import type Redis from "ioredis";
import type {
  CandidateMessage,
  DrainByPriorityOptions,
  InitOptions,
  PersistResult,
  QueueConfig,
  StoredMessage,
  TelemetryEmitter,
} from "./types";
import { Priority } from "./types";

const FETCH_BATCH_SIZE = 100;
const PRIORITY_FACTOR = 1_000_000_000_000;
const DRAIN_SCAN_LIMIT = 256;

let redisClient: Redis | undefined;
let config: QueueConfig | undefined;
let telemetryEmitter: TelemetryEmitter = {
  emit: () => {},
};

function emitQueueTelemetry(action: string, detail: string, extra?: Record<string, unknown>): void {
  telemetryEmitter.emit(action, detail, {
    component: "queue",
    ...(extra ?? {}),
  });
}

function getClient(): Redis {
  if (!redisClient) {
    throw new Error("[queue] redis client not initialized");
  }
  return redisClient;
}

function getConfig(): QueueConfig {
  if (!config) {
    throw new Error("[queue] queue not configured");
  }
  return config;
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

function streamIdToTimestamp(streamId: string): number {
  const first = streamId.split("-")[0];
  const parsed = Number.parseInt(first ?? "", 10);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function entryToStoredMessage(entry: [string, unknown], acked: boolean): StoredMessage {
  const [id, fieldList] = entry;
  const fields = parseFields(fieldList);
  const timestampFromField = Number.parseInt(fields.timestamp ?? "", 10);
  const metadata = parseMetadata(fields.metadata);
  const priorityFromField = Number.parseInt(fields.priority ?? "", 10);
  const priority = Number.isFinite(priorityFromField)
    ? toPriority(priorityFromField)
    : Priority.P3;

  const payload: Record<string, unknown> = {};
  const payloadStr = fields.payload ?? "{}";
  try {
    const parsed = JSON.parse(payloadStr) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      Object.assign(payload, parsed);
    }
  } catch {
    // ignore malformed payload
  }

  return {
    id,
    payload,
    metadata,
    timestamp: Number.isFinite(timestampFromField) ? timestampFromField : streamIdToTimestamp(id),
    priority,
    acked,
  };
}

/**
 * Initialize the queue with a Redis client and configuration.
 *
 * Creates a Redis stream and consumer group if they don't exist.
 * Safe to call multiple times — will detect existing consumer group.
 */
export async function init(redis: Redis, queueConfig: QueueConfig, options?: InitOptions): Promise<void> {
  telemetryEmitter = options?.telemetry ?? { emit: () => {} };
  redisClient = redis;
  config = queueConfig;

  try {
    await redis.xgroup("CREATE", queueConfig.streamKey, queueConfig.consumerGroup, "$", "MKSTREAM");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("BUSYGROUP")) {
      return;
    }
    throw error;
  }
}

/**
 * Add a message to the queue.
 *
 * - Appends to the Redis stream
 * - Indexes in the priority sorted set
 * - Returns stream ID and inferred priority
 * - Returns null if the message is rejected by a filter (subclass responsibility)
 *
 * This is the base implementation; subclasses may wrap with dedup, filtering, etc.
 */
export async function persist(msg: {
  payload: Record<string, unknown>;
  priority: Priority;
  metadata?: Record<string, unknown>;
}): Promise<PersistResult | null> {
  const redis = getClient();
  const cfg = getConfig();
  const timestamp = Date.now();
  const metadata = msg.metadata ? JSON.stringify(msg.metadata) : "";
  const payloadStr = JSON.stringify(msg.payload);

  const streamId = await redis.xadd(
    cfg.streamKey,
    "*",
    "payload",
    payloadStr,
    "metadata",
    metadata,
    "timestamp",
    `${timestamp}`,
    "priority",
    `${msg.priority}`,
  );

  if (!streamId) {
    throw new Error("[queue] xadd returned empty stream id");
  }

  await redis.zadd(cfg.priorityKey, `${scoreForPriority(msg.priority, timestamp)}`, streamId);

  emitQueueTelemetry("queue.enqueue", "Message enqueued", {
    streamId,
    priority: msg.priority,
    priority_label: priorityName(msg.priority),
    timestamp,
  });

  return { streamId, priority: msg.priority };
}

/**
 * Mark a message as resolved (acknowledged and deleted from the stream).
 *
 * - XACK to clean the consumer group's Pending Entries List
 * - XDEL to remove from the stream
 * - Remove from priority index
 *
 * Safe to call on messages that weren't claimed (XACK is a no-op in that case).
 */
export async function ack(streamId: string): Promise<void> {
  const redis = getClient();
  const cfg = getConfig();

  await redis.xack(cfg.streamKey, cfg.consumerGroup, streamId);
  const deleted = await redis.xdel(cfg.streamKey, streamId);
  await redis.zrem(cfg.priorityKey, streamId);

  emitQueueTelemetry("queue.ack", "Message acknowledged", {
    streamId,
    deleted,
  });
}

async function loadByStreamId(streamId: string): Promise<StoredMessage | undefined> {
  const redis = getClient();
  const cfg = getConfig();
  const raw = (await redis.xrange(
    cfg.streamKey,
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

function candidateComparator(a: CandidateMessage, b: CandidateMessage): number {
  if (a.effectivePriority !== b.effectivePriority) {
    return a.effectivePriority - b.effectivePriority;
  }
  if (a.message.timestamp !== b.message.timestamp) {
    return a.message.timestamp - b.message.timestamp;
  }
  return a.message.id.localeCompare(b.message.id);
}

async function loadPriorityCandidates(
  excludeIds: Set<string>,
  now: number,
  agingPromotionMs: number,
): Promise<CandidateMessage[]> {
  const redis = getClient();
  const cfg = getConfig();
  const ids = await redis.zrange(cfg.priorityKey, 0, DRAIN_SCAN_LIMIT - 1);
  if (ids.length === 0) return [];

  const candidates: CandidateMessage[] = [];
  for (const streamId of ids) {
    if (excludeIds.has(streamId)) continue;

    const msg = await loadByStreamId(streamId);
    if (!msg) {
      await redis.zrem(cfg.priorityKey, streamId);
      continue;
    }

    const waitTimeMs = Math.max(0, now - msg.timestamp);
    const shouldPromote = (msg.priority === Priority.P2 || msg.priority === Priority.P3)
      && waitTimeMs >= agingPromotionMs;
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

/**
 * Drain messages from the queue in priority order.
 *
 * - Returns messages sorted by effective priority (with aging promotion)
 * - Does NOT acknowledge messages — caller is responsible
 * - Excludes specified stream IDs from candidates
 *
 * Aging behavior:
 * - P2 messages promoted to P1 after agingPromotionMs
 * - P3 messages promoted to P2 after agingPromotionMs
 */
export async function drainByPriority(
  options?: DrainByPriorityOptions & { agingPromotionMs?: number },
): Promise<CandidateMessage[]> {
  const excludeIds = new Set<string>(options?.excludeIds ?? []);
  const limit = Math.max(1, options?.limit ?? 1);
  const agingPromotionMs = options?.agingPromotionMs ?? 5 * 60 * 1000; // 5 minutes default

  const now = Date.now();
  const candidates = await loadPriorityCandidates(excludeIds, now, agingPromotionMs);
  const orderedCandidates = [...candidates].sort(candidateComparator);
  const drained: CandidateMessage[] = [];

  for (let i = 0; i < Math.min(limit, orderedCandidates.length); i++) {
    const selected = orderedCandidates[i];
    if (!selected) break;
    drained.push(selected);
    
    emitQueueTelemetry("queue.lease", "Message leased for processing", {
      streamId: selected.message.id,
      priority: selected.effectivePriority,
      priority_label: priorityName(selected.effectivePriority),
      wait_time_ms: selected.waitTimeMs,
      promoted_from: selected.promotedFrom ? priorityName(selected.promotedFrom) : undefined,
    });
  }

  return drained;
}

/**
 * Re-index messages into the priority sorted set.
 *
 * Used during recovery or replay to rebuild the priority index.
 * Skips messages already in the index (using NX option).
 */
export async function indexMessagesByPriority(messages: StoredMessage[]): Promise<number> {
  const redis = getClient();
  const cfg = getConfig();
  let indexed = 0;

  for (const message of messages) {
    const added = await redis.zadd(
      cfg.priorityKey,
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
  const cfg = getConfig();
  const summary = (await redis.xpending(cfg.streamKey, cfg.consumerGroup)) as unknown;
  if (!Array.isArray(summary) || summary.length === 0) return [];

  const total = Number.parseInt(String(summary[0] ?? "0"), 10);
  if (!Number.isFinite(total) || total <= 0) return [];

  const pending = (await redis.xpending(
    cfg.streamKey,
    cfg.consumerGroup,
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
  const cfg = getConfig();
  const claimed = (await redis.xclaim(
    cfg.streamKey,
    cfg.consumerGroup,
    cfg.consumerName,
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
  const cfg = getConfig();
  const out: StoredMessage[] = [];

  // Read all available never-delivered records for this consumer group.
  // xreadgroup with ">" both returns and claims them pending until acked.
  while (true) {
    const raw = (await redis.xreadgroup(
      "GROUP",
      cfg.consumerGroup,
      cfg.consumerName,
      "COUNT",
      `${FETCH_BATCH_SIZE}`,
      "STREAMS",
      cfg.streamKey,
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
 * Get unacked (unresolved) messages from the queue.
 *
 * Returns messages that were either:
 * - Previously claimed but not yet acknowledged (pending entries)
 * - Never claimed yet (new entries since last startup)
 *
 * Messages older than maxUnackedAge are immediately acknowledged
 * and not returned (to prevent replay floods on restart).
 */
export async function getUnacked(maxUnackedAge?: number): Promise<StoredMessage[]> {
  const cfg = getConfig();
  const maxAgeMs = maxUnackedAge ?? (cfg.maxUnackedAge ?? 10 * 60 * 1000);

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
      await redis.xack(cfg.streamKey, cfg.consumerGroup, msg.id);
      await redis.xdel(cfg.streamKey, msg.id);
      await redis.zrem(cfg.priorityKey, msg.id);
    }
  }

  recent.sort((a, b) => a.timestamp - b.timestamp);

  emitQueueTelemetry("queue.replay", "Unacked messages loaded for replay", {
    replayable: recent.length,
    stale_acked: stale.length,
    pending: pendingMessages.length,
    fresh: newMessages.length,
    max_age_ms: maxAgeMs,
  });

  return recent;
}

/**
 * Trim old acked messages from the queue.
 *
 * Removes messages older than maxArchiveAge that are not in the pending list
 * (i.e., messages that have been acknowledged/resolved).
 */
export async function trimOld(maxArchiveAge?: number): Promise<number> {
  const redis = getClient();
  const cfg = getConfig();
  const maxAge = maxArchiveAge ?? (cfg.maxArchiveAge ?? 24 * 60 * 60 * 1000); // 24 hours default

  const now = Date.now();
  const cutoffTs = now - maxAge;
  const cutoffId = `${cutoffTs}-999999`;

  const pendingIds = new Set(await getPendingIds());
  let deleted = 0;
  let minId = "-";

  while (true) {
    const rows = (await redis.xrange(
      cfg.streamKey,
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
      const removed = await redis.xdel(cfg.streamKey, ...toDelete);
      await redis.zrem(cfg.priorityKey, ...toDelete);
      deleted += removed;
    }

    if (!lastId || rows.length < FETCH_BATCH_SIZE) break;
    minId = `(${lastId}`;
  }

  return deleted;
}

/**
 * Get queue depth and priority distribution statistics.
 * 
 * Returns:
 * - Total count
 * - Count by priority (P0, P1, P2, P3)
 * - Oldest message timestamp
 * - Newest message timestamp
 */
export async function getQueueStats(): Promise<{
  total: number;
  byPriority: Record<string, number>;
  oldestTimestamp: number | null;
  newestTimestamp: number | null;
}> {
  const redis = getClient();
  const cfg = getConfig();

  const total = await redis.zcard(cfg.priorityKey);
  
  // Get priority distribution
  const byPriority: Record<string, number> = {
    P0: 0,
    P1: 0,
    P2: 0,
    P3: 0,
  };

  const members = await redis.zrange(cfg.priorityKey, 0, -1, "WITHSCORES");
  for (let i = 1; i < members.length; i += 2) {
    const score = Number.parseFloat(members[i] ?? "0");
    const priority = Math.floor(score / PRIORITY_FACTOR);
    const priorityLabel = priorityName(toPriority(priority));
    byPriority[priorityLabel] = (byPriority[priorityLabel] ?? 0) + 1;
  }

  // Get oldest and newest timestamps
  let oldestTimestamp: number | null = null;
  let newestTimestamp: number | null = null;

  const oldest = await redis.zrange(cfg.priorityKey, 0, 0, "WITHSCORES");
  if (oldest.length >= 2) {
    const score = Number.parseFloat(oldest[1] ?? "0");
    oldestTimestamp = Math.floor(score % PRIORITY_FACTOR);
  }

  const newest = await redis.zrange(cfg.priorityKey, -1, -1, "WITHSCORES");
  if (newest.length >= 2) {
    const score = Number.parseFloat(newest[1] ?? "0");
    newestTimestamp = Math.floor(score % PRIORITY_FACTOR);
  }

  return {
    total,
    byPriority,
    oldestTimestamp,
    newestTimestamp,
  };
}

/**
 * Inspect a message by stream ID.
 * 
 * Returns the full message if found, undefined otherwise.
 */
export async function inspectById(streamId: string): Promise<StoredMessage | undefined> {
  return await loadByStreamId(streamId);
}

/**
 * List recent messages from the queue.
 * 
 * Returns messages in priority order (highest priority first).
 * Does not acknowledge or remove messages.
 */
export async function listMessages(limit = 10): Promise<StoredMessage[]> {
  const redis = getClient();
  const cfg = getConfig();

  const ids = await redis.zrange(cfg.priorityKey, 0, limit - 1);
  const messages: StoredMessage[] = [];

  for (const streamId of ids) {
    const msg = await loadByStreamId(streamId);
    if (msg) {
      messages.push(msg);
    }
  }

  return messages;
}

// Test utilities
export const __queueTestUtils = {
  toPriority,
  priorityName,
};
