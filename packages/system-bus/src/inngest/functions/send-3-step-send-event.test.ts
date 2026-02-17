import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { inngest } from "../client";

const originalInngestSend = inngest.send.bind(inngest);
let inngestSendCallCount = 0;

type StepSendCall = {
  id: string;
  payload: unknown;
};

function createStepMock(params: {
  canned: Record<string, unknown>;
  sendCalls: StepSendCall[];
  runIds?: string[];
}) {
  const { canned, sendCalls } = params;
  const runIds = params.runIds ?? [];

  return {
    run: async (id: string, _work: () => Promise<unknown>) => {
      runIds.push(id);
      if (id in canned) return canned[id];
      throw new Error(`Unexpected step.run id: ${id}`);
    },
    sendEvent: async (id: string, payload: unknown) => {
      sendCalls.push({ id, payload });
      return { ids: [`evt-${id}`] };
    },
  };
}

beforeEach(() => {
  inngestSendCallCount = 0;
  (inngest as { send: (...args: unknown[]) => Promise<unknown> }).send = async () => {
    inngestSendCallCount += 1;
    throw new Error("Unexpected direct inngest.send call");
  };
});

afterEach(() => {
  (inngest as { send: typeof originalInngestSend }).send = originalInngestSend;
});

describe("SEND-3 acceptance tests", () => {
  test("summarize emits content/summarized via step.sendEvent", async () => {
    const mod = await import(`./summarize.ts?send3=${Date.now()}`);
    const fn = (mod.summarize as unknown as { fn: (input: unknown) => Promise<unknown> }).fn;

    const sendCalls: StepSendCall[] = [];

    const result = (await fn({
      event: {
        name: "content/summarize.requested",
        data: {
          vaultPath: "/tmp/vault/example.md",
          prompt: "Use this prompt",
        },
      },
      step: createStepMock({
        canned: {
          "read-title": "Example Title",
          "pi-enrich": undefined,
          "log-and-emit": undefined,
        },
        sendCalls,
      }),
    })) as Record<string, unknown>;

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toMatchObject({
      id: "log-and-emit",
      payload: {
        name: "content/summarized",
        data: {
          vaultPath: "/tmp/vault/example.md",
          title: "Example Title",
        },
      },
    });
    expect(inngestSendCallCount).toBe(0);
    expect(result).toMatchObject({
      vaultPath: "/tmp/vault/example.md",
      title: "Example Title",
      status: "summarized",
    });
  });

  test("discovery capture emits discovery/captured via step.sendEvent", async () => {
    const mod = await import(`./discovery-capture.ts?send3=${Date.now()}`);
    const fn = (mod.discoveryCapture as unknown as { fn: (input: unknown) => Promise<unknown> }).fn;

    const sendCalls: StepSendCall[] = [];

    const result = (await fn({
      event: {
        name: "discovery/noted",
        data: {
          url: "https://example.com/interesting-post",
          context: "Important context",
        },
      },
      step: createStepMock({
        canned: {
          investigate: { content: "sample", sourceType: "article" },
          "generate-note": {
            noteName: "Interesting Discovery",
            vaultPath: "/tmp/vault/Interesting Discovery.md",
            piOutput: "done",
          },
          "slog-result": undefined,
        },
        sendCalls,
      }),
    })) as Record<string, unknown>;

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toMatchObject({
      id: "slog-result",
      payload: {
        name: "discovery/captured",
        data: {
          vaultPath: "/tmp/vault/Interesting Discovery.md",
          topic: "Interesting Discovery",
          slug: "Interesting Discovery",
        },
      },
    });
    expect(inngestSendCallCount).toBe(0);
    expect(result).toMatchObject({
      status: "captured",
      noteName: "Interesting Discovery",
      vaultPath: "/tmp/vault/Interesting Discovery.md",
    });
  });

  test("plan emits dispatch event via step.sendEvent", async () => {
    const mod = await import(`./agent-loop/plan.ts?send3=${Date.now()}`);
    const fn = (mod.agentLoopPlan as unknown as { fn: (input: unknown) => Promise<unknown> }).fn;

    const sendCalls: StepSendCall[] = [];

    const result = (await fn({
      event: {
        name: "agent/loop.story.passed",
        data: {
          loopId: "loop-send3-dispatch",
          project: "/tmp/project",
          maxIterations: 10,
        },
      },
      step: createStepMock({
        canned: {
          "verify-worktree": { exists: true },
          "ensure-worktree-deps": { installed: true },
          "resolve-workdir": "/tmp/agent-loop/worktree/project",
          "check-cancel": false,
          "read-prd": {
            stories: [
              {
                id: "SEND-3",
                title: "Story",
                description: "Do the work",
                acceptance_criteria: ["criterion"],
                priority: 1,
                passes: false,
              },
            ],
          },
          "derive-run-token": "run-token-send3",
          "claim-story": "run-token-send3",
          "emit-test": undefined,
        },
        sendCalls,
      }),
    })) as Record<string, unknown>;

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toMatchObject({
      id: "emit-test",
      payload: {
        name: "agent/loop.story.dispatched",
        data: {
          loopId: "loop-send3-dispatch",
          storyId: "SEND-3",
          runToken: "run-token-send3",
        },
      },
    });
    expect(inngestSendCallCount).toBe(0);
    expect(result).toMatchObject({
      status: "dispatched",
      loopId: "loop-send3-dispatch",
      storyId: "SEND-3",
    });
  });

  test("plan emits completion event at max iterations via step.sendEvent", async () => {
    const mod = await import(`./agent-loop/plan.ts?send3=${Date.now()}`);
    const fn = (mod.agentLoopPlan as unknown as { fn: (input: unknown) => Promise<unknown> }).fn;

    const sendCalls: StepSendCall[] = [];

    const result = (await fn({
      event: {
        name: "agent/loop.story.passed",
        data: {
          loopId: "loop-send3-max",
          project: "/tmp/project",
          maxIterations: 1,
        },
      },
      step: createStepMock({
        canned: {
          "verify-worktree": { exists: true },
          "ensure-worktree-deps": { installed: true },
          "resolve-workdir": "/tmp/agent-loop/worktree/project",
          "check-cancel": false,
          "read-prd": {
            stories: [
              {
                id: "DONE-1",
                title: "Done",
                description: "already done",
                acceptance_criteria: ["criterion"],
                priority: 1,
                passes: true,
              },
            ],
          },
          "emit-complete-max-iterations": undefined,
        },
        sendCalls,
      }),
    })) as Record<string, unknown>;

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toMatchObject({
      id: "emit-complete-max-iterations",
      payload: {
        name: "agent/loop.completed",
        data: {
          loopId: "loop-send3-max",
          storiesCompleted: 1,
        },
      },
    });
    expect(inngestSendCallCount).toBe(0);
    expect(result).toMatchObject({
      status: "max_iterations_reached",
      loopId: "loop-send3-max",
      storiesCompleted: 1,
    });
  });

  test("plan emits completion event when all stories are processed via step.sendEvent", async () => {
    const mod = await import(`./agent-loop/plan.ts?send3=${Date.now()}`);
    const fn = (mod.agentLoopPlan as unknown as { fn: (input: unknown) => Promise<unknown> }).fn;

    const sendCalls: StepSendCall[] = [];

    const result = (await fn({
      event: {
        name: "agent/loop.story.passed",
        data: {
          loopId: "loop-send3-complete",
          project: "/tmp/project",
          maxIterations: 10,
        },
      },
      step: createStepMock({
        canned: {
          "verify-worktree": { exists: true },
          "ensure-worktree-deps": { installed: true },
          "resolve-workdir": "/tmp/agent-loop/worktree/project",
          "check-cancel": false,
          "read-prd": {
            stories: [
              {
                id: "DONE-1",
                title: "Done",
                description: "already done",
                acceptance_criteria: ["criterion"],
                priority: 1,
                passes: true,
              },
            ],
          },
          "read-prd-post-recheck": {
            stories: [
              {
                id: "DONE-1",
                title: "Done",
                passes: true,
              },
            ],
          },
          "emit-complete": undefined,
        },
        sendCalls,
      }),
    })) as Record<string, unknown>;

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toMatchObject({
      id: "emit-complete",
      payload: {
        name: "agent/loop.completed",
        data: {
          loopId: "loop-send3-complete",
          storiesCompleted: 1,
        },
      },
    });
    expect(inngestSendCallCount).toBe(0);
    expect(result).toMatchObject({
      status: "complete",
      loopId: "loop-send3-complete",
      storiesCompleted: 1,
    });
  });

  test("review emits checks completed via step.sendEvent", async () => {
    const mod = await import(`./agent-loop/review.ts?send3=${Date.now()}`);
    const fn = (mod.agentLoopReview as unknown as { fn: (input: unknown) => Promise<unknown> }).fn;

    const sendCalls: StepSendCall[] = [];

    const result = (await fn({
      event: {
        name: "agent/loop.code.committed",
        data: {
          loopId: "loop-send3-review",
          project: "/tmp/project",
          storyId: "SEND-3",
          attempt: 1,
          story: {
            id: "SEND-3",
            title: "Story",
            description: "desc",
            acceptance_criteria: ["criterion"],
          },
          maxRetries: 2,
          maxIterations: 10,
          storyStartedAt: Date.now(),
          retryLadder: ["codex", "claude", "codex"],
          priorFeedback: "",
          runToken: "run-token-review",
          workDir: "/tmp/project",
        },
      },
      step: createStepMock({
        canned: {
          "check-cancel": false,
          "run-checks": {
            typecheckOk: true,
            typecheckOutput: "",
            lintOk: true,
            lintOutput: "",
            testsPassed: 5,
            testsFailed: 0,
            testOutput: "all green",
          },
          "get-story-diff": "diff",
          "collect-test-files": {
            q1: {
              id: "q1",
              answer: true,
              evidence: "New test files in diff: x.test.ts",
            },
            testFiles: [],
          },
          "evaluate-with-claude": {
            blocked: false,
            questions: [
              { id: "q2", answer: true, evidence: "real impl" },
              { id: "q3", answer: true, evidence: "truthful" },
              { id: "q4", answer: true, evidence: "intent met" },
            ],
          },
          "emit-judge": { event: "agent/loop.checks.completed" },
        },
        sendCalls,
      }),
    })) as Record<string, unknown>;

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toMatchObject({
      id: "emit-judge",
      payload: {
        name: "agent/loop.checks.completed",
        data: {
          loopId: "loop-send3-review",
          storyId: "SEND-3",
        },
      },
    });
    expect(inngestSendCallCount).toBe(0);
    expect(result).toMatchObject({
      status: "reviewed",
      loopId: "loop-send3-review",
      storyId: "SEND-3",
      testsFailed: 0,
      typecheckOk: true,
      lintOk: true,
    });
  });

  test("implement emits code committed via step.sendEvent", async () => {
    const mod = await import(`./agent-loop/implement.ts?send3=${Date.now()}`);
    const fn = (mod.agentLoopImplement as unknown as { fn: (input: unknown) => Promise<unknown> }).fn;

    const sendCalls: StepSendCall[] = [];

    const result = (await fn({
      event: {
        name: "agent/loop.tests.written",
        data: {
          loopId: "loop-send3-implement",
          project: "/tmp/project",
          storyId: "SEND-3",
          tool: "codex",
          attempt: 1,
          feedback: "",
          story: {
            id: "SEND-3",
            title: "Story",
            description: "desc",
            acceptance_criteria: ["criterion"],
          },
          maxRetries: 2,
          maxIterations: 10,
          retryLadder: ["codex", "claude", "codex"],
          freshTests: false,
          runToken: "run-token-implement",
          workDir: "/tmp/project",
        },
      },
      step: createStepMock({
        canned: {
          "record-start-time": 1_710_000_000_000,
          "check-cancel": false,
          "check-idempotency": true,
          "get-existing-sha": "abcdef1234567890",
          "emit-review": { event: "agent/loop.code.committed" },
        },
        sendCalls,
      }),
    })) as Record<string, unknown>;

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toMatchObject({
      id: "emit-review",
      payload: {
        name: "agent/loop.code.committed",
        data: {
          loopId: "loop-send3-implement",
          storyId: "SEND-3",
          commitSha: "abcdef1234567890",
          tool: "claude",
        },
      },
    });
    expect(inngestSendCallCount).toBe(0);
    expect(result).toMatchObject({
      status: "implemented",
      loopId: "loop-send3-implement",
      storyId: "SEND-3",
      attempt: 1,
      sha: "abcdef1234567890",
      tool: "codex",
    });
  });

  test("judge pass path emits story passed via step.sendEvent", async () => {
    const mod = await import(`./agent-loop/judge.ts?send3=${Date.now()}`);
    const fn = (mod.agentLoopJudge as unknown as { fn: (input: unknown) => Promise<unknown> }).fn;

    const sendCalls: StepSendCall[] = [];

    const result = (await fn({
      event: {
        name: "agent/loop.checks.completed",
        data: {
          loopId: "loop-send3-judge-pass",
          project: "/tmp/project",
          workDir: "/tmp/project",
          prdPath: "prd.json",
          storyId: "SEND-3",
          testResults: {
            testsPassed: 6,
            testsFailed: 0,
            typecheckOk: true,
            lintOk: true,
            details: "all green",
          },
          feedback: "",
          reviewerNotes: {
            questions: [
              { id: "q2", answer: true, evidence: "real impl" },
              { id: "q3", answer: true, evidence: "truthful" },
              { id: "q4", answer: true, evidence: "intent" },
            ],
            testResults: {
              typecheckOutput: "",
              lintOutput: "",
              testOutput: "",
            },
          },
          attempt: 1,
          maxRetries: 2,
          maxIterations: 10,
          storyStartedAt: Date.now(),
          retryLadder: ["codex", "claude", "codex"],
          priorFeedback: "",
          runToken: "run-token-judge-pass",
          story: {
            id: "SEND-3",
            title: "Story",
            description: "desc",
            acceptance_criteria: ["criterion"],
          },
          tool: "claude",
        },
      },
      step: createStepMock({
        canned: {
          "check-cancel": false,
          "check-gates": {
            mechanicalGatesPass: true,
            mechanicalGateFailures: [],
            reviewerRedFlags: [],
          },
          "get-story-diff": "diff",
          "read-test-files": "",
          "read-project-conventions": "",
          "llm-evaluate": {
            verdict: "pass",
            reasoning: "looks good",
          },
          "guard-before-verdict-write": { ok: true },
          "update-prd": { storyId: "SEND-3", action: "marked-passed" },
          "append-progress": { storyId: "SEND-3", verdict: "pass" },
          "release-claim-pass": { storyId: "SEND-3", action: "released-claim" },
          "emit-story-pass": { event: "agent/loop.story.passed" },
        },
        sendCalls,
      }),
    })) as Record<string, unknown>;

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toMatchObject({
      id: "emit-story-pass",
      payload: {
        name: "agent/loop.story.passed",
        data: {
          loopId: "loop-send3-judge-pass",
          storyId: "SEND-3",
        },
      },
    });
    expect(inngestSendCallCount).toBe(0);
    expect(result).toMatchObject({
      status: "passed",
      loopId: "loop-send3-judge-pass",
      storyId: "SEND-3",
      attempt: 1,
    });
  });

  test("judge retry path emits story retried via step.sendEvent", async () => {
    const mod = await import(`./agent-loop/judge.ts?send3=${Date.now()}`);
    const fn = (mod.agentLoopJudge as unknown as { fn: (input: unknown) => Promise<unknown> }).fn;

    const sendCalls: StepSendCall[] = [];

    const result = (await fn({
      event: {
        name: "agent/loop.checks.completed",
        data: {
          loopId: "loop-send3-judge-retry",
          project: "/tmp/project",
          workDir: "/tmp/project",
          prdPath: "prd.json",
          storyId: "SEND-3",
          testResults: {
            testsPassed: 3,
            testsFailed: 1,
            typecheckOk: true,
            lintOk: true,
            details: "1 failing test",
          },
          feedback: "needs work",
          reviewerNotes: {
            questions: [
              { id: "q2", answer: true, evidence: "real impl" },
              { id: "q3", answer: true, evidence: "truthful" },
              { id: "q4", answer: true, evidence: "intent" },
            ],
            testResults: {
              typecheckOutput: "",
              lintOutput: "",
              testOutput: "1 failing test",
            },
          },
          attempt: 1,
          maxRetries: 3,
          maxIterations: 10,
          storyStartedAt: Date.now(),
          retryLadder: ["codex", "claude", "codex"],
          priorFeedback: "same fail",
          runToken: "run-token-judge-retry",
          story: {
            id: "SEND-3",
            title: "Story",
            description: "desc",
            acceptance_criteria: ["criterion"],
          },
          tool: "claude",
        },
      },
      step: createStepMock({
        canned: {
          "check-cancel": false,
          "check-gates": {
            mechanicalGatesPass: false,
            mechanicalGateFailures: ["1 test(s) failed."],
            reviewerRedFlags: [],
          },
          "emit-retry-implement": { event: "agent/loop.story.retried" },
        },
        sendCalls,
      }),
    })) as Record<string, unknown>;

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toMatchObject({
      id: "emit-retry-implement",
      payload: {
        name: "agent/loop.story.retried",
        data: {
          loopId: "loop-send3-judge-retry",
          storyId: "SEND-3",
          attempt: 2,
        },
      },
    });
    expect(inngestSendCallCount).toBe(0);
    expect(result).toMatchObject({
      status: "retry",
      loopId: "loop-send3-judge-retry",
      storyId: "SEND-3",
      nextAttempt: 2,
    });
  });

  test("judge fail path emits story failed via step.sendEvent", async () => {
    const mod = await import(`./agent-loop/judge.ts?send3=${Date.now()}`);
    const fn = (mod.agentLoopJudge as unknown as { fn: (input: unknown) => Promise<unknown> }).fn;

    const sendCalls: StepSendCall[] = [];

    const result = (await fn({
      event: {
        name: "agent/loop.checks.completed",
        data: {
          loopId: "loop-send3-judge-fail",
          project: "/tmp/project",
          workDir: "/tmp/project",
          prdPath: "prd.json",
          storyId: "SEND-3",
          testResults: {
            testsPassed: 2,
            testsFailed: 2,
            typecheckOk: false,
            lintOk: true,
            details: "still failing",
          },
          feedback: "needs changes",
          reviewerNotes: {
            questions: [
              { id: "q2", answer: false, evidence: "stubbed behavior" },
              { id: "q3", answer: false, evidence: "gaming tests" },
              { id: "q4", answer: false, evidence: "intent not met" },
            ],
            testResults: {
              typecheckOutput: "failed",
              lintOutput: "",
              testOutput: "still failing",
            },
          },
          attempt: 2,
          maxRetries: 2,
          maxIterations: 10,
          storyStartedAt: Date.now(),
          retryLadder: ["codex", "claude", "codex"],
          priorFeedback: "same fail",
          runToken: "run-token-judge-fail",
          story: {
            id: "SEND-3",
            title: "Story",
            description: "desc",
            acceptance_criteria: ["criterion"],
          },
          tool: "claude",
        },
      },
      step: createStepMock({
        canned: {
          "check-cancel": false,
          "check-gates": {
            mechanicalGatesPass: false,
            mechanicalGateFailures: ["Typecheck failed.", "2 test(s) failed."],
            reviewerRedFlags: ["q2: stubbed behavior"],
          },
          "guard-before-verdict-write": { ok: true },
          "mark-skipped": { storyId: "SEND-3", action: "marked-skipped" },
          "append-progress-fail": { storyId: "SEND-3", verdict: "skipped" },
          "emit-story-fail": { event: "agent/loop.story.failed" },
          "release-claim-skip": { storyId: "SEND-3", action: "released-claim" },
        },
        sendCalls,
      }),
    })) as Record<string, unknown>;

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toMatchObject({
      id: "emit-story-fail",
      payload: {
        name: "agent/loop.story.failed",
        data: {
          loopId: "loop-send3-judge-fail",
          storyId: "SEND-3",
          attempts: 2,
        },
      },
    });
    expect(inngestSendCallCount).toBe(0);
    expect(result).toMatchObject({
      status: "skipped",
      loopId: "loop-send3-judge-fail",
      storyId: "SEND-3",
      attempts: 2,
    });
  });

  test("retro emits retro completed via step.sendEvent", async () => {
    const mod = await import(`./agent-loop/retro.ts?send3=${Date.now()}`);
    const fn = (mod.agentLoopRetro as unknown as { fn: (input: unknown) => Promise<unknown> }).fn;

    const sendCalls: StepSendCall[] = [];

    const result = (await fn({
      event: {
        name: "agent/loop.completed",
        data: {
          loopId: "loop-send3-retro",
          project: "/tmp/project",
          summary: "done",
          storiesCompleted: 3,
          storiesFailed: 1,
          cancelled: false,
          branchName: "agent-loop/loop-send3-retro",
        },
      },
      step: createStepMock({
        canned: {
          "read-progress": "progress log",
          "read-prd": {
            stories: [
              { id: "SEND-1", title: "Story 1", passes: true },
              { id: "SEND-2", title: "Story 2", passes: true },
              { id: "SEND-3", title: "Story 3", passes: false, skipped: true },
            ],
          },
          "llm-reflection": {
            analysis: "- Pattern found",
            narrative: "Retrospective narrative",
            error: null,
          },
          "write-retrospective-note": "/tmp/vault/system/retrospectives/loop-send3-retro.md",
          "write-planner-recommendations": {
            project: "/tmp/project",
            sourceLoopId: "loop-send3-retro",
          },
          "write-codebase-patterns": {
            project: "/tmp/project",
            hasPatterns: true,
          },
          "emit-retro-complete": undefined,
        },
        sendCalls,
      }),
    })) as Record<string, unknown>;

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toMatchObject({
      id: "emit-retro-complete",
      payload: {
        name: "agent/loop.retro.completed",
        data: {
          loopId: "loop-send3-retro",
          project: "/tmp/project",
        },
      },
    });
    expect(inngestSendCallCount).toBe(0);
    expect(result).toMatchObject({
      status: "retro-complete",
      loopId: "loop-send3-retro",
      storiesCompleted: 3,
      storiesFailed: 1,
    });
  });

  test("grep -r \"inngest.send\" has zero matches in src/inngest/functions (excluding tests)", async () => {
    const proc = Bun.spawn(
      [
        "sh",
        "-lc",
        "grep -r \"inngest.send\" src/inngest/functions/ --include=\"*.ts\" | grep -v test",
      ],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
    expect(stdout.trim()).toBe("");
    expect(stderr.trim()).toBe("");
  });

  test(
    "TypeScript compiles cleanly: bunx tsc --noEmit",
    async () => {
      const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    },
    30_000
  );
});
