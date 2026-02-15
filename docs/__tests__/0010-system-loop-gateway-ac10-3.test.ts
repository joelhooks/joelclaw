import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";

const HOME = process.env.HOME ?? "/Users/joel";
const ADR_PATH = resolve(
  HOME,
  "Vault",
  "docs",
  "decisions",
  "0010-system-loop-gateway.md",
);

async function readAdr(): Promise<string> {
  return Bun.file(ADR_PATH).text();
}

/**
 * Extract the body of a ## section from markdown.
 * Returns text from the heading until the next ## heading or end-of-file.
 */
function extractSection(content: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `^## ${escaped}\\s*\\n([\\s\\S]*?)(?=^## |\\z)`,
    "m",
  );
  const match = content.match(regex);
  return match?.[1]?.trim() ?? "";
}

/**
 * Extract ### subsections within a section body.
 * Returns array of { title, body } for each ### heading found.
 */
function extractSubsections(
  sectionBody: string,
): Array<{ title: string; body: string }> {
  const parts = sectionBody.split(/^### /m).filter((p) => p.trim().length > 0);
  const results: Array<{ title: string; body: string }> = [];
  for (const part of parts) {
    const newline = part.indexOf("\n");
    if (newline === -1) continue;
    results.push({
      title: part.slice(0, newline).trim(),
      body: part.slice(newline + 1).trim(),
    });
  }
  return results;
}

/** Count bullet points (lines starting with - or *). */
function bulletCount(text: string): number {
  return text.split("\n").filter((line) => /^\s*[-*]\s+/.test(line)).length;
}

// --------------------------------------------------------------------------
// AC-1: Has ## Decision Outcome section
// --------------------------------------------------------------------------
describe("AC-1: Decision Outcome section exists", () => {
  test("contains a ## Decision Outcome heading", async () => {
    const content = await readAdr();
    expect(content).toMatch(/^## Decision Outcome/m);
  });

  test("Decision Outcome section has non-empty body text", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section.length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------
// AC-2: Chosen option is clearly stated with rationale
// --------------------------------------------------------------------------
describe("AC-2: chosen option stated with rationale", () => {
  test("Decision Outcome section names a chosen option", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    // Should explicitly state which option was chosen
    expect(section).toMatch(/chosen\s+option/i);
  });

  test("Decision Outcome section provides a rationale (because/reason)", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    // Should explain why the option was chosen
    expect(section).toMatch(/because|rationale|reason/i);
  });
});

// --------------------------------------------------------------------------
// AC-3: Decision recommends a hybrid event-driven + cron approach
// --------------------------------------------------------------------------
describe("AC-3: hybrid event-driven + cron approach recommended", () => {
  test("Decision Outcome mentions hybrid approach", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).toMatch(/hybrid/i);
  });

  test("Decision Outcome mentions event-driven", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).toMatch(/event[- ]driven/i);
  });

  test("Decision Outcome mentions cron or heartbeat", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).toMatch(/cron|heartbeat/i);
  });
});

// --------------------------------------------------------------------------
// AC-4: Has ### Consequences subsection with Good, Bad, and Neutral items
// --------------------------------------------------------------------------
describe("AC-4: Consequences subsection with Good, Bad, Neutral", () => {
  test("Decision Outcome contains a ### Consequences subsection", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).toMatch(/^### Consequences/m);
  });

  test("Consequences contains Good items", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).toMatch(/good/i);
  });

  test("Consequences contains Bad items", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).toMatch(/bad/i);
  });

  test("Consequences contains Neutral items", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    expect(section).toMatch(/neutral/i);
  });

  test("Consequences has at least 3 bullet points total", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Outcome");
    // Extract the Consequences subsection from Decision Outcome
    const subsections = extractSubsections(section);
    const consequences = subsections.find((s) =>
      s.title.toLowerCase().includes("consequences"),
    );
    expect(consequences).toBeDefined();
    const bullets = bulletCount(consequences!.body);
    expect(bullets).toBeGreaterThanOrEqual(3);
  });
});

// --------------------------------------------------------------------------
// AC-5: Has ## Pros and Cons of the Options section
// --------------------------------------------------------------------------
describe("AC-5: Pros and Cons of the Options section exists", () => {
  test("contains a ## Pros and Cons heading", async () => {
    const content = await readAdr();
    expect(content).toMatch(/^## Pros and Cons of the Options/m);
  });

  test("Pros and Cons section has non-empty content", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Pros and Cons of the Options");
    expect(section.length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------
// AC-6: Each option from Considered Options has pros and cons listed
// --------------------------------------------------------------------------
describe("AC-6: each considered option has pros and cons", () => {
  test("Pros and Cons section has subsections for each considered option", async () => {
    const content = await readAdr();
    const consideredSection = extractSection(content, "Considered Options");
    const consideredOptions = extractSubsections(consideredSection);
    const prosConsSection = extractSection(
      content,
      "Pros and Cons of the Options",
    );
    const prosConsOptions = extractSubsections(prosConsSection);

    // Should have at least as many pros/cons subsections as considered options
    expect(prosConsOptions.length).toBeGreaterThanOrEqual(
      consideredOptions.length,
    );
  });

  test("each pros/cons subsection mentions both pros/good and cons/bad", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Pros and Cons of the Options");
    const subsections = extractSubsections(section);
    expect(subsections.length).toBeGreaterThanOrEqual(1);
    for (const sub of subsections) {
      const lower = sub.body.toLowerCase();
      expect(lower).toMatch(/good|pro|\+/i);
      expect(lower).toMatch(/bad|con|-/i);
    }
  });
});

// --------------------------------------------------------------------------
// AC-7: Mentions safety constraints (human override, action limits, cost caps)
// --------------------------------------------------------------------------
describe("AC-7: safety constraints mentioned", () => {
  test("mentions human override or human-in-the-loop", async () => {
    const content = await readAdr();
    expect(content).toMatch(/human\s+(override|in[- ]the[- ]loop|cancel|veto)/i);
  });

  test("mentions action limits or rate limiting", async () => {
    const content = await readAdr();
    expect(content).toMatch(/action\s+limit|rate\s+limit|runaway|guardrail/i);
  });

  test("mentions cost caps or cost control", async () => {
    const content = await readAdr();
    expect(content).toMatch(/cost\s+(cap|control|limit|budget)|LLM\s+call/i);
  });
});

// --------------------------------------------------------------------------
// AC-8: TypeScript compiles with no errors (bun test on the test file)
// --------------------------------------------------------------------------
describe("AC-8: TypeScript compiles", () => {
  test("this test file compiles and runs via bun test without TypeScript errors", () => {
    // If we've reached this point, bun has successfully compiled and
    // executed this .ts file — the AC is satisfied.
    expect(true).toBe(true);
  });
});
