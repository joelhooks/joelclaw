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
 * String label counterpart for Priority.
 */
export type QueuePriorityLabel = "P0" | "P1" | "P2" | "P3";

/**
 * Fixed priority bucket map used by queue operator surfaces.
 */
export type QueuePriorityCounts = Record<QueuePriorityLabel, number>;

/**
 * Queue triage mode for bounded model-assisted admission.
 */
export type QueueTriageMode = "off" | "shadow" | "enforce";

/**
 * Whether the model agrees with the static registry route.
 *
 * Phase 2 only allows route confirmation/mismatch signaling — not dynamic
 * handler invention or route replacement.
 */
export type QueueRouteCheck = "confirm" | "mismatch";

/**
 * Canonical fallback reasons when queue triage cannot be applied safely.
 */
export type QueueTriageFallbackReason =
  | "disabled"
  | "timeout"
  | "model_error"
  | "invalid_json"
  | "schema_error"
  | "unsafe_override";

/**
 * Bounded queue triage outcome used for suggested and final decisions.
 */
export interface QueueTriageOutcome {
  priority: QueuePriorityLabel;
  dedupKey?: string;
  routeCheck: QueueRouteCheck;
  reasoning?: string;
}

/**
 * Canonical queue triage decision contract.
 */
export interface QueueTriageDecision {
  mode: QueueTriageMode;
  model?: string;
  family: string;
  suggested: QueueTriageOutcome;
  final: QueueTriageOutcome;
  applied: boolean;
  fallbackReason?: QueueTriageFallbackReason;
  latencyMs: number;
}

/**
 * Queue observation mode for the Sonnet observer layer.
 */
export type QueueObservationMode = "off" | "dry-run" | "enforce";

/**
 * Canonical queue-pressure labels derived from the queue snapshot.
 */
export type QueueObservationPressure = "healthy" | "degraded" | "backlogged";

/**
 * Canonical downstream-health labels derived from drainer/runtime state.
 */
export type QueueObservationDownstreamState = "healthy" | "degraded" | "down";

/**
 * Canonical fallback reasons when queue observation cannot be applied safely.
 */
export type QueueObservationFallbackReason =
  | "disabled"
  | "timeout"
  | "model_error"
  | "invalid_json"
  | "schema_error"
  | "unsafe_action";

/**
 * Latency percentile summary used in queue observation snapshots.
 */
export interface QueueObservationLatencySummary {
  p50: number | null;
  p95: number | null;
}

/**
 * Per-family summary included in a canonical queue observation snapshot.
 */
export interface QueueObservationFamilySummary {
  family: string;
  total: number;
  byPriority: QueuePriorityCounts;
  oldestAgeMs: number | null;
  newestAgeMs: number | null;
}

/**
 * Recent queue-triage summary included in the observation snapshot.
 */
export interface QueueObservationTriageSummary {
  attempts: number;
  completed: number;
  failed: number;
  fallbacks: number;
  fallbackByReason: Partial<Record<QueueTriageFallbackReason, number>>;
  routeMismatches: number;
  latencyMs: QueueObservationLatencySummary;
}

/**
 * Recent drainer/runtime summary included in the observation snapshot.
 */
export interface QueueObservationDrainerSummary {
  state: QueueObservationDownstreamState;
  recentDispatches: number;
  recentFailures: number;
  throughputPerMinute: number | null;
}

/**
 * Gateway state that affects operator reporting semantics.
 */
export interface QueueObservationGatewaySummary {
  sleepMode: boolean;
  quietHours: boolean | null;
  mutedChannels: string[];
}

/**
 * Canonical queue observation snapshot consumed by the Sonnet observer.
 */
export interface QueueObservationSnapshot {
  snapshotId: string;
  capturedAt: string;
  totals: {
    depth: number;
    byPriority: QueuePriorityCounts;
    oldestAgeMs: number | null;
    newestAgeMs: number | null;
  };
  families: QueueObservationFamilySummary[];
  triage: QueueObservationTriageSummary;
  drainer: QueueObservationDrainerSummary;
  gateway: QueueObservationGatewaySummary;
}

/**
 * Canonical findings returned by the Sonnet observer.
 */
export interface QueueObservationFindings {
  queuePressure: QueueObservationPressure;
  downstreamState: QueueObservationDownstreamState;
  summary: string;
}

/**
 * Bounded queue observer action contract.
 */
