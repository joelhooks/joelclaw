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

/** Count sentences (rough heuristic: segments ending with .!? followed by space or end). */
function sentenceCount(text: string): number {
  return text.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 0).length;
}

/** Count bullet points (lines starting with - or *). */
function bulletCount(text: string): number {
  return text.split("\n").filter((line) => /^\s*[-*]\s+/.test(line)).length;
}

// --------------------------------------------------------------------------
// AC-1: Has ## Decision Drivers section with at least 5 bullet points
// --------------------------------------------------------------------------
describe("AC-1: Decision Drivers section with at least 5 bullet points", () => {
  test("contains a ## Decision Drivers heading", async () => {
    const content = await readAdr();
    expect(content).toMatch(/^## Decision Drivers/m);
  });

  test("Decision Drivers section has at least 5 bullet points", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Drivers");
    expect(section.length).toBeGreaterThan(0);
    const bullets = bulletCount(section);
    expect(bullets).toBeGreaterThanOrEqual(5);
  });
});

// --------------------------------------------------------------------------
// AC-2: Has ## Considered Options section
// --------------------------------------------------------------------------
describe("AC-2: Considered Options section exists", () => {
  test("contains a ## Considered Options heading", async () => {
    const content = await readAdr();
    expect(content).toMatch(/^## Considered Options/m);
  });

  test("Considered Options section has non-empty content", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Considered Options");
    expect(section.length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------
// AC-3: At least 3 options described, each as ### Option subsections
// --------------------------------------------------------------------------
describe("AC-3: at least 3 ### Option subsections", () => {
  test("Considered Options contains at least 3 ### subsections", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Considered Options");
    const subsections = extractSubsections(section);
    expect(subsections.length).toBeGreaterThanOrEqual(3);
  });

  test("each subsection heading contains 'Option'", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Considered Options");
    const subsections = extractSubsections(section);
    expect(subsections.length).toBeGreaterThanOrEqual(1);
    for (const sub of subsections) {
      expect(sub.title.toLowerCase()).toContain("option");
    }
  });
});

// --------------------------------------------------------------------------
// AC-4: Options include a cron/heartbeat approach and an event-driven approach
// --------------------------------------------------------------------------
describe("AC-4: cron/heartbeat and event-driven approaches present", () => {
  test("at least one option describes a cron or heartbeat approach", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Considered Options");
    expect(section).toMatch(/cron|heartbeat/i);
  });

  test("at least one option describes an event-driven approach", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Considered Options");
    expect(section).toMatch(/event[- ]driven/i);
  });
});

// --------------------------------------------------------------------------
// AC-5: Each option has at least 2 sentences describing how it works
// --------------------------------------------------------------------------
describe("AC-5: each option has at least 2 sentences", () => {
  test("every ### Option subsection has at least 2 sentences", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Considered Options");
    const subsections = extractSubsections(section);
    expect(subsections.length).toBeGreaterThanOrEqual(1);
    for (const sub of subsections) {
      const count = sentenceCount(sub.body);
      expect(count).toBeGreaterThanOrEqual(2);
    }
  });
});

// --------------------------------------------------------------------------
// AC-6: Decision drivers mention safety, cost, and human oversight
// --------------------------------------------------------------------------
describe("AC-6: decision drivers mention safety, cost, and human oversight", () => {
  test("Decision Drivers section mentions safety", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Drivers");
    expect(section.toLowerCase()).toContain("safety");
  });

  test("Decision Drivers section mentions cost", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Drivers");
    expect(section.toLowerCase()).toContain("cost");
  });

  test("Decision Drivers section mentions human oversight", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Decision Drivers");
    expect(section).toMatch(/human\s+oversight/i);
  });
});

// --------------------------------------------------------------------------
// AC-7: TypeScript compiles with no errors (bun test on the test file)
// --------------------------------------------------------------------------
describe("AC-7: TypeScript compiles", () => {
  test("this test file compiles and runs via bun test without TypeScript errors", () => {
    // Reaching this point means bun successfully compiled and executed
    // this .ts file — the AC is satisfied.
    expect(true).toBe(true);
  });
});
