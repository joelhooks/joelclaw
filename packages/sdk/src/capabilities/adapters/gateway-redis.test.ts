import { describe, expect, test } from "bun:test";
import {
  createNotifyCompatibilityPayload,
  notifyTerminalFailureCode,
  waitForNotifyTerminalReceipt,
} from "./gateway-redis";

const receipt = JSON.stringify({
  flowId: "flow_v2_11111111-1111-4111-8111-111111111111",
  correlationId: "campaign-pulse:11111111-1111-4111-8111-111111111111",
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

describe("notify terminal receipt wait", () => {
  test("returns the confirmed receipt under the source/event correlation key", async () => {
    const keys: string[] = [];
    const result = await waitForNotifyTerminalReceipt(
      {
        correlationId: "campaign-pulse:11111111-1111-4111-8111-111111111111",
        timeoutMs: 1_000,
      },
      {
        get: async (key) => {
          keys.push(key);
          return receipt;
        },
      },
    );

    expect(keys).toEqual([
      "joelclaw:message-contract:correlation:campaign-pulse:11111111-1111-4111-8111-111111111111",
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

  test("times out without mutating or minting a new event identity", async () => {
    let now = 0;
    let reads = 0;
    const result = await waitForNotifyTerminalReceipt(
      { correlationId: "campaign-pulse:event-1", timeoutMs: 500 },
      {
        get: async () => {
          reads += 1;
          return null;
        },
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        pollIntervalMs: 250,
      },
    );

    expect(result).toBeNull();
    expect(reads).toBe(3);
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
      { correlationId: "campaign-pulse:event-1", timeoutMs: 0 },
      { get: async () => JSON.stringify({ deliveryState: "confirmed" }) },
    )).rejects.toThrow();
  });
});
