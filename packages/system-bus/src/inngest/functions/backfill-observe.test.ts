import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InngestTestEngine } from "@inngest/test";
import Redis from "ioredis";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

const originalRedisMethods = {
  sismember: (Redis.prototype as { sismember?: unknown }).sismember,
  sadd: (Redis.prototype as { sadd?: unknown }).sadd,
  hset: Redis.prototype.hset,
};

const redisSets = new Map<string, Set<string>>();
const redisHashes = new Map<string, Record<string, string>>();

let tempHome = "";

function upsertHash(key: string, args: unknown[]): number {
  const existing = redisHashes.get(key) ?? {};

  if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) {
    Object.entries(args[0] as Record<string, unknown>).forEach(([field, value]) => {
      existing[field] = String(value ?? "");
    });
    redisHashes.set(key, existing);
    return Object.keys(existing).length;
  }

  for (let i = 0; i < args.length; i += 2) {
    const field = args[i];
    if (field == null) continue;
    existing[String(field)] = String(args[i + 1] ?? "");
  }

  redisHashes.set(key, existing);
  return Object.keys(existing).length;
}

function buildTranscriptJsonl(): string {
  const lines: string[] = [
    JSON.stringify({
      type: "session",
      id: "sess-fric-3-backfill",
      timestamp: "2026-02-17T12:00:00.000Z",
    }),
  ];

  for (let i = 0; i < 24; i += 1) {
    const role = i % 2 === 0 ? "user" : "assistant";
    lines.push(
      JSON.stringify({
        type: "message",
        message: {
          role,
          content: `Backfill line ${i} with enough length to pass observe payload threshold checks.`,
        },
      })
    );
  }

  return `${lines.join("\n")}\n`;
}

const sendEventCaptured: unknown[][] = [];

async function executeBackfillObserve() {
  sendEventCaptured.length = 0;
  const { backfillObserve } = await import("./backfill-observe");
  const engine = new InngestTestEngine({
    function: backfillObserve as any,
    events: [
      {
        name: "memory/backfill.requested",
        data: {
          minMessages: 10,
          sleepSeconds: 0,
          maxSessions: 1,
        },
      } as any,
    ],
    transformCtx: (ctx: any) => {
      const originalSendEvent = ctx.step.sendEvent;
      ctx.step.sendEvent = async (...args: unknown[]) => {
        sendEventCaptured.push(args);
        // Return mock response instead of calling real Inngest API
        return { ids: ["mock-event-id"] };
      };
      // Preserve mock interface for assertion compatibility
      ctx.step.sendEvent.mock = { calls: sendEventCaptured };
      return ctx;
    },
  });
  return engine.execute();
}

beforeAll(() => {
  // Prevent step.sendEvent from hitting real Inngest API
  process.env.INNGEST_EVENT_KEY = "test";
  process.env.INNGEST_DEV = "1";

  (Redis.prototype as any).sismember = async function (key: string, member: string) {
    const set = redisSets.get(String(key)) ?? new Set<string>();
    return set.has(String(member)) ? 1 : 0;
  };

  (Redis.prototype as any).sadd = async function (key: string, ...members: string[]) {
    const set = redisSets.get(String(key)) ?? new Set<string>();
    for (const member of members) {
      set.add(String(member));
    }
    redisSets.set(String(key), set);
    return set.size;
  };

  (Redis.prototype as any).hset = async function (key: string, ...args: unknown[]) {
    return upsertHash(String(key), args);
  };
});

afterAll(() => {
  (Redis.prototype as { sismember?: unknown }).sismember = originalRedisMethods.sismember;
  (Redis.prototype as { sadd?: unknown }).sadd = originalRedisMethods.sadd;
  Redis.prototype.hset = originalRedisMethods.hset;
});

beforeEach(() => {
  redisSets.clear();
  redisHashes.clear();

  tempHome = mkdtempSync(join(tmpdir(), "mem-fric-3-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  const sessionsDir = join(tempHome, ".pi", "agent", "sessions", "--Users-joel--");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, "2026-02-17-sess-fric-3-backfill.jsonl"), buildTranscriptJsonl());
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;

  rmSync(tempHome, { recursive: true, force: true });
});

describe("FRIC-3 backfill observe acceptance tests", () => {
  test("emits observe-session event with trigger set to backfill", async () => {
    const { ctx, result } = await executeBackfillObserve();

    const sendEventCalls = ((ctx.step.sendEvent as any).mock?.calls ?? []) as unknown[][];
    const emittedObserveEvent = sendEventCalls
      .map((call) => call[1])
      .find(
        (payload) =>
          typeof payload === "object" &&
          payload !== null &&
          "name" in payload &&
          (payload as { name?: unknown }).name === "memory/session.ended"
      ) as { data?: Record<string, unknown> } | undefined;

    expect(result).toMatchObject({
      status: "complete",
      processed: 1,
    });

    expect(emittedObserveEvent).toMatchObject({
      data: {
        trigger: "backfill",
        sessionId: expect.stringContaining("backfill-"),
      },
    });
  });
});
