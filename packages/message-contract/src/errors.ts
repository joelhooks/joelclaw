import { Data } from "effect";

export class InvalidMessageIntentError extends Data.TaggedError("InvalidMessageIntentError")<{
  readonly operation: "message-contract.decode-intent";
  readonly code: "INVALID_MESSAGE_INTENT";
  readonly fix: string;
  readonly cause: unknown;
}> {}

export class MessageRouteNotFoundError extends Data.TaggedError("MessageRouteNotFoundError")<{
  readonly operation: "message-contract.resolve-route";
  readonly code: "MESSAGE_ROUTE_NOT_FOUND";
  readonly fix: string;
  readonly kind: string;
}> {}

export class MessageTargetMissingError extends Data.TaggedError("MessageTargetMissingError")<{
  readonly operation: "message-contract.resolve-target";
  readonly code: "MESSAGE_TARGET_MISSING";
  readonly fix: string;
  readonly platform: string;
}> {}

export class MessageAdapterUnavailableError extends Data.TaggedError("MessageAdapterUnavailableError")<{
  readonly operation: "message-contract.send";
  readonly code: "MESSAGE_ADAPTER_UNAVAILABLE";
  readonly fix: string;
  readonly platform: string;
}> {}

export class ReplyAnchorNotFoundError extends Data.TaggedError("ReplyAnchorNotFoundError")<{
  readonly operation: "message-contract.resolve-reply";
  readonly code: "REPLY_ANCHOR_NOT_FOUND";
  readonly fix: string;
  readonly flowId: string;
  readonly platform: string;
}> {}

export class MessageDeliveryError extends Data.TaggedError("MessageDeliveryError")<{
  readonly operation: "message-contract.send";
  readonly code: "MESSAGE_DELIVERY_FAILED";
  readonly fix: string;
  readonly flowId: string;
  readonly platform: string;
  readonly cause: unknown;
}> {}