export type QueueObserverAction =
  | { kind: "noop"; reason: string }
  | { kind: "pause_family"; family: string; ttlMs: number; reason: string }
  | { kind: "resume_family"; family: string; reason: string }
  | { kind: "reprioritize_family"; family: string; priority: QueuePriorityLabel; reason: string }
  | { kind: "batch_family"; family: string; ttlMs: number; reason: string }
  | { kind: "shed_family"; family: string; reason: string }
  | { kind: "escalate"; channel: "telegram"; severity: "info" | "warn" | "error"; message: string };

/**
 * Canonical queue observer decision contract.
 */
export interface QueueObservationDecision {
  mode: QueueObservationMode;
  model?: string;
  snapshotId: string;
  findings: QueueObservationFindings;
  suggestedActions: QueueObserverAction[];
  finalActions: QueueObserverAction[];
  appliedCount: number;
  fallbackReason?: QueueObservationFallbackReason;
  latencyMs: number;
}

/**
 * Queue-control mode used for deterministic manual state and future observer enforcement.
 */
export type QueueControlMode = QueueObservationMode | "manual";

/**
 * Where a queue-control action originated.
 */
export type QueueControlSource = "manual" | "observer";

/**
 * Redis-backed deterministic pause state for one queue family.
 */
export interface QueueFamilyPauseState {
  kind: "pause_family";
  family: string;
  ttlMs: number;
  reason: string;
  source: QueueControlSource;
  mode: QueueControlMode;
  appliedAt: string;
  appliedAtMs: number;
  expiresAt: string;
  expiresAtMs: number;
  snapshotId?: string;
  model?: string;
  actor?: string;
}

/**
 * Queue family pause state that has been deterministically expired.
 */
export interface QueueExpiredFamilyPauseState extends QueueFamilyPauseState {
  expiredAt: string;
  expiredAtMs: number;
}

/**
 * Result of a deterministic resume/clear operation.
 */
export interface QueueResumeFamilyResult {
  removed: boolean;
  pause?: QueueFamilyPauseState;
}

/**
 * Redis keys for deterministic queue-control state.
 */
export interface QueueControlConfig {
  pauseStateKey: string;
  pauseExpiryKey: string;
}

/**
 * Trace metadata carried on queue envelopes.
 */
export interface QueueTraceMetadata {
  correlationId?: string;
  causationId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
}

/**
 * Queue event envelope — canonical shape for all enqueued events.
 * 
 * Provides stable identity, routing metadata, and typed payload structure
 * for queue consumers and operators. Distinct from Inngest event format.
 */
export interface QueueEventEnvelope<T = Record<string, unknown>> {
  /**
   * Stable event ID (ULID or UUID).
   * Used for idempotency and deduplication.
   */
  id: string;

  /**
   * Event name (namespaced, e.g., "discovery/noted", "content/updated").
   */
  name: string;

  /**
   * Event source (system, user, external service).
   */
  source: string;

  /**
   * Event timestamp (milliseconds since epoch).
   */
  ts: number;

  /**
   * Typed event payload.
   */
  data: T;

  /**
   * Priority level for queue processing.
   */
  priority: Priority;

  /**
   * Optional deduplication key.
   * If set, only one event with this key will be enqueued within the dedup window.
   */
  dedupKey?: string;

  /**
   * Trace metadata for observability and causality.
   */
  trace?: QueueTraceMetadata;

  /**
   * Optional triage metadata describing suggested vs applied admission decisions.
   *
   * The deterministic queue core may carry this metadata, but must not depend on
   * the model layer for correctness.
   */
  triage?: QueueTriageDecision;

  /**
   * Optional metadata for routing, filtering, or custom handling.
   */
  meta?: Record<string, unknown>;
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

  /**
   * Optional deterministic filter applied after priority ordering.
   *
   * Used by the drainer to defer paused families without changing the stored queue order.
   */
  filter?: (candidate: CandidateMessage) => boolean;
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
   * Sorted set key for the derived priority index (e.g., "myapp:queue:priority").
   *
   * The Redis stream remains the source of truth for payload + replay state; this
   * sorted set exists to make priority drains cheap and can be rebuilt from the
   * stream via `indexMessagesByPriority()` during recovery.
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
   *
   * On startup/reconnect the queue claims pending + never-delivered entries from
   * the stream. Messages older than this replay horizon are auto-acked, removed
   * from the stream, and dropped from the priority index so a stale backlog does
   * not flood the consumer after downtime.
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
