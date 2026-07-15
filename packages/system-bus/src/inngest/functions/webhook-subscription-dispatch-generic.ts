import {
  claimWebhookDelivery,
  findMatchingWebhookSubscriptions,
  publishWebhookSubscriptionEvent,
  type WebhookSubscription,
} from "../../lib/webhook-subscriptions";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";

const WEBHOOK_PROVIDER_NAMES = ["mux"] as const;
const WEBHOOK_EVENT_NAMES = [
  "asset.created",
  "asset.ready",
  "asset.errored",
  "asset.updated",
  "asset.static_rendition.ready",
  "upload.created",
  "upload.asset_created",
  "upload.cancelled",
] as const;

type GenericWebhookEvent =
  `${(typeof WEBHOOK_PROVIDER_NAMES)[number]}/${(typeof WEBHOOK_EVENT_NAMES)[number]}`;

// Add a provider here when its webhook normalizer emits the same event names.
export const genericWebhookSubscriptionTriggers: Array<{ event: GenericWebhookEvent }> =
  WEBHOOK_PROVIDER_NAMES.flatMap((provider) =>
    WEBHOOK_EVENT_NAMES.map((event) => ({
      event: `${provider}/${event}` as GenericWebhookEvent,
    })),
  );

export type GenericWebhookDependencies = {
  findMatching: typeof findMatchingWebhookSubscriptions;
  claim: typeof claimWebhookDelivery;
  publish: typeof publishWebhookSubscriptionEvent;
  notify: (input: Parameters<typeof pushGatewayEvent>[0]) => Promise<unknown>;
};

const defaultDependencies: GenericWebhookDependencies = {
  findMatching: findMatchingWebhookSubscriptions,
  claim: claimWebhookDelivery,
  publish: publishWebhookSubscriptionEvent,
  notify: pushGatewayEvent,
};

function deliveryKey(
  eventId: string | undefined,
  eventName: string,
  payload: Record<string, unknown>,
): string {
  const providerDeliveryId = [payload.deliveryId, payload.webhookId, payload.id]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);

  return `${eventName}:${providerDeliveryId ?? eventId ?? JSON.stringify(payload)}`;
}

function buildSessionPrompt(
  subscription: WebhookSubscription,
  provider: string,
  eventName: string,
  payload: Record<string, unknown>,
): string {
  return [
    "## 🔔 Webhook Subscription Match",
    "",
    `**Subscription**: ${subscription.id}`,
    `**Event**: ${provider}/${eventName}`,
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
    "",
    "Take immediate follow-up action if needed.",
  ].join("\n");
}

export async function dispatchGenericWebhookEvent(
  input: {
    provider: string;
    eventName: string;
    payload: Record<string, unknown>;
    eventId?: string;
  },
  dependencies: GenericWebhookDependencies = defaultDependencies,
): Promise<{
  matchedSubscriptions: number;
  delivered: number;
  duplicates: number;
  notifiedSessions: number;
}> {
  const subscriptions = await dependencies.findMatching(
    input.provider,
    input.eventName,
    input.payload,
  );

  let delivered = 0;
  let duplicates = 0;
  let notifiedSessions = 0;
  const key = deliveryKey(input.eventId, input.eventName, input.payload);

  for (const subscription of subscriptions) {
    const claimed = await dependencies.claim(subscription.id, `${key}:${subscription.id}`);
    if (!claimed) {
      duplicates += 1;
      continue;
    }

    const matchedPayload = {
      ...input.payload,
      provider: input.provider,
      event: input.eventName,
      subscriptionId: subscription.id,
      matchedAt: new Date().toISOString(),
    };

    await dependencies.publish(subscription.id, matchedPayload);
    delivered += 1;

    if (subscription.sessionId) {
      await dependencies.notify({
        type: "webhook.subscription.matched",
        source: `inngest/${input.provider}/${input.eventName}`,
        originSession: subscription.sessionId,
        payload: {
          ...matchedPayload,
          originSession: subscription.sessionId,
          prompt: buildSessionPrompt(
            subscription,
            input.provider,
            input.eventName,
            input.payload,
          ),
        },
      });
      notifiedSessions += 1;
    }
  }

  return {
    matchedSubscriptions: subscriptions.length,
    delivered,
    duplicates,
    notifiedSessions,
  };
}

export const webhookSubscriptionDispatchGeneric = inngest.createFunction(
  {
    id: "webhook-subscription-dispatch-generic",
    name: "Webhook Subscriptions: Dispatch Generic Provider Events",
    retries: 2,
    concurrency: {
      limit: 8,
      key: "event.name",
    },
  },
  genericWebhookSubscriptionTriggers,
  async ({ event, step }) => {
    const eventName = event.name.split("/").slice(1).join("/");
    const provider = event.name.split("/")[0] ?? "unknown";
    const payload = (event.data ?? {}) as Record<string, unknown>;

    await step.run("otel-webhook-dispatch-start", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "webhook-subscriptions",
        action: "webhook.subscription.dispatch.started",
        success: true,
        metadata: { provider, event: eventName },
      });
    });

    const dispatchResult = await step.run("dispatch-matches", async () =>
      dispatchGenericWebhookEvent({
        provider,
        eventName,
        payload,
        eventId: event.id,
      }),
    );

    await step.run("otel-webhook-dispatch-completed", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "webhook-subscriptions",
        action: "webhook.subscription.dispatch.completed",
        success: true,
        metadata: {
          provider,
          event: eventName,
          ...dispatchResult,
        },
      });
    });

    return {
      status: dispatchResult.matchedSubscriptions > 0 ? "dispatched" : "noop",
      provider,
      event: eventName,
      ...dispatchResult,
    };
  },
);
