import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const REPO_ADR = resolve(
  REPO_ROOT,
  "docs/decisions/0010-system-loop-gateway.md",
);

// Helper: read the ADR content
async function readAdr(): Promise<string> {
  return Bun.file(REPO_ADR).text();
}

// Helper: extract a ## section (everything between this heading and the next ## or EOF)
function extractSection(content: string, heading: string): string | null {
  const pattern = new RegExp(
    `\\n## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n# |$)`,
  );
  const match = content.match(pattern);
  return match ? match[1].trim() : null;
}

// Helper: count checkbox items (- [ ] syntax)
function countCheckboxItems(text: string): number {
  return text.split("\n").filter((line) => /^\s*-\s+\[[ x]\]\s+/.test(line))
    .length;
}

// Helper: extract checkbox items as strings
function extractCheckboxItems(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /^\s*-\s+\[[ x]\]\s+/.test(line))
    .map((line) => line.replace(/^\s*-\s+\[[ x]\]\s+/, "").trim());
}

// --------------------------------------------------------------------------
// AC-1: Has ## Implementation Plan section with numbered steps
// --------------------------------------------------------------------------
describe("AC-1: Implementation Plan section with numbered steps", () => {
  test("ADR contains a ## Implementation Plan heading", async () => {
    const content = await readAdr();
    expect(content).toMatch(/^## Implementation Plan/m);
  });

  test("Implementation Plan section has numbered steps", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    // Count lines starting with a number followed by a period
    const numberedSteps = section!
      .split("\n")
      .filter((line) => /^\d+\.\s+/.test(line));
    expect(numberedSteps.length).toBeGreaterThanOrEqual(3);
  });

  test("numbered steps are sequential starting from 1", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const stepNumbers = section!
      .split("\n")
      .filter((line) => /^\d+\.\s+/.test(line))
      .map((line) => parseInt(line.match(/^(\d+)\./)![1], 10));

    expect(stepNumbers[0]).toBe(1);
    for (let i = 1; i < stepNumbers.length; i++) {
      expect(stepNumbers[i]).toBe(stepNumbers[i - 1] + 1);
    }
  });
});

// --------------------------------------------------------------------------
// AC-2: Plan describes the heartbeat Inngest function
// --------------------------------------------------------------------------
describe("AC-2: Heartbeat Inngest function described", () => {
  test("Implementation Plan mentions heartbeat", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    expect(lower).toMatch(/heartbeat/);
  });

  test("Implementation Plan mentions Inngest function", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasInngest = lower.includes("inngest");
    const hasFunction = lower.includes("function");
    expect(hasInngest && hasFunction).toBe(true);
  });

  test("Implementation Plan describes cron trigger", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasCron = lower.includes("cron");
    const hasSchedule = lower.includes("schedule");
    expect(hasCron || hasSchedule).toBe(true);
  });

  test("Implementation Plan describes event triggers (terminal events)", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    // Should mention terminal lifecycle events
    const hasLoopComplete =
      lower.includes("loop.complete") || lower.includes("loop complete");
    const hasEventTrigger =
      lower.includes("event") && lower.includes("trigger");
    const hasTerminalEvent = lower.includes("terminal");
    expect(hasLoopComplete || hasEventTrigger || hasTerminalEvent).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-3: Plan describes state gathering (note queue, slog, retros, active runs)
// --------------------------------------------------------------------------
describe("AC-3: State gathering described", () => {
  test("Implementation Plan describes a state gathering step", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasStateGathering = lower.includes("state");
    const hasGather =
      lower.includes("gather") ||
      lower.includes("read") ||
      lower.includes("collect") ||
      lower.includes("snapshot");
    expect(hasStateGathering && hasGather).toBe(true);
  });

  test("state gathering includes note queue length", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    expect(lower).toMatch(/note\s+queue/);
  });

  test("state gathering includes recent slog entries", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    expect(lower).toMatch(/slog/);
  });

  test("state gathering includes pending retrospective recommendations", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasRetro =
      lower.includes("retrospective") || lower.includes("retro");
    const hasRecommendation =
      lower.includes("recommendation") || lower.includes("pending");
    expect(hasRetro && hasRecommendation).toBe(true);
  });

  test("state gathering includes active loop runs", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasActiveRuns =
      lower.includes("active") &&
      (lower.includes("loop") || lower.includes("run"));
    expect(hasActiveRuns).toBe(true);
  });

  test("state gathering includes half-done inventory", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasHalfDone = lower.includes("half-done") || lower.includes("half done");
    const hasIncomplete =
      lower.includes("incomplete") || lower.includes("unfinished");
    const hasInventory = lower.includes("inventory");
    expect((hasHalfDone || hasIncomplete) && hasInventory || hasHalfDone).toBe(
      true,
    );
  });
});

