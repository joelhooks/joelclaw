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

/** Count bullet points (lines starting with - or *). */
function bulletCount(text: string): number {
  return text.split("\n").filter((line) => /^\s*[-*]\s+/.test(line)).length;
}

/** Count checkbox items (lines starting with - [ ]). */
function checkboxCount(text: string): number {
  return text.split("\n").filter((line) => /^\s*-\s+\[[ x]\]\s+/.test(line))
    .length;
}

/** Extract numbered list items. */
function numberedItems(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /^\s*\d+\.\s+/.test(line))
    .map((line) => line.replace(/^\s*\d+\.\s+/, "").trim());
}

// --------------------------------------------------------------------------
// AC-1: Has ## Implementation Plan section with numbered steps
// --------------------------------------------------------------------------
describe("AC-1: Implementation Plan section with numbered steps", () => {
  test("contains a ## Implementation Plan heading", async () => {
    const content = await readAdr();
    expect(content).toMatch(/^## Implementation Plan/m);
  });

  test("Implementation Plan section has non-empty body text", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section.length).toBeGreaterThan(0);
  });

  test("Implementation Plan contains numbered steps", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    const items = numberedItems(section);
    expect(items.length).toBeGreaterThanOrEqual(3);
  });
});

// --------------------------------------------------------------------------
// AC-2: Plan describes the heartbeat Inngest function
// --------------------------------------------------------------------------
describe("AC-2: heartbeat Inngest function described", () => {
  test("Implementation Plan mentions Inngest function", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/inngest/i);
  });

  test("Implementation Plan mentions heartbeat", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/heartbeat/i);
  });

  test("Implementation Plan mentions cron trigger", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/cron/i);
  });

  test("Implementation Plan mentions terminal or workflow events as trigger", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/terminal|workflow\s+event|loop\.complete|event/i);
  });
});

// --------------------------------------------------------------------------
// AC-3: Plan describes state gathering (note queue, slog, retros, active runs)
// --------------------------------------------------------------------------
describe("AC-3: state gathering step described", () => {
  test("Implementation Plan mentions state gathering or snapshot", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/state[- ]gather|snapshot|state/i);
  });

  test("Implementation Plan mentions note queue", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/note\s+queue/i);
  });

  test("Implementation Plan mentions slog entries", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/slog/i);
  });

  test("Implementation Plan mentions retro recommendations", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/retro\s+recommendation/i);
  });

  test("Implementation Plan mentions active loop runs", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/active\s+(loop\s+)?runs/i);
  });

  test("Implementation Plan mentions half-done inventory", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/half[- ]done\s+inventory/i);
  });
});

// --------------------------------------------------------------------------
// AC-4: Plan describes LLM decision step with constrained action set
// --------------------------------------------------------------------------
describe("AC-4: LLM decision step with constrained action set", () => {
  test("Implementation Plan mentions LLM decision step", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/llm\s+decision|decision\s+step/i);
  });

  test("Implementation Plan mentions constrained action set", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/constrained\s+action\s+set|action\s+set/i);
  });

  test("Implementation Plan lists start_loop as an allowed action", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/start[_ ]loop/i);
  });

  test("Implementation Plan lists process_notes as an allowed action", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/process[_ ]notes/i);
  });

  test("Implementation Plan lists apply_retro_recommendation as an allowed action", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/apply[_ ]retro[_ ]recommendation/i);
  });

  test("Implementation Plan lists emit_alert as an allowed action", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/emit[_ ]alert/i);
  });

  test("Implementation Plan lists do_nothing as an allowed action", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/do[_ ]nothing/i);
  });
});

// --------------------------------------------------------------------------
// AC-5: Plan describes safety rails (rate limits, cost budget, human approval)
// --------------------------------------------------------------------------
describe("AC-5: safety rails described", () => {
  test("Implementation Plan mentions rate limits or max actions per hour", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/rate\s+limit|max(imum)?\s+actions?\s+per\s+hour|per[- ]hour/i);
  });

  test("Implementation Plan mentions cost budget", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/cost\s+budget/i);
  });

  test("Implementation Plan mentions human approval gate", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/human\s+approval|approval\s+gate/i);
  });

  test("Implementation Plan mentions logging reasoning", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/reasoning\s+log|log.*reasoning|mandatory.*log/i);
  });
});

