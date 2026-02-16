import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Events } from "../src/inngest/client.ts";
import { parseObserverOutput } from "../src/inngest/functions/observe-parser.ts";

type ObserveTrigger = "memory/session.compaction.pending" | "memory/session.ended";
type EventData<TName extends keyof Events> = Events[TName] extends { data: infer TData }
  ? TData
  : never;

type MockShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const originalBunDollar = Bun.$;

let mockShellResult: MockShellResult = {
  stdout: "<observations></observations>",
  stderr: "",
  exitCode: 0,
};
let mockShellError: Error | null = null;

function makeCompactionEventData(): EventData<"memory/session.compaction.pending"> {
  return {
    sessionId: "session-obs-3-compaction",
    dedupeKey: "obs-3-dedupe-compaction",
    trigger: "compaction",
    messages: "user: summarize observations\nassistant: capturing distilled output",
    messageCount: 2,
    tokensBefore: 1024,
    filesRead: ["src/inngest/functions/observe.ts"],
    filesModified: ["src/inngest/functions/observe.ts"],
    capturedAt: "2026-02-16T00:00:00.000Z",
    schemaVersion: 1,
  };
}

function installBunDollarMock() {
  // @ts-expect-error monkey-patching Bun.$ in tests
  Bun.$ = () => {
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

beforeEach(() => {
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

describe("OBS-3: parse-observations acceptance", () => {
  test("AC-1 and AC-2: parse-observations uses parser output derived from call-observer-llm output", async () => {
    const llmOutput = `
<observations>
  <segment>
    <narrative>Implemented retry strategy for Redis operations</narrative>
    <facts>
      - 🔴 Added exponential backoff to reconnect logic
      - 🟡 Needs load test coverage before release
    </facts>
  </segment>
</observations>
`;

    mockShellResult = {
      stdout: llmOutput,
      stderr: "",
      exitCode: 0,
    };

    const { stepOutputs } = await executeObserveHandler(
      "memory/session.compaction.pending",
      makeCompactionEventData()
    );

    const parsedObservations = stepOutputs.get("parse-observations");
    const expectedParsed = parseObserverOutput(llmOutput);

    expect(parsedObservations).toMatchObject(expectedParsed);
  });

  test("AC-3: returns structured observation data including segments, concepts, and facts", async () => {
    const llmOutput = `
<observations>
  <segment>
    <narrative>Stabilized worker queue processing</narrative>
    <facts>
      - 🔴 Queue drain resumed after restart
      - 🟢 Throughput returned to baseline
    </facts>
  </segment>
  <segment>
    <narrative>Improved deploy confidence</narrative>
    <facts>
      - 🔴 Added rollback runbook for failed migrations
    </facts>
  </segment>
</observations>
`;

    mockShellResult = {
      stdout: llmOutput,
      stderr: "",
      exitCode: 0,
    };

    const { stepOutputs } = await executeObserveHandler(
      "memory/session.compaction.pending",
      makeCompactionEventData()
    );

    const parsedObservations = stepOutputs.get("parse-observations");

    expect(parsedObservations).toMatchObject({
      segments: [
        {
          narrative: "Stabilized worker queue processing",
          facts: expect.arrayContaining([
            "🔴 Queue drain resumed after restart",
            "🟢 Throughput returned to baseline",
          ]),
        },
        {
          narrative: "Improved deploy confidence",
          facts: expect.arrayContaining(["🔴 Added rollback runbook for failed migrations"]),
        },
      ],
      concepts: expect.any(Array),
      facts: expect.any(Array),
    });
  });

  test("AC-4: malformed LLM output is handled gracefully without failing the function", async () => {
    mockShellResult = {
      stdout: "<observations><segment><narrative>broken",
      stderr: "",
      exitCode: 0,
    };

    const { result, stepOutputs } = await executeObserveHandler(
      "memory/session.compaction.pending",
      makeCompactionEventData()
    );

    const parsedObservations = stepOutputs.get("parse-observations");

    expect(result).toMatchObject({
      sessionId: "session-obs-3-compaction",
    });
    expect(parsedObservations).toMatchObject({
      segments: expect.any(Array),
      concepts: expect.any(Array),
      facts: expect.any(Array),
    });
  });
});

describe("OBS-3: TypeScript compile gate", () => {
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
