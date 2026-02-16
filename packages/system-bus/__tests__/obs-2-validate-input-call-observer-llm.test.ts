import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Events } from "../src/inngest/client.ts";
import {
  OBSERVER_SYSTEM_PROMPT,
  OBSERVER_USER_PROMPT,
} from "../src/inngest/functions/observe-prompt.ts";

type ObserveTrigger = "memory/session.compaction.pending" | "memory/session.ended";
type EventData<TName extends keyof Events> = Events[TName] extends { data: infer TData }
  ? TData
  : never;

type BunDollarCall = {
  strings: string[];
  values: unknown[];
  command: string;
};

type MockShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const originalBunDollar = Bun.$;

let bunDollarCalls: BunDollarCall[] = [];
let mockShellResult: MockShellResult = {
  stdout: "<observations></observations>",
  stderr: "",
  exitCode: 0,
};
let mockShellError: Error | null = null;

function makeCompactionEventData(): EventData<"memory/session.compaction.pending"> {
  return {
    sessionId: "session-obs-2-compaction",
    dedupeKey: "obs-2-dedupe-compaction",
    trigger: "compaction",
    messages: "user: investigate flaky test\nassistant: reproducing and fixing",
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
    sessionId: "session-obs-2-ended",
    dedupeKey: "obs-2-dedupe-ended",
    trigger: "shutdown",
    messages: "user: summarize results\nassistant: summary ready",
    messageCount: 2,
    userMessageCount: 1,
    duration: 180,
    sessionName: "OBS-2 acceptance session",
    filesRead: ["src/inngest/functions/observe.ts"],
    filesModified: ["src/inngest/functions/observe.ts"],
    capturedAt: "2026-02-16T00:00:00.000Z",
    schemaVersion: 1,
  };
}

function buildCommandString(strings: string[], values: unknown[]): string {
  let command = "";
  for (let i = 0; i < strings.length; i++) {
    command += strings[i] ?? "";
    if (i < values.length) {
      command += String(values[i]);
    }
  }
  return command;
}

function installBunDollarMock() {
  // @ts-expect-error monkey-patching Bun.$ in tests
  Bun.$ = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const call = {
      strings: Array.from(strings),
      values,
      command: buildCommandString(Array.from(strings), values),
    };
    bunDollarCalls.push(call);

    const promise = mockShellError
      ? Promise.reject(mockShellError)
      : Promise.resolve({ ...mockShellResult });

    const shellPromise: Promise<MockShellResult> & {
      quiet: () => typeof shellPromise;
      nothrow: () => typeof shellPromise;
      text: () => Promise<string>;
    } = {
      then: promise.then.bind(promise),
      catch: promise.catch.bind(promise),
      finally: promise.finally.bind(promise),
      quiet: () => shellPromise,
      nothrow: () => shellPromise,
      text: async () => mockShellResult.stdout,
      [Symbol.toStringTag]: "ShellPromise",
    } as Promise<MockShellResult> & {
      quiet: () => typeof shellPromise;
      nothrow: () => typeof shellPromise;
      text: () => Promise<string>;
    };

    return shellPromise;
  };
}

function restoreBunDollar() {
  Bun.$ = originalBunDollar;
}

async function loadObserveModule() {
  return import("../src/inngest/functions/observe.ts");
}

async function executeObserveHandler(trigger: ObserveTrigger, data: EventData<ObserveTrigger>) {
  const mod = await loadObserveModule();
  const fn = mod.observeSessionFunction as any;
  const handler = fn?.fn;

  expect(typeof handler).toBe("function");

  const stepOutputs = new Map<string, unknown>();
  const step = {
    run: async (id: string, cb: () => unknown | Promise<unknown>) => {
      const output = await cb();
      stepOutputs.set(id, output);
      return output;
    },
  };

  const result = await handler({
    event: { name: trigger, data },
    step,
  });

  return { result, stepOutputs };
}

function commandOrValuesContainText(call: BunDollarCall, text: string): boolean {
  if (call.command.includes(text)) return true;
  return call.values.some(
    (value) => typeof value === "string" && value.includes(text)
  );
}

beforeEach(() => {
  bunDollarCalls = [];
  mockShellResult = {
    stdout: "<observations></observations>",
    stderr: "",
    exitCode: 0,
  };
  mockShellError = null;
  installBunDollarMock();
});

afterEach(() => {
  restoreBunDollar();
});

describe("OBS-2: validate-input and call-observer-llm acceptance", () => {
  test("AC-1: validate-input throws when required session fields are missing", async () => {
    const missingFields: Array<keyof EventData<"memory/session.compaction.pending">> = [
      "sessionId",
      "dedupeKey",
      "trigger",
      "messages",
    ];

    for (const field of missingFields) {
      const invalidData = { ...makeCompactionEventData() } as Record<string, unknown>;
      delete invalidData[field];

      await expect(
        executeObserveHandler(
          "memory/session.compaction.pending",
          invalidData as EventData<"memory/session.compaction.pending">
        )
      ).rejects.toThrow();
    }
  });

  test("AC-2 and AC-3: call-observer-llm spawns pi via Bun.$ and passes prompt + session context", async () => {
    const endedData = makeEndedEventData();
    await executeObserveHandler("memory/session.ended", endedData);

    expect(bunDollarCalls.length).toBeGreaterThan(0);
    const firstCall = bunDollarCalls[0]!;

    expect(firstCall.command.toLowerCase()).toContain("pi");

    const expectedUserPrompt = OBSERVER_USER_PROMPT(
      endedData.messages,
      endedData.trigger,
      endedData.sessionName
    );

    expect(commandOrValuesContainText(firstCall, OBSERVER_SYSTEM_PROMPT)).toBe(true);
    expect(commandOrValuesContainText(firstCall, expectedUserPrompt)).toBe(true);
  });

  test("AC-4: call-observer-llm captures and returns subprocess output as a string", async () => {
    const expectedOutput = "<observations><segment><narrative>ok</narrative></segment></observations>";
    mockShellResult = {
      stdout: expectedOutput,
      stderr: "",
      exitCode: 0,
    };

    const { result, stepOutputs } = await executeObserveHandler(
      "memory/session.compaction.pending",
      makeCompactionEventData()
    );

    expect(typeof stepOutputs.get("call-observer-llm")).toBe("string");
    expect(stepOutputs.get("call-observer-llm")).toBe(expectedOutput);
    expect(result).toMatchObject({
      sessionId: "session-obs-2-compaction",
    });
  });

  test("AC-5: subprocess failures are handled and surfaced as errors", async () => {
    mockShellResult = {
      stdout: "",
      stderr: "pi failed",
      exitCode: 1,
    };

    await expect(
      executeObserveHandler("memory/session.compaction.pending", makeCompactionEventData())
    ).rejects.toThrow();
  });
});

describe("OBS-2: TypeScript compile gate", () => {
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
