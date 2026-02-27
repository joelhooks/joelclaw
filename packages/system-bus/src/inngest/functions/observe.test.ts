import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InngestTestEngine } from "@inngest/test";
import Redis from "ioredis";
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

  test("suppresses accumulated reflect trigger for backfill while still storing observations", async () => {
    const capturedAt = "2026-02-18T16:00:00.000Z";

    const { ctx } = await executeObserve({
      sessionId: "session-fric-3-backfill",
      dedupeKey: "fric-3-backfill-dedupe",
      trigger: "backfill",
      messages: "historical backfill transcript",
      messageCount: 12000,
      userMessageCount: 3000,
      duration: 0,
      filesRead: [],
      filesModified: [],
      capturedAt,
      schemaVersion: 1,
    });

    const sendEventCalls = ((ctx.step.sendEvent as any).mock?.calls ?? []) as unknown[][];
    const emittedAccumulatedEvent = sendEventCalls.some((call) => {
      const payload = call[1] as unknown;
      if (!Array.isArray(payload)) return false;
      return payload.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "name" in entry &&
          (entry as { name?: unknown }).name === "memory/observations.accumulated"
      );
    });

    const listKey = "memory:observations:2026-02-18";
    const persistedEntries = redisLists.get(listKey) ?? [];

    expect({
      emittedAccumulatedEvent,
      persistedEntryCount: persistedEntries.length,
    }).toMatchObject({
      emittedAccumulatedEvent: false,
      persistedEntryCount: 1,
    });
  });

  test("filters tool-call XML and internal shell traces from persisted summaries", async () => {
    const capturedAt = "2026-02-18T17:00:00.000Z";
    shellResultQueue = [
      {
        exitCode: 0,
        stdout: `<observations>
  <segment>
    <narrative><toolCall><id>toolu_abc123</id><name>bash</name><arguments>{"command":"ls -la"}</arguments></toolCall></narrative>
    <facts>
      - 🔴 [gate=allow confidence=0.98 category=jc:operations reason=internal_trace] <toolCall><id>toolu_abc123</id><name>bash</name><arguments>{"command":"git status"}</arguments></toolCall>
      - 🔴 [gate=allow confidence=0.97 category=jc:operations reason=internal_trace] bash -lc "bunx tsc --noEmit"
    </facts>
  </segment>
</observations>`,
        stderr: "",
      },
    ];

    await executeObserve({
      sessionId: "session-toolcall-filter",
      dedupeKey: "toolcall-filter-dedupe",
      trigger: "backfill",
      messages: "Assistant: <toolCall><id>toolu_abc123</id></toolCall>",
      messageCount: 4,
      userMessageCount: 2,
      duration: 42,
      filesRead: [],
      filesModified: [],
      capturedAt,
      schemaVersion: 1,
    });

    const listKey = "memory:observations:2026-02-18";
    const persistedEntries = redisLists.get(listKey) ?? [];
    expect(persistedEntries).toHaveLength(1);

    const payload = JSON.parse(persistedEntries[0] ?? "{}") as {
      summary?: string;
      metadata?: { observation_count?: number };
    };

    expect(payload.summary ?? "").not.toContain("<toolCall>");
    expect(payload.summary ?? "").not.toContain("<arguments>");
    expect(payload.summary ?? "").not.toContain("toolu_");
    expect(payload.summary ?? "").not.toContain("bash -lc");
    expect((payload.summary ?? "").trim()).toBe("");
    expect(payload.metadata?.observation_count ?? 0).toBe(0);
  });
});