// --------------------------------------------------------------------------
// AC-4: Plan describes LLM decision step with constrained action set
// --------------------------------------------------------------------------
describe("AC-4: LLM decision step with constrained action set", () => {
  test("Implementation Plan describes an LLM decision step", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasLlm = lower.includes("llm");
    const hasDecision =
      lower.includes("decision") ||
      lower.includes("decide") ||
      lower.includes("evaluate");
    expect(hasLlm && hasDecision).toBe(true);
  });

  test("action set includes start_loop or equivalent", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasStartLoop =
      lower.includes("start_loop") ||
      lower.includes("start loop") ||
      lower.includes("start a loop");
    expect(hasStartLoop).toBe(true);
  });

  test("action set includes process_notes or equivalent", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasProcessNotes =
      lower.includes("process_notes") ||
      lower.includes("process notes") ||
      lower.includes("note processing");
    expect(hasProcessNotes).toBe(true);
  });

  test("action set includes apply retro recommendation or equivalent", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasApplyRetro =
      lower.includes("apply_retro") ||
      lower.includes("apply retro") ||
      lower.includes("retro recommendation") ||
      lower.includes("apply recommendation");
    expect(hasApplyRetro).toBe(true);
  });

  test("action set includes emit_alert or equivalent", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasEmitAlert =
      lower.includes("emit_alert") ||
      lower.includes("emit alert") ||
      lower.includes("alert");
    expect(hasEmitAlert).toBe(true);
  });

  test("action set includes do_nothing or equivalent", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasDoNothing =
      lower.includes("do_nothing") ||
      lower.includes("do nothing") ||
      lower.includes("no-op") ||
      lower.includes("noop");
    expect(hasDoNothing).toBe(true);
  });

  test("action set is described as constrained or bounded", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasConstrained =
      lower.includes("constrained") ||
      lower.includes("bounded") ||
      lower.includes("allowed") ||
      lower.includes("fixed set") ||
      lower.includes("exactly one");
    expect(hasConstrained).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-5: Plan describes safety rails (rate limits, cost budget, human approval)
// --------------------------------------------------------------------------
describe("AC-5: Safety rails described", () => {
  test("Implementation Plan describes rate limiting or max actions per hour", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasRateLimit =
      lower.includes("rate limit") || lower.includes("rate-limit");
    const hasMaxActions =
      lower.includes("max actions") || lower.includes("max-actions");
    const hasPerHour = lower.includes("per hour");
    const hasThrottle = lower.includes("throttl");
    const hasLimiter = lower.includes("limiter");
    expect(
      hasRateLimit || hasMaxActions || hasPerHour || hasThrottle || hasLimiter,
    ).toBe(true);
  });

  test("Implementation Plan describes cost budget controls", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasCostBudget =
      lower.includes("cost budget") || lower.includes("cost cap");
    const hasBudget = lower.includes("budget");
    const hasSpend = lower.includes("spend");
    const hasTokenCeiling = lower.includes("token ceiling");
    expect(hasCostBudget || hasBudget || hasSpend || hasTokenCeiling).toBe(
      true,
    );
  });

  test("Implementation Plan describes human-approval gate for destructive actions", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasHumanApproval =
      lower.includes("human-approval") ||
      lower.includes("human approval") ||
      lower.includes("approval gate");
    const hasDestructive = lower.includes("destructive");
    expect(hasHumanApproval || hasDestructive).toBe(true);
  });

  test("Implementation Plan describes always-log reasoning requirement", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasAlwaysLog =
      lower.includes("always-log") || lower.includes("always log");
    const hasLogReasoning =
      lower.includes("log") && lower.includes("reasoning");
    const hasAudit = lower.includes("audit");
    expect(hasAlwaysLog || hasLogReasoning || hasAudit).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-6: Has ## Verification section with at least 5 checkbox items
// --------------------------------------------------------------------------
describe("AC-6: Verification section with checkbox items", () => {
  test("ADR contains a ## Verification heading", async () => {
    const content = await readAdr();
    expect(content).toMatch(/^## Verification/m);
  });

  test("Verification section has at least 5 checkbox items using - [ ] syntax", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Verification");
    expect(section).not.toBeNull();

    const checkboxCount = countCheckboxItems(section!);
    expect(checkboxCount).toBeGreaterThanOrEqual(5);
  });
});

// --------------------------------------------------------------------------
// AC-7: Verification items are specific and testable, not vague
// --------------------------------------------------------------------------
describe("AC-7: Verification items are specific and testable", () => {
  test("each checkbox item has at least 10 words (not overly terse)", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Verification");
    expect(section).not.toBeNull();

    const items = extractCheckboxItems(section!);
    expect(items.length).toBeGreaterThanOrEqual(5);

    for (const item of items) {
      const wordCount = item.split(/\s+/).filter((w) => w.length > 0).length;
      expect(wordCount).toBeGreaterThanOrEqual(10);
    }
  });

  test("no checkbox item uses vague wording like 'works correctly' or 'is good'", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Verification");
    expect(section).not.toBeNull();

    const items = extractCheckboxItems(section!);
    const vaguePatterns = [
      /works?\s+correctly/i,
      /is\s+good/i,
      /should\s+be\s+fine/i,
      /as\s+expected/i,
      /properly\s+implemented/i,
    ];

    for (const item of items) {
      for (const pattern of vaguePatterns) {
        expect(pattern.test(item)).toBe(false);
      }
    }
  });

  test("checkbox items reference concrete system concepts (events, functions, limits, logs)", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Verification");
    expect(section).not.toBeNull();

    const items = extractCheckboxItems(section!);
    const concreteTerms = [
      "inngest",
      "event",
      "cron",
      "heartbeat",
      "function",
      "action",
      "log",
      "schema",
      "validate",
      "limit",
      "budget",
      "approval",
      "snapshot",
      "trigger",
      "emit",
      "dispatch",
      "rate",
      "cost",
      "decision",
    ];

    // Each item should contain at least one concrete system term
    for (const item of items) {
      const lower = item.toLowerCase();
      const hasConcreteTerm = concreteTerms.some((term) =>
        lower.includes(term),
      );
      expect(hasConcreteTerm).toBe(true);
    }
  });
});

