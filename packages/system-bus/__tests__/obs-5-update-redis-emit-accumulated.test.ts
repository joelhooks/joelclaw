import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import type { Events } from "../src/inngest/client.ts";
import { inngest } from "../src/inngest/client.ts";

type ObserveTrigger = "memory/session.compaction.pending" | "memory/session.ended";
type EventData<TName extends keyof Events> = Events[TName] extends { data: infer TData }
  ? TData
  : never;

type MockShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type RedisWrite = {
  method: "set" | "hset";
  key: string;
  value?: string;
  args: unknown[];
};

type EmittedEvent = {
  name: string;
  data: Record<string, unknown>;
};

type EmitMode = "ok" | "throw";
type RedisMode = "ok" | "throw";

type InngestSend = typeof inngest.send;

const originalBunDollar = Bun.$;
const originalFetch = globalThis.fetch;
const originalInngestSend = inngest.send as InngestSend;

const originalRedisMethods = {
  set: Redis.prototype.set,
  hset: Redis.prototype.hset,
};

let mockShellResult: MockShellResult = {
  stdout: "<observations></observations>",
  stderr: "",
  exitCode: 0,
};

let redisMode: RedisMode = "ok";
let emitMode: EmitMode = "ok";

let redisWrites: RedisWrite[] = [];
let emittedEvents: EmittedEvent[] = [];

function makeCompactionEventData(): EventData<"memory/session.compaction.pending"> {
  return {
    sessionId: "session-obs-5-compaction",
    dedupeKey: "obs-5-dedupe-compaction",
    trigger: "compaction",
    messages: "user: summarize what to keep\nassistant: distilled reusable observations",
    messageCount: 2,
    tokensBefore: 1900,
    filesRead: ["src/inngest/functions/observe.ts"],
    filesModified: ["src/inngest/functions/observe.ts"],
    capturedAt: "2026-02-16T14:20:00.000Z",
    schemaVersion: 1,
  };
}

