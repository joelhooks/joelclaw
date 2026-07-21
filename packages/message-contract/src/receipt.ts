import { Schema } from "effect";
import { FlowId } from "./flow-id";
import {
  FormattingProfile,
  MESSAGE_CONTRACT_VERSION,
  MessageDeliveryMode,
  MessagePlatform,
} from "./kinds";

export const DeliveryState = Schema.Literal(
  "requested",
  "confirmed",
  "failed",
  "digested",
);
export type DeliveryState = typeof DeliveryState.Type;

const UtcTimestamp = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
);
const Link = Schema.Struct({ href: Schema.NonEmptyTrimmedString });

export const DeliveryReceiptEnvelopeV2 = Schema.Struct({
  contractVersion: Schema.Literal(MESSAGE_CONTRACT_VERSION),
  type: Schema.Literal("message/delivery.receipt"),
  data: Schema.Struct({
    flowId: FlowId,
    correlationId: Schema.NonEmptyTrimmedString,
    requestedAt: UtcTimestamp,
    confirmedAt: Schema.NullOr(UtcTimestamp),
    deliveryState: DeliveryState,
    platform: MessagePlatform,
    platformMessageId: Schema.NullOr(Schema.NonEmptyTrimmedString),
    threadId: Schema.NullOr(Schema.NonEmptyTrimmedString),
    route: Schema.Struct({
      delivery: MessageDeliveryMode,
      formatting: FormattingProfile,
    }),
  }),
  _links: Schema.Struct({
    self: Link,
    flow: Link,
    journal: Link,
  }),
});
export interface DeliveryReceiptEnvelopeV2
  extends Schema.Schema.Type<typeof DeliveryReceiptEnvelopeV2> {}

export function createDeliveryReceipt(
  data: DeliveryReceiptEnvelopeV2["data"],
): DeliveryReceiptEnvelopeV2 {
  const encodedFlowId = encodeURIComponent(data.flowId);
  return Schema.decodeUnknownSync(DeliveryReceiptEnvelopeV2)({
    contractVersion: MESSAGE_CONTRACT_VERSION,
    type: "message/delivery.receipt",
    data,
    _links: {
      self: { href: `joelclaw://messages/receipts/${encodedFlowId}` },
      flow: { href: `joelclaw://messages/flows/${encodedFlowId}` },
      journal: { href: `joelclaw://message-journal/flows/${encodedFlowId}` },
    },
  });
}