// --------------------------------------------------------------------------
// AC-8: Overall ADR is coherent and self-consistent across all sections
// --------------------------------------------------------------------------
describe("AC-8: ADR coherence and self-consistency", () => {
  test("Implementation Plan references concepts from Decision Outcome", async () => {
    const content = await readAdr();
    const decisionOutcome = extractSection(content, "Decision Outcome");
    const implPlan = extractSection(content, "Implementation Plan");
    expect(decisionOutcome).not.toBeNull();
    expect(implPlan).not.toBeNull();

    const implLower = implPlan!.toLowerCase();
    // Decision Outcome chose hybrid event-driven + cron; Implementation Plan should reflect both
    const hasCron = implLower.includes("cron");
    const hasEvent =
      implLower.includes("event") || implLower.includes("trigger");
    expect(hasCron && hasEvent).toBe(true);
  });

  test("Verification items align with Implementation Plan steps", async () => {
    const content = await readAdr();
    const implPlan = extractSection(content, "Implementation Plan");
    const verification = extractSection(content, "Verification");
    expect(implPlan).not.toBeNull();
    expect(verification).not.toBeNull();

    const verLower = verification!.toLowerCase();
    // Key implementation concepts should appear in verification
    const hasHeartbeat = verLower.includes("heartbeat");
    const hasAction =
      verLower.includes("action") || verLower.includes("dispatch");
    const hasState =
      verLower.includes("state") ||
      verLower.includes("snapshot") ||
      verLower.includes("input");
    expect(hasHeartbeat && hasAction && hasState).toBe(true);
  });

  test("safety concepts appear in both Implementation Plan and Verification", async () => {
    const content = await readAdr();
    const implPlan = extractSection(content, "Implementation Plan");
    const verification = extractSection(content, "Verification");
    expect(implPlan).not.toBeNull();
    expect(verification).not.toBeNull();

    const implLower = implPlan!.toLowerCase();
    const verLower = verification!.toLowerCase();

    // Rate limiting / action limits mentioned in both
    const implHasLimits =
      implLower.includes("limit") || implLower.includes("max");
    const verHasLimits =
      verLower.includes("limit") || verLower.includes("max");
    expect(implHasLimits && verHasLimits).toBe(true);

    // Cost budget mentioned in both
    const implHasBudget =
      implLower.includes("budget") || implLower.includes("cost");
    const verHasBudget =
      verLower.includes("budget") || verLower.includes("cost");
    expect(implHasBudget && verHasBudget).toBe(true);
  });

  test("ADR has all major sections present (Context, Drivers, Options, Outcome, Plan, Verification)", async () => {
    const content = await readAdr();
    const requiredSections = [
      "Context and Problem Statement",
      "Decision Drivers",
      "Considered Options",
      "Decision Outcome",
      "Implementation Plan",
      "Verification",
    ];

    for (const section of requiredSections) {
      const extracted = extractSection(content, section);
      expect(extracted).not.toBeNull();
    }
  });
});

// --------------------------------------------------------------------------
// AC-9: TypeScript compiles with no errors (bun test on the test file)
// --------------------------------------------------------------------------
describe("AC-9: TypeScript compiles", () => {
  test("this test file compiles and runs under bun test", () => {
    // If we reach this point, the file compiled successfully
    expect(true).toBe(true);
  });
});
