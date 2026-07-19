import {
  TelegramAdapter,
  type TelegramAdapterConfig,
  type TelegramRawMessage,
} from "@chat-adapter/telegram";
import { MESSAGE_CALLBACK_ACTION_ID } from "@joelclaw/message-contract";

const TELEGRAM_TEXT_LIMIT = 4_096;
const TELEGRAM_CALLBACK_LIMIT_BYTES = 64;

export interface TelegramCallbackAction {
  readonly id: "learner-flow.ack" | "learner-flow.run" | "learner-flow.investigate";
  readonly label: string;
}

export interface TelegramActionMessage {
  readonly telegramActionMessage: true;
  readonly markdownV2: string | null;
  readonly plainText: string;
  readonly actions: readonly TelegramCallbackAction[];
}

export function isTelegramActionMessage(
  message: unknown,
): message is TelegramActionMessage {
  return Boolean(
    message
      && typeof message === "object"
      && (message as Record<string, unknown>).telegramActionMessage === true,
  );
}

function boundedPlainText(text: string): string {
  const characters = Array.from(text);
  if (characters.length <= TELEGRAM_TEXT_LIMIT) return text;
  return `${characters.slice(0, TELEGRAM_TEXT_LIMIT - 3).join("")}...`;
}

function callbackData(actionId: TelegramCallbackAction["id"]): string {
  const data = `chat:${JSON.stringify({ a: MESSAGE_CALLBACK_ACTION_ID, v: actionId })}`;
  if (Buffer.byteLength(data, "utf8") > TELEGRAM_CALLBACK_LIMIT_BYTES) {
    throw new Error(
      `Telegram callback action exceeds ${TELEGRAM_CALLBACK_LIMIT_BYTES} bytes`,
    );
  }
  return data;
}

function keyboard(actions: readonly TelegramCallbackAction[]) {
  const buttons = actions.map((action) => ({
    text: action.label,
    callback_data: callbackData(action.id),
  }));
  if (buttons.length <= 1) return [buttons];
  const first = buttons[0];
  return first ? [[first], buttons.slice(1)] : [];
}

/**
 * Small extension of the pinned Chat SDK Telegram adapter. Chat SDK 4.34 keeps
 * inline keyboards when its card MarkdownV2 send falls back, but its fallback
 * text still contains markdown markers. This seam uses the adapter's own
 * definitive-400 fallback while supplying the preflighted plain text.
 */
export class GatewayTelegramAdapter extends TelegramAdapter {
  constructor(config?: TelegramAdapterConfig) {
    super(config);
  }

  async postActionMessage(
    threadId: string,
    message: TelegramActionMessage,
  ): Promise<{ readonly id: string; readonly threadId: string; readonly raw: TelegramRawMessage }> {
    const thread = this.decodeThreadId(threadId);
    const replyMarkup = { inline_keyboard: keyboard(message.actions) };
    const plainText = boundedPlainText(message.plainText);
    const send = (
      parseMode: "MarkdownV2" | "plain",
      text: string,
    ): Promise<TelegramRawMessage> => this.telegramFetch<TelegramRawMessage>(
      "sendMessage",
      {
        chat_id: thread.chatId,
        ...(thread.messageThreadId !== undefined
          ? { message_thread_id: thread.messageThreadId }
          : {}),
        text,
        reply_markup: replyMarkup,
        ...(parseMode === "MarkdownV2" ? { parse_mode: "MarkdownV2" } : {}),
      },
    );

    const raw = message.markdownV2 && message.markdownV2.length <= TELEGRAM_TEXT_LIMIT
      ? await this.withTelegramMarkdownFallback(
          "MarkdownV2",
          send,
          {
            initialText: message.markdownV2,
            fallbackText: plainText,
            method: "sendMessage",
            threadId,
          },
        )
      : await send("plain", plainText);

    return {
      id: `${raw.chat.id}:${raw.message_id}`,
      threadId: this.encodeThreadId({
        chatId: String(raw.chat.id),
        messageThreadId: raw.message_thread_id ?? thread.messageThreadId,
      }),
      raw,
    };
  }
}

export function createGatewayTelegramAdapter(
  config?: TelegramAdapterConfig,
): GatewayTelegramAdapter {
  return new GatewayTelegramAdapter(config);
}
