import { describe, expect, test } from "bun:test";
import { __testables } from "./inference";

describe("inference timeout budgeting", () => {
  test("normalizeTimeout preserves an explicit one-hour request budget", () => {
    expect(__testables.normalizeTimeout(60 * 60 * 1000)).toBe(60 * 60 * 1000);
  });

  test("normalizeTimeout clamps oversized requests to one hour", () => {
    expect(__testables.normalizeTimeout(2 * 60 * 60 * 1000)).toBe(60 * 60 * 1000);
  });

  test("remainingAttemptBudgetMs uses the remaining overall deadline budget", () => {
    const deadlineMs = 100_000;

    expect(__testables.remainingAttemptBudgetMs(deadlineMs, 40_000)).toBe(60_000);
    expect(__testables.remainingAttemptBudgetMs(deadlineMs, 99_500)).toBeNull();
  });
});
