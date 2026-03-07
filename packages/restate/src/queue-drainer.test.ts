import { describe, expect, test } from "bun:test";
import { Priority, type QueueEventRegistryEntry, type StoredMessage } from "@joelclaw/queue";
import { __queueDrainerTestUtils } from "./queue-drainer";

const { buildDispatchWorkflowId, buildHttpDispatchNode, buildInngestDispatchNode, normalizeEnvelope } = __queueDrainerTestUtils;

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
});
