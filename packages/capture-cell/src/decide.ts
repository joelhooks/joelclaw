import type {
  AppendObservation,
  CapturedPayload,
  CellEvent,
  Decision,
  Fact,
  OwedChange,
  PendingOtelEvent,
  RunState,
  ShadowVerdict,
  Step,
} from "./types";
import { STEPS } from "./types";

/*
 * The cell's fold: `decide(state, event) -> { facts, owed }`, pure and
 * synchronous, shaped like drovr's actor fold (`FoldCommitArgs` ->
 * `CommittedFold` with `ProjectionOwed` markers) and Mischief's
 * `RunChanges` / `RunBackend.apply`, so joining a shared kernel later is a
 * rename. `apply` in `outbox.ts` writes the decision in one BEGIN IMMEDIATE.
 */

export const COMPONENT = "capture-cell";
export const VERDICT_ACTION = "capture.cell.shadow.verdict";

/** The longest a transient failure waits before its next attempt. */
export const MAX_BACKOFF_MS = 5 * 60_000;
const BASE_BACKOFF_MS = 1_000;

const NOTHING: Decision = { facts: [], owed: [] };

/** One key per session: runs of a session never race the overlap check. */
export function sessionKeyOf(payload: CapturedPayload): string {
  return payload.source_identity ?? payload.run_id;
}

/** The exact command that revives a dead run. */
export function replayCommand(runId: string): string {
  return `capture-cell replay ${runId}`;
}

/** The deterministic otel event id for a run's step: never the attempt or the outcome. */
export function otelEventId(runId: string, step: Step): string {
  return `${COMPONENT}:${runId}:${step}`;
}

/** Capped exponential backoff for the given attempt count (1-based). */
export function backoffMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 30));
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** exponent);
}

/**
 * The stable-outcome rule: when this cell still owes `append` for a run and
 * the read finds the same Run already indexed (by run_id, with the same
 * identity), the run was appended by an earlier attempt, or in shadow mode
 * by the writer racing ahead. The original outcome, `appended`, is recorded
 * with the stored chunk_count; turn_count comes from the same pure parse.
 * The cell's own counts stay on the verdict as computed_*, for compare.
 */
export function stableVerdict(
  runId: string,
  observation: AppendObservation,
  decidedAt: number,
): ShadowVerdict {
  const verdict =
    observation.observed === "already_indexed" && observation.matched === "run"
      ? "appended"
      : observation.observed;
  return { ...observation, run_id: runId, verdict, decided_at: decidedAt };
}

/** The one otel event a run's verdict ships as. */
export function verdictOtelEvent(
  verdict: ShadowVerdict,
  mode: "cell" | "shadow" = "shadow",
): PendingOtelEvent {
  return {
    id: otelEventId(verdict.run_id, "append"),
    timestamp: verdict.decided_at,
    level: verdict.verdict === "conflict" ? "warn" : "info",
    source: COMPONENT,
    component: COMPONENT,
    action: mode === "cell" ? "capture.cell.append" : VERDICT_ACTION,
    duration_ms: Math.max(0, Math.round(verdict.duration_ms)),
    success: true,
    metadata: {
      mode,
      status: verdict.verdict,
      run_id: verdict.run_id,
      verdict: verdict.verdict,
      observed: verdict.observed,
      matched: verdict.matched,
      matched_run_id: verdict.matched_run_id,
      chunk_count: verdict.chunk_count,
      turn_count: verdict.turn_count,
      format: verdict.format,
      computed_chunk_count: verdict.computed_chunk_count,
      computed_turn_count: verdict.computed_turn_count,
      computed_format: verdict.computed_format,
      source_identity: verdict.source_identity,
    },
  };
}

function isOwed(state: RunState, step: Step): boolean {
  return state.owed.get(step)?.state === "owed";
}

