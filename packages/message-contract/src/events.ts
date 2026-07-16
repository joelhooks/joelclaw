import { Schema } from "effect";
import { FlowId } from "./flow-id";
import { MESSAGE_CONTRACT_VERSION, MessagePlatform } from "./kinds";

export const MESSAGE_REACTION_RECEIVED = "message/reaction.received" as const;
export const MESSAGE_REPLY_RECEIVED = "message/reply.received" as const;

const UtcTimestamp = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
);

export const MessageActor = Schema.Struct({
  id: Schema.NonEmptyTrimmedString,
  displayName: Schema.optional(Schema.NonEmptyTrimmedString),
});

const EventBase = {
  contractVersion: Schema.Literal(MESSAGE_CONTRACT_VERSION),
  flowId: FlowId,
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
