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
const realDateNow = Date.now.bind(Date);
const originalRedisMethods = {
  get: Redis.prototype.get,
  set: Redis.prototype.set,
  smembers: Redis.prototype.smembers,
  lpush: Redis.prototype.lpush,
  publish: Redis.prototype.publish,
};

let tempHome = "";
let heartbeatLastRunValue: string | null = null;
const heartbeatLastRunSetValues: string[] = [];
let adrPitchLastFiredValue: string | null = null;
const adrPitchLastFiredSetValues: string[] = [];
let mockedNowMs: number | null = null;

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
  Date.now = () => mockedNowMs ?? realDateNow();

  (Redis.prototype as any).get = async function (key: string) {
    if (key === "heartbeat:last_run") return heartbeatLastRunValue;
    if (key === "adr:pitch:last-fired") return adrPitchLastFiredValue;
    return null;
  };

  (Redis.prototype as any).set = async function (key: string, value: string) {
    if (key === "heartbeat:last_run") {
      heartbeatLastRunSetValues.push(value);
      heartbeatLastRunValue = value;
      return "OK";
    }

    if (key === "adr:pitch:last-fired") {
      adrPitchLastFiredSetValues.push(value);
      adrPitchLastFiredValue = value;
      return "OK";
    }

    return "OK";
  };

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
  Date.now = realDateNow;
  Redis.prototype.get = originalRedisMethods.get;
  Redis.prototype.set = originalRedisMethods.set;
  Redis.prototype.smembers = originalRedisMethods.smembers;
  Redis.prototype.lpush = originalRedisMethods.lpush;
  Redis.prototype.publish = originalRedisMethods.publish;
});

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "fric-4-heartbeat-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  heartbeatLastRunValue = null;
  heartbeatLastRunSetValues.length = 0;
  adrPitchLastFiredValue = null;
  adrPitchLastFiredSetValues.length = 0;
  mockedNowMs = null;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;

  rmSync(tempHome, { recursive: true, force: true });
});

describe("FRIC-4 heartbeat pruning acceptance tests", () => {
  test("adds check-if-needed as the first step and skips when the last run was under 10 minutes ago", async () => {
    heartbeatLastRunValue = `${Date.now() - 5 * 60 * 1000}`;

    const { ctx } = await executeHeartbeatCron();
    const runMock = (ctx.step.run as any).mock as {
      calls: unknown[][];
    };

    const stepNames = runMock.calls.map((call) => call[0]);

    expect({
      firstStep: stepNames[0],
      ranPruneStep: stepNames.includes("prune-old-sessions"),
      recordedLastRun: heartbeatLastRunSetValues.length,
    }).toMatchObject({
      firstStep: "check-if-needed",
      ranPruneStep: false,
      recordedLastRun: 0,
    });
  });

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

  test("stores heartbeat:last_run after a successful cron run", async () => {
    await executeHeartbeatCronWithCapturedSendEvents();

    expect({
      heartbeatLastRunWrites: heartbeatLastRunSetValues.length,
      timestampLooksNumeric:
        heartbeatLastRunSetValues.length > 0 &&
        Number.isFinite(Number(heartbeatLastRunSetValues[heartbeatLastRunSetValues.length - 1])),
    }).toMatchObject({
      heartbeatLastRunWrites: 1,
      timestampLooksNumeric: true,
    });
  });

  test("requests adr/pitch once during the 8am-10am Los Angeles window", async () => {
    mockedNowMs = Date.parse("2026-01-15T16:15:00.000Z");

    const { sendEventCalls } = await executeHeartbeatCronWithCapturedSendEvents();
    const adrPitchCall = sendEventCalls.find((call) => call[0] === "fan-out-adr-pitch");

    expect({
      adrPitchEventName: (adrPitchCall?.[1] as { name?: string } | undefined)?.name,
      adrPitchLastFiredWrites: adrPitchLastFiredSetValues.length,
    }).toMatchObject({
      adrPitchEventName: "adr/pitch.requested",
      adrPitchLastFiredWrites: 1,
    });
  });

  test("skips adr/pitch fanout outside the morning Los Angeles window", async () => {
    mockedNowMs = Date.parse("2026-01-15T19:15:00.000Z");

    const { sendEventCalls } = await executeHeartbeatCronWithCapturedSendEvents();
    const adrPitchCall = sendEventCalls.find((call) => call[0] === "fan-out-adr-pitch");

    expect({
      hasAdrPitchCall: Boolean(adrPitchCall),
      adrPitchLastFiredWrites: adrPitchLastFiredSetValues.length,
    }).toMatchObject({
      hasAdrPitchCall: false,
      adrPitchLastFiredWrites: 0,
    });
  });
});
