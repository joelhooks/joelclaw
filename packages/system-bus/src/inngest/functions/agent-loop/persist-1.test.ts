import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { mkdirSync } from "node:fs";

type RedisSetCall = {
  key: string;
  value: string;
  args: unknown[];
};

type StepSendCall = {
  id: string;
  payload: unknown;
};

const originalRedisSet = Redis.prototype.set;
const originalRedisGet = Redis.prototype.get;

const redisData = new Map<string, string>();
let redisSetCalls: RedisSetCall[] = [];

function makeStepMock(options: {
  canned?: Record<string, unknown>;
  passthroughRunIds?: string[];
  sendCalls?: StepSendCall[];
}) {
  const canned = options.canned ?? {};
  const passthroughRunIds = new Set(options.passthroughRunIds ?? []);
  const sendCalls = options.sendCalls ?? [];

  return {
    run: async (id: string, work: () => Promise<unknown>) => {
      if (id in canned) return canned[id];
      if (passthroughRunIds.has(id)) return work();
      throw new Error(`Unexpected step.run id: ${id}`);
    },
    sendEvent: async (id: string, payload: unknown) => {
      sendCalls.push({ id, payload });
      return { ids: [`evt-${id}`] };
    },
  };
}

function latestPrdRedisWrite(loopId: string): unknown {
  const key = `agent-loop:prd:${loopId}`;
  const writesForKey = redisSetCalls.filter((call) => call.key === key);
  if (writesForKey.length === 0) {
    throw new Error(`Expected Redis set call for key ${key}`);
  }

  const value = writesForKey[writesForKey.length - 1]?.value;
  if (!value) throw new Error(`Redis value missing for key ${key}`);
  return JSON.parse(value);
}

beforeAll(() => {
  (Redis.prototype as any).set = async function (
    key: string,
    value: string,
    ...args: unknown[]
  ) {
    const stringKey = String(key);
    const stringValue = String(value);
    redisSetCalls.push({ key: stringKey, value: stringValue, args });

    const hasNX = args.includes("NX");
    if (hasNX && redisData.has(stringKey)) return null;

    redisData.set(stringKey, stringValue);
    return "OK";
  };

  (Redis.prototype as any).get = async function (key: string) {
    return redisData.get(String(key)) ?? null;
  };
});

afterAll(() => {
  Redis.prototype.set = originalRedisSet;
  Redis.prototype.get = originalRedisGet;
});

describe("PERSIST-1 acceptance tests", () => {
  test("plan seeds Redis PRD with top-level project and provided workDir while preserving existing PRD fields", async () => {
    redisData.clear();
    redisSetCalls = [];

    const loopId = `loop-persist1-${Date.now()}-explicit`;
    const project = `/tmp/project-${loopId}`;
    const workDir = `${project}/worktree-copy`;
    mkdirSync(workDir, { recursive: true });

    await Bun.write(
      `${workDir}/prd.json`,
      JSON.stringify(
        {
          title: "Loop PRD",
          description: "Planner test fixture",
          context: ["docs/adr-1.md"],
          stories: [
            {
              id: "PERSIST-1",
              title: "Store project/workDir",
              description: "Persist metadata in Redis",
              acceptance_criteria: ["Project and workDir stored"],
              priority: 1,
              passes: false,
            },
          ],
        },
        null,
        2
      ) + "\n"
    );

    const mod = await import(`./plan.ts?persist1=${Date.now()}`);
    const fn = (mod.agentLoopPlan as unknown as { fn: (input: unknown) => Promise<unknown> }).fn;

    const sendCalls: StepSendCall[] = [];

    await fn({
      event: {
        name: "agent/loop.started",
        data: {
          loopId,
          project,
          workDir,
          maxIterations: 0,
        },
      },
      step: makeStepMock({
        canned: {
          "check-cancel": false,
          "create-worktree": undefined,
          "install-worktree-deps": { installed: true },
          "resolve-workdir": workDir,
          "emit-complete-max-iterations": undefined,
        },
        passthroughRunIds: ["read-prd"],
        sendCalls,
      }),
    });

    const persistedPrd = latestPrdRedisWrite(loopId) as Record<string, unknown>;

    expect(persistedPrd).toMatchObject({
      title: "Loop PRD",
      description: "Planner test fixture",
      context: ["docs/adr-1.md"],
      stories: [
        {
          id: "PERSIST-1",
          title: "Store project/workDir",
          description: "Persist metadata in Redis",
          acceptance_criteria: ["Project and workDir stored"],
          priority: 1,
          passes: false,
        },
      ],
      project,
      workDir,
    });

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toMatchObject({
      id: "emit-complete-max-iterations",
      payload: {
        name: "agent/loop.completed",
        data: {
          loopId,
          project,
          workDir,
        },
      },
    });
  });

  test("plan stores workDir as project when event.data.workDir is not provided", async () => {
    redisData.clear();
    redisSetCalls = [];

    const loopId = `loop-persist1-${Date.now()}-fallback`;
    const project = `/tmp/project-${loopId}`;
    mkdirSync(project, { recursive: true });

    await Bun.write(
      `${project}/prd.json`,
      JSON.stringify(
        {
          title: "Loop PRD fallback",
          description: "Planner fallback fixture",
          context: ["docs/adr-2.md"],
          stories: [
            {
              id: "PERSIST-1B",
              title: "Fallback workDir",
              description: "Workdir should fallback",
              acceptance_criteria: ["Fallback used"],
              priority: 1,
              passes: false,
            },
          ],
        },
        null,
        2
      ) + "\n"
    );

    const mod = await import(`./plan.ts?persist1=${Date.now()}`);
    const fn = (mod.agentLoopPlan as unknown as { fn: (input: unknown) => Promise<unknown> }).fn;

    await fn({
      event: {
        name: "agent/loop.started",
        data: {
          loopId,
          project,
          maxIterations: 0,
        },
      },
      step: makeStepMock({
        canned: {
          "check-cancel": false,
          "create-worktree": undefined,
          "install-worktree-deps": { installed: true },
          "resolve-workdir": project,
          "emit-complete-max-iterations": undefined,
        },
        passthroughRunIds: ["read-prd"],
      }),
    });

    const persistedPrd = latestPrdRedisWrite(loopId) as Record<string, unknown>;

    expect(persistedPrd).toMatchObject({
      title: "Loop PRD fallback",
      description: "Planner fallback fixture",
      context: ["docs/adr-2.md"],
      stories: [
        {
          id: "PERSIST-1B",
          title: "Fallback workDir",
          description: "Workdir should fallback",
          acceptance_criteria: ["Fallback used"],
          priority: 1,
          passes: false,
        },
      ],
      project,
      workDir: project,
    });
  });

  test("TypeScript compile criterion: planner module imports and exposes function entrypoint", async () => {
    const mod = await import(`./plan.ts?persist1-types=${Date.now()}`);
    const fn = (mod.agentLoopPlan as unknown as { fn?: unknown }).fn;
    expect(fn).toBeDefined();
  });
});