function decideCaptured(
  state: RunState,
  payload: CapturedPayload,
  at: number,
  writer?: boolean,
): Decision {
  // Arrival is idempotent on run_id: hook retries, accepted_prefix resends
  // and duplicate posts all collapse to the first save.
  if (state.captured !== null) {
    if (!writer || state.captured.writer) return NOTHING;
    // A lost acknowledgement can straddle cutover. Adopt the original stored
    // payload, never the retry's bytes, and owe a real append even if a shadow
    // read already predicted success. Subsequent writer arrivals are no-ops.
    return {
      facts: [{ kind: "writer_adopted", run_id: payload.run_id }],
      owed: STEPS.map((step) => ({
        kind: state.owed.has(step) ? "revive" : "owe",
        run_id: payload.run_id,
        step,
        next_at: at,
      })),
    };
  }
  return {
    facts: [
      {
        kind: "captured",
        run_id: payload.run_id,
        session_key: sessionKeyOf(payload),
        payload,
        arrived_at: at,
        ...(writer ? { writer: true } : {}),
      },
    ],
    owed: STEPS.map((step) => ({ kind: "owe", run_id: payload.run_id, step, next_at: at })),
  };
}

function decideAppendSucceeded(
  state: RunState,
  runId: string,
  observation: AppendObservation,
  at: number,
  mode: "cell" | "shadow" = "shadow",
): Decision {
  // A step that ran after its marker was settled re-ran harmlessly.
  if (!isOwed(state, "append")) return NOTHING;
  const facts: Fact[] = [];
  // The first outcome wins: a replay never rewrites a recorded verdict.
  const verdict = state.verdict ?? stableVerdict(runId, observation, at);
  if (state.verdict === null) facts.push({ kind: "verdict", verdict });
  if (!state.otelPending.has("append")) {
    facts.push({
      kind: "otel_pending",
      run_id: runId,
      step: "append",
      event: verdictOtelEvent(verdict, mode),
    });
  }
  return { facts, owed: [{ kind: "settled", run_id: runId, step: "append" }] };
}

function decideOtelSucceeded(state: RunState, runId: string): Decision {
  if (!isOwed(state, "otel")) return NOTHING;
  return {
    facts: [...state.otelPending].map((step) => ({ kind: "otel_shipped", run_id: runId, step })),
    owed: [{ kind: "settled", run_id: runId, step: "otel" }],
  };
}

function decideFailed(
  state: RunState,
  runId: string,
  step: Step,
  failure: { class: "deterministic" | "transient"; reason: string },
  at: number,
): Decision {
  const marker = state.owed.get(step);
  if (marker?.state !== "owed") return NOTHING;
  const attempts = marker.attempts + 1;
  if (failure.class === "transient") {
    // Transient failures never go dead: they back off and trip the age alarm.
    return {
      facts: [],
      owed: [
        {
          kind: "retry",
          run_id: runId,
          step,
          attempts,
          next_at: at + backoffMs(attempts),
          reason: failure.reason,
        },
      ],
    };
  }
  const owed: OwedChange[] = [
    {
      kind: "dead",
      run_id: runId,
      step,
      attempts,
      reason: failure.reason,
      replay: replayCommand(runId),
      at,
    },
  ];
  // A dead append leaves no verdict to ship, so its otel marker settles
  // with it rather than waiting forever; a replay owes both again.
  if (step === "append" && state.owed.has("otel") && state.otelPending.size === 0) {
    owed.push({ kind: "settled", run_id: runId, step: "otel" });
  }
  return { facts: [], owed };
}

function decideReplayed(state: RunState, runId: string, at: number): Decision {
  if (state.captured === null) return NOTHING;
  return {
    facts: [],
    owed: STEPS.map((step) =>
      state.owed.has(step)
        ? { kind: "revive", run_id: runId, step, next_at: at }
        : { kind: "owe", run_id: runId, step, next_at: at },
    ),
  };
}

/** The fold. Pure: no clock, no I/O; every instant comes from the event. */
export function decide(state: RunState, event: CellEvent): Decision {
  switch (event.type) {
    case "captured":
      return decideCaptured(state, event.payload, event.at, event.writer);
    case "step_succeeded":
      return event.step === "append"
        ? decideAppendSucceeded(state, event.run_id, event.observation, event.at, event.mode)
        : decideOtelSucceeded(state, event.run_id);
    case "step_failed":
      return decideFailed(state, event.run_id, event.step, event.failure, event.at);
    case "replayed":
      return decideReplayed(state, event.run_id, event.at);
  }
}

/** The state of a run the cell has never seen. */
export const EMPTY_RUN_STATE: RunState = {
  captured: null,
  owed: new Map(),
  verdict: null,
  otelPending: new Set(),
};
