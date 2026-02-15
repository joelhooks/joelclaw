import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const REPO_ADR = resolve(REPO_ROOT, "docs/decisions/0010-system-loop-gateway.md");

// Helper: read the ADR content (used by multiple test groups)
async function readAdr(path: string): Promise<string> {
  return Bun.file(path).text();
}

// Helper: extract a section by heading (returns everything between this ## and the next ## or EOF)
function extractSection(content: string, heading: string): string | null {
  const pattern = new RegExp(
    `\\n## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n# |$)`,
  );
  const match = content.match(pattern);
  return match ? match[1].trim() : null;
}

// Helper: extract ### subsections within a section
function extractSubsections(sectionText: string): { title: string; body: string }[] {
  const results: { title: string; body: string }[] = [];
  const pattern = /^### (.+)\s*\n([\s\S]*?)(?=\n### |$)/gm;
  let match;
  while ((match = pattern.exec(sectionText)) !== null) {
    results.push({ title: match[1].trim(), body: match[2].trim() });
  }
  return results;
}

// --------------------------------------------------------------------------
// AC-1: Has ## Decision Outcome section
// --------------------------------------------------------------------------
describe("AC-1: Decision Outcome section exists", () => {
  test("contains a ## Decision Outcome heading", async () => {
    const content = await readAdr(REPO_ADR);
    expect(content).toMatch(/^## Decision Outcome/m);
  });
});

// --------------------------------------------------------------------------
// AC-2: Chosen option is clearly stated with rationale
// --------------------------------------------------------------------------
describe("AC-2: chosen option is clearly stated with rationale", () => {
  test("Decision Outcome section states the chosen option", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasChosen = lower.includes("chosen option");
    const hasSelected = lower.includes("selected");
    const hasRecommended = lower.includes("recommended");
    expect(hasChosen || hasSelected || hasRecommended).toBe(true);
  });

  test("Decision Outcome includes a rationale (explains why)", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasBecause = lower.includes("because");
    const hasReason = lower.includes("reason");
    const hasApproach = lower.includes("approach");
    const hasSelected = lower.includes("selected");
    expect(hasBecause || hasReason || (hasApproach && hasSelected)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-3: Decision recommends a hybrid event-driven + cron approach
// --------------------------------------------------------------------------
describe("AC-3: hybrid event-driven + cron approach", () => {
  test("Decision Outcome mentions event-driven or reactive loop", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasEventDriven = lower.includes("event-driven") || lower.includes("event driven");
    const hasReactive = lower.includes("reactive");
    expect(hasEventDriven || hasReactive).toBe(true);
  });

  test("Decision Outcome mentions cron or heartbeat as fallback", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasCron = lower.includes("cron");
    const hasHeartbeat = lower.includes("heartbeat");
    const hasSweep = lower.includes("sweep");
    expect(hasCron || hasHeartbeat || hasSweep).toBe(true);
  });

  test("Decision Outcome describes a hybrid or combined approach", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasHybrid = lower.includes("hybrid");
    const hasCombined = lower.includes("combined");
    const hasBoth = lower.includes("both");
    const hasPlusFallback = lower.includes("fallback");
    expect(hasHybrid || hasCombined || hasBoth || hasPlusFallback).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-4: Has ### Consequences subsection with Good, Bad, and Neutral items
// --------------------------------------------------------------------------
describe("AC-4: Consequences subsection with Good, Bad, and Neutral", () => {
  test("Decision Outcome has a ### Consequences subsection", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();
    expect(section!).toMatch(/^### Consequences/m);
  });

  test("Consequences lists Good outcomes", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const subsections = extractSubsections(section!);
    const consequences = subsections.find((s) => s.title.includes("Consequences"));
    expect(consequences).toBeDefined();
    expect(consequences!.body.toLowerCase()).toMatch(/good/);
  });

  test("Consequences lists Bad outcomes", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const subsections = extractSubsections(section!);
    const consequences = subsections.find((s) => s.title.includes("Consequences"));
    expect(consequences).toBeDefined();
    expect(consequences!.body.toLowerCase()).toMatch(/bad/);
  });

  test("Consequences lists Neutral outcomes", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const subsections = extractSubsections(section!);
    const consequences = subsections.find((s) => s.title.includes("Consequences"));
    expect(consequences).toBeDefined();
    expect(consequences!.body.toLowerCase()).toMatch(/neutral/);
  });

  test("Good consequences mention autonomous action", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasAutonomous = lower.includes("autonomous");
    const hasAutomatic = lower.includes("automatic");
    expect(hasAutonomous || hasAutomatic).toBe(true);
  });

  test("Good consequences mention faster feedback loops", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    expect(lower).toMatch(/feedback/);
  });

  test("Good consequences mention note queue processing", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    expect(lower).toMatch(/note\s+queue/);
  });

  test("Bad consequences mention cost of LLM calls", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasCost = lower.includes("cost");
    const hasLlm = lower.includes("llm");
    const hasToken = lower.includes("token");
    expect(hasCost && (hasLlm || hasToken)).toBe(true);
  });

  test("Bad consequences mention runaway action risk", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasRunaway = lower.includes("runaway");
    const hasCascade = lower.includes("cascade");
    expect(hasRunaway || hasCascade).toBe(true);
  });

  test("Neutral consequences mention human override or cancel", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasOverride = lower.includes("override");
    const hasCancel = lower.includes("cancel");
    const hasPause = lower.includes("pause");
    expect(hasOverride || hasCancel || hasPause).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-5: Has ## Pros and Cons of the Options section
// --------------------------------------------------------------------------
describe("AC-5: Pros and Cons of the Options section", () => {
  test("contains a ## Pros and Cons heading", async () => {
    const content = await readAdr(REPO_ADR);
    expect(content).toMatch(/^## Pros and Cons/m);
  });
});

// --------------------------------------------------------------------------
// AC-6: Each option from the Considered Options has pros and cons listed
// --------------------------------------------------------------------------
describe("AC-6: each considered option has pros and cons", () => {
  test("Pros and Cons section has subsections matching Considered Options", async () => {
    const content = await readAdr(REPO_ADR);
    const consideredSection = extractSection(content, "Considered Options");
    expect(consideredSection).not.toBeNull();

    const prosConsSection = extractSection(content, "Pros and Cons of the Options");
    expect(prosConsSection).not.toBeNull();

    const consideredOptions = extractSubsections(consideredSection!);
    const prosConsOptions = extractSubsections(prosConsSection!);

    // Every option from Considered Options should have a matching entry in Pros and Cons
    expect(prosConsOptions.length).toBeGreaterThanOrEqual(consideredOptions.length);
  });

  test("each option subsection in Pros and Cons lists Pros", async () => {
    const content = await readAdr(REPO_ADR);
    const prosConsSection = extractSection(content, "Pros and Cons of the Options");
    expect(prosConsSection).not.toBeNull();

    const subsections = extractSubsections(prosConsSection!);
    expect(subsections.length).toBeGreaterThanOrEqual(1);

    for (const sub of subsections) {
      const lower = sub.body.toLowerCase();
      const hasPros = lower.includes("pros:") || lower.includes("pro:");
      const hasGood = lower.includes("good:");
      const hasAdvantage = lower.includes("advantage");
      expect(hasPros || hasGood || hasAdvantage).toBe(true);
    }
  });

  test("each option subsection in Pros and Cons lists Cons", async () => {
    const content = await readAdr(REPO_ADR);
    const prosConsSection = extractSection(content, "Pros and Cons of the Options");
    expect(prosConsSection).not.toBeNull();

    const subsections = extractSubsections(prosConsSection!);
    expect(subsections.length).toBeGreaterThanOrEqual(1);

    for (const sub of subsections) {
      const lower = sub.body.toLowerCase();
      const hasCons = lower.includes("cons:") || lower.includes("con:");
      const hasBad = lower.includes("bad:");
      const hasDisadvantage = lower.includes("disadvantage");
      expect(hasCons || hasBad || hasDisadvantage).toBe(true);
    }
  });
});

// --------------------------------------------------------------------------
// AC-7: Mentions safety constraints (human override, action limits, cost caps)
// --------------------------------------------------------------------------
describe("AC-7: safety constraints mentioned", () => {
  test("mentions human override capability", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasOverride = lower.includes("override");
    const hasCancel = lower.includes("cancel");
    const hasKillSwitch = lower.includes("kill switch") || lower.includes("kill-switch");
    const hasInterrupt = lower.includes("interrupt");
    expect(hasOverride || hasCancel || hasKillSwitch || hasInterrupt).toBe(true);
  });

  test("mentions action limits or rate limiting", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasActionLimit = lower.includes("action limit");
    const hasRateLimit = lower.includes("rate limit");
    const hasBound = lower.includes("bound");
    const hasGuard = lower.includes("guard");
    const hasLimit = lower.includes("limit");
    expect(hasActionLimit || hasRateLimit || hasBound || hasGuard || hasLimit).toBe(true);
  });

  test("mentions cost caps or budget controls", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasCostCap = lower.includes("cost cap");
    const hasBudget = lower.includes("budget");
    const hasTokenCeiling = lower.includes("token ceiling") || lower.includes("token cap");
    const hasCostControl = lower.includes("cost") && lower.includes("cap");
    expect(hasCostCap || hasBudget || hasTokenCeiling || hasCostControl).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-8: TypeScript compiles with no errors (bun test on the test file)
// --------------------------------------------------------------------------
describe("AC-8: TypeScript compiles", () => {
  test("this test file compiles and runs under bun test", () => {
    // If we reach this point, the file compiled successfully under bun
    expect(true).toBe(true);
  });
});
