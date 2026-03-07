import type Redis from "ioredis"
import type {
  CandidateMessage,
  DrainByPriorityOptions,
  InitOptions,
  PersistResult,
  QueueConfig,
  QueueDepthStats,
  QueueEventEnvelope,
  QueueInspectableRecord,
  StoredMessage,
  TelemetryEmitter,
} from "./types"
import { Priority } from "./types"

const FETCH_BATCH_SIZE = 100
const PRIORITY_FACTOR = 1_000_000_000_000
const DRAIN_SCAN_LIMIT = 256

let redisClient: Redis | undefined
let config: QueueConfig | undefined
let telemetryEmitter: TelemetryEmitter = {
  emit: () => {},
}

function emitQueueTelemetry(action: string, detail: string, extra?: Record<string, unknown>): void {
  telemetryEmitter.emit(action, detail, {
    ...(extra ?? {}),
  })
}

function getClient(): Redis {
  if (!redisClient) {
    throw new Error("[queue] redis client not initialized")
  }
  return redisClient
}

function getConfig(): QueueConfig {
  if (!config) {
    throw new Error("[queue] queue not configured")
  }
  return config
}

function toPriority(value: number): Priority {
  if (value <= Priority.P0) return Priority.P0
  if (value === Priority.P1) return Priority.P1
  if (value === Priority.P2) return Priority.P2
  return Priority.P3
}

function priorityName(priority: Priority): "P0" | "P1" | "P2" | "P3" {
  if (priority === Priority.P0) return "P0"
  if (priority === Priority.P1) return "P1"
  if (priority === Priority.P2) return "P2"
  return "P3"
}

function scoreForPriority(priority: Priority, timestamp: number): number {
  return (priority * PRIORITY_FACTOR) + timestamp
}

function parseFields(fields: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!Array.isArray(fields)) return out

  for (let i = 0; i < fields.length; i += 2) {
    const key = fields[i]
    const value = fields[i + 1]
    if (typeof key === "string" && typeof value === "string") {
      out[key] = value
    }
  }

  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function parseMetadata(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined

  try {
    const parsed = JSON.parse(raw) as unknown
    if (isRecord(parsed)) {
      return parsed
    }
  } catch {
    // ignore malformed metadata
  }

  return undefined
}

function parsePayload(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}

  try {
    const parsed = JSON.parse(raw) as unknown
    if (isRecord(parsed)) {
      return parsed
    }
  } catch {
    // ignore malformed payload
  }

  return {}
}

