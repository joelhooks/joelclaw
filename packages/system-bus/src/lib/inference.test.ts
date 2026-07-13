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

describe("pi attempt args", () => {
  test("always requests JSON output mode so usage is parseable", () => {
    const args = __testables.buildPiAttemptArgs("anthropic/claude-haiku-4-5", {});

    expect(args.slice(0, 5)).toEqual(["pi", "-p", "--no-session", "--mode", "json"]);
    expect(args).toContain("--models");
    expect(args[args.indexOf("--models") + 1]).toBe("anthropic/claude-haiku-4-5");
  });

  test("appends thinking level to the model pattern", () => {
    const args = __testables.buildPiAttemptArgs("openai-codex/gpt-5.6-sol", { thinking: "high" });

    expect(args[args.indexOf("--models") + 1]).toBe("openai-codex/gpt-5.6-sol:high");
  });
});
