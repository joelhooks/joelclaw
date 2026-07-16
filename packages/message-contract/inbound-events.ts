import { Schema } from "effect";

/**
 * Contract-v2 inbound schemas are intentionally standalone until the parallel
 * outbound slice finishes the @joelclaw/message-contract package skeleton.
 * TODO(integrate): export these from that package's public index.
 */
export const INBOUND_EVENT_CONTRACT_VERSION = 2 as const;

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));
const IsoInstantString = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
);
const NullOrNonEmptyString = Schema.NullOr(NonEmptyString);

export const InboundPlatform = Schema.Literal("telegram", "slack", "discord");
export type InboundPlatform = typeof InboundPlatform.Type;

export const InboundEventKind = Schema.Literal(
  "message",
  "command",
  "interaction",
  "reaction",
);
export type InboundEventKind = typeof InboundEventKind.Type;

export const InboundPolicyAction = Schema.Literal("invoke", "observe", "reject");
export type InboundPolicyAction = typeof InboundPolicyAction.Type;

export const InboundAuthorizationVerdict = Schema.Literal("accepted", "rejected");
export type InboundAuthorizationVerdict = typeof InboundAuthorizationVerdict.Type;

export const InboundAuthorizationReason = Schema.Literal(
  "authorized_joel",
  "self_message",
  "bot_message",
  "non_joel_actor",
  "missing_actor",
);
export type InboundAuthorizationReason = typeof InboundAuthorizationReason.Type;

export const InboundActor = Schema.Struct({
  platformUserId: Schema.String,
  userName: NullOrNonEmptyString,
  displayName: NullOrNonEmptyString,
  isBot: Schema.Union(Schema.Boolean, Schema.Literal("unknown")),
  isSelf: Schema.Boolean,
});
export interface InboundActor extends Schema.Schema.Type<typeof InboundActor> {}

export const InboundPlatformIds = Schema.Struct({
  conversationId: NonEmptyString,
  messageId: NullOrNonEmptyString,
  threadId: NullOrNonEmptyString,
  actorId: Schema.String,
  workspaceId: NullOrNonEmptyString,
});
export interface InboundPlatformIds
  extends Schema.Schema.Type<typeof InboundPlatformIds> {}

export const InboundRawAnchors = Schema.Struct({
  transportEventId: NullOrNonEmptyString,
  updateId: NullOrNonEmptyString,
  callbackQueryId: NullOrNonEmptyString,
  sourceMessageId: NullOrNonEmptyString,
  sourceThreadId: NullOrNonEmptyString,
});
export interface InboundRawAnchors
  extends Schema.Schema.Type<typeof InboundRawAnchors> {}

export const InboundAuditLineage = Schema.Struct({
  source: NonEmptyString,
  transport: NonEmptyString,
  sdkName: Schema.Literal("vercel/chat"),
  sdkVersion: NonEmptyString,
  normalizedAt: IsoInstantString,
  rawEventType: NonEmptyString,
  rawEventId: NullOrNonEmptyString,
  lineageId: NonEmptyString,
});
export interface InboundAuditLineage
  extends Schema.Schema.Type<typeof InboundAuditLineage> {}

export const InboundAuthorization = Schema.Union(
  Schema.Struct({
    verdict: Schema.Literal("accepted"),
    reason: Schema.Literal("authorized_joel"),
    policyAction: Schema.Literal("invoke", "observe"),
    expectedActorId: NonEmptyString,
    actualActorId: NonEmptyString,
    canPublish: Schema.Literal(true),
    canExecute: Schema.Literal(false),
  }),
  Schema.Struct({
    verdict: Schema.Literal("rejected"),
    reason: Schema.Literal(
      "self_message",
      "bot_message",
      "non_joel_actor",
      "missing_actor",
    ),
    policyAction: Schema.Literal("reject"),
    expectedActorId: NonEmptyString,
    actualActorId: Schema.String,
    canPublish: Schema.Literal(true),
    canExecute: Schema.Literal(false),
  }),
);
export type InboundAuthorization = Schema.Schema.Type<
  typeof InboundAuthorization
>;

const CommonInboundFields = {
  contractVersion: Schema.Literal(INBOUND_EVENT_CONTRACT_VERSION),
  eventId: NonEmptyString,
  platform: InboundPlatform,
  occurredAt: IsoInstantString,
  observedAt: IsoInstantString,
  shadow: Schema.Literal(true),
  actor: InboundActor,
  platformIds: InboundPlatformIds,
  rawAnchors: InboundRawAnchors,
  audit: InboundAuditLineage,
  authorization: InboundAuthorization,
};

export const InboundMessageEvent = Schema.Struct({
  ...CommonInboundFields,
  type: Schema.Literal("message"),
  text: Schema.String,
  isMention: Schema.Boolean,
  attachmentCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});
export interface InboundMessageEvent
  extends Schema.Schema.Type<typeof InboundMessageEvent> {}

export const InboundCommandEvent = Schema.Struct({
  ...CommonInboundFields,
  type: Schema.Literal("command"),
  command: Schema.String,
  argumentsText: Schema.String,
});
export interface InboundCommandEvent
  extends Schema.Schema.Type<typeof InboundCommandEvent> {}

export const InboundInteractionEvent = Schema.Struct({
  ...CommonInboundFields,
  type: Schema.Literal("interaction"),
  actionId: Schema.String,
  value: Schema.NullOr(Schema.String),
});
export interface InboundInteractionEvent
  extends Schema.Schema.Type<typeof InboundInteractionEvent> {}

export const InboundReactionEvent = Schema.Struct({
  ...CommonInboundFields,
  type: Schema.Literal("reaction"),
  emoji: Schema.String,
  rawEmoji: Schema.String,
  added: Schema.Boolean,
});
export interface InboundReactionEvent
  extends Schema.Schema.Type<typeof InboundReactionEvent> {}

export const InboundEvent = Schema.Union(
  InboundMessageEvent,
  InboundCommandEvent,
  InboundInteractionEvent,
  InboundReactionEvent,
);
export type InboundEvent = typeof InboundEvent.Type;

export const decodeInboundEvent = Schema.decodeUnknownSync(InboundEvent);
