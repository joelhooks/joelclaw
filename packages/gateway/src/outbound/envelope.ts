import type { InlineButton } from "../channels/telegram";

export type OutboundChannelId = "console" | "discord" | "imessage" | "slack" | "telegram" | "cli";

export type OutboundEnvelope = {
  text: string;
  buttons?: InlineButton[][];
  silent?: boolean;
  replyTo?: number | string;
  format?: "html" | "markdown" | "plain";
  channel?: OutboundChannelId;
  target?: string;
};

export function createEnvelope(
  text: string,
  options?: Partial<Omit<OutboundEnvelope, "text">>,
): OutboundEnvelope {
  return {
    text,
    ...options,
  };
}
