import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { InngestTestEngine } from "@inngest/test";
import Redis from "ioredis";
import { heartbeatCron } from "./heartbeat";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalRedisMethods = {
  smembers: Redis.prototype.smembers,
  lpush: Redis.prototype.lpush,
  publish: Redis.prototype.publish,
};

let tempHome = "";

function createFileDaysAgo(path: string, daysAgo: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `fixture: ${path}\n`);
  const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  utimesSync(path, ts, ts);
}

async function executeHeartbeatCron() {
  const engine = new InngestTestEngine({
    function: heartbeatCron as any,
    events: [
      {
        name: "inngest/scheduled.timer",
        data: {
          cron: "*/15 * * * *",
        },
      } as any,
    ],
  });
  return engine.execute();
}

async function executeHeartbeatCronWithCapturedSendEvents() {
  const sendEventCalls: unknown[][] = [];
  const engine = new InngestTestEngine({
    function: heartbeatCron as any,
    events: [
      {
        name: "inngest/scheduled.timer",
        data: {
          cron: "*/15 * * * *",
        },
      } as any,
    ],
    transformCtx: (ctx: any) => {
      ctx.step.sendEvent = async (...args: unknown[]) => {
        sendEventCalls.push(args);
        return { ids: ["mock-event-id"] };
      };
      ctx.step.sendEvent.mock = { calls: sendEventCalls };
      return ctx;
    },
  });
  const execution = await engine.execute();
  return { ...execution, sendEventCalls };
}

beforeAll(() => {
  (Redis.prototype as any).smembers = async function () {
    return [];
  };

  (Redis.prototype as any).lpush = async function () {
    return 1;
  };

  (Redis.prototype as any).publish = async function () {
    return 1;
  };
});

afterAll(() => {
  Redis.prototype.smembers = originalRedisMethods.smembers;
  Redis.prototype.lpush = originalRedisMethods.lpush;
  Redis.prototype.publish = originalRedisMethods.publish;
});

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "fric-4-heartbeat-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;

  rmSync(tempHome, { recursive: true, force: true });
});

describe("FRIC-4 heartbeat pruning acceptance tests", () => {
  test("adds a prune-old-sessions step that removes only files older than 30 days and reports the pruned count", async () => {
    const oldSessionJsonl = join(
      tempHome,
      ".pi",
      "agent",
      "sessions",
      "nested",
      "deep",
      "old-session.jsonl"
    );
    const newSessionJsonl = join(
      tempHome,
      ".pi",
      "agent",
      "sessions",
      "nested",
      "deep",
      "new-session.jsonl"
    );
    const oldSessionNonJsonl = join(
      tempHome,
      ".pi",
      "agent",
      "sessions",
      "nested",
      "deep",
      "old-session.txt"
    );
    const oldClaudeDebug = join(tempHome, ".claude", "debug", "old-debug.log");
    const newClaudeDebug = join(tempHome, ".claude", "debug", "new-debug.log");

    createFileDaysAgo(oldSessionJsonl, 31);
    createFileDaysAgo(newSessionJsonl, 29);
    createFileDaysAgo(oldSessionNonJsonl, 31);
    createFileDaysAgo(oldClaudeDebug, 31);
    createFileDaysAgo(newClaudeDebug, 29);

    const { ctx } = await executeHeartbeatCron();
    const runMock = (ctx.step.run as any).mock as {
      calls: unknown[][];
      results: Array<{ value: Promise<unknown> | unknown }>;
    };

    const pruneStepIndex = runMock.calls.findIndex((call) => call[0] === "prune-old-sessions");
    expect({ hasPruneStep: pruneStepIndex >= 0 }).toMatchObject({ hasPruneStep: true });

    const pruneStepOutput = await runMock.results[pruneStepIndex]?.value;
    const pruneCountEntry = Object.entries((pruneStepOutput ?? {}) as Record<string, unknown>).find(
      ([key, value]) => typeof value === "number" && value === 2 && key.toLowerCase().includes("prun")
    );

    expect({
      oldSessionJsonlExists: existsSync(oldSessionJsonl),
      newSessionJsonlExists: existsSync(newSessionJsonl),
      oldSessionNonJsonlExists: existsSync(oldSessionNonJsonl),
      oldClaudeDebugExists: existsSync(oldClaudeDebug),
      newClaudeDebugExists: existsSync(newClaudeDebug),
      hasPruneCountInStepOutput: pruneCountEntry !== undefined,
    }).toMatchObject({
      oldSessionJsonlExists: false,
      newSessionJsonlExists: true,
      oldSessionNonJsonlExists: true,
      oldClaudeDebugExists: false,
      newClaudeDebugExists: true,
      hasPruneCountInStepOutput: true,
    });
  });

  test("fans out system health core slice on heartbeat cadence", async () => {
    const { sendEventCalls } = await executeHeartbeatCronWithCapturedSendEvents();
    const fanoutCall = sendEventCalls.find((call) => call[0] === "fan-out-checks");
    const fanoutPayload = Array.isArray(fanoutCall?.[1]) ? fanoutCall?.[1] : [];
    const healthEvent = fanoutPayload.find(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "name" in item &&
        (item as { name?: string }).name === "system/health.requested"
    ) as { data?: Record<string, unknown> } | undefined;

    expect(healthEvent).toMatchObject({
      data: {
        mode: "core",
        source: "heartbeat-15m",
      },
    });
  });
});
