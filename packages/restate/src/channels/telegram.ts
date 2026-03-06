/**
 * Telegram notification channel — Redis-routed callbacks (ADR-0215).
 *
 * Sends messages with inline keyboard buttons via Bot API directly.
 * Receives callbacks via Redis pub/sub from the gateway, which owns
 * the sole getUpdates connection. No polling conflict possible.
 *
 * Registration: on startCallbackListener(), writes its prefix ("restate:")
 * to Redis hash `joelclaw:telegram:callback-routes` so the gateway knows
 * to route matching callbacks to our pub/sub channel.
 *
 * Button callback_data format: restate:{service}:{workflowId}:{action}
 */

import Redis from "ioredis";
import type {
  CallbackData,
  NotificationChannel,
  NotificationMessage,
  SendResult,
} from "./types";
import { decodeCallbackData, encodeCallbackData } from "./types";

const CALLBACK_ROUTES_KEY = "joelclaw:telegram:callback-routes";
const CALLBACK_PREFIX = "restate:";
const CALLBACK_CHANNEL = "joelclaw:telegram:callbacks:restate";
const DEFAULT_TRACE_RESULT_CHANNEL = "joelclaw:telegram:callback-trace-events";

type RoutedTelegramCallback = {
  data: string;
  chatId: number;
  messageId: number;
  traceId?: string;
  traceResultChannel?: string;
};

interface TelegramConfig {
  botToken: string;
  chatId: string;
  redisUrl?: string;
}

export class TelegramChannel implements NotificationChannel {
  readonly id = "telegram";
  private readonly baseUrl: string;
  private readonly chatId: string;
  private readonly redisUrl: string;

  private async publishTraceResult(
    cmdClient: Redis,
    payload: RoutedTelegramCallback,
    result: {
      status: "completed" | "failed";
      detail: string;
      error?: string;
    },
  ): Promise<void> {
    if (!payload.traceId) return;

    const channel = payload.traceResultChannel || DEFAULT_TRACE_RESULT_CHANNEL;
    await cmdClient.publish(channel, JSON.stringify({
      traceId: payload.traceId,
      status: result.status,
      detail: result.detail,
      ...(result.error ? { error: result.error } : {}),
      source: CALLBACK_CHANNEL,
      route: payload.data,
    }));
  }

  constructor(private config: TelegramConfig) {
    this.baseUrl = `https://api.telegram.org/bot${config.botToken}`;
    this.chatId = config.chatId;
    this.redisUrl = config.redisUrl ?? "redis://localhost:6379";
  }

  async send(message: NotificationMessage): Promise<SendResult> {
    // Build inline keyboard from actions
    const keyboard = message.actions.map((action) => ({
      text: action.label,
      callback_data: encodeCallbackData({
        serviceName: message.serviceName,
        workflowId: message.workflowId,
        action: action.value,
      }),
    }));

    const body = {
      chat_id: this.chatId,
      text: message.text,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [keyboard], // single row of buttons
      },
    };

    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Telegram sendMessage failed: ${response.status} ${error}`);
    }

    const result = (await response.json()) as {
      result: { message_id: number };
    };
    const messageId = String(result.result.message_id);

    console.log(
      `📨 Telegram: sent message ${messageId} with ${message.actions.length} buttons`,
    );

    return { messageId, channel: this.id };
  }

  async startCallbackListener(
    resolver: (data: CallbackData) => Promise<void>,
  ): Promise<() => void> {
    // Register our prefix with the gateway's callback router
    const cmdClient = new Redis(this.redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    await cmdClient.connect();
    await cmdClient.hset(CALLBACK_ROUTES_KEY, CALLBACK_PREFIX, CALLBACK_CHANNEL);
    console.log(
      `📡 Telegram: registered callback route "${CALLBACK_PREFIX}" → ${CALLBACK_CHANNEL}`,
    );

    // Subscribe to our callback channel
    const subClient = new Redis(this.redisUrl, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    await subClient.connect();
    await subClient.subscribe(CALLBACK_CHANNEL);

    console.log(`📡 Telegram: listening on Redis channel ${CALLBACK_CHANNEL}`);

    subClient.on("message", async (_channel: string, message: string) => {
      let payload: RoutedTelegramCallback | undefined;
      try {
        payload = JSON.parse(message) as RoutedTelegramCallback;

        const decoded = decodeCallbackData(payload.data);
        if (!decoded) {
          console.warn("[restate:telegram] undecodable callback data", {
            data: payload.data,
          });
          await this.publishTraceResult(cmdClient, payload, {
            status: "failed",
            detail: "restate callback payload rejected",
            error: "undecodable_callback_data",
          }).catch(() => {});
          return;
        }

        console.log(
          `🔔 Telegram: callback via Redis: ${decoded.action} on ${decoded.serviceName}/${decoded.workflowId}`,
        );

        // Edit the original message to remove buttons (show decision)
        if (payload.chatId && payload.messageId) {
          try {
            await fetch(`${this.baseUrl}/editMessageReplyMarkup`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: payload.chatId,
                message_id: payload.messageId,
                reply_markup: { inline_keyboard: [] },
              }),
            });
          } catch {
            // Non-critical — button removal is UX polish
          }
        }

        // Resolve via Restate
        await resolver(decoded);
        await this.publishTraceResult(cmdClient, payload, {
          status: "completed",
          detail: `restate resolved ${decoded.action} for ${decoded.serviceName}/${decoded.workflowId}`,
        }).catch(() => {});
      } catch (err) {
        console.error("[restate:telegram] callback processing error", {
          error: String(err),
        });
        if (payload) {
          await this.publishTraceResult(cmdClient, payload, {
            status: "failed",
            detail: "restate callback processing failed",
            error: String(err),
          }).catch(() => {});
        }
      }
    });

    // Return stop function
    return async () => {
      // Unregister our route
      try {
        await cmdClient.hdel(CALLBACK_ROUTES_KEY, CALLBACK_PREFIX);
        console.log(`📡 Telegram: unregistered callback route "${CALLBACK_PREFIX}"`);
      } catch { /* best effort */ }

      await subClient.unsubscribe(CALLBACK_CHANNEL);
      subClient.disconnect();
      cmdClient.disconnect();
      console.log(`📡 Telegram: stopped listening on ${CALLBACK_CHANNEL}`);
    };
  }
}
