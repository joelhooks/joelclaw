import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type GuardResult =
  | { ok: true }
  | { ok: false; reason: "already_claimed" | "already_passed" | "lease_expired" };

function makeStory() {
  return {
    id: "IDEM-4",
    title: "Guard side effects",
    description: "Ensure side effects are guarded",
    acceptance_criteria: ["guards run before side effects"],
  };
}

function makeEvent(runToken = "run-token-1") {
  return {
    data: {
      loopId: "loop-1",
      project: process.cwd(),
      storyId: "IDEM-4",
      story: makeStory(),
      tool: "codex" as const,
      attempt: 1,
      maxRetries: 2,
      maxIterations: 5,
      storyStartedAt: Date.now(),
      retryLadder: ["codex" as const],
      runToken,
    },
  };
}

function makeStep(opLog: string[]) {
  return {
    async run<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
      opLog.push(`step:${name}`);
      return await fn();
    },
  };
}

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function loadModule(params: {
  guardResults: GuardResult[];
  opLog: string[];
}) {
  const { guardResults, opLog } = params;
  let guardIndex = 0;

  const guardStory = mock(async (...args: [string, string, string]) => {
    const result = guardResults[Math.min(guardIndex, guardResults.length - 1)] ?? { ok: true };
    guardIndex += 1;
    opLog.push(`guard:${guardIndex}:${result.ok ? "ok" : result.reason}`);
    return result;
  });

  const renewLease = mock(async (...args: [string, string, string]) => {
    opLog.push("renew");
    return true;
  });

  mock.module("./utils", () => ({
    isCancelled: () => false,
    writePidFile: async () => {},
    cleanupPid: async () => {},
    TOOL_TIMEOUTS: {} as Record<string, number>,
    guardStory,
    renewLease,
  }));

  const send = mock(async () => {
    opLog.push("send");
    return { ids: ["evt_1"] };
  });

  mock.module("../../client", () => ({
    inngest: {
      send,
      createFunction: (opts: unknown, triggers: unknown, fn: unknown) => ({
        opts: { ...(opts as object), triggers },
        fn,
      }),
    },
  }));

  const mod = await import(`./test-writer.ts?case=${Date.now()}-${Math.random()}`);
  return {
    fn: (mod.agentLoopTestWriter as { fn: (ctx: unknown) => Promise<unknown> }).fn,
    guardStory,
    renewLease,
    send,
  };
}

describe("test-writer guardStory + lease renewal", () => {
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    mock.restore();
    originalSpawn = Bun.spawn;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
    mock.restore();
  });

  test("calls guardStory before tool spawn and before emitting next event; uses runToken; renews lease", async () => {
    const opLog: string[] = [];

    // @ts-expect-error test patch
    Bun.spawn = () => {
      opLog.push("spawn");
      return {
        pid: 123,
        stdout: streamFrom("ok"),
        stderr: streamFrom(""),
        exitCode: 0,
        kill() {},
      };
    };

    const { fn, guardStory, renewLease, send } = await loadModule({
      guardResults: [{ ok: true }, { ok: true }],
      opLog,
    });

    await fn({ event: makeEvent("token-abc"), step: makeStep(opLog) });

    expect(guardStory.mock.calls.length).toBe(2);
    expect(guardStory.mock.calls[0]).toEqual(["loop-1", "IDEM-4", "token-abc"]);
    expect(guardStory.mock.calls[1]).toEqual(["loop-1", "IDEM-4", "token-abc"]);
    expect(renewLease.mock.calls.length).toBeGreaterThan(0);
    expect(renewLease.mock.calls.every((call) => call[2] === "token-abc")).toBe(true);
    expect(send.mock.calls.length).toBe(1);

    const firstGuardIndex = opLog.indexOf("guard:1:ok");
    const spawnIndex = opLog.indexOf("spawn");
    const secondGuardIndex = opLog.indexOf("guard:2:ok");
    const sendIndex = opLog.indexOf("send");

    expect(firstGuardIndex).toBeGreaterThan(-1);
    expect(spawnIndex).toBeGreaterThan(-1);
    expect(secondGuardIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(-1);
    expect(firstGuardIndex).toBeLessThan(spawnIndex);
    expect(secondGuardIndex).toBeLessThan(sendIndex);
  });

  test("logs reason and returns early when guardStory blocks tool spawn", async () => {
    const opLog: string[] = [];

    // @ts-expect-error test patch
    Bun.spawn = () => {
      opLog.push("spawn");
      return {
        pid: 123,
        stdout: streamFrom(""),
        stderr: streamFrom(""),
        exitCode: 0,
        kill() {},
      };
    };

    const logCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map(String).join(" "));
    };

    try {
      const { fn, send } = await loadModule({
        guardResults: [{ ok: false, reason: "already_claimed" }],
        opLog,
      });

      await fn({ event: makeEvent("token-blocked"), step: makeStep(opLog) });

      expect(opLog.includes("spawn")).toBe(false);
      expect(send.mock.calls.length).toBe(0);
      expect(logCalls.join("\n")).toContain("already_claimed");
    } finally {
      console.log = originalLog;
    }
  });

  test("logs reason and returns early when guardStory blocks event emission", async () => {
    const opLog: string[] = [];

    // @ts-expect-error test patch
    Bun.spawn = () => {
      opLog.push("spawn");
      return {
        pid: 123,
        stdout: streamFrom("ok"),
        stderr: streamFrom(""),
        exitCode: 0,
        kill() {},
      };
    };

    const logCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map(String).join(" "));
    };

    try {
      const { fn, send, renewLease } = await loadModule({
        guardResults: [{ ok: true }, { ok: false, reason: "already_passed" }],
        opLog,
      });

      await fn({ event: makeEvent("token-emit-block"), step: makeStep(opLog) });

      expect(opLog.includes("spawn")).toBe(true);
      expect(send.mock.calls.length).toBe(0);
      expect(renewLease.mock.calls.length).toBeGreaterThan(0);
      expect(logCalls.join("\n")).toContain("already_passed");
    } finally {
      console.log = originalLog;
    }
  });
});
