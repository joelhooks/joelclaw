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

/** Count words in text. */
function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/** Extract checkbox item text (without the - [ ] prefix). */
function extractCheckboxItems(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /^\s*-\s+\[[ x]\]\s+/.test(line))
    .map((line) => line.replace(/^\s*-\s+\[[ x]\]\s+/, "").trim());
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

  test("Implementation Plan contains at least 3 numbered steps", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    const items = numberedItems(section);
    expect(items.length).toBeGreaterThanOrEqual(3);
  });

  test("numbered steps have substantive content (at least 3 words each)", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    const items = numberedItems(section);
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (const item of items) {
      expect(wordCount(item)).toBeGreaterThanOrEqual(3);
    }
  });
});

// --------------------------------------------------------------------------
// AC-2: Plan describes the heartbeat Inngest function
// --------------------------------------------------------------------------
describe("AC-2: heartbeat Inngest function described", () => {
  test("Implementation Plan mentions Inngest", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/inngest/i);
  });

  test("Implementation Plan mentions heartbeat function", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/heartbeat/i);
  });

  test("Implementation Plan mentions cron trigger", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/cron/i);
  });

  test("Implementation Plan mentions terminal or workflow event triggers", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/terminal|event[- ]trigger|workflow\s+event|loop\.complete|triggered?\s+by.*event/i);
  });

  test("heartbeat function name follows system/ namespace convention", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/system\/heartbeat|system[./]heartbeat/i);
  });
});

// --------------------------------------------------------------------------
// AC-3: Plan describes state gathering (note queue, slog, retros, active runs)
// --------------------------------------------------------------------------
describe("AC-3: state gathering step described", () => {
  test("Implementation Plan mentions state gathering or state snapshot", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/state[- ]gather|state\s+snapshot|gather.*state|reads?\s+.*state/i);
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

  test("state gathering covers at least 4 of the 5 expected data sources", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan").toLowerCase();
    const sources = [
      /note\s+queue/,
      /slog/,
      /retro/,
      /active\s+(loop\s+)?runs/,
      /half[- ]done/,
    ];
    let matchCount = 0;
    for (const src of sources) {
      if (src.test(section)) matchCount++;
    }
    expect(matchCount).toBeGreaterThanOrEqual(4);
  });
});

// --------------------------------------------------------------------------
// AC-4: Plan describes LLM decision step with constrained action set
// --------------------------------------------------------------------------
describe("AC-4: LLM decision step with constrained action set", () => {
  test("Implementation Plan mentions LLM decision step", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/llm\s+decision|decision\s+step|llm.*evaluat/i);
  });

  test("Implementation Plan mentions constrained action set", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/constrained\s+action\s+set|action\s+set|constrained.*actions/i);
  });

  test("lists start_loop action", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/start[_ ]loop/i);
  });

  test("lists process_notes action", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/process[_ ]notes/i);
  });

  test("lists apply_retro_recommendation action", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/apply[_ ]retro[_ ]recommendation/i);
  });

  test("lists emit_alert action", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/emit[_ ]alert/i);
  });

  test("lists do_nothing action", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/do[_ ]nothing/i);
  });

  test("all 5 actions from the constrained set are present", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan").toLowerCase();
    const actions = [
      /start[_ ]loop/,
      /process[_ ]notes/,
      /apply[_ ]retro[_ ]recommendation/,
      /emit[_ ]alert/,
      /do[_ ]nothing/,
    ];
    for (const action of actions) {
      expect(action.test(section)).toBe(true);
    }
  });

  test("describes action execution emitting Inngest events", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/emit.*event|inngest\s+event|event\s+emit/i);
  });
});

// --------------------------------------------------------------------------
// AC-5: Plan describes safety rails (rate limits, cost budget, human approval)
// --------------------------------------------------------------------------
describe("AC-5: safety rails described", () => {
  test("Implementation Plan mentions safety rails or guardrails", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/safety\s+rail|guardrail|safety/i);
  });

  test("mentions rate limits or max actions per hour", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/rate\s+limit|max(imum)?\s+actions?\s+per\s+hour|per[- ]hour\s+cap/i);
  });

  test("mentions cost budget", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/cost\s+budget/i);
  });

  test("mentions human approval gate", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/human[- ]approval|approval\s+gate/i);
  });

  test("mentions destructive actions requiring approval", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/destructive/i);
  });

  test("mentions always-log reasoning or mandatory logging", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan");
    expect(section).toMatch(/always[- ]log|log.*reasoning|reasoning.*log|mandatory.*log/i);
  });

  test("safety rails section covers all 4 rail types", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Implementation Plan").toLowerCase();
    const rails = [
      /rate|per[- ]hour|max.*action/,
      /cost\s+budget/,
      /human.*approval|approval.*gate/,
      /log.*reason|reason.*log|always.*log/,
    ];
    let matchCount = 0;
    for (const rail of rails) {
      if (rail.test(section)) matchCount++;
    }
    expect(matchCount).toBe(4);
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
    const items = extractCheckboxItems(section);
    expect(items.length).toBeGreaterThanOrEqual(5);
    for (const item of items) {
      expect(wordCount(item)).toBeGreaterThanOrEqual(10);
    }
  });

  test("no verification item is shorter than 50 characters", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Verification");
    const items = extractCheckboxItems(section);
    for (const item of items) {
      expect(item.length).toBeGreaterThanOrEqual(50);
    }
  });

  test("verification items reference concrete system concepts", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Verification");
    const lower = section.toLowerCase();
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
    expect(matchCount).toBeGreaterThanOrEqual(4);
  });

  test("verification items do not use vague language exclusively", async () => {
    const content = await readAdr();
    const section = extractSection(content, "Verification");
    const items = extractCheckboxItems(section);
    const technicalTerms = /inngest|cron|heartbeat|slog|llm|action|event|function|rate|cost|budget|log|queue|state|snapshot/i;
    for (const item of items) {
      expect(technicalTerms.test(item)).toBe(true);
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
    expect(verification).toMatch(/heartbeat|trigger|cron/i);
    expect(plan).toMatch(/state/i);
    expect(verification).toMatch(/state|snapshot|gather/i);
    expect(plan).toMatch(/decision|action/i);
    expect(verification).toMatch(/decision|action/i);
    expect(plan).toMatch(/safety|rate|cost|approval/i);
    expect(verification).toMatch(/rate|cost|budget|approval|safety/i);
  });

  test("all major sections are present for a complete ADR", async () => {
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

  test("ADR has valid YAML frontmatter with status field", async () => {
    const content = await readAdr();
    expect(content).toMatch(/^---\n[\s\S]*?status:\s+\w+[\s\S]*?\n---/);
  });

  test("Implementation Plan action set aligns with Decision Outcome's LLM gateway concept", async () => {
    const content = await readAdr();
    const outcome = extractSection(content, "Decision Outcome");
    const plan = extractSection(content, "Implementation Plan");
    expect(outcome).toMatch(/gateway|loop|orchestrat/i);
    expect(plan).toMatch(/action/i);
    expect(plan).toMatch(/llm|decision/i);
  });

  test("Decision Drivers themes are addressed by Implementation Plan", async () => {
    const content = await readAdr();
    const drivers = extractSection(content, "Decision Drivers").toLowerCase();
    const plan = extractSection(content, "Implementation Plan").toLowerCase();
    // Safety driver → safety rails in plan
    if (drivers.includes("safety")) {
      expect(plan).toMatch(/safety|guardrail|rail/);
    }
    // Cost driver → cost budget in plan
    if (drivers.includes("cost")) {
      expect(plan).toMatch(/cost/);
    }
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
