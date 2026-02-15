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

// Helper: extract numbered steps from a section
function extractNumberedSteps(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^\d+\.\s+/, "").trim());
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

  test("Implementation Plan has at least 3 numbered steps", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const steps = extractNumberedSteps(section!);
    expect(steps.length).toBeGreaterThanOrEqual(3);
  });

  test("numbered steps are sequential from 1", async () => {
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
  test("mentions heartbeat in the Implementation Plan", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();
    expect(section!.toLowerCase()).toContain("heartbeat");
  });

  test("describes an Inngest function", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    expect(lower).toContain("inngest");
    expect(lower).toMatch(/function/);
  });

  test("describes cron-based triggering", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasCron = lower.includes("cron");
    const hasSchedule = lower.includes("schedule");
    expect(hasCron || hasSchedule).toBe(true);
  });

  test("describes event-based triggering from terminal lifecycle events", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    // Should describe triggers from terminal events
    const hasTerminalEvent = lower.includes("terminal");
    const hasLoopComplete =
      lower.includes("loop.complete") || lower.includes("loop complete");
    const hasEventTrigger =
      lower.includes("event") &&
      (lower.includes("trigger") || lower.includes("triggered"));
    expect(hasTerminalEvent || hasLoopComplete || hasEventTrigger).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-3: Plan describes state gathering (note queue, slog, retros, active runs)
// --------------------------------------------------------------------------
describe("AC-3: State gathering described", () => {
  test("describes a state gathering or snapshot step", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasState = lower.includes("state");
    const hasGatherOrRead =
      lower.includes("gather") ||
      lower.includes("read") ||
      lower.includes("collect") ||
      lower.includes("snapshot");
    expect(hasState && hasGatherOrRead).toBe(true);
  });

  test("includes note queue length", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();
    expect(section!.toLowerCase()).toMatch(/note\s+queue/);
  });

  test("includes recent slog entries", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();
    expect(section!.toLowerCase()).toContain("slog");
  });

  test("includes pending retro recommendations", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasRetro =
      lower.includes("retrospective") || lower.includes("retro");
    const hasPendingOrRecommendation =
      lower.includes("recommendation") || lower.includes("pending");
    expect(hasRetro && hasPendingOrRecommendation).toBe(true);
  });

  test("includes active loop runs", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    expect(lower).toContain("active");
    const hasLoop = lower.includes("loop");
    const hasRun = lower.includes("run");
    expect(hasLoop || hasRun).toBe(true);
  });

  test("includes half-done inventory", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasHalfDone =
      lower.includes("half-done") || lower.includes("half done");
    const hasIncomplete =
      lower.includes("incomplete") || lower.includes("unfinished");
    expect(hasHalfDone || hasIncomplete).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-4: Plan describes LLM decision step with constrained action set
// --------------------------------------------------------------------------
describe("AC-4: LLM decision step with constrained action set", () => {
  test("describes an LLM-based decision step", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    expect(lower).toContain("llm");
    const hasDecide =
      lower.includes("decision") ||
      lower.includes("decide") ||
      lower.includes("evaluate") ||
      lower.includes("select");
    expect(hasDecide).toBe(true);
  });

  test("includes start_loop action", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    expect(
      lower.includes("start_loop") || lower.includes("start loop"),
    ).toBe(true);
  });

  test("includes process_notes action", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    expect(
      lower.includes("process_notes") || lower.includes("process notes"),
    ).toBe(true);
  });

  test("includes apply retro recommendation action", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasApply =
      lower.includes("apply_retro") ||
      lower.includes("apply retro") ||
      lower.includes("apply recommendation") ||
      lower.includes("retro recommendation");
    expect(hasApply).toBe(true);
  });

  test("includes emit_alert action", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    expect(
      lower.includes("emit_alert") ||
        lower.includes("emit alert") ||
        lower.includes("alert"),
    ).toBe(true);
  });

  test("includes do_nothing action", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    expect(
      lower.includes("do_nothing") ||
        lower.includes("do nothing") ||
        lower.includes("no-op") ||
        lower.includes("noop"),
    ).toBe(true);
  });

  test("action set is described as constrained or bounded", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasConstrained =
      lower.includes("constrained") ||
      lower.includes("bounded") ||
      lower.includes("fixed set") ||
      lower.includes("exactly one") ||
      lower.includes("allowed");
    expect(hasConstrained).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-5: Plan describes safety rails (rate limits, cost budget, human approval)
// --------------------------------------------------------------------------
describe("AC-5: Safety rails described", () => {
  test("describes rate limiting or max actions per hour", async () => {
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

  test("describes cost budget controls", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasBudget = lower.includes("budget");
    const hasCost = lower.includes("cost");
    const hasSpend = lower.includes("spend");
    expect(hasBudget || hasCost || hasSpend).toBe(true);
  });

  test("describes human-approval gate for destructive actions", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasApproval =
      lower.includes("human-approval") ||
      lower.includes("human approval") ||
      lower.includes("approval gate");
    const hasDestructive = lower.includes("destructive");
    expect(hasApproval || hasDestructive).toBe(true);
  });

  test("describes always-log reasoning requirement", async () => {
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

    const items = extractCheckboxItems(section!);
    expect(items.length).toBeGreaterThanOrEqual(5);
  });
});

// --------------------------------------------------------------------------
// AC-7: Verification items are specific and testable, not vague
// --------------------------------------------------------------------------
describe("AC-7: Verification items are specific and testable", () => {
  test("each checkbox item is substantive (at least 8 words)", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Verification");
    expect(section).not.toBeNull();

    const items = extractCheckboxItems(section!);
    expect(items.length).toBeGreaterThanOrEqual(5);

    for (const item of items) {
      const wordCount = item.split(/\s+/).filter((w) => w.length > 0).length;
      expect(wordCount).toBeGreaterThanOrEqual(8);
    }
  });

  test("no checkbox item uses vague phrases", async () => {
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
      /functions?\s+properly/i,
    ];

    for (const item of items) {
      for (const pattern of vaguePatterns) {
        expect(pattern.test(item)).toBe(false);
      }
    }
  });

  test("checkbox items reference concrete system concepts", async () => {
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
    const outcome = extractSection(content, "Decision Outcome");
    const plan = extractSection(content, "Implementation Plan");
    expect(outcome).not.toBeNull();
    expect(plan).not.toBeNull();

    const planLower = plan!.toLowerCase();
    // Decision Outcome chose hybrid event-driven + cron; plan should reflect both
    expect(planLower).toContain("cron");
    const hasEvent =
      planLower.includes("event") || planLower.includes("trigger");
    expect(hasEvent).toBe(true);
  });

  test("Verification items align with Implementation Plan steps", async () => {
    const content = await readAdr();
    const plan = extractSection(content, "Implementation Plan");
    const verification = extractSection(content, "Verification");
    expect(plan).not.toBeNull();
    expect(verification).not.toBeNull();

    const verLower = verification!.toLowerCase();
    // Key implementation concepts should appear in verification too
    expect(verLower).toContain("heartbeat");
    const hasAction =
      verLower.includes("action") || verLower.includes("dispatch");
    expect(hasAction).toBe(true);
    const hasState =
      verLower.includes("state") ||
      verLower.includes("snapshot") ||
      verLower.includes("input");
    expect(hasState).toBe(true);
  });

  test("safety concepts appear in both Implementation Plan and Verification", async () => {
    const content = await readAdr();
    const plan = extractSection(content, "Implementation Plan");
    const verification = extractSection(content, "Verification");
    expect(plan).not.toBeNull();
    expect(verification).not.toBeNull();

    const planLower = plan!.toLowerCase();
    const verLower = verification!.toLowerCase();

    // Rate limiting mentioned in both
    const planHasLimits =
      planLower.includes("limit") || planLower.includes("max");
    const verHasLimits =
      verLower.includes("limit") || verLower.includes("max");
    expect(planHasLimits && verHasLimits).toBe(true);

    // Budget mentioned in both
    const planHasBudget =
      planLower.includes("budget") || planLower.includes("cost");
    const verHasBudget =
      verLower.includes("budget") || verLower.includes("cost");
    expect(planHasBudget && verHasBudget).toBe(true);
  });

  test("ADR has all required major sections", async () => {
    const content = await readAdr();
    const requiredSections = [
      "Context and Problem Statement",
      "Decision Drivers",
      "Considered Options",
      "Decision Outcome",
      "Implementation Plan",
      "Verification",
    ];

    for (const heading of requiredSections) {
      const section = extractSection(content, heading);
      expect(section).not.toBeNull();
    }
  });
});

// --------------------------------------------------------------------------
// AC-9: TypeScript compiles with no errors (bun test on the test file)
// --------------------------------------------------------------------------
describe("AC-9: TypeScript compiles", () => {
  test("this test file compiles and runs under bun test", () => {
    // Reaching this point means the file compiled successfully
    expect(true).toBe(true);
  });
});
