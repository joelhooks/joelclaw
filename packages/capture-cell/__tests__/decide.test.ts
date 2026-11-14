import { describe, expect, test } from "bun:test";
import {
  backoffMs,
  decide,
  EMPTY_RUN_STATE,
  MAX_BACKOFF_MS,
  otelEventId,
  replayCommand,
  sessionKeyOf,
} from "../src/decide";
import { openOutbox, readRunState, fold } from "../src/outbox";
import type { CellEvent, Decision, OwedChange, RunState, Step } from "../src/types";
import { capturedPayload, OBSERVED_APPENDED, SOURCE } from "./fixtures";

function stateWith(overrides: Partial<RunState>): RunState {
  return { ...EMPTY_RUN_STATE, ...overrides };
}

const owedBoth = new Map<Step, { attempts: number; state: "owed" | "dead" }>([
  ["append", { attempts: 0, state: "owed" }],
  ["otel", { attempts: 0, state: "owed" }],
]);

const capturedState = stateWith({
  captured: { session_key: "r1", payload: capturedPayload("r1") },
  owed: owedBoth,
});

describe("decide", () => {
  test("is pure: the same state and event give an equal decision and leave the inputs untouched", () => {
    const event: CellEvent = { type: "captured", payload: capturedPayload("r1"), at: 100 };
    const frozenState = structuredClone(EMPTY_RUN_STATE);
    const frozenEvent = structuredClone(event);
    const first = decide(EMPTY_RUN_STATE, event);
    const second = decide(EMPTY_RUN_STATE, event);
    expect(second).toEqual(first);
    expect(EMPTY_RUN_STATE).toEqual(frozenState);
    expect(event).toEqual(frozenEvent);
  });

  test("arrival writes the captured row and owes append and otel", () => {
    const payload = capturedPayload("r1", { source_identity: SOURCE });
    const decision = decide(EMPTY_RUN_STATE, { type: "captured", payload, at: 100 });
    expect(decision.facts).toEqual([
      { kind: "captured", run_id: "r1", session_key: SOURCE, payload, arrived_at: 100 },
    ]);
    expect(decision.owed).toEqual([
      { kind: "owe", run_id: "r1", step: "append", next_at: 100 },
      { kind: "owe", run_id: "r1", step: "otel", next_at: 100 },
    ]);
  });

  test("a duplicate captured gives no new facts and owes nothing", () => {
    const decision = decide(capturedState, {
      type: "captured",
      payload: capturedPayload("r1"),
      at: 200,
    });
    expect(decision).toEqual({ facts: [], owed: [] });
  });

  test("a duplicate captured is a no-op end to end on the outbox", () => {
    const db = openOutbox(":memory:");
    const event: CellEvent = { type: "captured", payload: capturedPayload("r1"), at: 100 };
    expect(fold(db, event).facts).toHaveLength(1);
    const before = readRunState(db, "r1");
    expect(fold(db, { ...event, at: 999 })).toEqual({ facts: [], owed: [] });
    expect(readRunState(db, "r1")).toEqual(before);
    db.close();
  });

  test("the session key is source_identity, else run_id", () => {
    expect(sessionKeyOf(capturedPayload("r1", { source_identity: SOURCE }))).toBe(SOURCE);
    expect(sessionKeyOf(capturedPayload("r2"))).toBe("r2");
  });

  test("owed keys never include the attempt or the outcome", () => {
    const events: Array<[RunState, CellEvent]> = [
      [EMPTY_RUN_STATE, { type: "captured", payload: capturedPayload("r1"), at: 1 }],
      [
        capturedState,
        {
          type: "step_failed",
          run_id: "r1",
          step: "append",
          failure: { class: "transient", reason: "busy" },
          at: 2,
        },
      ],
      [
        capturedState,
        {
          type: "step_failed",
          run_id: "r1",
          step: "append",
          failure: { class: "deterministic", reason: "gone" },
          at: 3,
        },
      ],
      [
        capturedState,
        {
          type: "step_succeeded",
          run_id: "r1",
          step: "append",
          observation: OBSERVED_APPENDED,
          at: 4,
        },
      ],
      [capturedState, { type: "replayed", run_id: "r1", at: 5 }],
    ];
    const changes: OwedChange[] = events.flatMap(([state, event]) => [
      ...decide(state, event).owed,
    ]);
    expect(changes.length).toBeGreaterThan(0);
    // Every change addresses a row by (run_id, step) alone.
    expect(new Set(changes.map((change) => `${change.run_id}/${change.step}`))).toEqual(
      new Set(["r1/append", "r1/otel"]),
    );

    // The outbox's primary key is (run_id, step) and nothing else, so
    // retries and failures update one row instead of adding rows.
    const db = openOutbox(":memory:");
    const pk = (db.query("PRAGMA table_info(owed)").all() as Array<{ name: string; pk: number }>)
      .filter((column) => column.pk > 0)
      .map((column) => column.name);
    expect(pk).toEqual(["run_id", "step"]);
    fold(db, { type: "captured", payload: capturedPayload("r1"), at: 1 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      fold(db, {
        type: "step_failed",
        run_id: "r1",
        step: "append",
        failure: { class: "transient", reason: `busy ${attempt}` },
        at: 2 + attempt,
      });
    }
    const rows = db
      .query("SELECT step, attempts FROM owed WHERE run_id = 'r1' ORDER BY step")
      .all();
    expect(rows).toEqual([
      { step: "append", attempts: 3 },
      { step: "otel", attempts: 0 },
    ]);
    db.close();

    // The otel id is the same whatever the outcome.
    const appended = decide(capturedState, {
      type: "step_succeeded",
      run_id: "r1",
      step: "append",
      observation: OBSERVED_APPENDED,
      at: 1,
    });
    const conflicted = decide(capturedState, {
      type: "step_succeeded",
      run_id: "r1",
      step: "append",
      observation: { ...OBSERVED_APPENDED, observed: "conflict" },
      at: 2,
    });
    const idOf = (decision: Decision) =>
      (decision.facts.find((fact) => fact.kind === "otel_pending") as { event: { id: string } })
        .event.id;
    expect(idOf(appended)).toBe(idOf(conflicted));
    expect(otelEventId("r1", "append")).toBe("capture-cell:r1:append");
  });

  test("append success records the verdict, an otel row keyed (run_id, append), and settles the marker", () => {
    const decision = decide(capturedState, {
      type: "step_succeeded",
      run_id: "r1",
      step: "append",
      observation: OBSERVED_APPENDED,
      at: 50,
    });
    expect(decision.facts.map((fact) => fact.kind)).toEqual(["verdict", "otel_pending"]);
    const pending = decision.facts[1] as Extract<
      Decision["facts"][number],
      { kind: "otel_pending" }
    >;
    expect(pending.step).toBe("append");
    expect(pending.event.id).toBe("capture-cell:r1:append");
    expect(pending.event.component).toBe("capture-cell");
    expect(pending.event.action).toBe("capture.cell.shadow.verdict");
    expect(decision.owed).toEqual([{ kind: "settled", run_id: "r1", step: "append" }]);
  });

  test("stable outcome: already_indexed by the same run while append is owed records appended", () => {
    const decision = decide(capturedState, {
      type: "step_succeeded",
      run_id: "r1",
      step: "append",
      observation: {
        ...OBSERVED_APPENDED,
        observed: "already_indexed",
        matched: "run",
        matched_run_id: "r1",
        chunk_count: 7,
      },
      at: 50,
    });
    const verdict = decision.facts[0] as Extract<Decision["facts"][number], { kind: "verdict" }>;
    expect(verdict.verdict.verdict).toBe("appended");
    expect(verdict.verdict.observed).toBe("already_indexed");
    expect(verdict.verdict.chunk_count).toBe(7);
    expect(verdict.verdict.computed_chunk_count).toBe(OBSERVED_APPENDED.computed_chunk_count);
  });

  test("already_indexed by another run at the cursor stays already_indexed", () => {
    const decision = decide(capturedState, {
      type: "step_succeeded",
      run_id: "r1",
      step: "append",
      observation: {
        ...OBSERVED_APPENDED,
        observed: "already_indexed",
        matched: "cursor",
        matched_run_id: "r0",
      },
      at: 50,
    });
    const verdict = decision.facts[0] as Extract<Decision["facts"][number], { kind: "verdict" }>;
    expect(verdict.verdict.verdict).toBe("already_indexed");
  });

  test("the first verdict wins over a replayed append", () => {
    const first = decide(capturedState, {
      type: "step_succeeded",
      run_id: "r1",
      step: "append",
      observation: OBSERVED_APPENDED,
      at: 50,
    });
    const stored = (first.facts[0] as Extract<Decision["facts"][number], { kind: "verdict" }>)
      .verdict;
    const again = decide(stateWith({ ...capturedState, verdict: stored }), {
      type: "step_succeeded",
      run_id: "r1",
      step: "append",
      observation: { ...OBSERVED_APPENDED, observed: "conflict" },
      at: 90,
    });
    expect(again.facts.map((fact) => fact.kind)).toEqual(["otel_pending"]);
    const pending = again.facts[0] as Extract<Decision["facts"][number], { kind: "otel_pending" }>;
    expect(pending.event.metadata.verdict).toBe("appended");
  });

  test("a deterministic failure goes dead with its reason and the replay command", () => {
    const decision = decide(capturedState, {
      type: "step_failed",
      run_id: "r1",
      step: "append",
      failure: { class: "deterministic", reason: "run blob unreadable: ENOENT" },
      at: 10,
    });
    expect(decision.owed).toEqual([
      {
        kind: "dead",
        run_id: "r1",
        step: "append",
        attempts: 1,
        reason: "run blob unreadable: ENOENT",
        replay: replayCommand("r1"),
        at: 10,
      },
      { kind: "settled", run_id: "r1", step: "otel" },
    ]);
    expect(replayCommand("r1")).toBe("capture-cell replay r1");
  });

  test("a transient failure backs off, capped at five minutes, and never goes dead", () => {
    let state = capturedState;
    for (let attempt = 1; attempt <= 40; attempt += 1) {
      const decision = decide(state, {
        type: "step_failed",
        run_id: "r1",
        step: "append",
        failure: { class: "transient", reason: "SQLITE_BUSY" },
        at: 1_000,
      });
      const [change] = decision.owed;
      expect(change?.kind).toBe("retry");
      const retry = change as Extract<OwedChange, { kind: "retry" }>;
      expect(retry.attempts).toBe(attempt);
      expect(retry.next_at - 1_000).toBeLessThanOrEqual(MAX_BACKOFF_MS);
      state = stateWith({
        ...capturedState,
        owed: new Map([...owedBoth, ["append", { attempts: retry.attempts, state: "owed" }]]),
      });
    }
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(40)).toBe(MAX_BACKOFF_MS);
  });

  test("replay revives a dead marker and re-owes a settled one", () => {
    const dead = stateWith({
      ...capturedState,
      owed: new Map([["append", { attempts: 1, state: "dead" }]]),
    });
    expect(decide(dead, { type: "replayed", run_id: "r1", at: 9 }).owed).toEqual([
      { kind: "revive", run_id: "r1", step: "append", next_at: 9 },
      { kind: "owe", run_id: "r1", step: "otel", next_at: 9 },
    ]);
    expect(decide(EMPTY_RUN_STATE, { type: "replayed", run_id: "nope", at: 9 })).toEqual({
      facts: [],
      owed: [],
    });
  });

  test("a step outcome for a marker no longer owed is a no-op", () => {
    const settled = stateWith({ captured: capturedState.captured, owed: new Map() });
    expect(
      decide(settled, {
        type: "step_succeeded",
        run_id: "r1",
        step: "append",
        observation: OBSERVED_APPENDED,
        at: 1,
      }),
    ).toEqual({ facts: [], owed: [] });
    expect(
      decide(settled, {
        type: "step_failed",
        run_id: "r1",
        step: "append",
        failure: { class: "transient", reason: "x" },
        at: 1,
      }),
    ).toEqual({ facts: [], owed: [] });
  });
});
