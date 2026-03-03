/**
 * gateway/send.message handler
 *
 * Receives outbound message requests from other Inngest functions
 * and pushes them to a Redis outbound queue for the gateway daemon
 * to deliver via its channel interface.
 *
 * The gateway daemon polls `joelclaw:outbound:messages` and sends
 * through the appropriate channel (Telegram, Slack, etc.).
 *
 * This function owns NO channel-specific logic. It's a dumb relay
 * from Inngest event → Redis outbound queue.
 */

import Redis from "ioredis";
import { getRedisPort } from "../../lib/redis";
import { inngest } from "../client";

const OUTBOUND_QUEUE = "joelclaw:outbound:messages";

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
    const { channel, text, inline_keyboard, edit_message_id, remove_keyboard } = event.data;

    await step.run("push-to-outbound-queue", async () => {
      const redis = getRedis();
      const message = JSON.stringify({
        channel: channel ?? "telegram",
        text,
        inline_keyboard,
        edit_message_id,
        remove_keyboard,
        ts: new Date().toISOString(),
      });

      await redis.rpush(OUTBOUND_QUEUE, message);
      // Publish notification so gateway can wake up immediately
      await redis.publish("joelclaw:notify:outbound", "1");
      await redis.quit();
    });

    return { queued: true, channel: channel ?? "telegram" };
  },
);
