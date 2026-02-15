import { describe, expect, test } from "bun:test";

async function loadObserverPromptModule() {
  return import("../src/inngest/functions/observe-prompt.ts");
}

describe("MEM-2: Create observer system prompt constant", () => {
  test("AC-1: observe-prompt.ts exports OBSERVER_SYSTEM_PROMPT as a string constant", async () => {
    const mod = await loadObserverPromptModule();

    expect("OBSERVER_SYSTEM_PROMPT" in mod).toBe(true);
    expect(typeof mod.OBSERVER_SYSTEM_PROMPT).toBe("string");
    expect(mod.OBSERVER_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  test("AC-2: prompt includes 🔴 high, 🟡 medium, and 🟢 low priority marker instructions", async () => {
    const { OBSERVER_SYSTEM_PROMPT } = await loadObserverPromptModule();

    expect(OBSERVER_SYSTEM_PROMPT.includes("🔴")).toBe(true);
    expect(OBSERVER_SYSTEM_PROMPT.includes("🟡")).toBe(true);
    expect(OBSERVER_SYSTEM_PROMPT.includes("🟢")).toBe(true);
    expect(OBSERVER_SYSTEM_PROMPT.toLowerCase().includes("high")).toBe(true);
    expect(OBSERVER_SYSTEM_PROMPT.toLowerCase().includes("medium")).toBe(true);
    expect(OBSERVER_SYSTEM_PROMPT.toLowerCase().includes("low")).toBe(true);
  });

  test("AC-3: prompt specifies XML output tags <observations>, <current-task>, and <suggested-response>", async () => {
    const { OBSERVER_SYSTEM_PROMPT } = await loadObserverPromptModule();

    expect(OBSERVER_SYSTEM_PROMPT.includes("<observations>")).toBe(true);
    expect(OBSERVER_SYSTEM_PROMPT.includes("<current-task>")).toBe(true);
    expect(OBSERVER_SYSTEM_PROMPT.includes("<suggested-response>")).toBe(true);
  });

  test("AC-4: prompt includes temporal anchoring instruction 'Date: YYYY-MM-DD'", async () => {
    const { OBSERVER_SYSTEM_PROMPT } = await loadObserverPromptModule();

    expect(OBSERVER_SYSTEM_PROMPT.includes("Date: YYYY-MM-DD")).toBe(true);
  });
});

describe("MEM-2: TypeScript compile gate", () => {
  test(
    "AC-5: bunx tsc --noEmit succeeds",
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
