import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type GuardResult =
  | { ok: true }
  | { ok: false; reason: "already_claimed" | "already_passed" | "lease_expired" };

function makeStory() {
  return {
    id: "IDEM-5",
    title: "Guard judge side effects",
    description: "Ensure judge side effects are guarded",
    acceptance_criteria: ["guard before verdict write", "guard before next event emit"],
  };
}

function makeEvent(params?: {
  runToken?: string;
  attempt?: number;
  maxRetries?: number;
  testsFailed?: number;
}) {
  const runToken = params?.runToken ?? "run-token-1";
  const attempt = params?.attempt ?? 1;
  const maxRetries = params?.maxRetries ?? 2;
  const testsFailed = params?.testsFailed ?? 0;

  return {
    data: {
      loopId: "loop-1",
      project: process.cwd(),
      prdPath: "prd.json",
      storyId: "IDEM-5",
      testResults: {
        testsPassed: testsFailed > 0 ? 0 : 5,
        testsFailed,
        typecheckOk: testsFailed === 0,
        lintOk: testsFailed === 0,
        details: testsFailed > 0 ? "1 fail" : "5 pass",
      },
      feedback: "",
      reviewerNotes: {
        questions: [
          { id: "q2", answer: true, evidence: "ok" },
          { id: "q3", answer: true, evidence: "ok" },
          { id: "q4", answer: true, evidence: "ok" },
        ],
        testResults: {
          typecheckOutput: "",
          lintOutput: "",
          testOutput: "",
        },
      },
      attempt,
      maxRetries,
      maxIterations: 5,
      storyStartedAt: Date.now() - 10,
      retryLadder: ["codex" as const, "claude" as const],
      priorFeedback: "",
      story: makeStory(),
      tool: "codex" as const,
      runToken,
    },
  };
}

function makeStep(opLog: string[]) {
  return {
    async run<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
      opLog.push(`step:${name}`);

      if (name === "get-story-diff") {
        return "" as T;
      }

      if (name === "read-test-files") {
        return "" as T;
      }

      if (name === "read-project-conventions") {
        return "" as T;
      }

      return await fn();
    },
  };
}

