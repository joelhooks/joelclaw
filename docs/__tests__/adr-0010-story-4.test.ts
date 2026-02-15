import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const REPO_ADR_PATH = resolve(REPO_ROOT, "docs/decisions/0010-system-loop-gateway.md");

/**
 * Helper: extract a markdown section by ## heading name.
 * Returns the text from the heading to the next ## heading (or EOF).
 */
async function getSection(heading: string): Promise<string> {
  const content = await Bun.file(REPO_ADR_PATH).text();
  const pattern = new RegExp(`^## ${heading}`, "m");
  const match = content.match(pattern);
  if (!match || match.index === undefined) return "";
  const afterHeading = content.slice(match.index);
  const nextSection = afterHeading.indexOf("\n## ", 1);
  return nextSection > 0 ? afterHeading.slice(0, nextSection) : afterHeading;
}

/**
 * Helper: extract numbered list items from a section.
 * Matches lines starting with `N.` (digit(s) followed by a period).
 */
function getNumberedItems(sectionText: string): string[] {
  const lines = sectionText.split("\n");
  return lines.filter((line) => /^\d+\.\s/.test(line.trim()));
}

/**
 * Helper: extract checkbox items from a section.
 * Matches lines starting with `- [ ]` or `- [x]`.
 */
function getCheckboxItems(sectionText: string): string[] {
  const lines = sectionText.split("\n");
  return lines.filter((line) => /^-\s*\[[ x]\]\s/.test(line.trim()));
}

