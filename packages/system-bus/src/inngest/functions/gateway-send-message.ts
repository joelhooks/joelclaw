/** Keep the retired event registered so remaining producers fail visibly. */
import { NonRetriableError } from "inngest";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

export const gatewaySendMessage = inngest.createFunction(
  {
    id: "gateway-send-message",
    name: "Gateway: Send Message (Retired)",
    retries: 3,
  },
  { event: "gateway/send.message" },
  async ({ event }) => {
    const producer = event.data.audit?.producer ?? "gateway/send.message";
    const flowId = event.data.audit?.flowId ?? event.id ?? "unknown";
    const error = new NonRetriableError(
      "gateway outbound path retired: no consumer since the gateway was removed; use notifyJoel" +
        ` (producer=${producer}, flowId=${flowId})`,
    );
    // Telemetry is best-effort; even a telemetry outage must leave a terminal failure.
    await emitOtelEvent({
      level: "error",
      source: "worker",
      component: "gateway-send-message",
      action: "gateway.send.retired",
      success: false,
      error: error.message,
      metadata: { producer, flowId, eventId: event.id },
    }).catch(() => undefined);
    throw error;
  },
);
