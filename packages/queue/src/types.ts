export type { TelemetryEmitter } from "@joelclaw/telemetry"

/**
 * Priority levels for queue messages.
 * Lower numbers = higher priority (P0 > P1 > P2 > P3).
 */
export enum Priority {
  P0 = 0,
  P1 = 1,
  P2 = 2,
  P3 = 3,
}

/**
 * A message stored in the Redis queue.
 */
export interface StoredMessage {
  /**
   * Redis stream ID (timestamp-sequence format: "1749990000000-0")
   */
  id: string

  /**
   * Message payload — can be any serializable value.
   * Stored in Redis as a string.
   */
  payload: Record<string, unknown>

  /**
   * Optional metadata attached to the message.
   */
  metadata?: Record<string, unknown>

  /**
   * Timestamp when the message was added to the queue (milliseconds since epoch).
   */
  timestamp: number

  /**
   * Priority level for this message.
   */
  priority: Priority

  /**
   * Whether the message is currently leased/inflight.
   */
  acked: boolean
}

/**
 * Result of persisting a message to the queue.
 */
export type PersistResult = {
  streamId: string
  priority: Priority
}

/**
 * Options for draining messages with priority ordering.
 */
export type DrainByPriorityOptions = {
  /**
   * Maximum number of messages to drain (default: 1).
   */
  limit?: number

  /**
   * Stream IDs to exclude from draining.
   */
  excludeIds?: Iterable<string>
}

/**
 * A candidate message considered during priority-based drain operations.
 */
export type CandidateMessage = {
  /**
   * The message being considered.
   */
  message: StoredMessage

  /**
   * How long the message has waited in the queue (milliseconds).
   */
  waitTimeMs: number

  /**
   * The priority this message will have after aging promotion.
   */
  effectivePriority: Priority

  /**
   * If set, the message was promoted from this priority due to aging.
   */
  promotedFrom?: Priority
}

/**
 * Configuration for a Redis stream queue.
 */
export type QueueConfig = {
  /**
   * Redis stream key (e.g., "myapp:queue:messages")
   */
  streamKey: string

  /**
   * Sorted set key for the derived priority index (e.g., "myapp:queue:priority").
   *
   * The Redis stream remains the source of truth for payload + replay state; this
   * sorted set exists to make priority drains cheap and can be rebuilt from the
   * stream via `indexMessagesByPriority()` during recovery.
   */
  priorityKey: string

  /**
   * Consumer group name for tracking unacked messages.
   */
  consumerGroup: string

  /**
   * Consumer name within the group.
   */
  consumerName: string

  /**
   * How far back to replay messages on reconnect (milliseconds).
   *
   * On startup/reconnect the queue claims pending + never-delivered entries from
   * the stream. Messages older than this replay horizon are auto-acked, removed
   * from the stream, and dropped from the priority index so a stale backlog does
   * not flood the consumer after downtime.
   * Default: 10 minutes.
   */
  maxUnackedAge?: number

  /**
   * How long to keep acked messages in the stream before trimming (milliseconds).
   * Default: 24 hours.
   */
  maxArchiveAge?: number
}

/**
 * Initialize options for the queue.
 */
export type InitOptions = {
  telemetry?: TelemetryEmitter
}

export interface QueueTraceMetadata {
  /**
   * Stable correlation identifier across a workflow hop chain.
   */
  correlationId?: string

  /**
   * Stable causation identifier for the immediately preceding event.
   */
  causationId?: string

  /**
   * Optional provider/runtime trace identifiers when available.
   */
  traceId?: string
  spanId?: string
  parentSpanId?: string
}

/**
 * Canonical queue event envelope for all queue-routed events.
 */
export interface QueueEventEnvelope<TData extends Record<string, unknown> = Record<string, unknown>> {
  /**
   * Stable event instance ID (ULID / UUID).
   */
  id: string

  /**
   * Event name in domain/verb format.
   */
  event: string

  /**
   * Source system that produced the event.
   */
  source: string

  /**
   * Event timestamp (epoch milliseconds).
   */
  ts: number

  /**
   * Typed event payload.
   */
  data: TData

  /**
   * Queue routing priority.
   */
  priority: Priority

  /**
   * Optional deduplication key.
   */
  dedupKey?: string

  /**
   * Trace and causality metadata.
   */
  trace?: QueueTraceMetadata

  /**
   * Optional routing/enrichment metadata.
   */
  meta?: Record<string, unknown>
}

export interface QueueInspectableRecord<TData extends Record<string, unknown> = Record<string, unknown>> {
  streamId: string
  state: "ready" | "leased"
  stored: StoredMessage
  envelope?: QueueEventEnvelope<TData>
}

export interface QueueDepthStats {
  total: number
  ready: number
  pending: number
  byPriority: Record<"P0" | "P1" | "P2" | "P3", number>
  oldest?: {
    id: string
    age_ms: number
    priority: Priority
  }
}

export const QUEUE_DISPATCH_FAILED_CONTRACT = {
  action: "queue.dispatch.failed",
  available: false,
  planned_for: "ADR-0217 Story 3 drainer/dispatcher",
  reason: "No dispatcher exists in Story 2, so dispatch failures cannot be emitted honestly yet.",
} as const
