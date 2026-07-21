import { Schema } from "effect";

export const MESSAGE_CONTRACT_VERSION = 2 as const;

export const MessageKind = Schema.Literal("memory", "alert", "digest", "ask", "receipt");
export type MessageKind = typeof MessageKind.Type;

export const MessagePlatform = Schema.Literal("telegram", "slack", "discord");
export type MessagePlatform = typeof MessagePlatform.Type;

export const MessageDeliveryMode = Schema.Literal("immediate", "batch");
export type MessageDeliveryMode = typeof MessageDeliveryMode.Type;

export const FormattingProfile = Schema.Literal("plain", "markdown");
export type FormattingProfile = typeof FormattingProfile.Type;
