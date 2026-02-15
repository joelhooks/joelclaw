import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { agentLoopPlan } from "../src/inngest/functions/agent-loop/plan.ts";
import { inngest } from "../src/inngest/client.ts";
import { claimStory } from "../src/inngest/functions/agent-loop/utils.ts";

type RedisValue = {
  value: string;
  expiresAtMs: number | null;
};

const store = new Map<string, RedisValue>();

function getLiveEntry(key: string): RedisValue | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
    store.delete(key);
    return null;
  }
  return entry;
}

const originalMethods = {
  set: (Redis as any).prototype.set,
  get: (Redis as any).prototype.get,
  expire: (Redis as any).prototype.expire,
  del: (Redis as any).prototype.del,
  ttl: (Redis as any).prototype.ttl,
};

const originalSend = (inngest as any).send;
const originalWarn = console.warn;

let sendCalls: Array<{ name: string; data: { runToken?: string } & Record<string, unknown> }> = [];
let warnCalls: unknown[][] = [];

beforeAll(() => {
  (Redis as any).prototype.set = async function (...args: unknown[]) {
    const [key, rawValue, ...rest] = args as [string, string, ...unknown[]];
    const value = String(rawValue);

    let exSeconds: number | null = null;
    let nx = false;

    for (let i = 0; i < rest.length; i++) {
      const token = rest[i];
      if (token === "EX") {
        exSeconds = Number(rest[i + 1]);
        i += 1;
      }
      if (token === "NX") {
        nx = true;
      }
    }

    const existing = getLiveEntry(key);
    if (nx && existing) return null;

    const expiresAtMs =
      exSeconds !== null ? Date.now() + exSeconds * 1000 : existing?.expiresAtMs ?? null;

    store.set(key, { value, expiresAtMs });
    return "OK";
  };

  (Redis as any).prototype.get = async function (key: string) {
    const entry = getLiveEntry(key);
    return entry ? entry.value : null;
  };

  (Redis as any).prototype.expire = async function (key: string, seconds: number) {
    const entry = getLiveEntry(key);
    if (!entry) return 0;
    entry.expiresAtMs = Date.now() + Number(seconds) * 1000;
    store.set(key, entry);
    return 1;
  };

  (Redis as any).prototype.del = async function (...keys: string[]) {
    let deleted = 0;
    for (const key of keys) {
      if (store.delete(key)) deleted += 1;
    }
    return deleted;
  };

  (Redis as any).prototype.ttl = async function (key: string) {
    const entry = getLiveEntry(key);
    if (!entry) return -2;
    if (entry.expiresAtMs === null) return -1;
    const remainingMs = entry.expiresAtMs - Date.now();
    if (remainingMs <= 0) {
      store.delete(key);
      return -2;
    }
    return Math.ceil(remainingMs / 1000);
  };

  (inngest as any).send = async (
    payload: { name: string; data: { runToken?: string } & Record<string, unknown> }
  ) => {
    sendCalls.push(payload);
    return payload;
  };

  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };
});

afterAll(() => {
  (Redis as any).prototype.set = originalMethods.set;
  (Redis as any).prototype.get = originalMethods.get;
  (Redis as any).prototype.expire = originalMethods.expire;
  (Redis as any).prototype.del = originalMethods.del;
  (Redis as any).prototype.ttl = originalMethods.ttl;
  (inngest as any).send = originalSend;
  console.warn = originalWarn;
});

beforeEach(() => {
  store.clear();
  sendCalls = [];
  warnCalls = [];
});

function claimRedisKey(loopId: string, storyId: string): string {
  return `agent-loop:claim:${loopId}:${storyId}`;
}

function makeStory(storyId = "IDEM-3"): {
  id: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  priority: number;
  passes: boolean;
} {
  return {
    id: storyId,
    title: "Wire claimStory into plan before dispatch",
    description: "Claim a story before dispatching work",
    acceptance_criteria: ["TypeScript compiles cleanly: bunx tsc --noEmit"],
    priority: 1,
    passes: false,
  };
}

async function invokePlan(options?: {
  loopId?: string;
  storyId?: string;
  eventName?: "agent/loop.start" | "agent/loop.plan";
  eventId?: string;
}) {
  const loopId = options?.loopId ?? "loop-idem-3";
  const storyId = options?.storyId ?? "IDEM-3";
  const eventName = options?.eventName ?? "agent/loop.plan";

  const event = {
    id: options?.eventId,
    name: eventName,
    data: {
      loopId,
      project: "/tmp/project",
      maxIterations: 100,
      maxRetries: 2,
      retryLadder: ["codex", "claude", "codex"],
    },
  } as any;

  const prd = {
    title: "IDEM-3 PRD",
    stories: [makeStory(storyId)],
  };

  const step = {
    run: async (name: string, fn: () => Promise<unknown>) => {
      if (name === "check-cancel") return false;
      if (name === "read-prd") return prd;
      if (name === "emit-test") return fn();
      return undefined;
    },
  } as any;

  const result = await (agentLoopPlan as any).fn({ event, step });
  return { result, loopId, storyId };
}

describe("IDEM-3: plan claims story before dispatch", () => {
  test("dispatch path claims the selected story and forwards the same runToken in emitted event data", async () => {
    const { result, loopId, storyId } = await invokePlan({
      loopId: "loop-claim-success",
      storyId: "IDEM-3-A",
    });

    expect(result.status).toBe("dispatched");
    expect(sendCalls.length).toBe(1);
    expect(sendCalls[0]?.name).toBe("agent/loop.test");

    const emittedToken = sendCalls[0]?.data.runToken;
    expect(typeof emittedToken).toBe("string");
    expect((emittedToken as string).length).toBeGreaterThan(0);

    const redis = new Redis();
    const storedClaim = await redis.get(claimRedisKey(loopId, storyId));
    expect(storedClaim).toBe(emittedToken ?? null);
  });

  test("already-claimed story logs a warning and returns without dispatching", async () => {
    const loopId = "loop-already-claimed";
    const storyId = "IDEM-3-B";

    await claimStory(loopId, storyId, "existing-owner-token");

    const { result } = await invokePlan({ loopId, storyId });

    expect(result.status).not.toBe("dispatched");
    expect(sendCalls.length).toBe(0);
    expect(warnCalls.length).toBeGreaterThan(0);
  });

  test("runToken is non-empty and unique across separate dispatches", async () => {
    await invokePlan({
      loopId: "loop-token-1",
      storyId: "IDEM-3-C1",
      eventId: "run-1",
    });
    await invokePlan({
      loopId: "loop-token-2",
      storyId: "IDEM-3-C2",
      eventId: "run-2",
    });

    expect(sendCalls.length).toBe(2);

    const token1 = sendCalls[0]?.data.runToken;
    const token2 = sendCalls[1]?.data.runToken;

    expect(typeof token1).toBe("string");
    expect(typeof token2).toBe("string");
    expect((token1 as string).length).toBeGreaterThan(0);
    expect((token2 as string).length).toBeGreaterThan(0);
    expect(token1).not.toBe(token2);
  });
});

describe("IDEM-3: TypeScript compile gate", () => {
  test(
    "bunx tsc --noEmit succeeds",
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
