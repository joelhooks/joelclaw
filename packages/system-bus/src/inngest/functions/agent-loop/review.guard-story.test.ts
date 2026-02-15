import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type GuardResult =
  | { ok: true }
  | { ok: false; reason: "already_claimed" | "already_passed" | "lease_expired" };

function makeStory() {
  return {
    id: "IDEM-5",
    title: "Guard review side effects",
    description: "Ensure review side effects are guarded",
    acceptance_criteria: ["guard before spawn", "guard before emit"],
  };
}

function makeEvent(runToken = "run-token-1") {
  return {
    data: {
      loopId: "loop-1",
      project: process.cwd(),
      storyId: "IDEM-5",
      attempt: 1,
      story: makeStory(),
      maxRetries: 2,
      maxIterations: 5,
      storyStartedAt: Date.now(),
      retryLadder: ["codex" as const, "claude" as const],
      priorFeedback: "",
      runToken,
    },
  };
}

function makeStep(opLog: string[]) {
  return {
    async run<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
      opLog.push(`step:${name}`);

      if (name === "run-checks") {
        return {
          typecheckOk: true,
          typecheckOutput: "",
          lintOk: true,
          lintOutput: "",
          testsPassed: 3,
          testsFailed: 0,
          testOutput: "3 pass",
        } as T;
      }

      if (name === "get-story-diff") {
        return "" as T;
      }

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
    getStoryDiff: async () => "",
    parseClaudeOutput: () => ({
      questions: [
        { id: "q2", answer: true, evidence: "ok" },
        { id: "q3", answer: true, evidence: "ok" },
        { id: "q4", answer: true, evidence: "ok" },
      ],
    }),
    TOOL_TIMEOUTS: {} as Record<string, number>,
    guardStory,
    renewLease,
  }));

  const send = mock(async (payload: { name: string }) => {
    opLog.push(`send:${payload.name}`);
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

  const mod = await import(`./review.ts?case=${Date.now()}-${Math.random()}`);
  return {
    fn: (mod.agentLoopReview as { fn: (ctx: unknown) => Promise<unknown> }).fn,
    guardStory,
    renewLease,
    send,
  };
}

describe("review guardStory + lease renewal", () => {
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    mock.restore();
    originalSpawn = Bun.spawn;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
    mock.restore();
  });

  test("calls guardStory before reviewer spawn and before judge emit; uses event runToken; renews lease after review", async () => {
    const opLog: string[] = [];

    // @ts-expect-error test patch
    Bun.spawn = () => {
      opLog.push("spawn");
      return {
        pid: 123,
        stdout: streamFrom('{"questions":[{"id":"q2","answer":true,"evidence":"ok"},{"id":"q3","answer":true,"evidence":"ok"},{"id":"q4","answer":true,"evidence":"ok"}]}'),
        stderr: streamFrom(""),
        exitCode: 0,
        kill() {},
      };
    };

    const { fn, guardStory, renewLease, send } = await loadModule({
      guardResults: [{ ok: true }, { ok: true }],
      opLog,
    });

    await fn({ event: makeEvent("token-review"), step: makeStep(opLog) });

    expect(guardStory.mock.calls.length).toBe(2);
    expect(guardStory.mock.calls[0]).toEqual(["loop-1", "IDEM-5", "token-review"]);
    expect(guardStory.mock.calls[1]).toEqual(["loop-1", "IDEM-5", "token-review"]);
    expect(renewLease.mock.calls.length).toBeGreaterThan(0);
    expect(renewLease.mock.calls.every((call) => call[2] === "token-review")).toBe(true);
    expect(send.mock.calls.length).toBe(1);

    const firstGuardIndex = opLog.indexOf("guard:1:ok");
    const spawnIndex = opLog.indexOf("spawn");
    const secondGuardIndex = opLog.indexOf("guard:2:ok");
    const sendJudgeIndex = opLog.indexOf("send:agent/loop.judge");

    expect(firstGuardIndex).toBeGreaterThan(-1);
    expect(spawnIndex).toBeGreaterThan(-1);
    expect(secondGuardIndex).toBeGreaterThan(-1);
    expect(sendJudgeIndex).toBeGreaterThan(-1);
    expect(firstGuardIndex).toBeLessThan(spawnIndex);
    expect(secondGuardIndex).toBeLessThan(sendJudgeIndex);
  });

  test("logs reason and returns early when guardStory blocks reviewer spawn", async () => {
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
      const { fn, send, renewLease } = await loadModule({
        guardResults: [{ ok: false, reason: "already_claimed" }],
        opLog,
      });

      await fn({ event: makeEvent("token-spawn-block"), step: makeStep(opLog) });

      expect(opLog.includes("spawn")).toBe(false);
      expect(send.mock.calls.length).toBe(0);
      expect(renewLease.mock.calls.length).toBe(0);
      expect(logCalls.join("\n")).toContain("already_claimed");
    } finally {
      console.log = originalLog;
    }
  });

  test("logs reason and returns early when guardStory blocks judge emission", async () => {
    const opLog: string[] = [];

    // @ts-expect-error test patch
    Bun.spawn = () => {
      opLog.push("spawn");
      return {
        pid: 123,
        stdout: streamFrom('{"questions":[{"id":"q2","answer":true,"evidence":"ok"},{"id":"q3","answer":true,"evidence":"ok"},{"id":"q4","answer":true,"evidence":"ok"}]}'),
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
