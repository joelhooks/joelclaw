import { describe, expect, test } from "bun:test";

async function loadObserverPromptModule() {
  return import("../src/inngest/functions/observe-prompt.ts");
}

describe("MEM-3: Create observer user prompt function", () => {
  test("AC-1 and AC-2: observe-prompt.ts exports OBSERVER_USER_PROMPT function with expected callable signature", async () => {
    const mod = await loadObserverPromptModule();

    expect("OBSERVER_USER_PROMPT" in mod).toBe(true);
    expect(typeof mod.OBSERVER_USER_PROMPT).toBe("function");

    const promptBuilder: (messages: string, trigger: string, sessionName?: string) => string =
      mod.OBSERVER_USER_PROMPT;

    const output = promptBuilder("user: hi", "compaction");
    expect(typeof output).toBe("string");
  });

  test("AC-3: returned prompt includes the trigger value", async () => {
    const { OBSERVER_USER_PROMPT } = await loadObserverPromptModule();

    const trigger = "shutdown";
    const output = OBSERVER_USER_PROMPT("assistant: done", trigger);

    expect(output.includes(trigger)).toBe(true);
  });

  test("AC-4: returned prompt includes sessionName when provided", async () => {
    const { OBSERVER_USER_PROMPT } = await loadObserverPromptModule();

    const sessionName = "Post-deploy verification";
    const output = OBSERVER_USER_PROMPT("user: check logs", "compaction", sessionName);

    expect(output.includes(sessionName)).toBe(true);
  });

  test("AC-5: returned prompt embeds the messages transcript content", async () => {
    const { OBSERVER_USER_PROMPT } = await loadObserverPromptModule();

    const messages = `user: find the issue
assistant: looking now
user: thanks`;
    const output = OBSERVER_USER_PROMPT(messages, "compaction");

    expect(output.includes(messages)).toBe(true);
  });
});

describe("MEM-3: TypeScript compile gate", () => {
  test(
    "AC-6: bunx tsc --noEmit succeeds",
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
