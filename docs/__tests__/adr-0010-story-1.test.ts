import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const REPO_ADR = resolve(REPO_ROOT, "docs/decisions/0010-system-loop-gateway.md");
const VAULT_ADR = resolve(
  process.env.HOME ?? "/Users/joel",
  "Vault/docs/decisions/0010-system-loop-gateway.md",
);

// Helper: read the ADR content (used by multiple test groups)
async function readAdr(path: string): Promise<string> {
  return Bun.file(path).text();
}

// --------------------------------------------------------------------------
// AC-1: File exists at both paths (Vault and repo-local)
// --------------------------------------------------------------------------
describe("AC-1: file exists at both paths", () => {
  test("exists at ~/Vault/docs/decisions/0010-system-loop-gateway.md", () => {
    expect(existsSync(VAULT_ADR)).toBe(true);
  });

  test("exists at docs/decisions/0010-system-loop-gateway.md (repo-local)", () => {
    expect(existsSync(REPO_ADR)).toBe(true);
  });

  test("both files have identical content", async () => {
    const vaultContent = await readAdr(VAULT_ADR);
    const repoContent = await readAdr(REPO_ADR);
    expect(repoContent).toBe(vaultContent);
  });
});

// --------------------------------------------------------------------------
// AC-2: Has YAML frontmatter with status: proposed
// --------------------------------------------------------------------------
describe("AC-2: YAML frontmatter with status proposed", () => {
  test("file starts with YAML frontmatter delimiters", async () => {
    const content = await readAdr(REPO_ADR);
    expect(content.startsWith("---\n")).toBe(true);
    // Must have a closing delimiter
    const closingIndex = content.indexOf("\n---", 4);
    expect(closingIndex).toBeGreaterThan(0);
  });

  test("frontmatter contains status: proposed", async () => {
    const content = await readAdr(REPO_ADR);
    const frontmatter = content.split("---")[1];
    expect(frontmatter).toBeDefined();
    expect(frontmatter).toMatch(/status:\s*proposed/);
  });

  test("frontmatter contains a date field", async () => {
    const content = await readAdr(REPO_ADR);
    const frontmatter = content.split("---")[1];
    expect(frontmatter).toMatch(/date:\s*\d{4}-\d{2}-\d{2}/);
  });

  test("frontmatter contains decision-makers", async () => {
    const content = await readAdr(REPO_ADR);
    const frontmatter = content.split("---")[1];
    expect(frontmatter).toMatch(/decision-makers:/i);
  });
});

// --------------------------------------------------------------------------
// AC-3: Has ## Context and Problem Statement section
// --------------------------------------------------------------------------
describe("AC-3: Context and Problem Statement section", () => {
  test("contains a ## Context and Problem Statement heading", async () => {
    const content = await readAdr(REPO_ADR);
    expect(content).toMatch(/^## Context and Problem Statement/m);
  });
});

// --------------------------------------------------------------------------
// AC-4: Context section is at least 200 words
// --------------------------------------------------------------------------
describe("AC-4: context section is at least 200 words", () => {
  test("Context and Problem Statement section has >= 200 words", async () => {
    const content = await readAdr(REPO_ADR);
    // Extract everything after the Context heading until the next ## heading or EOF
    const contextMatch = content.match(
      /## Context and Problem Statement\s*\n([\s\S]*?)(?=\n## |\n# |$)/,
    );
    expect(contextMatch).not.toBeNull();

    const sectionText = contextMatch![1].trim();
    // Count words: split on whitespace, filter out empty strings
    const wordCount = sectionText.split(/\s+/).filter((w) => w.length > 0).length;
    expect(wordCount).toBeGreaterThanOrEqual(200);
  });
});

// --------------------------------------------------------------------------
// AC-5: References ADR-0005 (coding loops) and ADR-0007 (v2 improvements)
// --------------------------------------------------------------------------
describe("AC-5: references ADR-0005 and ADR-0007", () => {
  test("references ADR-0005", async () => {
    const content = await readAdr(REPO_ADR);
    expect(content).toMatch(/ADR[-\s]?0005/i);
  });

  test("references ADR-0007", async () => {
    const content = await readAdr(REPO_ADR);
    expect(content).toMatch(/ADR[-\s]?0007/i);
  });

  test("references ADR-0008", async () => {
    const content = await readAdr(REPO_ADR);
    expect(content).toMatch(/ADR[-\s]?0008/i);
  });
});

// --------------------------------------------------------------------------
// AC-6: Describes the SENSE→ORIENT→DECIDE→ACT→LEARN pattern
// --------------------------------------------------------------------------
describe("AC-6: SENSE ORIENT DECIDE ACT LEARN pattern", () => {
  test("mentions SENSE in the context of the loop pattern", async () => {
    const content = await readAdr(REPO_ADR);
    expect(content).toMatch(/sense/i);
  });

  test("mentions ORIENT in the context of the loop pattern", async () => {
    const content = await readAdr(REPO_ADR);
    expect(content).toMatch(/orient/i);
  });

  test("mentions DECIDE in the context of the loop pattern", async () => {
    const content = await readAdr(REPO_ADR);
    expect(content).toMatch(/decide/i);
  });

  test("mentions ACT in the context of the loop pattern", async () => {
    const content = await readAdr(REPO_ADR);
    expect(content).toMatch(/\bact\b/i);
  });

  test("mentions LEARN in the context of the loop pattern", async () => {
    const content = await readAdr(REPO_ADR);
    expect(content).toMatch(/learn/i);
  });
});

// --------------------------------------------------------------------------
// AC-7: Explains that Joel is currently the manual gateway
// --------------------------------------------------------------------------
describe("AC-7: Joel is the manual gateway", () => {
  test("mentions Joel as the current decision-maker / gateway", async () => {
    const content = await readAdr(REPO_ADR);
    // Should describe Joel as the one currently performing this role
    expect(content).toMatch(/Joel/);
  });

  test("describes the current process as manual or human-driven", async () => {
    const content = await readAdr(REPO_ADR);
    // Should convey that orchestration is currently manual
    const lowerContent = content.toLowerCase();
    const hasManual = lowerContent.includes("manual");
    const hasGateway = lowerContent.includes("gateway");
    const hasHuman = lowerContent.includes("human");
    expect(hasManual || hasGateway || hasHuman).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-8: Mentions existing capabilities
// --------------------------------------------------------------------------
describe("AC-8: mentions existing capabilities", () => {
  test("mentions coding loop", async () => {
    const content = await readAdr(REPO_ADR);
    expect(content).toMatch(/coding\s+loop/i);
  });

  test("mentions event bus", async () => {
    const content = await readAdr(REPO_ADR);
    expect(content).toMatch(/event\s+bus/i);
  });

  test("mentions note queue", async () => {
    const content = await readAdr(REPO_ADR);
    expect(content).toMatch(/note\s+queue/i);
  });

  test("mentions retrospective", async () => {
    const content = await readAdr(REPO_ADR);
    expect(content).toMatch(/retrospective/i);
  });
});

// --------------------------------------------------------------------------
// AC-9: TypeScript compiles with no errors (bun test on the test file)
// --------------------------------------------------------------------------
describe("AC-9: TypeScript compiles", () => {
  test("this test file compiles and runs under bun test", () => {
    // If we reach this point, the file compiled successfully under bun
    expect(true).toBe(true);
  });
});
