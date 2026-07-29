import { describe, expect, test } from "bun:test";
import {
  createNotifyCompatibilityPayload,
  notifyTerminalFailureCode,
  waitForNotifyTerminalReceipt,
} from "./gateway-redis";

const flowId = "notify:11111111-1111-4111-8111-111111111111";
const correlationId = "campaign-pulse:11111111-1111-4111-8111-111111111111";

const receipt = JSON.stringify({
  flowId,
  correlationId,
  platform: "telegram",
  platformMessageId: "7718912466:14562",
  deliveryState: "confirmed",
  declaredActions: [
    { kind: "callback", id: "learner-flow.ack", label: "Seen" },
    { kind: "callback", id: "learner-flow.run", label: "Run flow agent" },
    { kind: "callback", id: "learner-flow.investigate", label: "Investigate" },
  ],
  confirmedAt: "2026-07-19T15:00:00.000Z",
});

function canonicalTrace(
  events: Array<Record<string, unknown>>,
): Awaited<ReturnType<Parameters<
  typeof waitForNotifyTerminalReceipt
>[1]["trace"]>> {
  return {
    kind: "trace",
    source: "convex",
    flowId,
    projection: null,
    events,
    consumerReceipts: [],
    truncated: false,
  } as Awaited<ReturnType<Parameters<
    typeof waitForNotifyTerminalReceipt
  >[1]["trace"]>>;
}

function event(
  kind: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _id: `event-${kind}`,
    _creationTime: 1,
    schemaVersion: 1,
    sequence: 1,
    semanticKey: `test:${kind}`,
    kind,
    source: "test",
    payload: {},
    occurredAt: 1_753_000_000_000,
    recordedAt: 1_753_000_000_000,
    flowId,
    ...overrides,
  };
}

