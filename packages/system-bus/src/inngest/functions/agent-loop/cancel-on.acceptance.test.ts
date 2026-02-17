import { describe, expect, test } from "bun:test";
import type { Events } from "../../client";
import { agentLoopPlan } from "./plan";
import { agentLoopTestWriter } from "./test-writer";
import { agentLoopImplement } from "./implement";
import { agentLoopReview } from "./review";
import { agentLoopJudge } from "./judge";
import { agentLoopComplete } from "./complete";
import { agentLoopRetro } from "./retro";

const expectedCancelRule = {
  event: "agent/loop.cancelled",
  if: "event.data.loopId == async.data.loopId",
};

const loopFunctions = [
  { name: "plan", fn: agentLoopPlan },
  { name: "test-writer", fn: agentLoopTestWriter },
  { name: "implement", fn: agentLoopImplement },
  { name: "review", fn: agentLoopReview },
  { name: "judge", fn: agentLoopJudge },
  { name: "complete", fn: agentLoopComplete },
  { name: "retro", fn: agentLoopRetro },
] as const;

type InngestFn = {
  opts?: {
    cancelOn?: Array<{ event?: string; if?: string }>;
  };
  fn: (args: { event: { name: string; data: Record<string, unknown> }; step: any }) => Promise<unknown>;
};

function getCancelOnRules(fn: InngestFn): Array<{ event?: string; if?: string }> {
  return fn.opts?.cancelOn ?? [];
}

describe("CANCEL-1 acceptance: cancelOn on all agent-loop functions", () => {
  test("all 7 loop functions define cancelOn with loopId match against agent/loop.cancelled", () => {
    for (const entry of loopFunctions) {
      const rules = getCancelOnRules(entry.fn as unknown as InngestFn);
      const matchingRule = rules.find((rule) => rule.event === "agent/loop.cancelled");

      expect(matchingRule, `${entry.name} is missing cancelOn for agent/loop.cancelled`).toBeDefined();
      expect(matchingRule).toMatchObject(expectedCancelRule);
    }
  });

  test("agent/loop.cancelled event schema includes loopId in typed data", () => {
    const cancelledEvent: Events["agent/loop.cancelled"] = {
      data: {
        loopId: "loop-cancel-1",
        reason: "user_requested",
      },
    };

    const takeLoopId = (loopId: string) => loopId;
    const loopId = takeLoopId(cancelledEvent.data.loopId);

    expect(cancelledEvent).toMatchObject({
      data: {
        loopId,
      },
    });
  });
});

describe("CANCEL-1 acceptance: existing cancellation polling behavior is preserved", () => {
  const cancellableFunctions = [
    { name: "plan", fn: agentLoopPlan, event: "agent/loop.story.passed", data: { loopId: "loop-1", project: "/tmp/project", prdPath: "prd.json", storyId: "S-1", commitSha: "abc123", attempt: 1, duration: 1 } },
    { name: "test-writer", fn: agentLoopTestWriter, event: "agent/loop.story.dispatched", data: { loopId: "loop-1", project: "/tmp/project", storyId: "S-1", runToken: "token-1", tool: "codex", attempt: 1, maxRetries: 2, story: { id: "S-1", title: "Story", description: "Desc", acceptance_criteria: ["ac-1"] } } },
    { name: "implement", fn: agentLoopImplement, event: "agent/loop.tests.written", data: { loopId: "loop-1", project: "/tmp/project", storyId: "S-1", runToken: "token-1", tool: "codex", attempt: 1, maxRetries: 2, story: { id: "S-1", title: "Story", description: "Desc", acceptance_criteria: ["ac-1"] } } },
    { name: "review", fn: agentLoopReview, event: "agent/loop.code.committed", data: { loopId: "loop-1", project: "/tmp/project", storyId: "S-1", runToken: "token-1", commitSha: "abc123", attempt: 1, tool: "claude", maxRetries: 2, story: { id: "S-1", title: "Story", description: "Desc", acceptance_criteria: ["ac-1"] } } },
    { name: "judge", fn: agentLoopJudge, event: "agent/loop.checks.completed", data: { loopId: "loop-1", project: "/tmp/project", storyId: "S-1", runToken: "token-1", prdPath: "prd.json", attempt: 1, maxRetries: 2, story: { id: "S-1", title: "Story", description: "Desc", acceptance_criteria: ["ac-1"] }, tool: "codex", feedback: "feedback", testResults: { testsPassed: 0, testsFailed: 0, typecheckOk: true, lintOk: true, details: "" } } },
  ] as const;

  test("functions that previously polled cancellation still short-circuit on check-cancel", async () => {
    for (const entry of cancellableFunctions) {
      const runCalls: string[] = [];

      const step = {
        run: async (name: string, fn?: () => unknown) => {
          runCalls.push(name);
          if (name === "record-start-time") return Date.now();
          if (name === "check-cancel") return true;
          if (typeof fn === "function") return fn();
          return undefined;
        },
        sendEvent: async () => {
          throw new Error(`${entry.name} should not emit when cancelled`);
        },
      };

      const result = await (entry.fn as unknown as InngestFn).fn({
        event: {
          name: entry.event,
          data: entry.data as Record<string, unknown>,
        },
        step,
      });

      expect(runCalls).toContain("check-cancel");
      expect(result).toMatchObject({ status: "cancelled", loopId: "loop-1" });
    }
  });
});

describe("CANCEL-1 acceptance: TypeScript compiles cleanly", () => {
  test("bunx tsc --noEmit exits successfully", async () => {
    const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
      cwd: new URL("../../../../..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });
  });
});
