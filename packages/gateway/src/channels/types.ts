/** Consumer channels — bidirectional messaging platforms */
export type ChannelPlatform = "telegram" | "slack" | "discord" | "imessage";

export interface SendMediaPayload {
  url?: string;      // remote URL
  path?: string;     // local file path
  mimeType: string;  // e.g. "image/png", "video/mp4", "audio/ogg", "application/pdf"
  caption?: string;  // optional caption (used instead of text)
}

export interface SendOptions {
  format?: "html" | "markdown" | "plain";
  silent?: boolean;
  buttons?: Array<{ text: string; callbackData?: string; url?: string }>;
  replyTo?: string;
  threadId?: string;
  noPreview?: boolean;
  media?: SendMediaPayload;
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
  sendMedia?(target: string, media: SendMediaPayload, options?: SendOptions): Promise<void>;
  onMessage?: (handler: MessageHandler) => void;
}

export type ChannelRegistry = Map<ChannelPlatform, Channel>;
