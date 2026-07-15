/**
 * gateway/send.message handler
 *
 * Receives outbound message requests from other Inngest functions and pushes
 * them to the Redis queue consumed by the gateway daemon. The queue envelope
 * carries a privacy-safe audit context so one flow ID survives every hop.
 */

import Redis from "ioredis";
import { buildQueuedGatewayMessage } from "../../lib/channel-delivery-audit";
import { getRedisPort } from "../../lib/redis";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

export const OUTBOUND_QUEUE = "joelclaw:outbound:messages";

function getRedis(): Redis {
  return new Redis({ host: "localhost", port: getRedisPort() });
}

export const gatewaySendMessage = inngest.createFunction(
  {
    id: "gateway-send-message",
    name: "Gateway: Send Message",
    retries: 3,
  },
  { event: "gateway/send.message" },
  async ({ event, step }) => {
    const queued = await step.run("push-to-outbound-queue", async () => {
      const redis = getRedis();
      const message = buildQueuedGatewayMessage(event.data, {
        eventId: event.id,
        eventTimestampMs: event.ts,
      });

      try {
        const queueDepth = await redis.rpush(OUTBOUND_QUEUE, JSON.stringify(message));
        await redis.publish("joelclaw:notify:outbound", "1");

        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "gateway-send-message",
          action: "channel.delivery.queued",
          success: true,
          metadata: {
            ...message.audit,
            channel: message.channel,
            queueDepth,
            hasKeyboard: Boolean(message.inline_keyboard),
            editMessage: Boolean(message.edit_message_id),
            hasMedia: Boolean(message.media_url || message.media_path),
          },
        });

        return {
          channel: message.channel,
          flowId: message.audit.flowId,
          queueDepth,
        };
      } finally {
        await redis.quit().catch(() => undefined);
      }
    });

    return { queued: true, ...queued };
  },
);