function streamIdToTimestamp(streamId: string): number {
  const first = streamId.split("-")[0]
  const parsed = Number.parseInt(first ?? "", 10)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function entryToStoredMessage(entry: [string, unknown], acked: boolean): StoredMessage {
  const [id, fieldList] = entry
  const fields = parseFields(fieldList)
  const timestampFromField = Number.parseInt(fields.timestamp ?? "", 10)
  const metadata = parseMetadata(fields.metadata)
  const priorityFromField = Number.parseInt(fields.priority ?? "", 10)
  const priority = Number.isFinite(priorityFromField)
    ? toPriority(priorityFromField)
    : Priority.P3

  return {
    id,
    payload: parsePayload(fields.payload),
    metadata,
    timestamp: Number.isFinite(timestampFromField) ? timestampFromField : streamIdToTimestamp(id),
    priority,
    acked,
  }
}

function toEnvelopeMetadata(envelope: QueueEventEnvelope): Record<string, unknown> {
  return {
    event: envelope.event,
    source: envelope.source,
    correlationId: envelope.trace?.correlationId,
    causationId: envelope.trace?.causationId,
    dedupKey: envelope.dedupKey,
    hasMeta: envelope.meta !== undefined,
  }
}

function toQueueEventEnvelope(payload: Record<string, unknown>): QueueEventEnvelope | undefined {
  const id = typeof payload.id === "string" ? payload.id : undefined
  const event = typeof payload.event === "string" ? payload.event : undefined
  const source = typeof payload.source === "string" ? payload.source : undefined
  const ts = typeof payload.ts === "number" ? payload.ts : undefined
  const data = isRecord(payload.data) ? payload.data : undefined
  const priority = typeof payload.priority === "number" ? toPriority(payload.priority) : undefined
  const trace = isRecord(payload.trace)
    ? {
        correlationId: typeof payload.trace.correlationId === "string" ? payload.trace.correlationId : undefined,
        causationId: typeof payload.trace.causationId === "string" ? payload.trace.causationId : undefined,
        traceId: typeof payload.trace.traceId === "string" ? payload.trace.traceId : undefined,
        spanId: typeof payload.trace.spanId === "string" ? payload.trace.spanId : undefined,
        parentSpanId: typeof payload.trace.parentSpanId === "string" ? payload.trace.parentSpanId : undefined,
      }
    : undefined
  const meta = isRecord(payload.meta) ? payload.meta : undefined
  const dedupKey = typeof payload.dedupKey === "string" ? payload.dedupKey : undefined

  if (!id || !event || !source || ts === undefined || !data || priority === undefined) {
    return undefined
  }

  return {
    id,
    event,
    source,
    ts,
    data,
    priority,
    ...(dedupKey ? { dedupKey } : {}),
    ...(trace ? { trace } : {}),
    ...(meta ? { meta } : {}),
  }
}

/**
 * Initialize the queue with a Redis client and configuration.
 *
 * Creates a Redis stream and consumer group if they don't exist.
 * Safe to call multiple times — will detect existing consumer group.
 */
export async function init(redis: Redis, queueConfig: QueueConfig, options?: InitOptions): Promise<void> {
  telemetryEmitter = options?.telemetry ?? { emit: () => {} }
  redisClient = redis
  config = queueConfig

  try {
    await redis.xgroup("CREATE", queueConfig.streamKey, queueConfig.consumerGroup, "$", "MKSTREAM")
    console.log("[queue] initialized stream + consumer group", {
      stream: queueConfig.streamKey,
      group: queueConfig.consumerGroup,
      consumer: queueConfig.consumerName,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("BUSYGROUP")) {
      console.log("[queue] consumer group exists", {
        stream: queueConfig.streamKey,
        group: queueConfig.consumerGroup,
        consumer: queueConfig.consumerName,
      })
      return
    }
    throw error
  }
}

/**
 * Add a message to the queue.
 */
export async function persist(msg: {
  payload: Record<string, unknown>
  priority: Priority
  metadata?: Record<string, unknown>
}): Promise<PersistResult | null> {
  const redis = getClient()
  const cfg = getConfig()
  const timestamp = Date.now()
  const metadata = msg.metadata ? JSON.stringify(msg.metadata) : ""
  const payloadStr = JSON.stringify(msg.payload)

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
  )

  if (!streamId) {
    throw new Error("[queue] xadd returned empty stream id")
  }

  await redis.zadd(cfg.priorityKey, `${scoreForPriority(msg.priority, timestamp)}`, streamId)

  emitQueueTelemetry("queue.enqueue.persisted", "debug", {
    streamId,
    priority: msg.priority,
    priority_label: priorityName(msg.priority),
    wait_time_ms: 0,
    metadata: msg.metadata,
  })

  console.log("[queue] persisted message", {
    streamId,
    priority: priorityName(msg.priority),
  })

  return { streamId, priority: msg.priority }
}

export async function persistEnvelope<TData extends Record<string, unknown>>(
  envelope: QueueEventEnvelope<TData>,
): Promise<PersistResult> {
  const result = await persist({
    payload: envelope as unknown as Record<string, unknown>,
    priority: envelope.priority,
    metadata: toEnvelopeMetadata(envelope),
  })

  if (!result) {
    throw new Error("[queue] persistEnvelope unexpectedly returned null")
  }

  return result
}

/**
 * Mark a message as resolved (acknowledged and deleted from the stream).
 */
export async function ack(streamId: string): Promise<void> {
  const redis = getClient()
  const cfg = getConfig()

  await redis.xack(cfg.streamKey, cfg.consumerGroup, streamId)
  const deleted = await redis.xdel(cfg.streamKey, streamId)
  await redis.zrem(cfg.priorityKey, streamId)

  emitQueueTelemetry("queue.ack", "debug", {
    streamId,
    deleted,
  })

  console.log("[queue] resolved", {
    streamId,
    deleted,
  })
}

async function loadByStreamId(streamId: string, acked = false): Promise<StoredMessage | undefined> {
  const redis = getClient()
  const cfg = getConfig()
  const raw = (await redis.xrange(
    cfg.streamKey,
    streamId,
    streamId,
    "COUNT",
    "1",
  )) as unknown

  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const entry = raw[0]
  if (!Array.isArray(entry) || typeof entry[0] !== "string") return undefined
  return entryToStoredMessage(entry as [string, unknown], acked)
}

async function listStreamIds(limit?: number): Promise<string[]> {
  const redis = getClient()
  const cfg = getConfig()
  const stop = limit === undefined ? -1 : Math.max(0, limit - 1)
  return redis.zrange(cfg.priorityKey, 0, stop)
}

function candidateComparator(a: CandidateMessage, b: CandidateMessage): number {
  if (a.effectivePriority !== b.effectivePriority) {
    return a.effectivePriority - b.effectivePriority
  }
  if (a.message.timestamp !== b.message.timestamp) {
    return a.message.timestamp - b.message.timestamp
  }
  return a.message.id.localeCompare(b.message.id)
}

async function loadPriorityCandidates(
  excludeIds: Set<string>,
  now: number,
  agingPromotionMs: number,
): Promise<CandidateMessage[]> {
  const ids = await listStreamIds(DRAIN_SCAN_LIMIT)
  if (ids.length === 0) return []

  const candidates: CandidateMessage[] = []
  const redis = getClient()
  const cfg = getConfig()

  for (const streamId of ids) {
    if (excludeIds.has(streamId)) continue

    const msg = await loadByStreamId(streamId)
    if (!msg) {
      await redis.zrem(cfg.priorityKey, streamId)
      continue
    }

    const waitTimeMs = Math.max(0, now - msg.timestamp)
    const shouldPromote = (msg.priority === Priority.P2 || msg.priority === Priority.P3)
      && waitTimeMs >= agingPromotionMs
    const effectivePriority = shouldPromote
      ? toPriority(msg.priority - 1)
      : msg.priority

    candidates.push({
      message: msg,
      waitTimeMs,
      effectivePriority,
      ...(shouldPromote ? { promotedFrom: msg.priority } : {}),
    })
  }

  return candidates
}

/**
 * Drain messages from the queue in priority order.
 */
export async function drainByPriority(
  options?: DrainByPriorityOptions & { agingPromotionMs?: number },
): Promise<CandidateMessage[]> {
  const excludeIds = new Set<string>(options?.excludeIds ?? [])
  const limit = Math.max(1, options?.limit ?? 1)
  const agingPromotionMs = options?.agingPromotionMs ?? 5 * 60 * 1000

  const now = Date.now()
  const candidates = await loadPriorityCandidates(excludeIds, now, agingPromotionMs)
  const orderedCandidates = [...candidates].sort(candidateComparator)
  const drained: CandidateMessage[] = []

  for (let i = 0; i < Math.min(limit, orderedCandidates.length); i += 1) {
    const selected = orderedCandidates[i]
    if (!selected) break
    drained.push(selected)
  }

  if (drained.length > 0) {
    emitQueueTelemetry("queue.lease.selected", "debug", {
      count: drained.length,
      priorities: drained.map((candidate) => priorityName(candidate.effectivePriority)),
      promoted: drained.filter((candidate) => candidate.promotedFrom !== undefined).length,
      oldest_wait_ms: Math.max(...drained.map((candidate) => candidate.waitTimeMs)),
      streamIds: drained.map((candidate) => candidate.message.id),
    })
  }

  return drained
}

/**
 * Re-index messages into the priority sorted set.
 */
export async function indexMessagesByPriority(messages: StoredMessage[]): Promise<number> {
  const redis = getClient()
  const cfg = getConfig()
  let indexed = 0

  for (const message of messages) {
    const added = await redis.zadd(
      cfg.priorityKey,
      "NX",
      `${scoreForPriority(message.priority, message.timestamp)}`,
      message.id,
    )
    if (typeof added === "number") indexed += added
  }

  return indexed
}

async function getPendingIds(): Promise<string[]> {
  const redis = getClient()
  const cfg = getConfig()
  const summary = (await redis.xpending(cfg.streamKey, cfg.consumerGroup)) as unknown
  if (!Array.isArray(summary) || summary.length === 0) return []

  const total = Number.parseInt(String(summary[0] ?? "0"), 10)
  if (!Number.isFinite(total) || total <= 0) return []

  const pending = (await redis.xpending(
    cfg.streamKey,
    cfg.consumerGroup,
    "-",
    "+",
    total,
  )) as unknown

  if (!Array.isArray(pending)) return []

  return pending
    .map((item) => (Array.isArray(item) && typeof item[0] === "string" ? item[0] : undefined))
    .filter((id): id is string => typeof id === "string")
}

async function claimPendingEntries(ids: string[]): Promise<StoredMessage[]> {
  if (ids.length === 0) return []

  const redis = getClient()
  const cfg = getConfig()
  const claimed = (await redis.xclaim(
    cfg.streamKey,
    cfg.consumerGroup,
    cfg.consumerName,
    0,
    ...ids,
  )) as unknown

  if (!Array.isArray(claimed)) return []

  const out: StoredMessage[] = []
  for (const entry of claimed) {
    if (Array.isArray(entry) && typeof entry[0] === "string") {
      out.push(entryToStoredMessage(entry as [string, unknown], true))
    }
  }

  return out
}

async function readNeverClaimed(): Promise<StoredMessage[]> {
  const redis = getClient()
  const cfg = getConfig()
  const out: StoredMessage[] = []

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
    )) as unknown

    if (!Array.isArray(raw) || raw.length === 0) break
    const streamRows = raw[0]
    if (!Array.isArray(streamRows) || !Array.isArray(streamRows[1])) break

    const entries = streamRows[1] as unknown[]
    if (entries.length === 0) break

    for (const entry of entries) {
      if (Array.isArray(entry) && typeof entry[0] === "string") {
        out.push(entryToStoredMessage(entry as [string, unknown], false))
      }
    }

    if (entries.length < FETCH_BATCH_SIZE) break
  }

  return out
}

