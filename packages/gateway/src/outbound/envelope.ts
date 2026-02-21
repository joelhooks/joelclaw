import type { InlineButton } from "../channels/telegram";

export type OutboundEnvelope = {
  text: string;
  buttons?: InlineButton[][];
  silent?: boolean;
  replyTo?: number;
  format?: "html" | "markdown" | "plain";
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
