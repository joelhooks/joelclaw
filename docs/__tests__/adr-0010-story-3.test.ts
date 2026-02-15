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
 * Helper: extract all ### subsections within a section string.
 * Returns an array of { title, body } objects.
 */
function getSubsections(sectionText: string): { title: string; body: string }[] {
  const parts = sectionText.split(/^### /m).slice(1); // skip text before first ###
  return parts.map((part) => {
    const newline = part.indexOf("\n");
    const title = newline > 0 ? part.slice(0, newline).trim() : part.trim();
    const body = newline > 0 ? part.slice(newline).trim() : "";
    return { title, body };
  });
}

/**
 * Helper: get the Considered Options section and extract option titles.
 * Needed to cross-reference with Pros and Cons section.
 */
async function getOptionTitles(): Promise<string[]> {
  const section = await getSection("Considered Options");
  const subsections = getSubsections(section);
  return subsections.map((s) => s.title);
}

// --------------------------------------------------------------------------
// AC-1: Has ## Decision Outcome section
// --------------------------------------------------------------------------
describe("AC-1: Decision Outcome section exists", () => {
  test("contains ## Decision Outcome heading", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    expect(content).toMatch(/^## Decision Outcome/m);
  });

  test("Decision Outcome section has non-empty content", async () => {
    const section = await getSection("Decision Outcome");
    // Strip the heading line itself and check remaining content
    const body = section.replace(/^## Decision Outcome\s*\n/, "").trim();
    expect(body.length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------
// AC-2: Chosen option is clearly stated with rationale
// --------------------------------------------------------------------------
describe("AC-2: Chosen option clearly stated with rationale", () => {
  test("Decision Outcome section states the chosen option", async () => {
    const section = await getSection("Decision Outcome");
    const lower = section.toLowerCase();
    // Should explicitly name which option was chosen
    const statesChoice =
      lower.includes("chosen option") ||
      lower.includes("we decided") ||
      lower.includes("we chose") ||
      lower.includes("selected option") ||
      lower.includes("we will use") ||
      lower.includes("decision is to");
    expect(statesChoice).toBe(true);
  });

  test("Decision Outcome section includes rationale (because / reason)", async () => {
    const section = await getSection("Decision Outcome");
    const lower = section.toLowerCase();
    const hasRationale =
      lower.includes("because") ||
      lower.includes("rationale") ||
      lower.includes("reason") ||
      lower.includes("since") ||
      lower.includes("this approach");
    expect(hasRationale).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-3: Decision recommends a hybrid event-driven + cron approach
// --------------------------------------------------------------------------
describe("AC-3: hybrid event-driven + cron approach", () => {
  test("Decision Outcome mentions event-driven or reactive", async () => {
    const section = await getSection("Decision Outcome");
    const lower = section.toLowerCase();
    const hasEventDriven =
      lower.includes("event-driven") ||
      lower.includes("event driven") ||
      lower.includes("reactive");
    expect(hasEventDriven).toBe(true);
  });

  test("Decision Outcome mentions cron or heartbeat", async () => {
    const section = await getSection("Decision Outcome");
    const lower = section.toLowerCase();
    const hasCron =
      lower.includes("cron") || lower.includes("heartbeat");
    expect(hasCron).toBe(true);
  });

  test("Decision Outcome mentions hybrid or combination of approaches", async () => {
    const section = await getSection("Decision Outcome");
    const lower = section.toLowerCase();
    const hasHybrid =
      lower.includes("hybrid") ||
      lower.includes("combination") ||
      lower.includes("both") ||
      lower.includes("plus") ||
      lower.includes("combined") ||
      lower.includes("complemented by") ||
      lower.includes("fallback");
    expect(hasHybrid).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-4: Has ### Consequences subsection with Good, Bad, and Neutral items
// --------------------------------------------------------------------------
describe("AC-4: Consequences with Good, Bad, and Neutral items", () => {
  test("has ### Consequences subsection within Decision Outcome", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    // Consequences can be a subsection of Decision Outcome or a standalone section
    expect(content).toMatch(/^###?\s*Consequences/m);
  });

  test("Consequences lists Good items", async () => {
    // Get everything from Consequences heading onward (could be ### or ##)
    const content = await Bun.file(REPO_ADR_PATH).text();
    const consMatch = content.match(/^###?\s*Consequences/m);
    expect(consMatch).not.toBeNull();
    expect(consMatch!.index).toBeDefined();

    const afterCons = content.slice(consMatch!.index!);
    const nextMajor = afterCons.indexOf("\n## ", 1);
    const consSection = nextMajor > 0 ? afterCons.slice(0, nextMajor) : afterCons;
    const lower = consSection.toLowerCase();

    expect(lower).toMatch(/good/);
  });

  test("Consequences lists Bad items", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    const consMatch = content.match(/^###?\s*Consequences/m);
    expect(consMatch).not.toBeNull();

    const afterCons = content.slice(consMatch!.index!);
    const nextMajor = afterCons.indexOf("\n## ", 1);
    const consSection = nextMajor > 0 ? afterCons.slice(0, nextMajor) : afterCons;
    const lower = consSection.toLowerCase();

    expect(lower).toMatch(/bad/);
  });

  test("Consequences lists Neutral items", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    const consMatch = content.match(/^###?\s*Consequences/m);
    expect(consMatch).not.toBeNull();

    const afterCons = content.slice(consMatch!.index!);
    const nextMajor = afterCons.indexOf("\n## ", 1);
    const consSection = nextMajor > 0 ? afterCons.slice(0, nextMajor) : afterCons;
    const lower = consSection.toLowerCase();

    expect(lower).toMatch(/neutral/);
  });

  test("Good consequences mention autonomous action or faster feedback", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    const consMatch = content.match(/^###?\s*Consequences/m);
    expect(consMatch).not.toBeNull();

    const afterCons = content.slice(consMatch!.index!);
    const nextMajor = afterCons.indexOf("\n## ", 1);
    const consSection = nextMajor > 0 ? afterCons.slice(0, nextMajor) : afterCons;
    const lower = consSection.toLowerCase();

    const hasGoodThings =
      lower.includes("autonomous") ||
      lower.includes("feedback loop") ||
      lower.includes("note queue") ||
      lower.includes("faster");
    expect(hasGoodThings).toBe(true);
  });

  test("Bad consequences mention cost, runaway risk, or complexity", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    const consMatch = content.match(/^###?\s*Consequences/m);
    expect(consMatch).not.toBeNull();

    const afterCons = content.slice(consMatch!.index!);
    const nextMajor = afterCons.indexOf("\n## ", 1);
    const consSection = nextMajor > 0 ? afterCons.slice(0, nextMajor) : afterCons;
    const lower = consSection.toLowerCase();

    const hasBadThings =
      lower.includes("cost") ||
      lower.includes("runaway") ||
      lower.includes("complexity") ||
      lower.includes("llm");
    expect(hasBadThings).toBe(true);
  });

  test("Neutral consequences mention human override or cancel", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    const consMatch = content.match(/^###?\s*Consequences/m);
    expect(consMatch).not.toBeNull();

    const afterCons = content.slice(consMatch!.index!);
    const nextMajor = afterCons.indexOf("\n## ", 1);
    const consSection = nextMajor > 0 ? afterCons.slice(0, nextMajor) : afterCons;
    const lower = consSection.toLowerCase();

    const hasNeutralThings =
      lower.includes("human") ||
      lower.includes("override") ||
      lower.includes("cancel");
    expect(hasNeutralThings).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-5: Has ## Pros and Cons of the Options section
// --------------------------------------------------------------------------
describe("AC-5: Pros and Cons of the Options section exists", () => {
  test("contains ## Pros and Cons heading", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    expect(content).toMatch(/^## Pros and Cons of the Options/m);
  });

  test("Pros and Cons section has non-empty content", async () => {
    const section = await getSection("Pros and Cons of the Options");
    const body = section.replace(/^## Pros and Cons of the Options\s*\n/, "").trim();
    expect(body.length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------
// AC-6: Each option from Considered Options has pros and cons listed
// --------------------------------------------------------------------------
describe("AC-6: each considered option has pros and cons", () => {
  test("Pros and Cons section has subsections for each considered option", async () => {
    const optionTitles = await getOptionTitles();
    expect(optionTitles.length).toBeGreaterThanOrEqual(3);

    const prosConsSection = await getSection("Pros and Cons of the Options");
    const prosConsSubsections = getSubsections(prosConsSection);

    // Each considered option should appear in the pros/cons section
    expect(prosConsSubsections.length).toBeGreaterThanOrEqual(optionTitles.length);
  });

  test("each pros/cons subsection lists at least one pro (Good/Pro/+)", async () => {
    const prosConsSection = await getSection("Pros and Cons of the Options");
    const subsections = getSubsections(prosConsSection);
    expect(subsections.length).toBeGreaterThanOrEqual(3);

    for (const sub of subsections) {
      const lower = sub.body.toLowerCase();
      const hasPro =
        lower.includes("good") ||
        lower.includes("pro") ||
        lower.includes("{.good}") ||
        lower.includes("advantage") ||
        lower.includes("benefit") ||
        sub.body.includes("+");
      expect(hasPro).toBe(true);
    }
  });

  test("each pros/cons subsection lists at least one con (Bad/Con/-)", async () => {
    const prosConsSection = await getSection("Pros and Cons of the Options");
    const subsections = getSubsections(prosConsSection);
    expect(subsections.length).toBeGreaterThanOrEqual(3);

    for (const sub of subsections) {
      const lower = sub.body.toLowerCase();
      const hasCon =
        lower.includes("bad") ||
        lower.includes("con") ||
        lower.includes("{.bad}") ||
        lower.includes("disadvantage") ||
        lower.includes("drawback") ||
        lower.includes("risk") ||
        sub.body.includes("−") || // minus sign
        sub.body.includes("–"); // en dash
      expect(hasCon).toBe(true);
    }
  });
});

// --------------------------------------------------------------------------
// AC-7: Mentions safety constraints (human override, action limits, cost caps)
// --------------------------------------------------------------------------
describe("AC-7: safety constraints mentioned", () => {
  test("mentions human override or human-in-the-loop", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    const lower = content.toLowerCase();
    const hasHumanOverride =
      lower.includes("human override") ||
      lower.includes("human-in-the-loop") ||
      lower.includes("human in the loop") ||
      lower.includes("human can") ||
      lower.includes("cancel") ||
      lower.includes("kill switch") ||
      lower.includes("veto");
    expect(hasHumanOverride).toBe(true);
  });

  test("mentions action limits or rate limits", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    const lower = content.toLowerCase();
    const hasLimits =
      lower.includes("action limit") ||
      lower.includes("rate limit") ||
      lower.includes("throttl") ||
      lower.includes("limit") ||
      lower.includes("cap") ||
      lower.includes("bound") ||
      lower.includes("runaway");
    expect(hasLimits).toBe(true);
  });

  test("mentions cost caps or cost controls", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    const lower = content.toLowerCase();
    const hasCostCaps =
      lower.includes("cost cap") ||
      lower.includes("cost control") ||
      lower.includes("cost limit") ||
      lower.includes("budget") ||
      lower.includes("spend") ||
      (lower.includes("cost") && lower.includes("limit")) ||
      (lower.includes("cost") && lower.includes("cap"));
    expect(hasCostCaps).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-8: TypeScript compiles with no errors
// --------------------------------------------------------------------------
describe("AC-8: TypeScript compiles", () => {
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
