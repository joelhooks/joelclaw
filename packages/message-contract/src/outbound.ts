import { Schema } from "effect";
import { InvalidMessageIntentError } from "./errors";
import { FlowId } from "./flow-id";
import { MESSAGE_CONTRACT_VERSION, MessageKind } from "./kinds";

export const OutboundIntentV2 = Schema.Struct({
  contractVersion: Schema.Literal(MESSAGE_CONTRACT_VERSION),
  kind: MessageKind,
  content: Schema.NonEmptyTrimmedString,
  correlationId: Schema.NonEmptyTrimmedString,
  replyTo: Schema.optional(FlowId),
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
