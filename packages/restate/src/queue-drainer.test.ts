import { describe, expect, test } from "bun:test";
import { Priority, type QueueEventRegistryEntry, type StoredMessage } from "@joelclaw/queue";
import { __queueDrainerTestUtils } from "./queue-drainer";

const {
  buildDispatchWorkflowId,
  buildHttpDispatchNode,
  buildInngestDispatchNode,
  createImmediateTickScheduler,
  detectQueueDrainerStall,
  normalizeEnvelope,
} = __queueDrainerTestUtils;

describe("queue drainer helpers", () => {
  test("normalizeEnvelope falls back to queue stream id and defaults", () => {
    const message: StoredMessage = {
      id: "1741390743510-0",
      payload: {
        name: "discovery/noted",
        data: { url: "https://example.com" },
      },
      timestamp: 1741390743510,
      priority: Priority.P2,
      acked: false,
    };

    expect(normalizeEnvelope(message)).toEqual({
      id: "queue:1741390743510-0",
      name: "discovery/noted",
      source: "queue",
      ts: 1741390743510,
      data: { url: "https://example.com" },
      priority: Priority.P2,
    });
  });

  test("buildDispatchWorkflowId is stable and sanitized", () => {
    const message: StoredMessage = {
      id: "1741390743510-0",
      payload: {
        id: "evt:abc/123",
        name: "content/updated",
        data: {},
      },
      timestamp: 1741390743510,
      priority: Priority.P1,
      acked: false,
    };

    const envelope = normalizeEnvelope(message);
    expect(buildDispatchWorkflowId(message, envelope)).toBe("queue-dispatch-evt-abc-123");
  });

  test("buildInngestDispatchNode preserves event id and target", () => {
    const registry: QueueEventRegistryEntry = {
      name: "subscription/check-feeds.requested",
      priority: Priority.P2,
      handler: {
        type: "inngest",
        target: "subscription/check-feeds.requested",
      },
    };

    const envelope = {
      id: "evt_123",
      name: "subscription/check-feeds.requested",
      source: "cli",
      ts: 1741390743510,
      data: { forceAll: false },
      priority: Priority.P2,
    };

    const node = buildInngestDispatchNode(registry, envelope, "http://localhost:8288/", "test-key");

    expect(node.handler).toBe("http");
    expect(node.config?.url).toBe("http://localhost:8288/e/test-key");
    expect(node.config?.method).toBe("POST");
    expect(JSON.parse(String(node.config?.body))).toEqual({
      id: "evt_123",
      name: "subscription/check-feeds.requested",
      ts: 1741390743510,
      data: { forceAll: false },
    });
  });

  test("buildHttpDispatchNode posts raw queue data to target", () => {
    const registry: QueueEventRegistryEntry = {
      name: "example/http",
      priority: Priority.P1,
      handler: {
        type: "http",
        target: "https://example.com/hook",
      },
    };

    const envelope = {
      id: "evt_http",
      name: "example/http",
      source: "cli",
      ts: 1741390743510,
      data: { hello: "world" },
      priority: Priority.P1,
    };

    const node = buildHttpDispatchNode(registry, envelope);

    expect(node.config?.url).toBe("https://example.com/hook");
    expect(JSON.parse(String(node.config?.body))).toEqual({ hello: "world" });
  });

  test("detectQueueDrainerStall ignores empty queues and active backoff windows", () => {
    expect(detectQueueDrainerStall({
      now: 100_000,
      queueDepth: 0,
      draining: false,
      stopping: false,
      activeDispatchAgesMs: [],
      lastTickStartedAt: null,
      lastTickFinishedAt: 99_000,
      nextRetryAt: null,
      stallAfterMs: 10_000,
    })).toBeNull();

    expect(detectQueueDrainerStall({
      now: 100_000,
      queueDepth: 3,
      draining: false,
      stopping: false,
      activeDispatchAgesMs: [],
      lastTickStartedAt: null,
      lastTickFinishedAt: 80_000,
      nextRetryAt: 105_000,
      stallAfterMs: 10_000,
    })).toBeNull();
  });

  test("detectQueueDrainerStall flags hung ticks, hung dispatches, and idle backlog", () => {
    expect(detectQueueDrainerStall({
      now: 100_000,
      queueDepth: 2,
      draining: true,
      stopping: false,
      activeDispatchAgesMs: [],
      lastTickStartedAt: 80_000,
      lastTickFinishedAt: 79_000,
      nextRetryAt: null,
      stallAfterMs: 10_000,
    })).toEqual({ reason: "tick_hung", ageMs: 20_000 });

    expect(detectQueueDrainerStall({
      now: 100_000,
      queueDepth: 2,
      draining: false,
      stopping: false,
      activeDispatchAgesMs: [2_000, 14_000],
      lastTickStartedAt: 98_000,
      lastTickFinishedAt: 98_500,
      nextRetryAt: null,
      stallAfterMs: 10_000,
    })).toEqual({ reason: "dispatch_hung", ageMs: 14_000 });

    expect(detectQueueDrainerStall({
      now: 100_000,
      queueDepth: 4,
      draining: false,
      stopping: false,
      activeDispatchAgesMs: [],
      lastTickStartedAt: 70_000,
      lastTickFinishedAt: 85_000,
      nextRetryAt: null,
      stallAfterMs: 10_000,
    })).toEqual({ reason: "backlog_idle", ageMs: 15_000 });
  });

  test("createImmediateTickScheduler coalesces same-turn follow-up drain requests", async () => {
    let calls = 0;
    const schedule = createImmediateTickScheduler(() => {
      calls += 1;
    });

    schedule();
    schedule();
    schedule();
    expect(calls).toBe(0);

    await Promise.resolve();
    expect(calls).toBe(1);

    schedule();
    await Promise.resolve();
    expect(calls).toBe(2);
  });
});
