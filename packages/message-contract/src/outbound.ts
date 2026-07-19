import { Schema } from "effect";
import { InvalidMessageIntentError } from "./errors";
import { FlowId } from "./flow-id";
import { MESSAGE_CONTRACT_VERSION, MessageKind } from "./kinds";

export const MESSAGE_CALLBACK_ACTION_ID = "message_action" as const;
export const LEARNER_FLOW_ACTION_IDS = [
  "learner-flow.ack",
  "learner-flow.run",
  "learner-flow.investigate",
] as const;

const TELEGRAM_CALLBACK_LIMIT_BYTES = 64;

export const CallbackActionId = Schema.Literal(...LEARNER_FLOW_ACTION_IDS);
export type CallbackActionId = typeof CallbackActionId.Type;

const BoundedCallbackActionId = CallbackActionId.pipe(
  Schema.filter((id) =>
    new TextEncoder().encode(
      `chat:${JSON.stringify({ a: MESSAGE_CALLBACK_ACTION_ID, v: id })}`,
    ).byteLength <= TELEGRAM_CALLBACK_LIMIT_BYTES
  ),
);

export const MessageCallbackAction = Schema.Struct({
  kind: Schema.Literal("callback"),
  id: BoundedCallbackActionId,
  label: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(40)),
});
export interface MessageCallbackAction
  extends Schema.Schema.Type<typeof MessageCallbackAction> {}

export const MessageAction = MessageCallbackAction;
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
