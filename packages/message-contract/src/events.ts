import { Schema } from "effect";
import { FlowId } from "./flow-id";
import { MESSAGE_CONTRACT_VERSION, MessagePlatform } from "./kinds";

export const MESSAGE_REACTION_RECEIVED = "message/reaction.received" as const;
export const MESSAGE_REPLY_RECEIVED = "message/reply.received" as const;

const UtcTimestamp = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
);
const LegacyNotifyFlowId = Schema.String.pipe(
  Schema.pattern(/^notify:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
  Schema.brand("LegacyNotifyFlowId"),
);

/** Migration-safe return-path correlation while legacy notify:* receipts drain. */
export const MessageFlowReference = Schema.Union(FlowId, LegacyNotifyFlowId);
export type MessageFlowReference = typeof MessageFlowReference.Type;

export const ReactionCorrelationSource = Schema.Literal(
  "gateway-acting",
  "redis-contract",
  "redis-legacy-telegram",
  "journal",
);
export type ReactionCorrelationSource = typeof ReactionCorrelationSource.Type;

export const MessageActor = Schema.Struct({
  id: Schema.NonEmptyTrimmedString,
  displayName: Schema.optional(Schema.NonEmptyTrimmedString),
});

const EventBase = {
  contractVersion: Schema.Literal(MESSAGE_CONTRACT_VERSION),
  flowId: MessageFlowReference,
  platform: MessagePlatform,
  actor: MessageActor,
  at: UtcTimestamp,
};

export const MessageReactionReceivedEvent = Schema.Struct({
  name: Schema.Literal(MESSAGE_REACTION_RECEIVED),
  data: Schema.Struct({
    ...EventBase,
    emoji: Schema.NonEmptyTrimmedString,
    action: Schema.Literal("added", "removed"),
    added: Schema.Boolean,
    rawEventId: Schema.NonEmptyTrimmedString,
    platformMessageId: Schema.NonEmptyTrimmedString,
    correlationSource: ReactionCorrelationSource,
  }),
});
export interface MessageReactionReceivedEvent
  extends Schema.Schema.Type<typeof MessageReactionReceivedEvent> {}

export const MessageReplyReceivedEvent = Schema.Struct({
  name: Schema.Literal(MESSAGE_REPLY_RECEIVED),
  data: Schema.Struct({
    ...EventBase,
    text: Schema.NonEmptyTrimmedString,
  }),
});
export interface MessageReplyReceivedEvent
  extends Schema.Schema.Type<typeof MessageReplyReceivedEvent> {}