// --------------------------------------------------------------------------
// AC-1: Has ## Implementation Plan section with numbered steps
// --------------------------------------------------------------------------
describe("AC-1: Implementation Plan section with numbered steps", () => {
  test("contains ## Implementation Plan heading", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    expect(content).toMatch(/^## Implementation Plan/m);
  });

  test("Implementation Plan section has non-empty content", async () => {
    const section = await getSection("Implementation Plan");
    const body = section.replace(/^## Implementation Plan\s*\n/, "").trim();
    expect(body.length).toBeGreaterThan(0);
  });

  test("Implementation Plan contains numbered steps", async () => {
    const section = await getSection("Implementation Plan");
    const items = getNumberedItems(section);
    expect(items.length).toBeGreaterThanOrEqual(3);
  });
});

// --------------------------------------------------------------------------
// AC-2: Plan describes the heartbeat Inngest function
// --------------------------------------------------------------------------
describe("AC-2: heartbeat Inngest function described", () => {
  test("Implementation Plan mentions heartbeat", async () => {
    const section = await getSection("Implementation Plan");
    const lower = section.toLowerCase();
    expect(lower).toContain("heartbeat");
  });

  test("Implementation Plan mentions Inngest function", async () => {
    const section = await getSection("Implementation Plan");
    const lower = section.toLowerCase();
    const hasInngest =
      lower.includes("inngest") || lower.includes("function");
    expect(hasInngest).toBe(true);
  });

  test("Implementation Plan mentions cron trigger", async () => {
    const section = await getSection("Implementation Plan");
    const lower = section.toLowerCase();
    const hasCron =
      lower.includes("cron") || lower.includes("schedule");
    expect(hasCron).toBe(true);
  });

  test("Implementation Plan mentions terminal event triggers", async () => {
    const section = await getSection("Implementation Plan");
    const lower = section.toLowerCase();
    const hasEventTrigger =
      lower.includes("terminal event") ||
      lower.includes("loop.complete") ||
      lower.includes("event trigger") ||
      lower.includes("event-driven");
    expect(hasEventTrigger).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-3: Plan describes state gathering (note queue, slog, retros, active runs)
// --------------------------------------------------------------------------
describe("AC-3: state gathering described", () => {
  test("Implementation Plan mentions state gathering or state collection", async () => {
    const section = await getSection("Implementation Plan");
    const lower = section.toLowerCase();
    const hasStateGathering =
      lower.includes("state-gathering") ||
      lower.includes("state gathering") ||
      lower.includes("gather") ||
      lower.includes("collect");
    expect(hasStateGathering).toBe(true);
  });

  test("Implementation Plan mentions note queue", async () => {
    const section = await getSection("Implementation Plan");
    const lower = section.toLowerCase();
    expect(lower).toMatch(/note\s*queue/);
  });

  test("Implementation Plan mentions slog entries", async () => {
    const section = await getSection("Implementation Plan");
    const lower = section.toLowerCase();
    expect(lower).toContain("slog");
  });

  test("Implementation Plan mentions retro recommendations", async () => {
    const section = await getSection("Implementation Plan");
    const lower = section.toLowerCase();
    const hasRetro =
      lower.includes("retro") || lower.includes("retrospective");
    expect(hasRetro).toBe(true);
  });

  test("Implementation Plan mentions active loop runs", async () => {
    const section = await getSection("Implementation Plan");
    const lower = section.toLowerCase();
    const hasActiveRuns =
      lower.includes("active loop") ||
      lower.includes("active run") ||
      lower.includes("loop runs");
    expect(hasActiveRuns).toBe(true);
  });

  test("Implementation Plan mentions half-done inventory", async () => {
    const section = await getSection("Implementation Plan");
    const lower = section.toLowerCase();
    const hasHalfDone =
      lower.includes("half-done") ||
      lower.includes("half done") ||
      lower.includes("interrupted") ||
      lower.includes("partial");
    expect(hasHalfDone).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-4: Plan describes LLM decision step with constrained action set
// --------------------------------------------------------------------------
describe("AC-4: LLM decision step with constrained action set", () => {
  test("Implementation Plan mentions LLM decision step", async () => {
    const section = await getSection("Implementation Plan");
    const lower = section.toLowerCase();
    const hasLLMDecision =
      lower.includes("llm decision") ||
      lower.includes("llm") ||
      lower.includes("decision step");
    expect(hasLLMDecision).toBe(true);
  });

  test("Implementation Plan defines constrained action set", async () => {
    const section = await getSection("Implementation Plan");
    const lower = section.toLowerCase();
    const hasConstraint =
      lower.includes("constrained") ||
      lower.includes("action set") ||
      lower.includes("allowed action");
    expect(hasConstraint).toBe(true);
  });

  test("action set includes start_loop", async () => {
    const section = await getSection("Implementation Plan");
    const lower = section.toLowerCase();
    expect(lower).toContain("start_loop");
  });

  test("action set includes process_notes", async () => {
    const section = await getSection("Implementation Plan");
    const lower = section.toLowerCase();
    expect(lower).toContain("process_notes");
  });

  test("action set includes apply_retro_recommendation", async () => {
    const section = await getSection("Implementation Plan");
    const lower = section.toLowerCase();
    expect(lower).toContain("apply_retro_recommendation");
  });

  test("action set includes emit_alert", async () => {
    const section = await getSection("Implementation Plan");
    const lower = section.toLowerCase();
    expect(lower).toContain("emit_alert");
  });

  test("action set includes do_nothing", async () => {
    const section = await getSection("Implementation Plan");
    const lower = section.toLowerCase();
    expect(lower).toContain("do_nothing");
  });
});

// --------------------------------------------------------------------------
// AC-5: Plan describes safety rails (rate limits, cost budget, human approval)
// --------------------------------------------------------------------------
describe("AC-5: safety rails described", () => {
  test("Implementation Plan mentions rate limits or max actions per hour", async () => {
    const section = await getSection("Implementation Plan");
    const lower = section.toLowerCase();
    const hasRateLimit =
      lower.includes("rate limit") ||
      lower.includes("max actions") ||
      lower.includes("per hour") ||
      lower.includes("throttle");
    expect(hasRateLimit).toBe(true);
  });

  test("Implementation Plan mentions cost budget", async () => {
    const section = await getSection("Implementation Plan");
    const lower = section.toLowerCase();
    const hasCostBudget =
      lower.includes("cost budget") ||
      lower.includes("cost cap") ||
      lower.includes("token") ||
      lower.includes("budget");
    expect(hasCostBudget).toBe(true);
  });

  test("Implementation Plan mentions human-approval gate", async () => {
    const section = await getSection("Implementation Plan");
    const lower = section.toLowerCase();
    const hasHumanApproval =
      lower.includes("human-approval") ||
      lower.includes("human approval") ||
      lower.includes("approval gate") ||
      lower.includes("destructive");
    expect(hasHumanApproval).toBe(true);
  });

  test("Implementation Plan mentions always-log reasoning", async () => {
    const section = await getSection("Implementation Plan");
    const lower = section.toLowerCase();
    const hasLogging =
      lower.includes("always-log") ||
      lower.includes("always log") ||
      lower.includes("log reasoning") ||
      lower.includes("auditab");
    expect(hasLogging).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-6: Has ## Verification section with at least 5 checkbox items
// --------------------------------------------------------------------------
describe("AC-6: Verification section with checkbox items", () => {
  test("contains ## Verification heading", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    expect(content).toMatch(/^## Verification/m);
  });

  test("Verification section has non-empty content", async () => {
    const section = await getSection("Verification");
    const body = section.replace(/^## Verification\s*\n/, "").trim();
    expect(body.length).toBeGreaterThan(0);
  });

  test("Verification section uses - [ ] checkbox syntax", async () => {
    const section = await getSection("Verification");
    expect(section).toMatch(/^- \[ \]/m);
  });

  test("Verification section contains at least 5 checkbox items", async () => {
    const section = await getSection("Verification");
    const checkboxes = getCheckboxItems(section);
    expect(checkboxes.length).toBeGreaterThanOrEqual(5);
  });
});

// --------------------------------------------------------------------------
// AC-7: Verification items are specific and testable, not vague
// --------------------------------------------------------------------------
describe("AC-7: Verification items are specific and testable", () => {
  test("each checkbox item has at least 10 words (specific enough)", async () => {
    const section = await getSection("Verification");
    const checkboxes = getCheckboxItems(section);
    expect(checkboxes.length).toBeGreaterThanOrEqual(5);

    for (const item of checkboxes) {
      const words = item.split(/\s+/).filter((w) => w.length > 0);
      expect(words.length).toBeGreaterThanOrEqual(10);
    }
  });

  test("no checkbox item is too vague (must not be just 'works' or 'is good')", async () => {
    const section = await getSection("Verification");
    const checkboxes = getCheckboxItems(section);

    const vaguePatterns = [
      /^- \[ \]\s*(it )?works\.?$/i,
      /^- \[ \]\s*(it )?is good\.?$/i,
      /^- \[ \]\s*everything (is )?(fine|ok|good)\.?$/i,
      /^- \[ \]\s*done\.?$/i,
    ];

    for (const item of checkboxes) {
      for (const vague of vaguePatterns) {
        expect(item.trim()).not.toMatch(vague);
      }
    }
  });

  test("checkbox items reference concrete system concepts (events, functions, logs, etc.)", async () => {
    const section = await getSection("Verification");
    const checkboxes = getCheckboxItems(section);
    const allText = checkboxes.join(" ").toLowerCase();

    // Verification items should reference concrete system elements
    const concreteTerms = [
      "event",
      "function",
      "log",
      "action",
      "trigger",
      "heartbeat",
      "cron",
      "rate",
      "budget",
      "approval",
      "state",
      "decision",
      "dispatch",
      "inngest",
      "alert",
      "run",
    ];

    const matchedTerms = concreteTerms.filter((term) =>
      allText.includes(term),
    );
    // Should reference at least 5 different concrete concepts
    expect(matchedTerms.length).toBeGreaterThanOrEqual(5);
  });
});

// --------------------------------------------------------------------------
// AC-8: Overall ADR is coherent and self-consistent across all sections
// --------------------------------------------------------------------------
describe("AC-8: ADR coherence and self-consistency", () => {
  test("Implementation Plan references the hybrid approach chosen in Decision Outcome", async () => {
    const implSection = await getSection("Implementation Plan");
    const lower = implSection.toLowerCase();
    // Should reference both trigger types from the decision outcome
    const hasCron = lower.includes("cron") || lower.includes("schedule");
    const hasEvent =
      lower.includes("event") || lower.includes("trigger");
    expect(hasCron).toBe(true);
    expect(hasEvent).toBe(true);
  });

  test("Implementation Plan references capabilities mentioned in Context", async () => {
    const implSection = await getSection("Implementation Plan");
    const lower = implSection.toLowerCase();
    // Context mentions coding loops, event bus, note queue, retrospective
    const mentionedCapabilities = [
      lower.includes("note"),
      lower.includes("retro") || lower.includes("retrospective"),
      lower.includes("loop"),
    ];
    const matchCount = mentionedCapabilities.filter(Boolean).length;
    expect(matchCount).toBeGreaterThanOrEqual(2);
  });

  test("Verification items map back to Implementation Plan steps", async () => {
    const implSection = await getSection("Implementation Plan");
    const verifSection = await getSection("Verification");
    const implLower = implSection.toLowerCase();
    const verifLower = verifSection.toLowerCase();

    // Key concepts from the plan should appear in verification
    const planConcepts = [
      "heartbeat",
      "state",
      "decision",
      "action",
      "safety",
      "rate",
      "budget",
      "approval",
      "log",
    ];

    const sharedConcepts = planConcepts.filter(
      (concept) => implLower.includes(concept) && verifLower.includes(concept),
    );
    // At least 5 concepts should be shared between plan and verification
    expect(sharedConcepts.length).toBeGreaterThanOrEqual(5);
  });

  test("ADR has all required major sections", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    const requiredSections = [
      "Context and Problem Statement",
      "Decision Drivers",
      "Considered Options",
      "Decision Outcome",
      "Pros and Cons of the Options",
      "Implementation Plan",
      "Verification",
    ];

    for (const section of requiredSections) {
      expect(content).toMatch(new RegExp(`^## ${section}`, "m"));
    }
  });
});

// --------------------------------------------------------------------------
// AC-9: TypeScript compiles with no errors
// --------------------------------------------------------------------------
describe("AC-9: TypeScript compiles", () => {
  test(
    "bunx tsc --noEmit succeeds on this test file",
    async () => {
      const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: REPO_ROOT,
      });

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        console.error("tsc stdout:", stdout);
        console.error("tsc stderr:", stderr);
      }

      expect(exitCode).toBe(0);
    },
    30_000,
  );
});