/**
 * Get unacked (unresolved) messages from the queue.
 */
export async function getUnacked(maxUnackedAge?: number): Promise<StoredMessage[]> {
  const cfg = getConfig()
  const maxAgeMs = maxUnackedAge ?? (cfg.maxUnackedAge ?? 10 * 60 * 1000)

  const pendingIds = await getPendingIds()
  const [pendingMessages, newMessages] = await Promise.all([
    claimPendingEntries(pendingIds),
    readNeverClaimed(),
  ])

  const seen = new Set<string>()
  const allMessages: StoredMessage[] = []

  for (const message of [...pendingMessages, ...newMessages]) {
    if (seen.has(message.id)) continue
    seen.add(message.id)
    allMessages.push(message)
  }

  const cutoff = Date.now() - maxAgeMs
  const recent: StoredMessage[] = []
  const stale: StoredMessage[] = []

  for (const message of allMessages) {
    if (message.timestamp >= cutoff) {
      recent.push(message)
    } else {
      stale.push(message)
    }
  }

  if (stale.length > 0) {
    const redis = getClient()
    for (const message of stale) {
      await redis.xack(cfg.streamKey, cfg.consumerGroup, message.id)
      await redis.xdel(cfg.streamKey, message.id)
      await redis.zrem(cfg.priorityKey, message.id)
    }
    console.log("[queue] deleted stale messages on load (won't replay)", {
      staleCount: stale.length,
      maxAgeMs,
      oldestAge: `${Math.round((Date.now() - Math.min(...stale.map((message) => message.timestamp))) / 1000)}s`,
    })
  }

  recent.sort((a, b) => a.timestamp - b.timestamp)

  emitQueueTelemetry("queue.replay.recovery", "info", {
    replayable: recent.length,
    staleAcked: stale.length,
    pending: pendingMessages.length,
    fresh: newMessages.length,
    maxAgeMs,
  })

  console.log("[queue] loaded unacked messages", {
    replayable: recent.length,
    staleAcked: stale.length,
    pending: pendingMessages.length,
    fresh: newMessages.length,
    maxAgeMs,
  })

  return recent
}