function installBunDollarMock() {
  // @ts-expect-error monkey-patching Bun.$ in tests
  Bun.$ = () => {
    const promise = Promise.resolve({ ...mockShellResult });

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
  globalThis.fetch = (async () => {
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

function normalizeAndCaptureEvents(payload: unknown) {
  const inputs = Array.isArray(payload) ? payload : [payload];

  for (const entry of inputs) {
    if (!entry || typeof entry !== "object") continue;

    const event = entry as { name?: unknown; data?: unknown };
    if (typeof event.name !== "string") continue;

    const data =
      event.data && typeof event.data === "object"
        ? (event.data as Record<string, unknown>)
        : {};

    emittedEvents.push({
      name: event.name,
      data,
    });
  }
}

function installInngestSendMock() {
  (inngest as any).send = async (payload: unknown) => {
    if (emitMode === "throw") {
      throw new Error("emit failed");
    }

    normalizeAndCaptureEvents(payload);
    return { ids: ["evt-1"] };
  };
}

function restoreInngestSend() {
  (inngest as any).send = originalInngestSend;
}

beforeAll(() => {
  (Redis.prototype as any).set = async function (key: string, value: string, ...args: unknown[]) {
    if (redisMode === "throw") {
      throw new Error("redis unavailable");
    }

    redisWrites.push({
      method: "set",
      key: String(key),
      value: String(value),
      args,
    });

    return "OK";
  };

  (Redis.prototype as any).hset = async function (key: string, ...args: unknown[]) {
    if (redisMode === "throw") {
      throw new Error("redis unavailable");
    }

    redisWrites.push({
      method: "hset",
      key: String(key),
      args,
    });

    return 1;
  };
});

afterAll(() => {
  Object.assign(Redis.prototype, originalRedisMethods);
});

beforeEach(() => {
  mockShellResult = {
    stdout: `
<observations>
  <segment>
    <narrative>Captured durable debugging lessons</narrative>
    <facts>
      - 🔴 Added retry with backoff for unstable dependencies
      - 🟢 Confirmed stable execution after fix
    </facts>
  </segment>
</observations>
`,
    stderr: "",
    exitCode: 0,
  };

  redisMode = "ok";
  emitMode = "ok";
  redisWrites = [];
  emittedEvents = [];

  installBunDollarMock();
  installFetchMock();
  installInngestSendMock();
});

afterEach(() => {
  restoreBunDollar();
  restoreFetch();
  restoreInngestSend();
});

function tryParseJson(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function hsetArgsToObject(args: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (let i = 0; i < args.length; i += 2) {
    const rawKey = args[i];
    const rawValue = args[i + 1];
    if (typeof rawKey !== "string") continue;
    out[rawKey] = rawValue;
  }

  return out;
}

function extractRedisPayload(write: RedisWrite): Record<string, unknown> {
  if (write.method === "set") {
    return tryParseJson(write.value) ?? { raw: write.value ?? "" };
  }

  return hsetArgsToObject(write.args);
}

async function loadObserveModule() {
  const cacheBuster = Date.now().toString(36) + Math.random().toString(36).slice(2);
  return import(`../src/inngest/functions/observe.ts?obs5=${cacheBuster}`);
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
    sendEvent: async (_id: string, payload: unknown) => {
      if (emitMode === "throw") {
        throw new Error("emit failed");
      }
      normalizeAndCaptureEvents(payload);
      return { ids: ["evt-step-1"] };
    },
  };

  const result = await handler({
    event: { name: trigger, data },
    step,
  });

  return { result, stepOutputs };
}

function findAccumulatedEvent() {
  return emittedEvents.find((event) => event.name === "memory/observations.accumulated");
}

function hasErrorSignal(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const raw = JSON.stringify(value).toLowerCase();
  return raw.includes("error") || raw.includes("fail");
}

describe("OBS-5: update-redis-state and emit-accumulated acceptance", () => {
  test("AC-1 and AC-2: update-redis-state writes memory:latest:{date} key with observation summary/metadata", async () => {
    await executeObserveHandler("memory/session.compaction.pending", makeCompactionEventData());

    const matchingWrite = redisWrites.find((write) =>
      /^memory:latest:\d{4}-\d{2}-\d{2}$/.test(write.key)
    );
    expect(matchingWrite).toBeDefined();

    const payload = extractRedisPayload(matchingWrite!);

    expect(payload).toMatchObject({});

    const payloadText = JSON.stringify(payload).toLowerCase();
    expect(payloadText.includes("summary") || payloadText.includes("observation")).toBe(true);
    expect(
      payloadText.includes("session") ||
        payloadText.includes("count") ||
        payloadText.includes("metadata")
    ).toBe(true);
  });

  test("AC-3 and AC-4: emit-accumulated emits memory/observations.accumulated with session_id and observation count", async () => {
    await executeObserveHandler("memory/session.compaction.pending", makeCompactionEventData());

    const accumulatedEvent = findAccumulatedEvent();
    expect(accumulatedEvent).toMatchObject({
      name: "memory/observations.accumulated",
      data: expect.any(Object),
    });

    const eventData = accumulatedEvent!.data;
    const sessionId = (eventData.session_id ?? eventData.sessionId) as string | undefined;
    const observationCount =
      (eventData.observationCount ?? eventData.observation_count) as number | undefined;

    expect(sessionId).toBe("session-obs-5-compaction");
    expect(typeof observationCount).toBe("number");
    expect((observationCount ?? 0) > 0).toBe(true);
  });

  test("AC-5: update-redis-state handles Redis errors without crashing function execution", async () => {
    redisMode = "throw";

    const { result, stepOutputs } = await executeObserveHandler(
      "memory/session.compaction.pending",
      makeCompactionEventData()
    );

    expect(result).toMatchObject({
      sessionId: "session-obs-5-compaction",
    });

    const redisStepOutput = stepOutputs.get("update-redis-state");
    expect(redisStepOutput).toBeDefined();
    expect(redisStepOutput as Record<string, unknown>).toMatchObject({});
    expect(hasErrorSignal(redisStepOutput)).toBe(true);
  });

  test("AC-5: emit-accumulated handles emission errors without crashing function execution", async () => {
    emitMode = "throw";

    const { result, stepOutputs } = await executeObserveHandler(
      "memory/session.compaction.pending",
      makeCompactionEventData()
    );

    expect(result).toMatchObject({
      sessionId: "session-obs-5-compaction",
    });

    const emitStepOutput = stepOutputs.get("emit-accumulated");
    expect(emitStepOutput).toBeDefined();
    expect(emitStepOutput as Record<string, unknown>).toMatchObject({});
    expect(hasErrorSignal(emitStepOutput)).toBe(true);
  });
});

describe("OBS-5: TypeScript compile gate", () => {
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
