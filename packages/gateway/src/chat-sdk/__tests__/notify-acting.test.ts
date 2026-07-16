import { describe, expect, test } from "bun:test";
import {
  createDeliveryReceipt,
  type DeliveryReceiptEnvelope,
  mintFlowId,
} from "@joelclaw/message-contract";
import {
  notifyCompatTelemetry,
  routeNotifySendCompat,
} from "../notify-acting";

function receiptWith(
  deliveryState: DeliveryReceiptEnvelope["data"]["deliveryState"],
  platformMessageId: string | null,
): DeliveryReceiptEnvelope {
  return createDeliveryReceipt({
    flowId: mintFlowId(() => "11111111-1111-4111-8111-111111111111"),
    correlationId: "notify-event-1",
    requestedAt: "2026-07-16T21:30:00.000Z",
    confirmedAt:
      deliveryState === "confirmed" ? "2026-07-16T21:30:01.000Z" : null,
    deliveryState,
    platform: "telegram",
    platformMessageId,
    threadId: platformMessageId ? "telegram:7718912466" : null,
    route: { lane: "operator", urgency: "high", formatting: "plain" },
  });
}

const receipt = receiptWith("confirmed", "7718912466:14544");

const event = {
  id: "notify-event-1",
  type: "notify.message",
  source: "cli/notify",
  payload: {
    prompt: "Cutover receipt",
    message: "Cutover receipt",
    priority: "urgent",
    telegramOnly: true,
    context: {},
    audit: { flowId: "notify:notify-event-1" },
  },
};

describe("notify send contract-v2 acting route", () => {
  test("names OTEL after the real terminal disposition", () => {
    expect(notifyCompatTelemetry("confirmed")).toEqual({
      action: "notify.compat_v2.confirmed",
      level: "info",
      success: true,
    });
    expect(notifyCompatTelemetry("digested")).toEqual({
      action: "notify.compat_v2.digested",
      level: "info",
      success: true,
    });
    expect(notifyCompatTelemetry("suppressed")).toEqual({
      action: "notify.compat_v2.suppressed",
      level: "info",
      success: true,
    });
    expect(notifyCompatTelemetry("failed")).toEqual({
      action: "notify.compat_v2.failed",
      level: "error",
      success: false,
      error: "NOTIFY_COMPAT_DELIVERY_FAILED",
    });
  });

  test("maps the Redis compatibility envelope and sends only once", async () => {
    const sent: unknown[] = [];
    const result = await routeNotifySendCompat(event, {
      env: { CHAT_SDK_ACTING_ENABLED: "1" },
      isTransportReady: () => true,
      send: async (intent) => {
        sent.push(intent);
        return receipt;
      },
    });

    expect(result).toMatchObject({
      handled: true,
      receipt,
      disposition: "confirmed",
    });
    expect(sent).toEqual([
      {
        contractVersion: 2,
        kind: "alert",
        content: "Cutover receipt",
        correlationId: "notify-event-1",
      },
    ]);
  });

  test("maps all four legacy priorities onto approved contract-v2 kinds", async () => {
    const kinds: string[] = [];
    for (const priority of ["low", "normal", "high", "urgent"] as const) {
      await routeNotifySendCompat(
        {
          ...event,
          id: `notify-${priority}`,
          payload: {
            ...event.payload,
            priority,
            audit: { flowId: `notify:notify-${priority}` },
          },
        },
        {
          env: { CHAT_SDK_ACTING_ENABLED: "1" },
          isTransportReady: () => true,
          send: async (intent) => {
            kinds.push(intent.kind);
            return receipt;
          },
        },
      );
    }
    expect(kinds).toEqual(["digest", "digest", "alert", "alert"]);
  });

  test("does not treat channel or telegram-only flags as routing authority", async () => {
    const intents: unknown[] = [];
    await routeNotifySendCompat(
      {
        ...event,
        payload: {
          ...event.payload,
          context: { channel: "main" },
        },
      },
      {
        env: { CHAT_SDK_ACTING_ENABLED: "1" },
        isTransportReady: () => true,
        send: async (intent) => {
          intents.push(intent);
          return receipt;
        },
      },
    );

    expect(intents).toEqual([
      {
        contractVersion: 2,
        kind: "alert",
        content: "Cutover receipt",
        correlationId: "notify-event-1",
      },
    ]);
  });

  test("rejects the confirmed-without-platform-id regression shape", async () => {
    const invalidReceipt = {
      ...receipt,
      data: {
        ...receipt.data,
        platformMessageId: null,
      },
    } as DeliveryReceiptEnvelope;

    await expect(
      routeNotifySendCompat(event, {
        env: { CHAT_SDK_ACTING_ENABLED: "1" },
        isTransportReady: () => true,
        send: async () => invalidReceipt,
      }),
    ).rejects.toMatchObject({
      name: "NotifyCompatDeliveryError",
      handled: true,
      eventId: "notify-event-1",
    });
  });

  test("reports the real hot-dog journal disposition as digested, not confirmed", async () => {
    const hotDogEvent = {
      ...event,
      id: "hot-dog-neat-memory",
      source: "memory/observe-session",
      payload: {
        ...event.payload,
        prompt: "The hot-dog propagation demo came back flat twice.",
        message: "The hot-dog propagation demo came back flat twice.",
        priority: "normal",
        audit: { flowId: "notify:hot-dog-neat-memory" },
      },
    };
    const result = await routeNotifySendCompat(hotDogEvent, {
      env: { CHAT_SDK_ACTING_ENABLED: "1" },
      isTransportReady: () => true,
      send: async () => receiptWith("digested", null),
    });

    expect(result).toMatchObject({
      handled: true,
      disposition: "digested",
      receipt: { data: { deliveryState: "digested", platformMessageId: null } },
    });
  });

  test("preserves a failed terminal receipt instead of confirming it", async () => {
    const result = await routeNotifySendCompat(event, {
      env: { CHAT_SDK_ACTING_ENABLED: "1" },
      isTransportReady: () => true,
      send: async () => receiptWith("failed", null),
    });

    expect(result).toMatchObject({
      handled: true,
      disposition: "failed",
      receipt: { data: { deliveryState: "failed" } },
    });
  });

  test("marks ambiguous SDK failures handled so Redis cannot legacy-fallback", async () => {
    await expect(
      routeNotifySendCompat(event, {
        env: { CHAT_SDK_ACTING_ENABLED: "1" },
        isTransportReady: () => true,
        send: async () => {
          throw new Error("journal failed after platform send");
        },
      }),
    ).rejects.toMatchObject({
      name: "NotifyCompatDeliveryError",
      handled: true,
      eventId: "notify-event-1",
    });
  });

  test("leaves legacy routing untouched before transport handover is ready", async () => {
    let called = false;
    expect(
      await routeNotifySendCompat(event, {
        env: { CHAT_SDK_ACTING_ENABLED: "1" },
        isTransportReady: () => false,
        send: async () => {
          called = true;
          return receipt;
        },
      }),
    ).toEqual({ handled: false });
    expect(called).toBe(false);
  });

  test("leaves legacy routing untouched while the flag is absent", async () => {
    let called = false;
    expect(
      await routeNotifySendCompat(event, {
        env: {},
        isTransportReady: () => true,
        send: async () => {
          called = true;
          return receipt;
        },
      }),
    ).toEqual({ handled: false });
    expect(called).toBe(false);
  });
});
