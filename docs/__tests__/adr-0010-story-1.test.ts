import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const REPO_ADR_PATH = resolve(REPO_ROOT, "docs/decisions/0010-system-loop-gateway.md");
const VAULT_ADR_PATH = resolve(
  process.env.HOME ?? "/Users/joel",
  "Vault/docs/decisions/0010-system-loop-gateway.md",
);

// --------------------------------------------------------------------------
// AC-1: File exists at both paths (vault + repo-local)
// --------------------------------------------------------------------------
describe("AC-1: file exists at both paths", () => {
  test("repo-local file exists at docs/decisions/0010-system-loop-gateway.md", () => {
    expect(existsSync(REPO_ADR_PATH)).toBe(true);
  });

  test("vault file exists at ~/Vault/docs/decisions/0010-system-loop-gateway.md", () => {
    expect(existsSync(VAULT_ADR_PATH)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-2: Has YAML frontmatter with status: proposed
// --------------------------------------------------------------------------
describe("AC-2: YAML frontmatter with status: proposed", () => {
  test("file starts with YAML frontmatter delimiters", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    expect(content.startsWith("---\n")).toBe(true);
    // Close delimiter exists after the opening one
    const closeIndex = content.indexOf("\n---", 4);
    expect(closeIndex).toBeGreaterThan(0);
  });

  test("frontmatter contains status: proposed (unquoted)", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    const frontmatter = content.split("---")[1];
    // Must have unquoted value — match `status: proposed` but NOT `status: "proposed"`
    expect(frontmatter).toMatch(/^status:\s*proposed\s*$/m);
    expect(frontmatter).not.toMatch(/status:\s*["']/);
  });

  test("frontmatter contains date field", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    const frontmatter = content.split("---")[1];
    expect(frontmatter).toMatch(/^date:\s*\d{4}-\d{2}-\d{2}\s*$/m);
  });

  test("frontmatter contains decision-makers field", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    const frontmatter = content.split("---")[1];
    expect(frontmatter).toMatch(/decision-makers/i);
  });
});

// --------------------------------------------------------------------------
// AC-3: Has ## Context and Problem Statement section
// --------------------------------------------------------------------------
describe("AC-3: Context and Problem Statement section", () => {
  test("contains ## Context and Problem Statement heading", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    expect(content).toMatch(/^## Context and Problem Statement/m);
  });
});

// --------------------------------------------------------------------------
// AC-4: Context section is at least 200 words
// --------------------------------------------------------------------------
describe("AC-4: context section word count >= 200", () => {
  test("context section contains at least 200 words", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    // Extract the Context and Problem Statement section
    const contextStart = content.indexOf("## Context and Problem Statement");
    expect(contextStart).toBeGreaterThan(-1);

    // Get text from that heading to the next ## heading or end of file
    const afterHeading = content.slice(contextStart);
    const nextSection = afterHeading.indexOf("\n## ", 1);
    const sectionText =
      nextSection > 0 ? afterHeading.slice(0, nextSection) : afterHeading;

    // Count words (split on whitespace, filter empties)
    const words = sectionText.split(/\s+/).filter((w) => w.length > 0);
    expect(words.length).toBeGreaterThanOrEqual(200);
  });
});

// --------------------------------------------------------------------------
// AC-5: References ADR-0005 and ADR-0007
// --------------------------------------------------------------------------
describe("AC-5: references ADR-0005 and ADR-0007", () => {
  test("references ADR-0005 (coding loops)", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    expect(content).toMatch(/ADR[-‑–]?0005/);
  });

  test("references ADR-0007 (v2 improvements)", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    expect(content).toMatch(/ADR[-‑–]?0007/);
  });
});

// --------------------------------------------------------------------------
// AC-6: Describes the SENSE→ORIENT→DECIDE→ACT→LEARN pattern
// --------------------------------------------------------------------------
describe("AC-6: SENSE→ORIENT→DECIDE→ACT→LEARN pattern", () => {
  test("mentions all five SODALAL phases", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
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
  test("mentions Joel as the current decision-maker / gateway", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    expect(content).toMatch(/Joel/);
    // Should convey the idea that Joel is the gateway / bottleneck / manual orchestrator
    const lower = content.toLowerCase();
    const hasGatewayConcept =
      lower.includes("gateway") ||
      lower.includes("bottleneck") ||
      lower.includes("manual") ||
      lower.includes("decides");
    expect(hasGatewayConcept).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-8: Mentions existing capabilities
// --------------------------------------------------------------------------
describe("AC-8: existing capabilities mentioned", () => {
  test("mentions coding loop capability", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    const lower = content.toLowerCase();
    expect(lower).toMatch(/coding\s*loop/);
  });

  test("mentions event bus capability", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    const lower = content.toLowerCase();
    expect(lower).toMatch(/event\s*bus/);
  });

  test("mentions note queue capability", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    const lower = content.toLowerCase();
    expect(lower).toMatch(/note\s*queue/);
  });

  test("mentions retrospective capability", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    const lower = content.toLowerCase();
    expect(lower).toContain("retrospective");
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
