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
      tool: "codex" as const,
      attempt: 1,
      feedback: "",
      story: makeStory(),
      maxRetries: 2,
      maxIterations: 5,
      retryLadder: ["codex" as const],
      freshTests: true,
      storyStartedAt: Date.now(),
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
  let headIndex = 0;

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

  const gitCommit = mock(async () => {
    opLog.push("commit");
    return "commit-sha";
  });

  mock.module("./utils", () => ({
    isCancelled: () => false,
    commitExists: async () => false,
    commitMessage: () => "test commit",
    gitCommit,
    outputPath: () => "/tmp/idem-4.out",
    writePidFile: async () => {},
    cleanupPid: async () => {},
    parseToolOutput: async () => ({ success: true, output: "ok" }),
    TOOL_TIMEOUTS: {} as Record<string, number>,
    hasUncommittedChanges: async () => true,
    getHeadSha: async () => {
      const value = headIndex === 0 ? "head-before" : "head-before";
      headIndex += 1;
      return value;
    },
    isDockerAvailable: async () => false,
    spawnInContainer: async () => ({ exitCode: 0, output: "ok" }),
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

  const mod = await import(`./implement.ts?case=${Date.now()}-${Math.random()}`);
  return {
    fn: (mod.agentLoopImplement as { fn: (ctx: unknown) => Promise<unknown> }).fn,
    guardStory,
    renewLease,
    gitCommit,
    send,
  };
}

describe("implement guardStory + lease renewal", () => {
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    mock.restore();
    originalSpawn = Bun.spawn;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
    mock.restore();
  });

  test("calls guardStory before spawn, commit, and emit; uses runToken; renews lease", async () => {
    const opLog: string[] = [];

    // @ts-expect-error test patch
    Bun.spawn = () => {
      opLog.push("spawn");
      return {
        pid: 456,
        stdout: streamFrom("tool-output"),
        stderr: streamFrom(""),
        exitCode: 0,
        kill() {},
      };
    };

    const { fn, guardStory, renewLease, gitCommit, send } = await loadModule({
      guardResults: [{ ok: true }, { ok: true }, { ok: true }],
      opLog,
    });

    await fn({ event: makeEvent("token-impl"), step: makeStep(opLog) });

    expect(guardStory.mock.calls.length).toBe(3);
    expect(guardStory.mock.calls[0]).toEqual(["loop-1", "IDEM-4", "token-impl"]);
    expect(guardStory.mock.calls[1]).toEqual(["loop-1", "IDEM-4", "token-impl"]);
    expect(guardStory.mock.calls[2]).toEqual(["loop-1", "IDEM-4", "token-impl"]);
    expect(gitCommit.mock.calls.length).toBe(1);
    expect(send.mock.calls.length).toBe(1);
    expect(renewLease.mock.calls.length).toBeGreaterThan(0);
    expect(renewLease.mock.calls.every((call) => call[2] === "token-impl")).toBe(true);

    const firstGuardIndex = opLog.indexOf("guard:1:ok");
    const spawnIndex = opLog.indexOf("spawn");
    const secondGuardIndex = opLog.indexOf("guard:2:ok");
    const commitIndex = opLog.indexOf("commit");
    const thirdGuardIndex = opLog.indexOf("guard:3:ok");
    const sendIndex = opLog.indexOf("send");

    expect(firstGuardIndex).toBeGreaterThan(-1);
    expect(spawnIndex).toBeGreaterThan(-1);
    expect(secondGuardIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(-1);
    expect(thirdGuardIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(-1);
    expect(firstGuardIndex).toBeLessThan(spawnIndex);
    expect(secondGuardIndex).toBeLessThan(commitIndex);
    expect(thirdGuardIndex).toBeLessThan(sendIndex);
  });

  test("logs reason and returns early when guardStory blocks tool spawn", async () => {
    const opLog: string[] = [];

    // @ts-expect-error test patch
    Bun.spawn = () => {
      opLog.push("spawn");
      return {
        pid: 456,
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
      const { fn, gitCommit, send } = await loadModule({
        guardResults: [{ ok: false, reason: "lease_expired" }],
        opLog,
      });

      await fn({ event: makeEvent("token-spawn-block"), step: makeStep(opLog) });

      expect(opLog.includes("spawn")).toBe(false);
      expect(gitCommit.mock.calls.length).toBe(0);
      expect(send.mock.calls.length).toBe(0);
      expect(logCalls.join("\n")).toContain("lease_expired");
    } finally {
      console.log = originalLog;
    }
  });

  test("logs reason and returns early when guardStory blocks commit", async () => {
    const opLog: string[] = [];

    // @ts-expect-error test patch
    Bun.spawn = () => {
      opLog.push("spawn");
      return {
        pid: 456,
        stdout: streamFrom("tool-output"),
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
      const { fn, gitCommit, send, renewLease } = await loadModule({
        guardResults: [{ ok: true }, { ok: false, reason: "already_claimed" }],
        opLog,
      });

      await fn({ event: makeEvent("token-commit-block"), step: makeStep(opLog) });

      expect(opLog.includes("spawn")).toBe(true);
      expect(gitCommit.mock.calls.length).toBe(0);
      expect(send.mock.calls.length).toBe(0);
      expect(renewLease.mock.calls.length).toBeGreaterThan(0);
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
        pid: 456,
        stdout: streamFrom("tool-output"),
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
      const { fn, gitCommit, send } = await loadModule({
        guardResults: [{ ok: true }, { ok: true }, { ok: false, reason: "already_passed" }],
        opLog,
      });

      await fn({ event: makeEvent("token-emit-block"), step: makeStep(opLog) });

      expect(opLog.includes("spawn")).toBe(true);
      expect(gitCommit.mock.calls.length).toBe(1);
      expect(send.mock.calls.length).toBe(0);
      expect(logCalls.join("\n")).toContain("already_passed");
    } finally {
      console.log = originalLog;
    }
  });
});
