import { describe, expect, test } from "bun:test";

async function loadObserverPromptModule() {
  return import("../src/inngest/functions/observe-prompt.ts");
}

describe("NUUM-1: Rewrite observer system prompt for segment-aware distillation", () => {
  test("AC-1: observe-prompt.ts exports OBSERVER_SYSTEM_PROMPT as a non-empty string constant", async () => {
    const mod = await loadObserverPromptModule();

    expect("OBSERVER_SYSTEM_PROMPT" in mod).toBe(true);
    expect(typeof mod.OBSERVER_SYSTEM_PROMPT).toBe("string");
    expect(mod.OBSERVER_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  test("AC-1: prompt instructs segment identification before distillation/extraction", async () => {
    const { OBSERVER_SYSTEM_PROMPT } = await loadObserverPromptModule();
    const lines = OBSERVER_SYSTEM_PROMPT.split("\n").map((line) => line.trim());

    const identifySegmentLine = lines.find((line) => {
      const normalized = line.toLowerCase();
      return normalized.includes("identify") && normalized.includes("segment");
    });
    const distillationLine = lines.find((line) => {
      const normalized = line.toLowerCase();
      return normalized.includes("distillate") || normalized.includes("for each segment");
    });

    expect(identifySegmentLine).toBeDefined();
    expect(distillationLine).toBeDefined();
    expect(identifySegmentLine).not.toEqual(distillationLine);

    const promptParts = OBSERVER_SYSTEM_PROMPT.split(distillationLine!);
    expect(promptParts.length).toBeGreaterThan(1);
    expect(promptParts[0].toLowerCase()).toContain("segment");
    expect(promptParts[0].toLowerCase()).toContain("identify");
  });

  test("AC-2: prompt specifies operational context narrative (1-3 sentences) via <narrative> tag per segment", async () => {
    const { OBSERVER_SYSTEM_PROMPT } = await loadObserverPromptModule();
    const normalized = OBSERVER_SYSTEM_PROMPT.toLowerCase();

    expect(OBSERVER_SYSTEM_PROMPT).toContain("<narrative>");
    expect(normalized).toContain("operational context");
    expect(normalized).toContain("1-3");
    expect(normalized).toContain("sentence");
  });

  test("AC-3: prompt specifies retained facts bullet list with specifics via <facts> tag per segment", async () => {
    const { OBSERVER_SYSTEM_PROMPT } = await loadObserverPromptModule();
    const normalized = OBSERVER_SYSTEM_PROMPT.toLowerCase();

    expect(OBSERVER_SYSTEM_PROMPT).toContain("<facts>");
    expect(normalized).toContain("retained facts");
    expect(normalized).toContain("bullet");
    expect(normalized).toContain("file path");
    expect(normalized).toContain("value");
    expect(normalized).toContain("decision");
    expect(normalized).toContain("error");
    expect(normalized).toContain("fix");
    expect(normalized).toContain("user preference");
  });

  test("AC-4: prompt preserves 🔴/🟡/🟢 priority markers on individual facts", async () => {
    const { OBSERVER_SYSTEM_PROMPT } = await loadObserverPromptModule();

    expect(OBSERVER_SYSTEM_PROMPT).toContain("🔴");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("🟡");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("🟢");
    expect(OBSERVER_SYSTEM_PROMPT.toLowerCase()).toContain("individual facts");
  });

  test("AC-5: output format uses <segment> tags nested within <observations>", async () => {
    const { OBSERVER_SYSTEM_PROMPT } = await loadObserverPromptModule();
    const withinObservations = OBSERVER_SYSTEM_PROMPT.split("<observations>").slice(1).join("<observations>");

    expect(OBSERVER_SYSTEM_PROMPT).toContain("<observations>");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("<segment>");
    expect(withinObservations).toContain("<segment>");
  });

  test("AC-6: <current-task> and <suggested-response> tag instructions remain unchanged", async () => {
    const { OBSERVER_SYSTEM_PROMPT } = await loadObserverPromptModule();

    expect(OBSERVER_SYSTEM_PROMPT).toContain(
      "- <current-task> (optional): what the user is currently working on"
    );
    expect(OBSERVER_SYSTEM_PROMPT).toContain(
      "- <suggested-response> (optional): a concise greeting/context suggestion for the next session"
    );
  });
});

describe("NUUM-1: TypeScript compile gate", () => {
  test(
    "AC-7: bunx tsc --noEmit succeeds",
    async () => {
      const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: new URL("..", import.meta.url).pathname,
      });

      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    },
    30_000
  );
});
