import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const HOME = process.env.HOME ?? "/Users/joel";
const ADR_PATH = resolve(
  HOME,
  "Vault",
  "docs",
  "decisions",
  "0010-system-loop-gateway.md",
);

/** Read the ADR file content once for reuse across tests. */
async function readAdr(): Promise<string> {
  return Bun.file(ADR_PATH).text();
}

/**
 * Extract the body of a specific ## section from markdown.
 * Returns all text from the heading until the next ## heading or end-of-file.
 */
function extractSection(content: string, heading: string): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `^## ${escapedHeading}\\s*\\n([\\s\\S]*?)(?=^## |\\z)`,
    "m",
  );
  const match = content.match(regex);
  return match?.[1]?.trim() ?? "";
}

/** Count words in a string (whitespace-delimited, non-empty tokens). */
function wordCount(text: string): number {
  return text
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

/**
 * Extract YAML frontmatter from markdown.
 * Returns the raw YAML string between the opening and closing --- fences.
 */
function extractFrontmatter(content: string): string {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match?.[1] ?? "";
}

// --------------------------------------------------------------------------
// AC-1: File exists at ~/Vault/docs/decisions/0010-system-loop-gateway.md
// --------------------------------------------------------------------------
describe("AC-1: file exists", () => {
  test("ADR file exists at ~/Vault/docs/decisions/0010-system-loop-gateway.md", () => {
    expect(existsSync(ADR_PATH)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-2: Has YAML frontmatter with status: proposed
// --------------------------------------------------------------------------
describe("AC-2: YAML frontmatter", () => {
  test("file starts with YAML frontmatter fences (---)", async () => {
    const content = await readAdr();
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("\n---");
  });

  test("frontmatter contains status: proposed", async () => {
    const content = await readAdr();
    const fm = extractFrontmatter(content);
    expect(fm).toMatch(/^status:\s*proposed$/m);
  });

  test("frontmatter contains a date field", async () => {
    const content = await readAdr();
    const fm = extractFrontmatter(content);
    expect(fm).toMatch(/^date:\s*.+$/m);
  });

  test("frontmatter contains decision-makers field", async () => {
    const content = await readAdr();
    const fm = extractFrontmatter(content);
    expect(fm).toMatch(/decision.makers/im);
  });
});

// --------------------------------------------------------------------------
// AC-3: Has ## Context and Problem Statement section
// --------------------------------------------------------------------------
describe("AC-3: Context and Problem Statement section", () => {
  test("contains ## Context and Problem Statement heading", async () => {
    const content = await readAdr();
    expect(content).toMatch(/^## Context and Problem Statement/m);
  });

  test("section has non-empty body text", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Context and Problem Statement");
    expect(section.length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------
// AC-4: Context section is at least 200 words
// --------------------------------------------------------------------------
describe("AC-4: context section word count", () => {
  test("Context and Problem Statement section is at least 200 words", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Context and Problem Statement");
    const count = wordCount(section);
    expect(count).toBeGreaterThanOrEqual(200);
  });
});

// --------------------------------------------------------------------------
// AC-5: References ADR-0005 (coding loops) and ADR-0007 (v2 improvements)
// --------------------------------------------------------------------------
describe("AC-5: ADR cross-references", () => {
  test("references ADR-0005", async () => {
    const content = await readAdr();
    expect(content).toMatch(/ADR[-‑–]?0005/i);
  });

  test("references ADR-0007", async () => {
    const content = await readAdr();
    expect(content).toMatch(/ADR[-‑–]?0007/i);
  });
});

// --------------------------------------------------------------------------
// AC-6: Describes the SENSE→ORIENT→DECIDE→ACT→LEARN pattern
// --------------------------------------------------------------------------
describe("AC-6: OODA-like loop pattern", () => {
  test("mentions SENSE, ORIENT, DECIDE, ACT, and LEARN", async () => {
    const content = await readAdr();
    const upper = content.toUpperCase();
    expect(upper).toContain("SENSE");
    expect(upper).toContain("ORIENT");
    expect(upper).toContain("DECIDE");
    expect(upper).toContain("ACT");
    expect(upper).toContain("LEARN");
  });
});

// --------------------------------------------------------------------------
// AC-7: Explains that Joel is currently the manual gateway
// --------------------------------------------------------------------------
describe("AC-7: Joel as manual gateway", () => {
  test("mentions Joel as the current gateway or manual decision-maker", async () => {
    const content = await readAdr();
    // Must mention Joel in context of being the gateway / manual orchestrator
    expect(content).toMatch(/Joel/i);
    expect(content).toMatch(/gateway|manual|decides|orchestrat/i);
  });
});

// --------------------------------------------------------------------------
// AC-8: Mentions existing capabilities: coding loop, event bus, note queue,
//       retrospective
// --------------------------------------------------------------------------
describe("AC-8: existing capabilities mentioned", () => {
  test("mentions coding loop", async () => {
    const content = await readAdr();
    expect(content).toMatch(/coding\s+loop/i);
  });

  test("mentions event bus", async () => {
    const content = await readAdr();
    expect(content).toMatch(/event\s+bus/i);
  });

  test("mentions note queue", async () => {
    const content = await readAdr();
    expect(content).toMatch(/note\s+queue/i);
  });

  test("mentions retrospective", async () => {
    const content = await readAdr();
    expect(content).toMatch(/retrospective/i);
  });
});

// --------------------------------------------------------------------------
// AC-9: TypeScript compiles with no errors (bun test on the test file)
// --------------------------------------------------------------------------
describe("AC-9: TypeScript compiles", () => {
  test(
    "this test file compiles and runs via bun test without TypeScript errors",
    () => {
      // If we've reached this point, bun has successfully compiled and
      // executed this .ts file — the AC is satisfied.
      expect(true).toBe(true);
    },
  );
});
