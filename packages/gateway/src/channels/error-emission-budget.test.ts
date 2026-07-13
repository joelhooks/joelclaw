import { describe, expect, test } from "bun:test";
import { describeError, ErrorEmissionBudget } from "./error-emission-budget";

describe("ErrorEmissionBudget", () => {
  test("emits one row for a repeated signature and summarizes the rest", () => {
    let now = 1_000;
    const budget = new ErrorEmissionBudget({
      windowMs: 60_000,
      maxDistinctPerWindow: 3,
      now: () => now,
    });

    expect(budget.record("ECONNREFUSED")).toEqual({ emit: true });
    expect(budget.record("ECONNREFUSED")).toEqual({ emit: false });
    expect(budget.record("ECONNREFUSED")).toEqual({ emit: false });

    now += 60_000;
    expect(budget.record("ECONNREFUSED")).toEqual({
      emit: true,
      summary: {
        windowStartedAt: 1_000,
        windowEndedAt: 61_000,
        emitted: 1,
        suppressed: 2,
        suppressedSignatures: ["ECONNREFUSED"],
      },
    });
  });

  test("caps distinct failures and flushes a summary on recovery", () => {
    let now = 5_000;
    const budget = new ErrorEmissionBudget({
      windowMs: 60_000,
      maxDistinctPerWindow: 2,
      now: () => now,
    });

    expect(budget.record("first").emit).toBe(true);
    expect(budget.record("second").emit).toBe(true);
    expect(budget.record("third").emit).toBe(false);
    expect(budget.record("third").emit).toBe(false);

    now = 8_000;
    expect(budget.flush()).toEqual({
      windowStartedAt: 5_000,
      windowEndedAt: 8_000,
      emitted: 2,
      suppressed: 2,
      suppressedSignatures: ["third"],
    });
    expect(budget.flush()).toBeUndefined();
  });
});

describe("describeError", () => {
  test("keeps bounded AggregateError causes for diagnosis and dedupe", () => {
    const error = new AggregateError([
      Object.assign(new Error("connect ETIMEDOUT 127.0.0.1:6379"), { code: "ETIMEDOUT" }),
      new Error("connect ENETUNREACH ::1:6379"),
    ]);

    expect(describeError(error)).toEqual({
      message: "AggregateError",
      name: "AggregateError",
      causes: [
        "Error: connect ETIMEDOUT 127.0.0.1:6379",
        "Error: connect ENETUNREACH ::1:6379",
      ],
      signature: "AggregateError:AggregateError:Error: connect ETIMEDOUT 127.0.0.1:6379:Error: connect ENETUNREACH ::1:6379",
    });
  });
});
