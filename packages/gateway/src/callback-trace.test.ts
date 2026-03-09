import { afterEach, describe, expect, test } from "bun:test";
import {
  __callbackTraceTestUtils,
  acknowledgeOperatorTrace,
  applyExternalOperatorTraceResult,
  completeOperatorTrace,
  failOperatorTrace,
  getOperatorTraceSnapshot,
  markOperatorTraceDispatched,
  startOperatorTrace,
} from "./callback-trace";

afterEach(() => {
  __callbackTraceTestUtils.reset();
});

describe("operator trace", () => {
  test("records callback acknowledge, dispatch, and completion", () => {
    const traceId = startOperatorTrace({
      kind: "callback",
      handler: "telegram.commands",
      route: "cmd:model",
      rawData: "cmd:model:haiku",
      chatId: 1,
      messageId: 2,
    });

    acknowledgeOperatorTrace(traceId, { text: "Queued /model" });
    markOperatorTraceDispatched(traceId, "command enqueued");
    completeOperatorTrace(traceId, "agent command queued");

    const snapshot = getOperatorTraceSnapshot();
    expect(snapshot.activeCount).toBe(0);
    expect(snapshot.lastCompleted?.traceId).toBe(traceId);
    expect(snapshot.lastCompleted?.kind).toBe("callback");
    expect(snapshot.lastCompleted?.ack.state).toBe("succeeded");
    expect(snapshot.lastCompleted?.detail).toBe("agent command queued");
  });

  test("records command traces with command-prefixed ids", () => {
    const traceId = startOperatorTrace({
      kind: "command",
      handler: "telegram.commands",
      route: "command:status",
      rawData: "/status",
      chatId: 1,
      messageId: 3,
    });

    acknowledgeOperatorTrace(traceId, { text: "Running /status" });
    markOperatorTraceDispatched(traceId, "executing direct command /status");
    completeOperatorTrace(traceId, "direct command finished");

    const snapshot = getOperatorTraceSnapshot();
    expect(traceId.startsWith("cmd_")).toBe(true);
    expect(snapshot.lastCompleted?.kind).toBe("command");
    expect(snapshot.lastCompleted?.route).toBe("command:status");
  });

  test("records failures", () => {
    const traceId = startOperatorTrace({
      kind: "callback",
      handler: "telegram.worktree",
      route: "worktree:merge",
      rawData: "worktree:merge:demo",
    });

    acknowledgeOperatorTrace(traceId, { text: "Processing..." });
    failOperatorTrace(traceId, "merge exploded", "worktree merge failed");

    const snapshot = getOperatorTraceSnapshot();
    expect(snapshot.lastFailed?.traceId).toBe(traceId);
    expect(snapshot.lastFailed?.error).toBe("merge exploded");
    expect(snapshot.lastFailed?.detail).toBe("worktree merge failed");
  });

  test("applies external completion results to active traces", () => {
    const traceId = startOperatorTrace({
      kind: "callback",
      handler: "telegram.callback",
      route: "external:restate",
      rawData: "restate:deploy:123:approve",
    });

    markOperatorTraceDispatched(traceId, "published to joelclaw:telegram:callbacks:restate");
    expect(applyExternalOperatorTraceResult({
      traceId,
      status: "completed",
      detail: "restate approval resolved",
    })).toBe(true);

    const snapshot = getOperatorTraceSnapshot();
    expect(snapshot.lastCompleted?.traceId).toBe(traceId);
    expect(snapshot.lastCompleted?.detail).toBe("restate approval resolved");
  });

  test("surfaces the longest active/recent timeout in the snapshot", () => {
    const traceId = startOperatorTrace(
      {
        kind: "command",
        handler: "telegram.commands",
        route: "command:long-running",
        rawData: "/long-running",
      },
      { timeoutMs: 120_000 },
    );

    const snapshot = getOperatorTraceSnapshot();
    expect(snapshot.timeoutMs).toBe(120_000);

    completeOperatorTrace(traceId, "done");
    expect(getOperatorTraceSnapshot().timeoutMs).toBe(120_000);
  });

  test("records timeout and removes active trace", async () => {
    const timedOut: string[] = [];

    startOperatorTrace(
      {
        kind: "callback",
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

    const snapshot = getOperatorTraceSnapshot();
    expect(snapshot.activeCount).toBe(0);
    expect(snapshot.lastTimedOut?.status).toBe("timed_out");
    expect(snapshot.lastTimedOut?.traceId).toBeDefined();
    expect(timedOut).toEqual([snapshot.lastTimedOut!.traceId]);
  });

  test("does not overwrite a timed out trace with a late completion", async () => {
    const traceId = startOperatorTrace(
      {
        kind: "command",
        handler: "telegram.commands",
        route: "command:reload",
        rawData: "/reload",
      },
      { timeoutMs: 10 },
    );

    await new Promise((resolve) => setTimeout(resolve, 30));

    completeOperatorTrace(traceId, "late completion should be ignored");

    const snapshot = getOperatorTraceSnapshot();
    expect(snapshot.lastTimedOut?.traceId).toBe(traceId);
    expect(snapshot.lastTimedOut?.detail).not.toBe("late completion should be ignored");
    expect(snapshot.lastCompleted?.traceId).not.toBe(traceId);
  });

  test("ignores late external results after timeout", async () => {
    const traceId = startOperatorTrace(
      {
        kind: "callback",
        handler: "telegram.callback",
        route: "external:restate",
        rawData: "restate:deploy:123:approve",
      },
      { timeoutMs: 10 },
    );

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(applyExternalOperatorTraceResult({
      traceId,
      status: "completed",
      detail: "late restate resolution",
    })).toBe(false);

    const snapshot = getOperatorTraceSnapshot();
    expect(snapshot.lastTimedOut?.traceId).toBe(traceId);
    expect(snapshot.lastCompleted?.traceId).not.toBe(traceId);
  });
});
