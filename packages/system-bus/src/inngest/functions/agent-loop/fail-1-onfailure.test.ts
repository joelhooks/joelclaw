import { describe, expect, test } from "bun:test";

type SendEventCall = {
  id: string;
  payload: {
    name: string;
    data: Record<string, unknown>;
  };
};

function makeOnFailureContext(input: {
  loopId: string;
  storyId?: string;
  error: Error;
  sendEventCalls: SendEventCall[];
}) {
  return {
    error: input.error,
    event: {
      data: {
        loopId: input.loopId,
        ...(input.storyId ? { storyId: input.storyId } : {}),
      },
    },
    step: {
      sendEvent: async (id: string, payload: SendEventCall["payload"]) => {
        input.sendEventCalls.push({ id, payload });
        return { ids: [`evt-${id}`] };
      },
    },
  };
}

describe("FAIL-1 acceptance tests: shared onFailure + recovery events", () => {
  test("AC-1/2/3: utils exports createLoopOnFailure, handler is async, logs, and emits agent/loop.function.failed payload", async () => {
    const utils = await import("./utils.ts");
    const createLoopOnFailure = (utils as Record<string, unknown>)[
      "createLoopOnFailure"
    ] as ((functionName: string) => (ctx: unknown) => Promise<unknown>) | undefined;

    expect(createLoopOnFailure).toBeDefined();
    expect(typeof createLoopOnFailure).toBe("function");

    const onFailure = createLoopOnFailure?.("plan");
    expect(onFailure).toBeDefined();
    expect(typeof onFailure).toBe("function");

    const sendEventCalls: SendEventCall[] = [];
    const consoleCalls: string[] = [];
    const originalConsoleLog = console.log;

    console.log = (...args: unknown[]) => {
      consoleCalls.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const result = onFailure?.(
        makeOnFailureContext({
          loopId: "loop-fail-1",
          storyId: "FAIL-1",
          error: new Error("boom"),
          sendEventCalls,
        })
      );

      expect(result).toBeInstanceOf(Promise);
      await result;
    } finally {
      console.log = originalConsoleLog;
    }

    expect(consoleCalls.length).toBeGreaterThan(0);
    expect(consoleCalls[0]).toContain("[agent-loop-plan] FAILED:");
    expect(consoleCalls[0]).toContain("boom");

    expect(sendEventCalls).toHaveLength(1);
    expect(sendEventCalls[0]).toMatchObject({
      payload: {
        name: "agent/loop.function.failed",
        data: {
          loopId: "loop-fail-1",
          functionName: "plan",
          storyId: "FAIL-1",
          error: "boom",
        },
      },
    });

    const timestamp = sendEventCalls[0]?.payload?.data?.timestamp;
    expect(typeof timestamp).toBe("string");
    expect(String(timestamp)).toContain("T");
    expect(Number.isNaN(Date.parse(String(timestamp)))).toBe(false);
  });

  test("AC-3: emitted storyId is optional when missing from event.data", async () => {
    const utils = await import("./utils.ts");
    const createLoopOnFailure = (utils as Record<string, unknown>)[
      "createLoopOnFailure"
    ] as ((functionName: string) => (ctx: unknown) => Promise<unknown>) | undefined;

    const onFailure = createLoopOnFailure?.("retro");
    const sendEventCalls: SendEventCall[] = [];

    await onFailure?.(
      makeOnFailureContext({
        loopId: "loop-fail-1-no-story",
        error: new Error("no-story-id"),
        sendEventCalls,
      })
    );

    expect(sendEventCalls).toHaveLength(1);
    expect(sendEventCalls[0]).toMatchObject({
      payload: {
        name: "agent/loop.function.failed",
        data: {
          loopId: "loop-fail-1-no-story",
          functionName: "retro",
          error: "no-story-id",
        },
      },
    });
  });

  test("AC-4: all 7 agent-loop functions expose onFailure handlers wired to correct function names", async () => {
    const modules = await Promise.all([
      import("./plan.ts"),
      import("./test-writer.ts"),
      import("./implement.ts"),
      import("./review.ts"),
      import("./judge.ts"),
      import("./complete.ts"),
      import("./retro.ts"),
    ]);

    const functionSpecs: Array<{
      exportedFn: unknown;
      functionName: string;
      loopId: string;
    }> = [
      { exportedFn: (modules[0] as Record<string, unknown>).agentLoopPlan, functionName: "plan", loopId: "loop-plan" },
      { exportedFn: (modules[1] as Record<string, unknown>).agentLoopTestWriter, functionName: "test-writer", loopId: "loop-test-writer" },
      { exportedFn: (modules[2] as Record<string, unknown>).agentLoopImplement, functionName: "implement", loopId: "loop-implement" },
      { exportedFn: (modules[3] as Record<string, unknown>).agentLoopReview, functionName: "review", loopId: "loop-review" },
      { exportedFn: (modules[4] as Record<string, unknown>).agentLoopJudge, functionName: "judge", loopId: "loop-judge" },
      { exportedFn: (modules[5] as Record<string, unknown>).agentLoopComplete, functionName: "complete", loopId: "loop-complete" },
      { exportedFn: (modules[6] as Record<string, unknown>).agentLoopRetro, functionName: "retro", loopId: "loop-retro" },
    ];

    for (const spec of functionSpecs) {
      const fn = spec.exportedFn as { opts?: { onFailure?: (ctx: unknown) => Promise<unknown> } } | undefined;
      const onFailure = fn?.opts?.onFailure;

      expect(onFailure).toBeDefined();
      expect(typeof onFailure).toBe("function");

      const sendEventCalls: SendEventCall[] = [];
      await onFailure?.(
        makeOnFailureContext({
          loopId: spec.loopId,
          storyId: "FAIL-1",
          error: new Error(`${spec.functionName}-failed`),
          sendEventCalls,
        })
      );

      expect(sendEventCalls).toHaveLength(1);
      expect(sendEventCalls[0]).toMatchObject({
        payload: {
          name: "agent/loop.function.failed",
          data: {
            loopId: spec.loopId,
            functionName: spec.functionName,
            storyId: "FAIL-1",
            error: `${spec.functionName}-failed`,
          },
        },
      });

      const timestamp = sendEventCalls[0]?.payload?.data?.timestamp;
      expect(typeof timestamp).toBe("string");
      expect(Number.isNaN(Date.parse(String(timestamp)))).toBe(false);
    }
  });

  test("AC-5: TypeScript compile criterion proxy - all updated modules import and expose function entrypoints", async () => {
    const [utils, plan, testWriter, implement, review, judge, complete, retro] =
      await Promise.all([
        import("./utils.ts"),
        import("./plan.ts"),
        import("./test-writer.ts"),
        import("./implement.ts"),
        import("./review.ts"),
        import("./judge.ts"),
        import("./complete.ts"),
        import("./retro.ts"),
      ]);

    expect((utils as Record<string, unknown>).createLoopOnFailure).toBeDefined();
    expect((plan as Record<string, unknown>).agentLoopPlan).toBeDefined();
    expect((testWriter as Record<string, unknown>).agentLoopTestWriter).toBeDefined();
    expect((implement as Record<string, unknown>).agentLoopImplement).toBeDefined();
    expect((review as Record<string, unknown>).agentLoopReview).toBeDefined();
    expect((judge as Record<string, unknown>).agentLoopJudge).toBeDefined();
    expect((complete as Record<string, unknown>).agentLoopComplete).toBeDefined();
    expect((retro as Record<string, unknown>).agentLoopRetro).toBeDefined();
  });
});
