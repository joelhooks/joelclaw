import { describe, expect, test } from "bun:test";
import {
  dispatchGenericWebhookEvent,
  type GenericWebhookDependencies,
  genericWebhookSubscriptionTriggers,
} from "./webhook-subscription-dispatch-generic";

const subscription = {
  id: "whs_mux",
  provider: "mux",
  event: "asset.ready",
  filters: {},
  sessionId: "session-123",
  createdAt: "2026-07-13T00:00:00.000Z",
  active: true,
};

describe("webhookSubscriptionDispatchGeneric", () => {
  test("registers every normalized Mux event explicitly", () => {
    expect(genericWebhookSubscriptionTriggers.map((trigger) => trigger.event)).toEqual([
      "mux/asset.created",
      "mux/asset.ready",
      "mux/asset.errored",
      "mux/asset.updated",
      "mux/asset.static_rendition.ready",
      "mux/upload.created",
      "mux/upload.asset_created",
      "mux/upload.cancelled",
    ]);
  });

  test("matches, claims, publishes, and notifies a session", async () => {
    const published: Array<{ id: string; payload: Record<string, unknown> }> = [];
    const notified: unknown[] = [];
    const claimed: string[] = [];
    const dependencies: GenericWebhookDependencies = {
      findMatching: async () => [subscription],
      claim: async (id, key) => {
        claimed.push(`${id}:${key}`);
        return true;
      },
      publish: async (id, payload) => {
        published.push({ id, payload });
      },
      notify: async (event) => {
        notified.push(event);
      },
    };

    const result = await dispatchGenericWebhookEvent(
      {
        provider: "mux",
        eventName: "asset.ready",
        eventId: "evt_mux_123",
        payload: { id: "asset-123", playback_ids: [{ id: "playback-123" }] },
      },
      dependencies,
    );

    expect(result).toEqual({
      matchedSubscriptions: 1,
      delivered: 1,
      duplicates: 0,
      notifiedSessions: 1,
    });
    expect(claimed).toEqual(["whs_mux:asset.ready:asset-123:whs_mux"]);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      id: "whs_mux",
      payload: {
        id: "asset-123",
        provider: "mux",
        event: "asset.ready",
        subscriptionId: "whs_mux",
      },
    });
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({
      type: "webhook.subscription.matched",
      source: "inngest/mux/asset.ready",
      originSession: "session-123",
    });
  });
});
