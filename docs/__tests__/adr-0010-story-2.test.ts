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
// AC-1: Has ## Decision Drivers section with at least 5 bullet points
// --------------------------------------------------------------------------
describe("AC-1: Decision Drivers section with at least 5 bullet points", () => {
  test("contains a ## Decision Drivers heading", async () => {
    const content = await readAdr(REPO_ADR);
    expect(content).toMatch(/^## Decision Drivers/m);
  });

  test("Decision Drivers has at least 5 bullet points", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Decision Drivers");
    expect(section).not.toBeNull();

    // Count lines starting with - (markdown bullet points)
    const bullets = section!.split("\n").filter((line) => /^\s*-\s+/.test(line));
    expect(bullets.length).toBeGreaterThanOrEqual(5);
  });
});

// --------------------------------------------------------------------------
// AC-2: Has ## Considered Options section
// --------------------------------------------------------------------------
describe("AC-2: Considered Options section exists", () => {
  test("contains a ## Considered Options heading", async () => {
    const content = await readAdr(REPO_ADR);
    expect(content).toMatch(/^## Considered Options/m);
  });
});

// --------------------------------------------------------------------------
// AC-3: At least 3 options described, each as ### Option subsections
// --------------------------------------------------------------------------
describe("AC-3: at least 3 options as ### subsections", () => {
  test("Considered Options section has at least 3 ### Option subsections", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Considered Options");
    expect(section).not.toBeNull();

    const subsections = extractSubsections(section!);
    expect(subsections.length).toBeGreaterThanOrEqual(3);
  });

  test("each option subsection title starts with 'Option'", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Considered Options");
    expect(section).not.toBeNull();

    const subsections = extractSubsections(section!);
    for (const sub of subsections) {
      expect(sub.title).toMatch(/^Option\s/);
    }
  });
});

// --------------------------------------------------------------------------
// AC-4: Options include a cron/heartbeat approach and an event-driven approach
// --------------------------------------------------------------------------
describe("AC-4: includes cron/heartbeat and event-driven approaches", () => {
  test("one option describes a cron or heartbeat approach", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Considered Options");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasCron = lower.includes("cron");
    const hasHeartbeat = lower.includes("heartbeat");
    const hasScheduled = lower.includes("scheduled");
    expect(hasCron || hasHeartbeat || hasScheduled).toBe(true);
  });

  test("one option describes an event-driven approach", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Considered Options");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasEventDriven = lower.includes("event-driven") || lower.includes("event driven");
    const hasReactive = lower.includes("reactive");
    const hasTriggered = lower.includes("triggered");
    expect(hasEventDriven || hasReactive || hasTriggered).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-5: Each option has at least 2 sentences describing how it works
// --------------------------------------------------------------------------
describe("AC-5: each option has at least 2 sentences", () => {
  test("every ### Option subsection contains at least 2 sentences", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Considered Options");
    expect(section).not.toBeNull();

    const subsections = extractSubsections(section!);
    expect(subsections.length).toBeGreaterThanOrEqual(1);

    for (const sub of subsections) {
      // Count sentence-ending punctuation (. ! ?) followed by space or end-of-string
      const sentences = sub.body.match(/[.!?](?:\s|$)/g);
      expect(sentences).not.toBeNull();
      expect(sentences!.length).toBeGreaterThanOrEqual(
        2,
      );
    }
  });
});

// --------------------------------------------------------------------------
// AC-6: Decision drivers mention safety, cost, and human oversight
// --------------------------------------------------------------------------
describe("AC-6: drivers mention safety, cost, and human oversight", () => {
  test("Decision Drivers section mentions safety", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Decision Drivers");
    expect(section).not.toBeNull();
    expect(section!.toLowerCase()).toMatch(/safety/);
  });

  test("Decision Drivers section mentions cost", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Decision Drivers");
    expect(section).not.toBeNull();
    expect(section!.toLowerCase()).toMatch(/cost/);
  });

  test("Decision Drivers section mentions human oversight", async () => {
    const content = await readAdr(REPO_ADR);
    const section = extractSection(content, "Decision Drivers");
    expect(section).not.toBeNull();

    const lower = section!.toLowerCase();
    const hasHumanOversight = lower.includes("human oversight");
    const hasHuman = lower.includes("human") && lower.includes("oversight");
    const hasReviewable = lower.includes("reviewable");
    const hasInterruptible = lower.includes("interruptible");
    expect(hasHumanOversight || hasHuman || hasReviewable || hasInterruptible).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-7: TypeScript compiles with no errors (bun test on the test file)
// --------------------------------------------------------------------------
describe("AC-7: TypeScript compiles", () => {
  test("this test file compiles and runs under bun test", () => {
    // If we reach this point, the file compiled successfully under bun
    expect(true).toBe(true);
  });
});
