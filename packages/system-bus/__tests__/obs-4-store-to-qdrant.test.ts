import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Events } from "../src/inngest/client.ts";

type ObserveTrigger = "memory/session.compaction.pending" | "memory/session.ended";
type EventData<TName extends keyof Events> = Events[TName] extends { data: infer TData }
  ? TData
  : never;

type MockShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type FetchCall = {
  url: string;
  init?: RequestInit;
};

const originalBunDollar = Bun.$;
const originalFetch = globalThis.fetch;

let mockShellResult: MockShellResult = {
  stdout: "<observations></observations>",
  stderr: "",
  exitCode: 0,
};
let mockShellError: Error | null = null;

let fetchCalls: FetchCall[] = [];
let fetchMode: "ok" | "reject" | "error-response" = "ok";

function makeCompactionEventData(): EventData<"memory/session.compaction.pending"> {
  return {
    sessionId: "session-obs-4-compaction",
    dedupeKey: "obs-4-dedupe-compaction",
    trigger: "compaction",
    messages: "user: capture this session\nassistant: extracting observations for memory",
    messageCount: 2,
    tokensBefore: 1536,
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

function installFetchMock() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    fetchCalls.push({ url, init });

    if (fetchMode === "reject") {
      throw new Error("Qdrant connection failed");
    }

    if (fetchMode === "error-response") {
      return new Response(
        JSON.stringify({
          status: "error",
          result: null,
        }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        }
      );
    }

    return new Response(
      JSON.stringify({
        status: "ok",
        result: { operation_id: 1, status: "acknowledged" },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

async function loadObserveModule() {
  const cacheBuster = Date.now().toString(36) + Math.random().toString(36).slice(2);
  return import(`../src/inngest/functions/observe.ts?obs4=${cacheBuster}`);
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

function extractPointsFromQdrantCall(call: FetchCall): Array<Record<string, unknown>> {
  if (!call.init?.body || typeof call.init.body !== "string") {
    return [];
  }

  const parsed = JSON.parse(call.init.body) as Record<string, unknown>;
  const points = parsed.points;
  if (!Array.isArray(points)) {
    return [];
  }

  return points.filter((point): point is Record<string, unknown> => !!point && typeof point === "object");
}

function extractVector(point: Record<string, unknown>): number[] {
  const rawVector = point.vector;
  if (Array.isArray(rawVector)) {
    return rawVector.filter((n): n is number => typeof n === "number");
  }

  if (rawVector && typeof rawVector === "object") {
    const firstEntry = Object.values(rawVector).find((value) => Array.isArray(value));
    if (Array.isArray(firstEntry)) {
      return firstEntry.filter((n): n is number => typeof n === "number");
    }
  }

  return [];
}

beforeEach(() => {
  mockShellResult = {
    stdout: `
<observations>
  <segment>
    <narrative>Stabilized event processing</narrative>
    <facts>
      - 🔴 Added retry handling for transient failures
      - 🟢 Reduced flakiness in queue drain
    </facts>
  </segment>
</observations>
`,
    stderr: "",
    exitCode: 0,
  };
  mockShellError = null;
  fetchCalls = [];
  fetchMode = "ok";
  installBunDollarMock();
  installFetchMock();
});

afterEach(() => {
  restoreBunDollar();
  restoreFetch();
});

describe("OBS-4: store-to-qdrant acceptance", () => {
  test("AC-1, AC-2 and AC-3: stores observations via Qdrant API on localhost:6333 in memory_observations collection", async () => {
    const { stepOutputs } = await executeObserveHandler(
      "memory/session.compaction.pending",
      makeCompactionEventData()
    );

    const qdrantCalls = fetchCalls.filter((call) => call.url.includes("memory_observations"));
    expect(qdrantCalls.length).toBeGreaterThan(0);

    const hasLocalhostCall = fetchCalls.some(
      (call) =>
        call.url.includes("localhost:6333") ||
        call.url.includes("127.0.0.1:6333") ||
        call.url.includes("[::1]:6333")
    );
    expect(hasLocalhostCall).toBe(true);

    expect(stepOutputs.get("store-to-qdrant")).toMatchObject({
      sourceSessionId: "session-obs-4-compaction",
    });
  });

  test("AC-4 and AC-5: upsert payload uses 768-dimension zero-vector placeholder and required metadata", async () => {
    await executeObserveHandler("memory/session.compaction.pending", makeCompactionEventData());

    const writeCall = fetchCalls.find((call) =>
      call.url.includes("/collections/memory_observations/points")
    );
    expect(writeCall).toBeDefined();

    const points = extractPointsFromQdrantCall(writeCall!);
    expect(points.length).toBeGreaterThan(0);

    for (const point of points) {
      const vector = extractVector(point);
      expect(vector.length).toBe(768);
      expect(vector.every((value) => value === 0)).toBe(true);

      const payload = point.payload as Record<string, unknown> | undefined;
      expect(payload).toMatchObject({
        session_id: "session-obs-4-compaction",
        timestamp: expect.any(String),
      });

      const observationType = payload?.observation_type ?? payload?.type;
      expect(typeof observationType).toBe("string");
      expect(String(observationType).trim().length).toBeGreaterThan(0);
    }
  });

  test("AC-6: connection failures are handled without crashing the function", async () => {
    fetchMode = "reject";

    const { result, stepOutputs } = await executeObserveHandler(
      "memory/session.compaction.pending",
      makeCompactionEventData()
    );

    expect(result).toMatchObject({
      sessionId: "session-obs-4-compaction",
    });

    expect(stepOutputs.get("store-to-qdrant")).toMatchObject({
      stored: false,
    });
  });

  test("AC-6: storage failures are handled without crashing the function", async () => {
    fetchMode = "error-response";

    const { result, stepOutputs } = await executeObserveHandler(
      "memory/session.compaction.pending",
      makeCompactionEventData()
    );

    expect(result).toMatchObject({
      sessionId: "session-obs-4-compaction",
    });

    expect(stepOutputs.get("store-to-qdrant")).toMatchObject({
      stored: false,
    });
  });
});

describe("OBS-4: TypeScript compile gate", () => {
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
