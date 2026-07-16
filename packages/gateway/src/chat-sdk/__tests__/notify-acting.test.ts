import { describe, expect, test } from "bun:test";
import type { DeliveryReceiptEnvelope } from "@joelclaw/message-contract";
import { routeNotifySendCompat } from "../notify-acting";

const receipt = {
  contractVersion: 2,
  flowId: "flow_v2_11111111-1111-4111-8111-111111111111",
  kind: "alert",
  platform: "telegram",
  lane: "operator",
  urgency: "high",
  formatting: "plain",
  requestedAt: "2026-07-16T21:30:00.000Z",
  confirmedAt: "2026-07-16T21:30:01.000Z",
  deliveryState: "confirmed",
  platformMessageId: "7718912466:14544",
  links: [],
} as unknown as DeliveryReceiptEnvelope;

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

    expect(result).toMatchObject({ handled: true, receipt });
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
