import { afterEach, describe, expect, test } from "bun:test";
import {
  __callbackTraceTestUtils,
  acknowledgeCallbackTrace,
  completeCallbackTrace,
  failCallbackTrace,
  getCallbackTraceSnapshot,
  markCallbackTraceDispatched,
  startCallbackTrace,
} from "./callback-trace";

afterEach(() => {
  __callbackTraceTestUtils.reset();
});

describe("callback trace", () => {
  test("records acknowledge, dispatch, and completion", () => {
    const traceId = startCallbackTrace({
      handler: "telegram.commands",
      route: "cmd:model",
      rawData: "cmd:model:haiku",
      chatId: 1,
      messageId: 2,
    });

    acknowledgeCallbackTrace(traceId, { text: "Queued /model" });
    markCallbackTraceDispatched(traceId, "command enqueued");
    completeCallbackTrace(traceId, "agent command queued");

    const snapshot = getCallbackTraceSnapshot();
    expect(snapshot.activeCount).toBe(0);
    expect(snapshot.lastCompleted?.traceId).toBe(traceId);
    expect(snapshot.lastCompleted?.ack.state).toBe("succeeded");
    expect(snapshot.lastCompleted?.detail).toBe("agent command queued");
  });

  test("records failures", () => {
    const traceId = startCallbackTrace({
      handler: "telegram.worktree",
      route: "worktree:merge",
      rawData: "worktree:merge:demo",
    });

    acknowledgeCallbackTrace(traceId, { text: "Processing..." });
    failCallbackTrace(traceId, "merge exploded", "worktree merge failed");

    const snapshot = getCallbackTraceSnapshot();
    expect(snapshot.lastFailed?.traceId).toBe(traceId);
    expect(snapshot.lastFailed?.error).toBe("merge exploded");
    expect(snapshot.lastFailed?.detail).toBe("worktree merge failed");
  });

  test("records timeout and removes active trace", async () => {
    const timedOut: string[] = [];

    startCallbackTrace(
      {
        handler: "telegram.callback",
        route: "external:demo",
        rawData: "demo:123",
      },
      {
        timeoutMs: 10,
        onTimeout: (trace) => {
          timedOut.push(trace.traceId);
        },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 30));

    const snapshot = getCallbackTraceSnapshot();
    expect(snapshot.activeCount).toBe(0);
    expect(snapshot.lastTimedOut?.status).toBe("timed_out");
    expect(timedOut).toEqual([snapshot.lastTimedOut?.traceId]);
  });
});