/**
 * Trim old acked messages from the queue.
 */
export async function trimOld(maxArchiveAge?: number): Promise<number> {
  const redis = getClient()
  const cfg = getConfig()
  const maxAge = maxArchiveAge ?? (cfg.maxArchiveAge ?? 24 * 60 * 60 * 1000)

  const now = Date.now()
  const cutoffTs = now - maxAge
  const cutoffId = `${cutoffTs}-999999`

  const pendingIds = new Set(await getPendingIds())
  let deleted = 0
  let minId = "-"

  while (true) {
    const rows = (await redis.xrange(
      cfg.streamKey,
      minId,
      cutoffId,
      "COUNT",
      `${FETCH_BATCH_SIZE}`,
    )) as unknown

    if (!Array.isArray(rows) || rows.length === 0) break

    const toDelete: string[] = []
    let lastId = ""

    for (const row of rows) {
      if (!Array.isArray(row) || typeof row[0] !== "string") continue
      const streamId = row[0]
      lastId = streamId
      if (!pendingIds.has(streamId)) {
        toDelete.push(streamId)
      }
    }

    if (toDelete.length > 0) {
      const removed = await redis.xdel(cfg.streamKey, ...toDelete)
      await redis.zrem(cfg.priorityKey, ...toDelete)
      deleted += removed
    }

    if (!lastId || rows.length < FETCH_BATCH_SIZE) break
    minId = `(${lastId}`
  }

  if (deleted > 0) {
    console.log("[queue] trimmed old acked messages", {
      deleted,
      maxAge,
    })
  } else {
    console.log("[queue] trim found no old acked messages", {
      maxAge,
    })
  }

  return deleted
}