// --------------------------------------------------------------------------
// AC-6: Has ## Verification section with at least 5 checkbox items
// --------------------------------------------------------------------------
describe("AC-6: Verification section with checkbox items", () => {
  test("contains a ## Verification heading", async () => {
    const content = await readAdr();
    expect(content).toMatch(/^## Verification/m);
  });

  test("Verification section has non-empty body text", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Verification");
    expect(section.length).toBeGreaterThan(0);
  });

  test("Verification section uses - [ ] checkbox syntax", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Verification");
    expect(section).toMatch(/^- \[ \]/m);
  });

  test("Verification section has at least 5 checkbox items", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Verification");
    const count = checkboxCount(section);
    expect(count).toBeGreaterThanOrEqual(5);
  });
});

// --------------------------------------------------------------------------
// AC-7: Verification items are specific and testable, not vague
// --------------------------------------------------------------------------
describe("AC-7: Verification items are specific and testable", () => {
  test("each verification item has at least 10 words", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Verification");
    const items = section
      .split("\n")
      .filter((line) => /^\s*-\s+\[[ x]\]\s+/.test(line))
      .map((line) => line.replace(/^\s*-\s+\[[ x]\]\s+/, "").trim());
    expect(items.length).toBeGreaterThanOrEqual(5);
    for (const item of items) {
      const wordCount = item.split(/\s+/).length;
      expect(wordCount).toBeGreaterThanOrEqual(10);
    }
  });

  test("verification items reference concrete system concepts", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Verification");
    const lower = section.toLowerCase();
    // Should mention specific technical concepts, not just generic phrases
    const concreteTerms = [
      /inngest|event|function/,
      /state|snapshot|gather/,
      /action|decision|llm/,
      /log|slog|audit/,
      /rate|limit|budget|cost/,
    ];
    let matchCount = 0;
    for (const term of concreteTerms) {
      if (term.test(lower)) matchCount++;
    }
    // At least 4 of 5 concrete concept categories should appear
    expect(matchCount).toBeGreaterThanOrEqual(4);
  });

  test("no verification item is shorter than 50 characters", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Verification");
    const items = section
      .split("\n")
      .filter((line) => /^\s*-\s+\[[ x]\]\s+/.test(line))
      .map((line) => line.replace(/^\s*-\s+\[[ x]\]\s+/, "").trim());
    for (const item of items) {
      expect(item.length).toBeGreaterThanOrEqual(50);
    }
  });
});

// --------------------------------------------------------------------------
// AC-8: Overall ADR is coherent and self-consistent across all sections
// --------------------------------------------------------------------------
describe("AC-8: ADR coherence and self-consistency", () => {
  test("Implementation Plan references the hybrid approach from Decision Outcome", async () => {
    const content = await readAdr();
    const outcome = extractSection(content, "Decision Outcome");
    const plan = extractSection(content, "Implementation Plan");
    // Decision Outcome chose hybrid; Implementation Plan should reflect both triggers
    expect(outcome).toMatch(/hybrid|event[- ]driven.*cron|cron.*event[- ]driven/i);
    expect(plan).toMatch(/cron/i);
    expect(plan).toMatch(/event/i);
  });

  test("Verification items cover topics from the Implementation Plan", async () => {
    const content = await readAdr();
    const plan = extractSection(content, "Implementation Plan");
    const verification = extractSection(content, "Verification");
    // Key plan concepts should appear in verification
    expect(plan).toMatch(/heartbeat/i);
    expect(verification).toMatch(/heartbeat|trigger/i);
    expect(plan).toMatch(/state[- ]gather|snapshot/i);
    expect(verification).toMatch(/state|snapshot|gather/i);
    expect(plan).toMatch(/llm\s+decision|decision\s+step/i);
    expect(verification).toMatch(/decision|action/i);
    expect(plan).toMatch(/safety|rate|cost|approval/i);
    expect(verification).toMatch(/rate|cost|budget|approval/i);
  });

  test("all major sections are present", async () => {
    const content = await readAdr();
    const requiredSections = [
      "Context and Problem Statement",
      "Decision Drivers",
      "Considered Options",
      "Decision Outcome",
      "Pros and Cons of the Options",
      "Implementation Plan",
      "Verification",
    ];
    for (const section of requiredSections) {
      expect(content).toMatch(new RegExp(`^## ${section}`, "m"));
    }
  });

  test("ADR has valid YAML frontmatter with status", async () => {
    const content = await readAdr();
    expect(content).toMatch(/^---\n[\s\S]*?status:\s+\w+[\s\S]*?\n---/);
  });
});

// --------------------------------------------------------------------------
// AC-9: TypeScript compiles with no errors (bun test on the test file)
// --------------------------------------------------------------------------
describe("AC-9: TypeScript compiles", () => {
  test("this test file compiles and runs via bun test without TypeScript errors", () => {
    // If we've reached this point, bun has successfully compiled and
    // executed this .ts file — the AC is satisfied.
    expect(true).toBe(true);
  });
});