async function loadModule(params: {
  guardResults: GuardResult[];
  llmVerdict?: "pass" | "fail";
  opLog: string[];
}) {
  const { guardResults, llmVerdict = "pass", opLog } = params;
  let guardIndex = 0;

  const guardStory = mock(async (...args: [string, string, string]) => {
    const result = guardResults[Math.min(guardIndex, guardResults.length - 1)] ?? { ok: true };
    guardIndex += 1;
    opLog.push(`guard:${guardIndex}:${result.ok ? "ok" : result.reason}`);
    return result;
  });

  const updateStoryPass = mock(async () => {
    opLog.push("update-pass");
  });

  const markStorySkipped = mock(async () => {
    opLog.push("mark-skipped");
  });

  const appendProgress = mock(async () => {
    opLog.push("progress");
  });

  const releaseClaim = mock(async (...args: [string, string]) => {
    opLog.push("release");
  });

  mock.module("./utils", () => ({
    isCancelled: () => false,
    updateStoryPass,
    markStorySkipped,
    appendProgress,
    getStoryDiff: async () => "",
    llmEvaluate: async () => ({
      verdict: llmVerdict,
      reasoning: llmVerdict === "pass" ? "all good" : "failing checks",
    }),
    guardStory,
    releaseClaim,
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

  const mod = await import(`./judge.ts?case=${Date.now()}-${Math.random()}`);
  return {
    fn: (mod.agentLoopJudge as { fn: (ctx: unknown) => Promise<unknown> }).fn,
    guardStory,
    updateStoryPass,
    markStorySkipped,
    releaseClaim,
    send,
  };
}

describe("judge guardStory + releaseClaim", () => {
  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
  });

  test("calls guardStory before verdict write and before loop-continuation event; uses runToken; releases claim after pass", async () => {
    const opLog: string[] = [];

    const { fn, guardStory, updateStoryPass, releaseClaim, send } = await loadModule({
      guardResults: [{ ok: true }, { ok: true }],
      llmVerdict: "pass",
      opLog,
    });

    await fn({ event: makeEvent({ runToken: "token-pass" }), step: makeStep(opLog) });

    expect(guardStory.mock.calls.length).toBe(2);
    expect(guardStory.mock.calls[0]).toEqual(["loop-1", "IDEM-5", "token-pass"]);
    expect(guardStory.mock.calls[1]).toEqual(["loop-1", "IDEM-5", "token-pass"]);
    expect(updateStoryPass.mock.calls.length).toBe(1);
    expect(releaseClaim.mock.calls.length).toBe(1);
    expect(releaseClaim.mock.calls[0]).toEqual(["loop-1", "IDEM-5"]);

    const firstGuardIndex = opLog.indexOf("guard:1:ok");
    const updatePassIndex = opLog.indexOf("update-pass");
    const releaseIndex = opLog.indexOf("release");
    const secondGuardIndex = opLog.indexOf("guard:2:ok");
    const sendPlanIndex = opLog.indexOf("send:agent/loop.plan");

    expect(firstGuardIndex).toBeGreaterThan(-1);
    expect(updatePassIndex).toBeGreaterThan(-1);
    expect(releaseIndex).toBeGreaterThan(-1);
    expect(secondGuardIndex).toBeGreaterThan(-1);
    expect(sendPlanIndex).toBeGreaterThan(-1);
    expect(firstGuardIndex).toBeLessThan(updatePassIndex);
    expect(releaseIndex).toBeGreaterThan(updatePassIndex);
    expect(secondGuardIndex).toBeLessThan(sendPlanIndex);

    const sentEvents = send.mock.calls.map((call) => call[0]?.name);
    expect(sentEvents).toContain("agent/loop.plan");
  });

  test("calls guardStory before verdict write and before loop-continuation event; releases claim after skip", async () => {
    const opLog: string[] = [];

    const { fn, guardStory, markStorySkipped, releaseClaim, send } = await loadModule({
      guardResults: [{ ok: true }, { ok: true }],
      llmVerdict: "fail",
      opLog,
    });

    await fn({
      event: makeEvent({
        runToken: "token-skip",
        attempt: 2,
        maxRetries: 2,
        testsFailed: 1,
      }),
      step: makeStep(opLog),
    });

    expect(guardStory.mock.calls.length).toBe(2);
    expect(guardStory.mock.calls[0]).toEqual(["loop-1", "IDEM-5", "token-skip"]);
    expect(guardStory.mock.calls[1]).toEqual(["loop-1", "IDEM-5", "token-skip"]);
    expect(markStorySkipped.mock.calls.length).toBe(1);
    expect(releaseClaim.mock.calls.length).toBe(1);
    expect(releaseClaim.mock.calls[0]).toEqual(["loop-1", "IDEM-5"]);

    const firstGuardIndex = opLog.indexOf("guard:1:ok");
    const markSkippedIndex = opLog.indexOf("mark-skipped");
    const releaseIndex = opLog.indexOf("release");
    const secondGuardIndex = opLog.indexOf("guard:2:ok");
    const sendPlanIndex = opLog.indexOf("send:agent/loop.plan");

    expect(firstGuardIndex).toBeGreaterThan(-1);
    expect(markSkippedIndex).toBeGreaterThan(-1);
    expect(releaseIndex).toBeGreaterThan(-1);
    expect(secondGuardIndex).toBeGreaterThan(-1);
    expect(sendPlanIndex).toBeGreaterThan(-1);
    expect(firstGuardIndex).toBeLessThan(markSkippedIndex);
    expect(releaseIndex).toBeGreaterThan(markSkippedIndex);
    expect(secondGuardIndex).toBeLessThan(sendPlanIndex);

    const sentEvents = send.mock.calls.map((call) => call[0]?.name);
    expect(sentEvents).toContain("agent/loop.plan");
  });

  test("logs reason and returns early when guardStory blocks verdict write", async () => {
    const opLog: string[] = [];
    const logCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map(String).join(" "));
    };

    try {
      const { fn, updateStoryPass, markStorySkipped, releaseClaim, send } = await loadModule({
        guardResults: [{ ok: false, reason: "already_claimed" }],
        llmVerdict: "pass",
        opLog,
      });

      await fn({ event: makeEvent({ runToken: "token-block-verdict" }), step: makeStep(opLog) });

      expect(updateStoryPass.mock.calls.length).toBe(0);
      expect(markStorySkipped.mock.calls.length).toBe(0);
      expect(releaseClaim.mock.calls.length).toBe(0);
      expect(send.mock.calls.length).toBe(0);
      expect(logCalls.join("\n")).toContain("already_claimed");
    } finally {
      console.log = originalLog;
    }
  });

  test("logs reason and returns early when guardStory blocks loop continuation emit", async () => {
    const opLog: string[] = [];
    const logCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map(String).join(" "));
    };

    try {
      const { fn, updateStoryPass, send } = await loadModule({
        guardResults: [{ ok: true }, { ok: false, reason: "already_passed" }],
        llmVerdict: "pass",
        opLog,
      });

      await fn({ event: makeEvent({ runToken: "token-block-emit" }), step: makeStep(opLog) });

      expect(updateStoryPass.mock.calls.length).toBe(1);
      const sentEvents = send.mock.calls.map((call) => call[0]?.name);
      expect(sentEvents).not.toContain("agent/loop.plan");
      expect(logCalls.join("\n")).toContain("already_passed");
    } finally {
      console.log = originalLog;
    }
  });
});