/**
 * Get queue depth and operator-friendly statistics.
 */
export async function getDepth(): Promise<QueueDepthStats> {
  const ids = await listStreamIds()
  const pendingIds = new Set(await getPendingIds())
  const byPriority: QueueDepthStats["byPriority"] = {
    P0: 0,
    P1: 0,
    P2: 0,
    P3: 0,
  }

  let oldest: QueueDepthStats["oldest"]

  for (const streamId of ids) {
    const message = await loadByStreamId(streamId, pendingIds.has(streamId))
    if (!message) continue

    byPriority[priorityName(message.priority)] += 1

    const ageMs = Date.now() - message.timestamp
    if (!oldest || message.timestamp < streamIdToTimestamp(oldest.id)) {
      oldest = {
        id: message.id,
        age_ms: ageMs,
        priority: message.priority,
      }
    }
  }

  const pending = ids.filter((streamId) => pendingIds.has(streamId)).length
  const total = ids.length
  const ready = Math.max(0, total - pending)

  emitQueueTelemetry("queue.depth.read", "debug", {
    total,
    ready,
    pending,
    byPriority,
    oldest_age_ms: oldest?.age_ms,
  })

  return {
    total,
    ready,
    pending,
    byPriority,
    oldest,
  }
}

/**
 * Inspect a specific message by stream ID.
 */
export async function inspect(streamId: string): Promise<StoredMessage | undefined> {
  const pendingIds = new Set(await getPendingIds())
  const message = await loadByStreamId(streamId, pendingIds.has(streamId))

  emitQueueTelemetry("queue.inspect", "debug", {
    streamId,
    found: message !== undefined,
    priority: message ? priorityName(message.priority) : undefined,
    state: pendingIds.has(streamId) ? "leased" : "ready",
  })

  return message
}

export async function inspectById<TData extends Record<string, unknown>>(
  streamId: string,
): Promise<QueueInspectableRecord<TData> | undefined> {
  const message = await inspect(streamId)
  if (!message) return undefined

  const state = message.acked ? "leased" : "ready"
  return {
    streamId: message.id,
    state,
    stored: message,
    envelope: toQueueEventEnvelope(message.payload) as QueueEventEnvelope<TData> | undefined,
  }
}

export async function loadEnvelope<TData extends Record<string, unknown>>(
  streamId: string,
): Promise<QueueEventEnvelope<TData> | undefined> {
  const record = await inspectById<TData>(streamId)
  return record?.envelope
}

/**
 * List messages in stored priority order with optional limit.
 */
export async function listMessages(limit = 10): Promise<StoredMessage[]> {
  const ids = await listStreamIds(limit)
  const pendingIds = new Set(await getPendingIds())
  const messages: StoredMessage[] = []

  for (const streamId of ids) {
    const message = await loadByStreamId(streamId, pendingIds.has(streamId))
    if (message) {
      messages.push(message)
    }
  }

  return messages
}

// Test utilities
export const __queueTestUtils = {
  toPriority,
  priorityName,
  toQueueEventEnvelope,
}
