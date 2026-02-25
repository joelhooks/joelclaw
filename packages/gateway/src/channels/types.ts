/** Consumer channels — bidirectional messaging platforms */
export type ChannelPlatform = "telegram" | "slack" | "discord" | "imessage";

export interface SendOptions {
  format?: "html" | "markdown" | "plain";
  silent?: boolean;
  buttons?: Array<{ text: string; callbackData?: string; url?: string }>;
  replyTo?: string;
  threadId?: string;
  noPreview?: boolean;
}

export interface InboundMessage {
  source: ChannelPlatform;
  prompt: string;
  metadata?: Record<string, unknown>;
  replyTo?: string;
  threadId?: string;
}

export type MessageHandler = (message: InboundMessage) => void | Promise<void>;

export interface Channel {
  readonly platform: ChannelPlatform;
  start(..._args: unknown[]): Promise<void>;
  stop(): Promise<void>;
  send(target: string, text: string, options?: SendOptions): Promise<void>;
  onMessage?: (handler: MessageHandler) => void;
}

export type ChannelRegistry = Map<ChannelPlatform, Channel>;
