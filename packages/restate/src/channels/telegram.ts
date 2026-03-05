/**
 * Telegram notification channel.
 *
 * Sends messages with inline keyboard buttons via Bot API.
 * Listens for callbacks via long-polling (not webhooks — avoids
 * conflicting with the gateway's webhook registration).
 *
 * Button callback_data format: restate:{service}:{workflowId}:{action}
 */

import type {
  NotificationChannel,
  NotificationMessage,
  SendResult,
  CallbackData,
} from "./types";
import { encodeCallbackData, decodeCallbackData } from "./types";

interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export class TelegramChannel implements NotificationChannel {
  readonly id = "telegram";
  private readonly baseUrl: string;
  private readonly chatId: string;

  constructor(private config: TelegramConfig) {
    this.baseUrl = `https://api.telegram.org/bot${config.botToken}`;
    this.chatId = config.chatId;
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

    const result = await response.json() as { result: { message_id: number } };
    const messageId = String(result.result.message_id);

    console.log(`📨 Telegram: sent message ${messageId} with ${message.actions.length} buttons`);

    return { messageId, channel: this.id };
  }

  async startCallbackListener(
    resolver: (data: CallbackData) => Promise<void>,
  ): Promise<() => void> {
    let running = true;
    let offset = 0;

    console.log(`📡 Telegram: polling for callback queries...`);

    const poll = async () => {
      while (running) {
        try {
          const response = await fetch(
            `${this.baseUrl}/getUpdates?offset=${offset}&timeout=10&allowed_updates=["callback_query"]`,
          );

          if (!response.ok) continue;

          const data = await response.json() as {
            result: Array<{
              update_id: number;
              callback_query?: {
                id: string;
                data: string;
                from: { first_name: string };
                message?: { message_id: number };
              };
            }>;
          };

          for (const update of data.result) {
            offset = update.update_id + 1;

            if (!update.callback_query?.data) continue;

            const decoded = decodeCallbackData(update.callback_query.data);
            if (!decoded) continue;

            console.log(
              `🔔 Telegram: callback from ${update.callback_query.from.first_name}: ` +
              `${decoded.action} on ${decoded.serviceName}/${decoded.workflowId}`,
            );

            // Answer the callback query (removes "loading" spinner on button)
            await fetch(`${this.baseUrl}/answerCallbackQuery`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                callback_query_id: update.callback_query.id,
                text: `✅ ${decoded.action}`,
              }),
            });

            // Edit the original message to show the decision
            if (update.callback_query.message) {
              await fetch(`${this.baseUrl}/editMessageReplyMarkup`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  chat_id: this.chatId,
                  message_id: update.callback_query.message.message_id,
                  reply_markup: { inline_keyboard: [] }, // remove buttons
                }),
              });
            }

            // Resolve via Restate
            try {
              await resolver(decoded);
            } catch (err) {
              console.error(`❌ Telegram: resolver failed for ${decoded.workflowId}:`, err);
            }
          }
        } catch (err) {
          if (running) {
            console.error("Telegram polling error:", err);
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
      }
    };

    // Start polling in background
    poll();

    return () => {
      running = false;
      console.log(`📡 Telegram: stopped polling`);
    };
  }
}
