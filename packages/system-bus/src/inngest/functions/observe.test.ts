import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { InngestTestEngine } from "@inngest/test";
import Redis from "ioredis";
import { QdrantClient } from "@qdrant/js-client-rest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeSessionFunction } from "./observe";

type MockShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalBunDollar = Bun.$;
const originalRedisMethods = {
  set: Redis.prototype.set,
  rpush: Redis.prototype.rpush,
  expire: Redis.prototype.expire,
};
const originalQdrantMethods = {
  getCollections: QdrantClient.prototype.getCollections,
  createCollection: QdrantClient.prototype.createCollection,
  upsert: QdrantClient.prototype.upsert,
};

const redisStrings = new Map<string, string>();
const redisLists = new Map<string, string[]>();
let shellResultQueue: MockShellResult[] = [];
let tempHome = "";

function buildCommandText(strings: TemplateStringsArray, values: unknown[]): string {
  let out = "";
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i] ?? "";
    if (i < values.length) out += String(values[i] ?? "");
  }
  return out;
}

function dailyLogPathFor(date: string): string {
  return join(tempHome, ".joelclaw", "workspace", "memory", `${date}.md`);
}

function countSessionObservationBlocks(markdown: string, sessionId: string): number {
  const marker = `### 🔭 Observations (session: ${sessionId}`;
  return markdown.split(marker).length - 1;
}

async function executeObserve(eventData: Record<string, unknown>) {
  const engine = new InngestTestEngine({
    function: observeSessionFunction as any,
    events: [
      {
        name: "memory/session.ended",
        data: eventData,
      } as any,
    ],
  });
  return engine.execute();
}

beforeAll(() => {
  (Redis.prototype as any).set = async function (
    key: string,
    value: string,
    ...rest: Array<string | number>
  ) {
    const keyText = String(key);
    const hasNx = rest.some((arg) => String(arg).toUpperCase() === "NX");
    if (hasNx && redisStrings.has(keyText)) {
      return null;
    }
    redisStrings.set(keyText, String(value));
    return "OK";
  };

  (Redis.prototype as any).rpush = async function (key: string, ...values: string[]) {
    const list = redisLists.get(String(key)) ?? [];
    list.push(...values.map(String));
    redisLists.set(String(key), list);
    return list.length;
  };

  (Redis.prototype as any).expire = async function () {
    return 1;
  };

  (QdrantClient.prototype as any).getCollections = async function () {
    return {
      collections: [{ name: "memory_observations" }],
    };
  };

  (QdrantClient.prototype as any).createCollection = async function () {
    return;
  };

  (QdrantClient.prototype as any).upsert = async function () {
    return;
  };

  // @ts-expect-error test monkey patch for deterministic subprocess behavior.
  Bun.$ = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    buildCommandText(strings, values);
    const next = shellResultQueue.shift() ?? {
      exitCode: 0,
      stdout: "<observations> </observations>",
      stderr: "",
    };

    return {
      quiet() {
        return this;
      },
      async nothrow() {
        return next;
      },
    };
  }) as typeof Bun.$;
});

afterAll(() => {
  Redis.prototype.set = originalRedisMethods.set;
  Redis.prototype.rpush = originalRedisMethods.rpush;
  Redis.prototype.expire = originalRedisMethods.expire;
  QdrantClient.prototype.getCollections = originalQdrantMethods.getCollections;
  QdrantClient.prototype.createCollection = originalQdrantMethods.createCollection;
  QdrantClient.prototype.upsert = originalQdrantMethods.upsert;
  Bun.$ = originalBunDollar;
});

beforeEach(() => {
  redisStrings.clear();
  redisLists.clear();
  shellResultQueue = [
    { exitCode: 0, stdout: "<observations> </observations>", stderr: "" },
    { exitCode: 0, stdout: "<observations> </observations>", stderr: "" },
  ];

  tempHome = mkdtempSync(join(tmpdir(), "mem-observe-home-"));
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

describe("FRIC-1 observe acceptance tests", () => {
  test("running observe twice for the same session and trigger appends only one daily log entry", async () => {
    const sessionId = "session-fric-1";
    const capturedAt = "2026-02-18T15:42:00.000Z";
    const eventBase = {
      sessionId,
      trigger: "shutdown",
      messages: "compact transcript",
      messageCount: 9,
      userMessageCount: 4,
      duration: 120,
      filesRead: ["README.md"],
      filesModified: ["packages/system-bus/src/inngest/functions/observe.ts"],
      capturedAt,
      schemaVersion: 1,
    };

    const firstRun = await executeObserve({
      ...eventBase,
      dedupeKey: "fric-1-dedupe-1",
    });

    const secondRun = await executeObserve({
      ...eventBase,
      dedupeKey: "fric-1-dedupe-2",
    });

    const dailyLog = readFileSync(dailyLogPathFor("2026-02-18"), "utf8");
    const sessionEntries = countSessionObservationBlocks(dailyLog, sessionId);

    expect({
      sessionEntries,
      hasOnlyOneSessionEntry: sessionEntries === 1,
    }).toMatchObject({
      sessionEntries: 1,
      hasOnlyOneSessionEntry: true,
    });
  });
});
