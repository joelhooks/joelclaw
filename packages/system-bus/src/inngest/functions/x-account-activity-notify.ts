import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";

function eventLabel(eventTypes: unknown): string {
  if (!Array.isArray(eventTypes) || eventTypes.length === 0) return "account activity";
  return eventTypes.map((eventType) => String(eventType)).join(", ");
}

export const xAccountActivityReceived = inngest.createFunction(
  {
    id: "x-account-activity-received-notify",
    name: "X → Gateway: Account Activity Received",
    retries: 2,
  },
  { event: "x/account_activity.received" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const { forUserId, eventTypes, payloadHash, webhookId } = event.data as Record<string, unknown>;
    const label = eventLabel(eventTypes);

    const result = await step.run("notify-gateway", async () => {
      if (!gateway) return { pushed: false, reason: "no gateway context" };

      return gateway.notify("x.account_activity.received", {
        prompt: [
          "## 🐦 X Account Activity",
          "",
          `**Event types**: ${label}`,
          `**For user**: ${forUserId || "unknown"}`,
          webhookId ? `**Webhook**: ${webhookId}` : "",
          `**Payload hash**: \`${payloadHash || "unknown"}\``,
          "",
          "Raw payload is intentionally not included in the notification. Inspect the Inngest event if needed.",
        ].filter(Boolean).join("\n"),
        forUserId,
        eventTypes,
        payloadHash,
        webhookId,
      });
    });

    return {
      status: result.pushed ? "notified" : "skipped",
      forUserId,
      eventTypes,
      payloadHash,
      result,
    };
  },
);