describe("notify terminal receipt wait", () => {
  test("returns the confirmed receipt under the source/event correlation key", async () => {
    const keys: string[] = [];
    const result = await waitForNotifyTerminalReceipt(
      {
        flowId,
        correlationId,
        timeoutMs: 1_000,
      },
      {
        trace: async () => canonicalTrace([]),
        get: async (key) => {
          keys.push(key);
          return receipt;
        },
      },
    );

    expect(keys).toEqual([
      `joelclaw:message-contract:correlation:${correlationId}`,
    ]);
    expect(result).toMatchObject({
      deliveryState: "confirmed",
      platformMessageId: "7718912466:14562",
      declaredActions: [
        { id: "learner-flow.ack" },
        { id: "learner-flow.run" },
        { id: "learner-flow.investigate" },
      ],
    });
  });

  test("reads judged delivery from the canonical flow when the Redis cache is empty", async () => {
    const traced: string[] = [];
    const result = await waitForNotifyTerminalReceipt(
      { flowId, correlationId, timeoutMs: 0 },
      {
        get: async () => null,
        trace: async (requestedFlowId) => {
          traced.push(requestedFlowId);
          return canonicalTrace([
            event("message.requested"),
            event("gateway.decision.recorded", {
              correlationId,
              payload: {
                inputEventIds: ["event-message.requested"],
                decision: { verb: "deliver" },
              },
            }),
            event("delivery.confirmed", {
              correlationId,
              platform: "telegram",
              platformMessageId: "telegram-confirmed-1",
            }),
          ]);
        },
      },
    );

    expect(traced).toEqual([flowId]);
    expect(result).toMatchObject({
      flowId,
      correlationId,
      deliveryState: "confirmed",
      platform: "telegram",
      platformMessageId: "telegram-confirmed-1",
    });
  });

  test("treats raw fallback delivery as confirmed canonical delivery", async () => {
    const result = await waitForNotifyTerminalReceipt(
      { flowId, correlationId, timeoutMs: 0 },
      {
        get: async () => null,
        trace: async () => canonicalTrace([
          event("fallback.delivered", {
            correlationId,
            platform: "telegram",
            platformMessageId: "telegram-fallback-1",
            payload: { fallback: true, outcome: "confirmed" },
          }),
        ]),
      },
    );

    expect(result).toMatchObject({
      deliveryState: "confirmed",
      platform: "telegram",
      platformMessageId: "telegram-fallback-1",
    });
  });

  test("recognizes explicit aggregate closure as a digested terminal", async () => {
    const result = await waitForNotifyTerminalReceipt(
      { flowId, correlationId, timeoutMs: 0 },
      {
        get: async () => null,
        trace: async () => canonicalTrace([
          event("gateway.decision.recorded", {
            correlationId,
            payload: {
              inputEventIds: ["event-message.requested"],
              decision: {
                verb: "aggregate",
                action: "close-deliver",
                aggregateId: "daily-health",
              },
            },
          }),
        ]),
      },
    );

    expect(result).toMatchObject({
      deliveryState: "digested",
      platformMessageId: null,
    });
  });

  test("returns canonical delivery failure without inventing a resend", async () => {
    const result = await waitForNotifyTerminalReceipt(
      { flowId, correlationId, timeoutMs: 0 },
      {
        get: async () => null,
        trace: async () => canonicalTrace([
          event("delivery.failed", { correlationId, platform: "telegram" }),
        ]),
      },
    );

    expect(result).toMatchObject({
      deliveryState: "failed",
      platform: "telegram",
      platformMessageId: null,
    });
  });

  test("times out without mutating or minting a new event identity", async () => {
    let now = 0;
    const reads: string[] = [];
    const result = await waitForNotifyTerminalReceipt(
      {
        flowId: "notify:event-1",
        correlationId: "campaign-pulse:event-1",
        timeoutMs: 500,
      },
      {
        get: async (key) => {
          reads.push(key);
          return null;
        },
        trace: async (requestedFlowId) => {
          reads.push(requestedFlowId);
          return {
            kind: "not_found",
            lookup: requestedFlowId,
          };
        },
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        pollIntervalMs: 250,
      },
    );

    expect(result).toBeNull();
    expect(reads).toHaveLength(6);
    expect(new Set(reads)).toEqual(new Set([
      "notify:event-1",
      "joelclaw:message-contract:correlation:campaign-pulse:event-1",
    ]));
  });

  test("keeps terminal non-delivery states distinct", () => {
    expect(notifyTerminalFailureCode("failed")).toBe("NOTIFY_DELIVERY_FAILED");
    expect(notifyTerminalFailureCode("digested")).toBe("NOTIFY_DIGESTED");
  });

  test("keeps legacy priority as optional compatibility metadata only", () => {
    const base = {
      message: "Visible message",
      context: {},
      audit: { flowId: "notify:event-1" },
    };
    expect(createNotifyCompatibilityPayload(base)).toEqual({
      prompt: "Visible message",
      message: "Visible message",
      context: {},
      audit: { flowId: "notify:event-1" },
    });
    expect(createNotifyCompatibilityPayload({
      ...base,
      priority: "high",
      kind: "memory",
    })).toEqual({
      prompt: "Visible message",
      message: "Visible message",
      context: {},
      audit: { flowId: "notify:event-1" },
      priority: "high",
      kind: "memory",
    });
    const payload = createNotifyCompatibilityPayload({ ...base, priority: "urgent" });
    expect(payload.level).toBeUndefined();
    expect(payload.immediateTelegram).toBeUndefined();
  });

  test("rejects malformed terminal projections", async () => {
    await expect(waitForNotifyTerminalReceipt(
      {
        flowId: "notify:event-1",
        correlationId: "campaign-pulse:event-1",
        timeoutMs: 0,
      },
      {
        get: async () => JSON.stringify({ deliveryState: "confirmed" }),
        trace: async () => ({ kind: "not_found", lookup: "notify:event-1" }),
      },
    )).rejects.toThrow();
  });
});
