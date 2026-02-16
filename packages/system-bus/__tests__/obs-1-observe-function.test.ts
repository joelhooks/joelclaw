import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

type BunDollarCall = {
  strings: string[];
  values: unknown[];
  command: string;
};

const originalBunDollar = Bun.$;
let bunDollarCalls: BunDollarCall[] = [];

function buildCommandString(strings: string[], values: unknown[]): string {
  let command = "";
  for (let i = 0; i < strings.length; i++) {
    command += strings[i] ?? "";
    if (i < values.length) command += String(values[i]);
  }
  return command;
}

function installBunDollarMock() {
  // @ts-expect-error monkey-patching Bun.$ for test isolation
  Bun.$ = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const call = {
      strings: Array.from(strings),
      values,
      command: buildCommandString(Array.from(strings), values),
    };
    bunDollarCalls.push(call);

    const shellResult = {
      stdout: "<observations></observations>",
      stderr: "",
      exitCode: 0,
    };

    const promise = Promise.resolve(shellResult);
    const shellPromise: Promise<typeof shellResult> & {
      quiet: () => typeof shellPromise;
      nothrow: () => typeof shellPromise;
    } = {
      then: promise.then.bind(promise),
      catch: promise.catch.bind(promise),
      finally: promise.finally.bind(promise),
      quiet: () => shellPromise,
      nothrow: () => shellPromise,
      [Symbol.toStringTag]: "ShellPromise",
    } as Promise<typeof shellResult> & {
      quiet: () => typeof shellPromise;
      nothrow: () => typeof shellPromise;
    };

    return shellPromise;
  };
}

function restoreBunDollar() {
  Bun.$ = originalBunDollar;
}

function commandOrValuesContainText(call: BunDollarCall, text: string): boolean {
  if (call.command.includes(text)) return true;
  return call.values.some(
    (value) => typeof value === "string" && value.includes(text)
  );
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

beforeEach(() => {
  bunDollarCalls = [];
  installBunDollarMock();
});

afterEach(() => {
  restoreBunDollar();
});

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
    const firstCall = bunDollarCalls[0];
    expect(firstCall).toBeDefined();
    expect(commandOrValuesContainText(firstCall!, OBSERVER_SYSTEM_PROMPT)).toBe(true);
    expect(commandOrValuesContainText(firstCall!, expectedCompactionUserPrompt)).toBe(true);
    expect(typeof compactionStepOutputs.get("call-observer-llm")).toBe("string");

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
    const secondCall = bunDollarCalls[1];
    expect(secondCall).toBeDefined();
    expect(commandOrValuesContainText(secondCall!, OBSERVER_SYSTEM_PROMPT)).toBe(true);
    expect(commandOrValuesContainText(secondCall!, expectedEndedUserPrompt)).toBe(true);
    expect(typeof endedStepOutputs.get("call-observer-llm")).toBe("string");
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
