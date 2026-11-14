import type { AgentRuntime, JsonlFormat } from "@joelclaw/memory";

/**
 * The `memory/run.captured` payload, as the run-capture route sends it to
 * Inngest (system-bus `src/inngest/client.ts`). Mirrored here so the cell
 * never imports system-bus or Inngest. Legacy `jsonl_inline` senders are
 * not accepted: the route always passes `jsonl_path`.
 */
export interface CapturedPayload {
  run_id: string;
  user_id: string;
  machine_id: string;
  agent_runtime: AgentRuntime;
  jsonl_path: string;
  jsonl_bytes: number;
  jsonl_sha256: string;
  started_at: number;
  parent_run_id?: string;
  conversation_id?: string;
  tags?: string[];
  from_offset?: number;
  to_offset?: number;
  source_identity?: string;
}

/** The steps a captured run owes. Shadow mode's `append` only reads. */
export const STEPS = ["append", "otel"] as const;
export type Step = (typeof STEPS)[number];

/**
 * An owed marker's key. It never carries the attempt or the outcome, so a
 * retry or a replay lands on the same row and the same otel event id.
 */
export interface OwedKey {
  readonly run_id: string;
  readonly step: Step;
}

/** One change to an owed marker, applied by key. */
export type OwedChange =
  /** Arrival: INSERT OR IGNORE, so a duplicate leaves the first marker. */
  | (OwedKey & { readonly kind: "owe"; readonly next_at: number })
  /** Operator replay: back to owed, attempts reset, whatever state it held. */
  | (OwedKey & { readonly kind: "revive"; readonly next_at: number })
  | (OwedKey & {
      readonly kind: "retry";
      readonly attempts: number;
      readonly next_at: number;
      readonly reason: string;
    })
  | (OwedKey & {
      readonly kind: "dead";
      readonly attempts: number;
      readonly reason: string;
      readonly replay: string;
      readonly at: number;
    })
  /** The step is done: the marker is deleted. */
  | (OwedKey & { readonly kind: "settled" });

export type Verdict = "appended" | "already_indexed" | "conflict";

/** What one shadow read saw, before the fold applies the stable-outcome rule. */
export interface AppendObservation {
  readonly observed: Verdict;
  /** Writer-stage timings. Parent connection_ms includes open/schema when cold. */
  readonly phase_ms?: Record<string, number>;
  readonly canonical_duration_ms?: number;
  readonly text_bytes?: number;
  /** Which index row decided it: the same Run, another Run at the cursor, or an overlap. */
  readonly matched: "run" | "cursor" | "overlap" | null;
  readonly matched_run_id: string | null;
  /** The stable outcome: the stored chunk_count when the index already had this run. */
  readonly chunk_count: number;
  readonly turn_count: number;
  readonly format: JsonlFormat;
  /**
   * The cell's own parse of the blob, in every branch. compare checks these
   * against the index, so a race the writer wins still tests the cell.
   */
  readonly computed_chunk_count: number;
  readonly computed_turn_count: number;
  readonly computed_format: JsonlFormat;
  readonly source_identity: string;
  readonly duration_ms: number;
}

/** The recorded verdict for one run. The first one recorded wins. */
export interface ShadowVerdict extends AppendObservation {
  readonly run_id: string;
  readonly verdict: Verdict;
  readonly decided_at: number;
}

/** The JSON shape system-bus's `/observability/emit` accepts (`OtelEvent`). */
export interface CellOtelEvent {
  id: string;
  timestamp: number;
  sessionId: string;
  systemId: string;
  level: "debug" | "info" | "warn" | "error" | "fatal";
  source: string;
  component: string;
  action: string;
  duration_ms?: number;
  success: boolean;
  error?: string;
  metadata: Record<string, unknown>;
}

/** An event as the fold stores it; the shipper adds where it was sent from. */
export type PendingOtelEvent = Omit<CellOtelEvent, "sessionId" | "systemId">;

/** A row the fold writes, other than an owed marker. */
export type Fact =
  | {
      readonly kind: "captured";
      readonly run_id: string;
      readonly session_key: string;
      readonly payload: CapturedPayload;
      readonly arrived_at: number;
      readonly writer?: boolean;
    }
  | { readonly kind: "writer_adopted"; readonly run_id: string }
  | { readonly kind: "verdict"; readonly verdict: ShadowVerdict }
  /** Keyed `(run_id, step)`: the step whose outcome the event reports. */
  | {
      readonly kind: "otel_pending";
      readonly run_id: string;
      readonly step: Step;
      readonly event: PendingOtelEvent;
    }
  | { readonly kind: "otel_shipped"; readonly run_id: string; readonly step: Step };

export type FailureClass = "deterministic" | "transient";

export interface Failure {
  readonly class: FailureClass;
  readonly reason: string;
}

export type CellEvent =
  | {
      readonly type: "captured";
      readonly payload: CapturedPayload;
      readonly at: number;
      readonly writer?: boolean;
    }
  | {
      readonly type: "step_succeeded";
      readonly run_id: string;
      readonly step: "append";
      readonly observation: AppendObservation;
      readonly mode?: "cell" | "shadow";
      readonly at: number;
    }
  | {
      readonly type: "step_succeeded";
      readonly run_id: string;
      readonly step: "otel";
      readonly at: number;
    }
  | {
      readonly type: "step_failed";
      readonly run_id: string;
      readonly step: Step;
      readonly failure: Failure;
      readonly at: number;
    }
  | { readonly type: "replayed"; readonly run_id: string; readonly at: number };

export interface OwedMarkerState {
  readonly attempts: number;
  readonly state: "owed" | "dead";
}

/** What the fold reads about one run before deciding. */
export interface RunState {
  readonly captured: {
    readonly session_key: string;
    readonly payload: CapturedPayload;
    readonly writer?: boolean;
  } | null;
  readonly owed: ReadonlyMap<Step, OwedMarkerState>;
  readonly verdict: ShadowVerdict | null;
  readonly otelPending: ReadonlySet<Step>;
}

/** What one fold commits: rows, then owed markers, in one transaction. */
export interface Decision {
  readonly facts: readonly Fact[];
  readonly owed: readonly OwedChange[];
}
