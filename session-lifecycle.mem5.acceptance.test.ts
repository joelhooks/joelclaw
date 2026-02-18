import { beforeEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";

const SESSION_LIFECYCLE_PATH = "/Users/joel/Code/joelhooks/pi-tools/session-lifecycle/index.ts";
const TEST_HOME = "/tmp/mem5-home";
const MEMORY_PATH = `${TEST_HOME}/.joelclaw/workspace/MEMORY.md`;
const DAILY_PATH = `${TEST_HOME}/.joelclaw/workspace/memory/${new Date()
  .toISOString()
  .slice(0, 10)}.md`;
const PENDING_LINE =
  "📋 3 pending memory proposals — run `joelclaw review` or say \"review proposals\" to see them";

const fsState = {
  memoryContent: "Keep momentum on current priorities.",
  dailyContent: "### 📋 Prior session\nImportant handoff note.",
};

const redisState = {
  constructorArgs: [] as unknown[][],
  connectCalls: 0,
  llenCalls: [] as string[],
  quitCalls: 0,
  disconnectCalls: 0,
  pendingCount: 0,
  throwOnLlen: false,
};

class MockRedis {
  constructor(...args: unknown[]) {
    redisState.constructorArgs.push(args);
  }

  async connect() {
    redisState.connectCalls += 1;
    return this;
  }

  async llen(key: string) {
    redisState.llenCalls.push(key);
    if (redisState.throwOnLlen) {
      throw new Error("Redis unavailable");
    }
    return redisState.pendingCount;
  }

  async quit() {
    redisState.quitCalls += 1;
    return "OK";
  }

  disconnect() {
    redisState.disconnectCalls += 1;
  }
}

mock.module("ioredis", () => ({
  default: MockRedis,
}));

mock.module("node:os", () => ({
  homedir: () => TEST_HOME,
}));

mock.module("node:fs", () => ({
  readFileSync: (filePath: string) => {
    if (filePath === MEMORY_PATH) return fsState.memoryContent;
    if (filePath === DAILY_PATH) return fsState.dailyContent;
    throw new Error(`ENOENT: ${filePath}`);
  },
  readdirSync: () => {
    throw new Error("ENOENT");
  },
  mkdirSync: () => {},
  appendFileSync: () => {},
}));

type BeforeAgentStartHandler = (
  event: { prompt?: string; systemPrompt: string },
  ctx: unknown
) => Promise<Record<string, any>>;

async function loadBeforeAgentStart(): Promise<BeforeAgentStartHandler> {
  const mod = await import(`${SESSION_LIFECYCLE_PATH}?mem5=${Date.now()}-${Math.random()}`);
  const handlers = new Map<string, Function>();

  mod.default({
    registerTool: () => {},
    on: (name: string, handler: Function) => {
      handlers.set(name, handler);
    },
    setSessionName: () => {},
    getSessionName: () => "",
  });

  const handler = handlers.get("before_agent_start");
  if (!handler) throw new Error("before_agent_start handler was not registered");
  return handler as BeforeAgentStartHandler;
}

async function runFirstTurn() {
  const beforeAgentStart = await loadBeforeAgentStart();
  return beforeAgentStart(
    { prompt: "Continue the current work", systemPrompt: "Base system prompt" },
    {}
  );
}

function constructorValues(): Array<string | number> {
  const values: Array<string | number> = [];
  for (const args of redisState.constructorArgs) {
    for (const arg of args) {
      if (typeof arg === "string" || typeof arg === "number") {
        values.push(arg);
      } else if (arg && typeof arg === "object") {
        for (const value of Object.values(arg as Record<string, unknown>)) {
          if (typeof value === "string" || typeof value === "number") values.push(value);
        }
      }
    }
  }
  return values;
}

beforeEach(() => {
  redisState.constructorArgs = [];
  redisState.connectCalls = 0;
  redisState.llenCalls = [];
  redisState.quitCalls = 0;
  redisState.disconnectCalls = 0;
  redisState.pendingCount = 0;
  redisState.throwOnLlen = false;
});

describe("MEM-5 acceptance: pending proposal count in session briefing", () => {
  test("AC-1: queries Redis LLEN memory:review:pending on briefing injection", async () => {
    redisState.pendingCount = 1;

    await runFirstTurn();

    expect(redisState.llenCalls).toMatchObject(["memory:review:pending"]);
    const values = constructorValues();
    expect(values.some((value) => String(value).includes("localhost"))).toBe(true);
    expect(values.some((value) => String(value).includes("6379"))).toBe(true);
    expect(redisState.connectCalls).toBeGreaterThan(0);
    expect(redisState.quitCalls + redisState.disconnectCalls).toBeGreaterThan(0);
  });

  test("AC-2: when count > 0, briefing includes pending proposals line with count", async () => {
    redisState.pendingCount = 3;

    const result = await runFirstTurn();

    expect(result).toMatchObject({
      message: {
        customType: "session-briefing",
        content: expect.any(String),
      },
    });
    expect(result.message.content).toContain(PENDING_LINE);
  });

  test("AC-3: when count is 0, pending proposals line is not included", async () => {
    redisState.pendingCount = 0;

    const result = await runFirstTurn();

    expect(result).toMatchObject({
      message: {
        customType: "session-briefing",
        content: expect.any(String),
      },
    });
    expect(result.message.content).not.toContain("pending memory proposals");
  });

  test("AC-4: Redis errors are caught and briefing still returns", async () => {
    redisState.throwOnLlen = true;

    const result = await runFirstTurn();

    expect(result).toMatchObject({
      systemPrompt: expect.any(String),
      message: {
        customType: "session-briefing",
        content: expect.any(String),
      },
    });
    expect(result.message.content).not.toContain("pending memory proposals");
  });

  test("AC-5: TypeScript compiles in pi-tools with bunx tsc --noEmit", () => {
    const proc = spawnSync("bunx", ["tsc", "--noEmit"], {
      cwd: "/Users/joel/Code/joelhooks/pi-tools",
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).toBe(0);
  });
});
