import { describe, expect, test } from "bun:test";
import type { Events } from "../src/inngest/client.ts";

type ObserveTrigger = "memory/session.compaction.pending" | "memory/session.ended";
type EventData<TName extends keyof Events> = Events[TName] extends { data: infer TData }
  ? TData
  : never;

function observeFilePath(): string {
  return new URL("../src/inngest/functions/observe.ts", import.meta.url).pathname;
}

async function loadObserveModule() {
  return import("../src/inngest/functions/observe.ts");
}

async function loadObservePromptModule() {
  return import("../src/inngest/functions/observe-prompt.ts");
}

function makeCompactionEventData(): EventData<"memory/session.compaction.pending"> {
  return {
    sessionId: "session-obs-1-compaction",
    dedupeKey: "obs-1-dedupe-compaction",
    trigger: "compaction",
    messages: "user: summarize what happened\nassistant: capturing observations",
    messageCount: 2,
    tokensBefore: 2048,
    filesRead: ["src/inngest/functions/observe.ts"],
    filesModified: ["src/inngest/functions/observe.ts"],
    capturedAt: "2026-02-16T00:00:00.000Z",
    schemaVersion: 1,
  };
}

function makeEndedEventData(): EventData<"memory/session.ended"> {
  return {
    sessionId: "session-obs-1-ended",
    dedupeKey: "obs-1-dedupe-ended",
    trigger: "shutdown",
    messages: "user: wrap up\nassistant: done",
    messageCount: 2,
    userMessageCount: 1,
    duration: 180,
    sessionName: "OBS-1 acceptance session",
    filesRead: ["src/inngest/functions/observe-prompt.ts"],
    filesModified: ["src/inngest/functions/observe.ts"],
    capturedAt: "2026-02-16T00:00:00.000Z",
    schemaVersion: 1,
  };
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function executeObserveHandler(trigger: ObserveTrigger, data: EventData<ObserveTrigger>) {
  const mod = await loadObserveModule();
  const fn = mod.observeSessionFunction as any;
  const handler = fn?.fn;

  expect(fn).toMatchObject({
    opts: {
      id: "memory/observe-session",
      name: "Observe Session",
    },
  });
  expect(typeof handler).toBe("function");

  const stepIds: string[] = [];
  const stepOutputs = new Map<string, unknown>();

  const step = {
    run: async (id: string, cb: () => unknown | Promise<unknown>) => {
      stepIds.push(id);
      const output = await cb();
      stepOutputs.set(id, output);
      return output;
    },
  };

  const result = await handler({
    event: { name: trigger, data },
    step,
  });

  return { result, stepIds, stepOutputs };
}

describe("OBS-1: observe.ts scaffold contract", () => {
  test("AC-1: src/inngest/functions/observe.ts exists", async () => {
    const exists = await Bun.file(observeFilePath()).exists();
    expect(exists).toBe(true);
  });

  test("AC-2 and AC-3: exports observeSessionFunction via createFunction with expected id/name and both triggers", async () => {
    const mod = await loadObserveModule();

    expect(mod).toMatchObject({
      observeSessionFunction: expect.any(Object),
    });

    const fn = mod.observeSessionFunction as any;
    const triggers = (fn.opts?.triggers ?? []) as Array<{ event?: string }>;
    const eventNames = triggers
      .map((triggerEntry) => triggerEntry.event)
      .filter((eventName): eventName is string => Boolean(eventName));

    expect(fn).toMatchObject({
      opts: {
        id: "memory/observe-session",
        name: "Observe Session",
      },
    });

    expect(eventNames).toEqual(
      expect.arrayContaining([
        "memory/session.compaction.pending",
        "memory/session.ended",
      ])
    );
  });

  test("AC-4 and AC-5: runtime behavior uses observer prompts and runs all 6 required step placeholders", async () => {
    const { OBSERVER_SYSTEM_PROMPT, OBSERVER_USER_PROMPT } = await loadObservePromptModule();

    const compactionData = makeCompactionEventData();
    const { stepIds: compactionStepIds, stepOutputs: compactionStepOutputs } =
      await executeObserveHandler("memory/session.compaction.pending", compactionData);

    expect(compactionStepIds).toEqual(
      expect.arrayContaining([
        "validate-input",
        "call-observer-llm",
        "parse-observations",
        "store-to-qdrant",
        "update-redis-state",
        "emit-accumulated",
      ])
    );

    const expectedCompactionUserPrompt = OBSERVER_USER_PROMPT(
      compactionData.messages,
      compactionData.trigger
    );
    const compactionLlmOutput = asText(compactionStepOutputs.get("call-observer-llm"));

    expect(compactionLlmOutput).toContain(OBSERVER_SYSTEM_PROMPT);
    expect(compactionLlmOutput).toContain(expectedCompactionUserPrompt);

    const endedData = makeEndedEventData();
    const { stepIds: endedStepIds, stepOutputs: endedStepOutputs } =
      await executeObserveHandler("memory/session.ended", endedData);

    expect(endedStepIds).toEqual(
      expect.arrayContaining([
        "validate-input",
        "call-observer-llm",
        "parse-observations",
        "store-to-qdrant",
        "update-redis-state",
        "emit-accumulated",
      ])
    );

    const expectedEndedUserPrompt = OBSERVER_USER_PROMPT(
      endedData.messages,
      endedData.trigger,
      endedData.sessionName
    );
    const endedLlmOutput = asText(endedStepOutputs.get("call-observer-llm"));

    expect(endedLlmOutput).toContain(OBSERVER_SYSTEM_PROMPT);
    expect(endedLlmOutput).toContain(expectedEndedUserPrompt);
  });
});

describe("OBS-1: TypeScript compile gate", () => {
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
