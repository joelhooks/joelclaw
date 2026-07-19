import { Schema } from "effect";
import { InvalidMessageIntentError } from "./errors";
import { FlowId } from "./flow-id";
import { MESSAGE_CONTRACT_VERSION, MessageKind } from "./kinds";

export const MESSAGE_REACTION_ACTION_ID = "message_reaction" as const;
const TELEGRAM_CALLBACK_LIMIT_BYTES = 64;

const MessageReactionEmoji = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(16),
  Schema.filter((emoji) =>
    new TextEncoder().encode(
      `chat:${JSON.stringify({ a: MESSAGE_REACTION_ACTION_ID, v: emoji })}`,
    ).byteLength <= TELEGRAM_CALLBACK_LIMIT_BYTES
  ),
);

export const MessageReactionAction = Schema.Struct({
  kind: Schema.Literal("reaction"),
  label: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(40)),
  emoji: MessageReactionEmoji,
});
export interface MessageReactionAction
  extends Schema.Schema.Type<typeof MessageReactionAction> {}

export const MessageAction = MessageReactionAction;
export type MessageAction = typeof MessageAction.Type;

export const OutboundIntentV2 = Schema.Struct({
  contractVersion: Schema.Literal(MESSAGE_CONTRACT_VERSION),
  kind: MessageKind,
  content: Schema.NonEmptyTrimmedString,
  correlationId: Schema.NonEmptyTrimmedString,
  replyTo: Schema.optional(FlowId),
  actions: Schema.optional(
    Schema.Array(MessageAction).pipe(Schema.minItems(1), Schema.maxItems(6)),
  ),
});
export interface OutboundIntentV2 extends Schema.Schema.Type<typeof OutboundIntentV2> {}

export function decodeOutboundIntent(input: unknown): OutboundIntentV2 {
  try {
    const decoded = Schema.decodeUnknownSync(OutboundIntentV2)(input);
    if (!decoded.content.trim() || !decoded.correlationId.trim()) {
      throw new Error("content and correlationId must not be blank");
    }
    return decoded;
  } catch (cause) {
    throw new InvalidMessageIntentError({
      operation: "message-contract.decode-intent",
      code: "INVALID_MESSAGE_INTENT",
      cause,
      fix: "Send contractVersion 2 with kind, non-blank content, and a stable correlationId.",
    });
  }
}
