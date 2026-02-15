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
 * Helper: extract all ### subsections within a ## section.
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

// --------------------------------------------------------------------------
// AC-1: Has ## Decision Drivers section with at least 5 bullet points
// --------------------------------------------------------------------------
describe("AC-1: Decision Drivers section with >= 5 bullets", () => {
  test("contains ## Decision Drivers heading", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    expect(content).toMatch(/^## Decision Drivers/m);
  });

  test("Decision Drivers section has at least 5 bullet points", async () => {
    const section = await getSection("Decision Drivers");
    expect(section.length).toBeGreaterThan(0);

    // Match markdown bullet points (-, *, or numbered)
    const bullets = section.match(/^[\s]*[-*]\s+.+/gm) ?? [];
    expect(bullets.length).toBeGreaterThanOrEqual(5);
  });
});

// --------------------------------------------------------------------------
// AC-2: Has ## Considered Options section
// --------------------------------------------------------------------------
describe("AC-2: Considered Options section exists", () => {
  test("contains ## Considered Options heading", async () => {
    const content = await Bun.file(REPO_ADR_PATH).text();
    expect(content).toMatch(/^## Considered Options/m);
  });
});

// --------------------------------------------------------------------------
// AC-3: At least 3 options described, each as ### Option subsections
// --------------------------------------------------------------------------
describe("AC-3: at least 3 ### Option subsections", () => {
  test("Considered Options section has at least 3 ### subsections", async () => {
    const section = await getSection("Considered Options");
    expect(section.length).toBeGreaterThan(0);

    const subsections = getSubsections(section);
    expect(subsections.length).toBeGreaterThanOrEqual(3);
  });

  test("each option subsection has a title", async () => {
    const section = await getSection("Considered Options");
    const subsections = getSubsections(section);

    for (const sub of subsections) {
      expect(sub.title.length).toBeGreaterThan(0);
    }
  });
});

// --------------------------------------------------------------------------
// AC-4: Options include a cron/heartbeat approach and an event-driven approach
// --------------------------------------------------------------------------
describe("AC-4: includes cron/heartbeat and event-driven approaches", () => {
  test("at least one option mentions cron or heartbeat", async () => {
    const section = await getSection("Considered Options");
    const lower = section.toLowerCase();
    const hasCronOrHeartbeat =
      lower.includes("cron") || lower.includes("heartbeat");
    expect(hasCronOrHeartbeat).toBe(true);
  });

  test("at least one option mentions event-driven or reactive", async () => {
    const section = await getSection("Considered Options");
    const lower = section.toLowerCase();
    const hasEventDriven =
      lower.includes("event-driven") ||
      lower.includes("event driven") ||
      lower.includes("reactive");
    expect(hasEventDriven).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-5: Each option has at least 2 sentences describing how it works
// --------------------------------------------------------------------------
describe("AC-5: each option has >= 2 sentences", () => {
  test("every ### option subsection contains at least 2 sentences", async () => {
    const section = await getSection("Considered Options");
    const subsections = getSubsections(section);
    expect(subsections.length).toBeGreaterThanOrEqual(3);

    for (const sub of subsections) {
      // Count sentence-ending punctuation (. ! ?) followed by space, newline, or end
      const sentences = sub.body.match(/[.!?](?:\s|$)/g) ?? [];
      expect(sentences.length).toBeGreaterThanOrEqual(
        2,
        `Option "${sub.title}" has fewer than 2 sentences`,
      );
    }
  });
});

// --------------------------------------------------------------------------
// AC-6: Decision drivers mention safety, cost, and human oversight
// --------------------------------------------------------------------------
describe("AC-6: drivers mention safety, cost, and human oversight", () => {
  test("Decision Drivers mention safety", async () => {
    const section = await getSection("Decision Drivers");
    const lower = section.toLowerCase();
    expect(lower).toMatch(/safe(ty)?/);
  });

  test("Decision Drivers mention cost", async () => {
    const section = await getSection("Decision Drivers");
    const lower = section.toLowerCase();
    expect(lower).toMatch(/cost/);
  });

  test("Decision Drivers mention human oversight", async () => {
    const section = await getSection("Decision Drivers");
    const lower = section.toLowerCase();
    const hasHumanOversight =
      lower.includes("human oversight") ||
      lower.includes("human-in-the-loop") ||
      lower.includes("human in the loop") ||
      lower.includes("human control") ||
      lower.includes("human review") ||
      (lower.includes("human") && lower.includes("oversight"));
    expect(hasHumanOversight).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-7: TypeScript compiles with no errors
// --------------------------------------------------------------------------
describe("AC-7: TypeScript compiles", () => {
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
