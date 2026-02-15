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

// Helper: extract ### subsections within a section
function extractSubsections(
  sectionText: string,
): { title: string; body: string }[] {
  const results: { title: string; body: string }[] = [];
  const pattern = /^### (.+)\s*\n([\s\S]*?)(?=\n### |$)/gm;
  let match;
  while ((match = pattern.exec(sectionText)) !== null) {
    results.push({ title: match[1].trim(), body: match[2].trim() });
  }
  return results;
}

// Helper: count bullet points in text
function countBullets(text: string): number {
  return text.split("\n").filter((line) => /^\s*[-*]\s+/.test(line)).length;
}

// --------------------------------------------------------------------------
// AC-1: Has ## Decision Outcome section
// --------------------------------------------------------------------------
describe("AC-1: Decision Outcome section exists", () => {
  test("ADR contains a ## Decision Outcome heading", async () => {
    const content = await readAdr();
    expect(content).toMatch(/^## Decision Outcome/m);
  });

  test("Decision Outcome section has substantive content (>= 20 words)", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();
    const wordCount = section!.split(/\s+/).filter((w) => w.length > 0).length;
    expect(wordCount).toBeGreaterThanOrEqual(20);
  });
});

// --------------------------------------------------------------------------
// AC-2: Chosen option is clearly stated with rationale
// --------------------------------------------------------------------------
describe("AC-2: Chosen option is clearly stated with rationale", () => {
  test("Decision Outcome identifies the chosen option", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const statesChoice =
      lower.includes("chosen option") ||
      lower.includes("selected") ||
      lower.includes("recommended") ||
      lower.includes("we choose") ||
      lower.includes("we recommend");
    expect(statesChoice).toBe(true);
  });

  test("Decision Outcome provides rationale (because/reason/rationale)", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasRationale =
      lower.includes("because") ||
      lower.includes("reason") ||
      lower.includes("rationale") ||
      lower.includes("this approach");
    expect(hasRationale).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-3: Decision recommends a hybrid event-driven + cron approach
// --------------------------------------------------------------------------
describe("AC-3: Hybrid event-driven + cron approach", () => {
  test("Decision Outcome references event-driven or reactive mechanism", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasEventDriven =
      lower.includes("event-driven") || lower.includes("event driven");
    const hasReactive = lower.includes("reactive");
    const hasEventTriggered =
      lower.includes("event") && lower.includes("trigger");
    expect(hasEventDriven || hasReactive || hasEventTriggered).toBe(true);
  });

  test("Decision Outcome references cron, heartbeat, or scheduled sweep", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasCron = lower.includes("cron");
    const hasHeartbeat = lower.includes("heartbeat");
    const hasSweep = lower.includes("sweep");
    const hasScheduled = lower.includes("scheduled");
    expect(hasCron || hasHeartbeat || hasSweep || hasScheduled).toBe(true);
  });

  test("Decision Outcome describes a hybrid or combined strategy", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasHybrid = lower.includes("hybrid");
    const hasCombined = lower.includes("combined");
    const hasBoth = lower.includes("both");
    const hasFallback = lower.includes("fallback");
    const hasPlus = lower.includes("plus");
    expect(hasHybrid || hasCombined || hasBoth || hasFallback || hasPlus).toBe(
      true,
    );
  });

  test("references a time interval for the cron/heartbeat (e.g. 15-30 minutes)", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasMinutes = lower.includes("minute");
    const hasInterval = lower.includes("interval");
    const hasPeriod = lower.includes("period");
    expect(hasMinutes || hasInterval || hasPeriod).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-4: Has ### Consequences subsection with Good, Bad, and Neutral items
// --------------------------------------------------------------------------
describe("AC-4: Consequences subsection with Good, Bad, Neutral", () => {
  test("Decision Outcome contains a ### Consequences subsection", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();
    expect(section!).toMatch(/^### Consequences/m);
  });

  test("Consequences include Good outcomes", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const subsections = extractSubsections(section!);
    const consequences = subsections.find((s) =>
      s.title.includes("Consequences"),
    );
    expect(consequences).toBeDefined();
    expect(consequences!.body.toLowerCase()).toMatch(/good/);
  });

  test("Consequences include Bad outcomes", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const subsections = extractSubsections(section!);
    const consequences = subsections.find((s) =>
      s.title.includes("Consequences"),
    );
    expect(consequences).toBeDefined();
    expect(consequences!.body.toLowerCase()).toMatch(/bad/);
  });

  test("Consequences include Neutral outcomes", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const subsections = extractSubsections(section!);
    const consequences = subsections.find((s) =>
      s.title.includes("Consequences"),
    );
    expect(consequences).toBeDefined();
    expect(consequences!.body.toLowerCase()).toMatch(/neutral/);
  });

  test("Good consequences cover autonomous action", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasAutonomous = lower.includes("autonomous");
    const hasAutomatic = lower.includes("automatic");
    const hasSelfDriven = lower.includes("self-driven");
    expect(hasAutonomous || hasAutomatic || hasSelfDriven).toBe(true);
  });

  test("Good consequences cover faster feedback loops", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    expect(lower).toMatch(/feedback/);
  });

  test("Good consequences cover note queue processing", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    expect(lower).toMatch(/note\s+queue/);
  });

  test("Bad consequences cover cost of LLM calls", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasCost = lower.includes("cost");
    const hasLlm = lower.includes("llm");
    const hasToken = lower.includes("token");
    const hasExpense = lower.includes("expens");
    expect(hasCost && (hasLlm || hasToken || hasExpense)).toBe(true);
  });

  test("Bad consequences cover risk of runaway actions", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasRunaway = lower.includes("runaway");
    const hasCascade = lower.includes("cascade");
    const hasInfinite = lower.includes("infinite");
    const hasSpiral = lower.includes("spiral");
    expect(hasRunaway || hasCascade || hasInfinite || hasSpiral).toBe(true);
  });

  test("Bad consequences mention complexity", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasComplexity = lower.includes("complex");
    const hasOperational = lower.includes("operational");
    expect(hasComplexity || hasOperational).toBe(true);
  });

  test("Neutral consequences cover human override or cancel", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasOverride = lower.includes("override");
    const hasCancel = lower.includes("cancel");
    const hasPause = lower.includes("pause");
    const hasInterrupt = lower.includes("interrupt");
    expect(hasOverride || hasCancel || hasPause || hasInterrupt).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-5: Has ## Pros and Cons of the Options section
// --------------------------------------------------------------------------
describe("AC-5: Pros and Cons of the Options section exists", () => {
  test("ADR contains a ## Pros and Cons heading", async () => {
    const content = await readAdr();
    expect(content).toMatch(/^## Pros and Cons/m);
  });

  test("Pros and Cons section has substantive content (>= 50 words)", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Pros and Cons of the Options");
    expect(section).not.toBeNull();
    const wordCount = section!.split(/\s+/).filter((w) => w.length > 0).length;
    expect(wordCount).toBeGreaterThanOrEqual(50);
  });
});

// --------------------------------------------------------------------------
// AC-6: Each option from the Considered Options has pros and cons listed
// --------------------------------------------------------------------------
describe("AC-6: Each considered option has pros and cons", () => {
  test("Pros and Cons section has at least as many subsections as Considered Options", async () => {
    const content = await readAdr();

    const consideredSection = extractSection(content, "Considered Options");
    expect(consideredSection).not.toBeNull();

    const prosConsSection = extractSection(
      content,
      "Pros and Cons of the Options",
    );
    expect(prosConsSection).not.toBeNull();

    const consideredOptions = extractSubsections(consideredSection!);
    const prosConsOptions = extractSubsections(prosConsSection!);

    expect(prosConsOptions.length).toBeGreaterThanOrEqual(
      consideredOptions.length,
    );
  });

  test("each option in Pros and Cons lists pros (advantages)", async () => {
    const content = await readAdr();
    const prosConsSection = extractSection(
      content,
      "Pros and Cons of the Options",
    );
    expect(prosConsSection).not.toBeNull();

    const subsections = extractSubsections(prosConsSection!);
    expect(subsections.length).toBeGreaterThanOrEqual(1);

    for (const sub of subsections) {
      const lower = sub.body.toLowerCase();
      const hasPros = lower.includes("pros") || lower.includes("pro:");
      const hasGood = lower.includes("good:");
      const hasAdvantage = lower.includes("advantage");
      const hasStrength = lower.includes("strength");
      expect(hasPros || hasGood || hasAdvantage || hasStrength).toBe(true);
    }
  });

  test("each option in Pros and Cons lists cons (disadvantages)", async () => {
    const content = await readAdr();
    const prosConsSection = extractSection(
      content,
      "Pros and Cons of the Options",
    );
    expect(prosConsSection).not.toBeNull();

    const subsections = extractSubsections(prosConsSection!);
    expect(subsections.length).toBeGreaterThanOrEqual(1);

    for (const sub of subsections) {
      const lower = sub.body.toLowerCase();
      const hasCons = lower.includes("cons") || lower.includes("con:");
      const hasBad = lower.includes("bad:");
      const hasDisadvantage = lower.includes("disadvantage");
      const hasWeakness = lower.includes("weakness");
      expect(hasCons || hasBad || hasDisadvantage || hasWeakness).toBe(true);
    }
  });

  test("each option lists at least one pro bullet and one con bullet", async () => {
    const content = await readAdr();
    const prosConsSection = extractSection(
      content,
      "Pros and Cons of the Options",
    );
    expect(prosConsSection).not.toBeNull();

    const subsections = extractSubsections(prosConsSection!);
    for (const sub of subsections) {
      const bullets = countBullets(sub.body);
      expect(bullets).toBeGreaterThanOrEqual(2);
    }
  });
});

// --------------------------------------------------------------------------
// AC-7: Mentions safety constraints (human override, action limits, cost caps)
// --------------------------------------------------------------------------
describe("AC-7: Safety constraints mentioned", () => {
  test("mentions human override capability", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasOverride = lower.includes("override");
    const hasCancel = lower.includes("cancel");
    const hasKillSwitch =
      lower.includes("kill switch") || lower.includes("kill-switch");
    const hasInterrupt = lower.includes("interrupt");
    const hasHumanControl =
      lower.includes("human") && lower.includes("control");
    expect(
      hasOverride ||
        hasCancel ||
        hasKillSwitch ||
        hasInterrupt ||
        hasHumanControl,
    ).toBe(true);
  });

  test("mentions action limits or rate limiting", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasActionLimit = lower.includes("action limit");
    const hasRateLimit = lower.includes("rate limit");
    const hasBound = lower.includes("bound");
    const hasGuard = lower.includes("guard");
    const hasLimit = lower.includes("limit");
    const hasThrottle = lower.includes("throttl");
    expect(
      hasActionLimit ||
        hasRateLimit ||
        hasBound ||
        hasGuard ||
        hasLimit ||
        hasThrottle,
    ).toBe(true);
  });

  test("mentions cost caps or budget controls", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasCostCap = lower.includes("cost cap");
    const hasBudget = lower.includes("budget");
    const hasTokenCap =
      lower.includes("token ceiling") || lower.includes("token cap");
    const hasCostAndCap = lower.includes("cost") && lower.includes("cap");
    const hasSpendLimit = lower.includes("spend") && lower.includes("limit");
    expect(
      hasCostCap || hasBudget || hasTokenCap || hasCostAndCap || hasSpendLimit,
    ).toBe(true);
  });

  test("safety constraints appear across the broader ADR (not just Decision Outcome)", async () => {
    const content = await readAdr();
    const lower = content.toLowerCase();

    const safetyKeywords = [
      "safety",
      "safe",
      "guardrail",
      "constraint",
      "limit",
    ];
    const safetyMentions = safetyKeywords.filter((kw) => lower.includes(kw));
    expect(safetyMentions.length).toBeGreaterThanOrEqual(2);
  });
});

// --------------------------------------------------------------------------
// AC-8: TypeScript compiles with no errors (bun test on the test file)
// --------------------------------------------------------------------------
describe("AC-8: TypeScript compiles", () => {
  test("this test file compiles and runs under bun test", () => {
    // If we reach this point, the file compiled successfully
    expect(true).toBe(true);
  });
});
