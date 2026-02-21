import type Redis from "ioredis";

export interface StoredMessage {
  id: string;
  source: string;
  prompt: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
  acked: boolean;
}

const STREAM_KEY = "joelclaw:gateway:messages";
const CONSUMER_GROUP = "gateway-session";
const CONSUMER_NAME = "daemon";
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FETCH_BATCH_SIZE = 100;

let redisClient: Redis | undefined;

function getClient(): Redis {
  if (!redisClient) {
    throw new Error("[gateway:store] redis client not initialized");
  }
  return redisClient;
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

  return {
    id,
    source: fields.source ?? "unknown",
    prompt: fields.prompt ?? "",
    metadata: parseMetadata(fields.metadata),
    timestamp: Number.isFinite(timestampFromField) ? timestampFromField : streamIdToTimestamp(id),
    acked,
  };
}

export async function init(redis: Redis): Promise<void> {
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
}): Promise<string> {
  const redis = getClient();
  const timestamp = Date.now();
  const metadata = msg.metadata ? JSON.stringify(msg.metadata) : "";

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
  );

  if (!streamId) {
    throw new Error("[gateway:store] xadd returned empty stream id");
  }

  console.log("[gateway:store] persisted inbound message", {
    streamId,
    source: msg.source,
  });

  return streamId;
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

  console.log("[gateway:store] resolved", {
    streamId,
    deleted,
  });
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
