export type { TelemetryEmitter } from "@joelclaw/telemetry";

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
  id: string;

  /**
   * Message payload — can be any serializable value.
   * Stored in Redis as a string.
   */
  payload: Record<string, unknown>;

  /**
   * Optional metadata attached to the message.
   */
  metadata?: Record<string, unknown>;

  /**
   * Timestamp when the message was added to the queue (milliseconds since epoch).
   */
  timestamp: number;

  /**
   * Priority level for this message.
   */
  priority: Priority;

  /**
   * Whether the message has been acknowledged (resolved/deleted).
   */
  acked: boolean;
}

/**
 * Result of persisting a message to the queue.
 */
export type PersistResult = {
  streamId: string;
  priority: Priority;
};

/**
 * Options for draining messages with priority ordering.
 */
export type DrainByPriorityOptions = {
  /**
   * Maximum number of messages to drain (default: 1).
   */
  limit?: number;

  /**
   * Stream IDs to exclude from draining.
   */
  excludeIds?: Iterable<string>;
};

/**
 * A candidate message considered during priority-based drain operations.
 */
export type CandidateMessage = {
  /**
   * The message being considered.
   */
  message: StoredMessage;

  /**
   * How long the message has waited in the queue (milliseconds).
   */
  waitTimeMs: number;

  /**
   * The priority this message will have after aging promotion.
   */
  effectivePriority: Priority;

  /**
   * If set, the message was promoted from this priority due to aging.
   */
  promotedFrom?: Priority;
};

/**
 * Configuration for a Redis stream queue.
 */
export type QueueConfig = {
  /**
   * Redis stream key (e.g., "myapp:queue:messages")
   */
  streamKey: string;

  /**
   * Sorted set key for priority index (e.g., "myapp:queue:priority")
   */
  priorityKey: string;

  /**
   * Consumer group name for tracking unacked messages.
   */
  consumerGroup: string;

  /**
   * Consumer name within the group.
   */
  consumerName: string;

  /**
   * How far back to replay messages on reconnect (milliseconds).
   * Messages older than this are auto-acked and discarded.
   * Default: 10 minutes.
   */
  maxUnackedAge?: number;

  /**
   * How long to keep acked messages in the stream before trimming (milliseconds).
   * Default: 24 hours.
   */
  maxArchiveAge?: number;
};

/**
 * Initialize options for the queue.
 */
export type InitOptions = {
  telemetry?: TelemetryEmitter;
};
