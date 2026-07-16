import { Schema } from "effect";

export const MESSAGE_CONTRACT_VERSION = 2 as const;

export const MessageKind = Schema.Literal("memory", "alert", "digest", "ask", "receipt");
export type MessageKind = typeof MessageKind.Type;

export const MessagePlatform = Schema.Literal("telegram", "slack", "discord");
export type MessagePlatform = typeof MessagePlatform.Type;

export const DeliveryLane = Schema.Literal("operator", "digest", "automation");
export type DeliveryLane = typeof DeliveryLane.Type;

export const MessageUrgency = Schema.Literal("low", "normal", "high", "critical");
export type MessageUrgency = typeof MessageUrgency.Type;

export const FormattingProfile = Schema.Literal("plain", "markdown");
export type FormattingProfile = typeof FormattingProfile.Type;
