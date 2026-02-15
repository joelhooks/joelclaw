import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ADR_PATH = resolve(
  process.env.HOME ?? "/Users/joel",
  "Vault",
  "docs",
  "decisions",
  "0010-system-loop-gateway.md",
);

/**
 * Helper: read the ADR file content. Throws if file doesn't exist.
 */
async function readAdr(): Promise<string> {
  return Bun.file(ADR_PATH).text();
}

/**
 * Helper: extract YAML frontmatter from markdown content.
 * Returns the raw YAML string between the opening and closing `---`.
 */
function extractFrontmatter(content: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match?.[1] ?? null;
}

/**
 * Helper: extract a named section's body text.
 * Returns everything after `## <heading>` until the next `## ` or end of file.
 */
function extractSection(content: string, heading: string): string | null {
  const pattern = new RegExp(
    `## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`,
  );
  const match = content.match(pattern);
  return match?.[1]?.trim() ?? null;
}

/**
 * Helper: count words in a string (split on whitespace).
 */
function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

// --------------------------------------------------------------------------
// AC-1: File exists at ~/Vault/docs/decisions/0010-system-loop-gateway.md
// --------------------------------------------------------------------------
describe("AC-1: ADR file exists", () => {
  test("0010-system-loop-gateway.md exists", () => {
    expect(existsSync(ADR_PATH)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-2: Has YAML frontmatter with status: proposed
// --------------------------------------------------------------------------
describe("AC-2: YAML frontmatter with status: proposed", () => {
  test("file has YAML frontmatter delimiters", async () => {
    const content = await readAdr();
    expect(content.startsWith("---\n")).toBe(true);
    expect(content.indexOf("\n---", 4)).toBeGreaterThan(0);
  });

  test("frontmatter contains status: proposed", async () => {
    const content = await readAdr();
    const fm = extractFrontmatter(content);
    expect(fm).not.toBeNull();
    expect(fm).toMatch(/status:\s*proposed/);
  });

  test("frontmatter contains date field", async () => {
    const content = await readAdr();
    const fm = extractFrontmatter(content);
    expect(fm).not.toBeNull();
    expect(fm).toMatch(/date:\s*\d{4}-\d{2}-\d{2}/);
  });

  test("frontmatter contains decision-makers", async () => {
    const content = await readAdr();
    const fm = extractFrontmatter(content);
    expect(fm).not.toBeNull();
    expect(fm).toMatch(/decision-makers/i);
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

  test("section has non-empty body", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Context and Problem Statement");
    expect(section).not.toBeNull();
    expect(section!.length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------
// AC-4: Context section is at least 200 words
// --------------------------------------------------------------------------
describe("AC-4: Context section word count", () => {
  test("Context and Problem Statement is at least 200 words", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Context and Problem Statement");
    expect(section).not.toBeNull();
    const count = wordCount(section!);
    if (count < 200) {
      console.error(
        `Context section is only ${count} words (need at least 200)`,
      );
    }
    expect(count).toBeGreaterThanOrEqual(200);
  });
});

// --------------------------------------------------------------------------
// AC-5: References ADR-0005 (coding loops) and ADR-0007 (v2 improvements)
// --------------------------------------------------------------------------
describe("AC-5: References to related ADRs", () => {
  test("references ADR-0005", async () => {
    const content = await readAdr();
    expect(content).toMatch(/ADR-0005/);
  });

  test("references ADR-0007", async () => {
    const content = await readAdr();
    expect(content).toMatch(/ADR-0007/);
  });
});

// --------------------------------------------------------------------------
// AC-6: Describes the SENSE→ORIENT→DECIDE→ACT→LEARN pattern
// --------------------------------------------------------------------------
describe("AC-6: OODA-like loop pattern", () => {
  test("mentions SENSE step", async () => {
    const content = await readAdr();
    expect(content).toMatch(/sense/i);
  });

  test("mentions ORIENT step", async () => {
    const content = await readAdr();
    expect(content).toMatch(/orient/i);
  });

  test("mentions DECIDE step", async () => {
    const content = await readAdr();
    expect(content).toMatch(/decide/i);
  });

  test("mentions ACT step", async () => {
    const content = await readAdr();
    expect(content).toMatch(/\bact\b/i);
  });

  test("mentions LEARN step", async () => {
    const content = await readAdr();
    expect(content).toMatch(/learn/i);
  });
});

// --------------------------------------------------------------------------
// AC-7: Explains that Joel is currently the manual gateway
// --------------------------------------------------------------------------
describe("AC-7: Joel as manual gateway", () => {
  test("mentions Joel in the context of decision-making or gateway", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Context and Problem Statement");
    expect(section).not.toBeNull();
    expect(section).toMatch(/Joel/);
  });

  test("describes manual or human gateway role", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Context and Problem Statement");
    expect(section).not.toBeNull();
    // Should describe Joel as the gateway / manual orchestrator
    const hasGateway = /gateway/i.test(section!);
    const hasManual = /manual/i.test(section!);
    const hasDecides = /decides/i.test(section!);
    expect(hasGateway || hasManual || hasDecides).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-8: Mentions existing capabilities
// --------------------------------------------------------------------------
describe("AC-8: Existing capabilities mentioned", () => {
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
    "bunx tsc --noEmit succeeds on this test file",
    async () => {
      const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: resolve(import.meta.dir, ".."),
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
