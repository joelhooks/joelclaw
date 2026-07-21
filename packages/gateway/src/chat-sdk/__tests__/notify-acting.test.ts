import { afterEach, describe, expect, test } from "bun:test";
import {
  createDeliveryReceipt,
  type DeliveryReceiptEnvelope,
  mintFlowId,
  type OutboundIntent,
} from "@joelclaw/message-contract";
import {
  __notifyCompatTestUtils,
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
    route: { delivery: "immediate", formatting: "plain" },
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

afterEach(() => {
  __notifyCompatTestUtils.clearDeprecations();
});

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
        correlationId: "cli/notify:notify-event-1",
      },
    ]);
  });

  test("maps every legacy priority onto the explicit compatibility kind", async () => {
    const kinds: string[] = [];
    for (const priority of ["low", "normal", "high", "urgent", "critical"] as const) {
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
                isTransportReady: () => true,
          send: async (intent) => {
            kinds.push(intent.kind);
            return receipt;
          },
        },
      );
    }
    expect(kinds).toEqual(["digest", "memory", "alert", "alert", "alert"]);
  });

  test("omitted priority maps to memory and emits one actionable deprecation row", async () => {
    const { priority: _priority, ...payload } = event.payload;
    const deprecations: unknown[] = [];
    const intents: OutboundIntent[] = [];

    await routeNotifySendCompat(
      { ...event, id: "notify-omitted", payload },
      {
        isTransportReady: () => true,
        emitDeprecation: (input) => {
          deprecations.push(input);
        },
        send: async (intent) => {
          intents.push(intent);
          return receipt;
        },
      },
    );

    expect(intents[0]?.kind).toBe("memory");
    expect(deprecations).toEqual([{
      eventId: "notify-omitted",
      source: "cli/notify",
      legacyPriority: "omitted",
      mappedKind: "memory",
      fix: "Pass --kind memory; --priority is deprecated and has no routing authority.",
    }]);
  });

  test("bounds the default deprecation emitter to one row per event", async () => {
    const dependencies = {
      isTransportReady: () => true,
      send: async () => receipt,
    };

    await routeNotifySendCompat(event, dependencies);
    await routeNotifySendCompat(event, dependencies);

    expect(__notifyCompatTestUtils.deprecationCount()).toBe(1);
  });

  test("an explicit payload.kind overrides priority and emits no deprecation", async () => {
    const kinds: string[] = [];
    const deprecations: unknown[] = [];
    for (const kind of ["memory", "alert", "digest", "ask", "receipt"] as const) {
      await routeNotifySendCompat(
        {
          ...event,
          id: `notify-kind-${kind}`,
          payload: {
            ...event.payload,
            priority: "normal",
            kind,
            audit: { flowId: `notify:notify-kind-${kind}` },
          },
        },
        {
          isTransportReady: () => true,
          emitDeprecation: (input) => {
            deprecations.push(input);
          },
          send: async (intent) => {
            kinds.push(intent.kind);
            return receipt;
          },
        },
      );
    }
    expect(kinds).toEqual(["memory", "alert", "digest", "ask", "receipt"]);
    expect(deprecations).toEqual([]);
  });

  test("rejects an invalid payload.kind instead of guessing semantics", async () => {
    const sent: unknown[] = [];
    let caught: unknown;
    try {
      await routeNotifySendCompat(
        {
          ...event,
          id: "notify-kind-bogus",
          payload: {
            ...event.payload,
            kind: "shipping-list",
            audit: { flowId: "notify:notify-kind-bogus" },
          },
        },
        {
          isTransportReady: () => true,
          send: async (intent) => {
            sent.push(intent);
            return receipt;
          },
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(sent).toEqual([]);
    expect(caught).toMatchObject({
      name: "NotifyCompatDeliveryError",
      cause: expect.objectContaining({
        message: expect.stringContaining("payload.kind must be one of"),
      }),
    });
  });

  test("carries semantic callback actions from notify context into contract v2", async () => {
    const intents: unknown[] = [];
    await routeNotifySendCompat(
      {
        ...event,
        payload: {
          ...event.payload,
          context: {
            actions: [
              { kind: "callback", id: "learner-flow.ack", label: "Seen" },
              { kind: "callback", id: "learner-flow.run", label: "Run flow agent" },
              { kind: "callback", id: "learner-flow.investigate", label: "Investigate" },
            ],
          },
        },
      },
      {
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
        correlationId: "cli/notify:notify-event-1",
        actions: [
          { kind: "callback", id: "learner-flow.ack", label: "Seen" },
          { kind: "callback", id: "learner-flow.run", label: "Run flow agent" },
          { kind: "callback", id: "learner-flow.investigate", label: "Investigate" },
        ],
      },
    ]);
  });

  test("marks malformed action declarations handled instead of falling through", async () => {
    await expect(routeNotifySendCompat(
      {
        ...event,
        payload: {
          ...event.payload,
          context: { actions: [{ label: "missing kind" }] },
        },
      },
      {
        isTransportReady: () => true,
        send: async () => receipt,
      },
    )).rejects.toMatchObject({
      name: "NotifyCompatDeliveryError",
      handled: true,
      eventId: "notify-event-1",
    });
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
        correlationId: "cli/notify:notify-event-1",
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
            isTransportReady: () => true,
        send: async () => invalidReceipt,
      }),
    ).rejects.toMatchObject({
      name: "NotifyCompatDeliveryError",
      handled: true,
      eventId: "notify-event-1",
    });
  });

  test("ignores source substrings when mapping legacy inputs", async () => {
    const intents: OutboundIntent[] = [];
    for (const source of ["memory/observe-session", "approval/request", "daily-digest", "build-receipt"]) {
      await routeNotifySendCompat(
        {
          ...event,
          id: `source-${source}`,
          source,
          payload: {
            ...event.payload,
            priority: "normal",
            audit: { flowId: `notify:source-${source}` },
          },
        },
        {
          isTransportReady: () => true,
          emitDeprecation: () => {},
          send: async (intent) => {
            intents.push(intent);
            return receipt;
          },
        },
      );
    }

    expect(intents.map((intent) => intent.kind)).toEqual([
      "memory",
      "memory",
      "memory",
      "memory",
    ]);
  });

  test("preserves a failed terminal receipt instead of confirming it", async () => {
    const result = await routeNotifySendCompat(event, {
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

  test("waits for canonical transport readiness", async () => {
    let called = false;
    expect(
      await routeNotifySendCompat(event, {
            isTransportReady: () => false,
        send: async () => {
          called = true;
          return receipt;
        },
      }),
    ).toEqual({ handled: false });
    expect(called).toBe(false);
  });

});
