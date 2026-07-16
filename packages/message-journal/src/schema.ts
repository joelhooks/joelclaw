import { createHash } from "node:crypto";
import { Schema } from "effect";

export const JournalDirection = Schema.Literal("inbound", "outbound", "interaction");
export type JournalDirection = typeof JournalDirection.Type;

const UInt16 = Schema.Number.pipe(Schema.int(), Schema.between(0, 65_535));
const PositiveUInt16 = Schema.Number.pipe(Schema.int(), Schema.between(1, 65_535));
const UInt32 = Schema.Number.pipe(Schema.int(), Schema.between(0, 4_294_967_295));
const PositiveUInt32 = Schema.Number.pipe(Schema.int(), Schema.between(1, 4_294_967_295));
const SafeInt64 = Schema.Number.pipe(
  Schema.int(),
  Schema.between(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
);

export const JournalEvent = Schema.Struct({
  schema_version: UInt16,
  journal_event_id: Schema.String,
  message_key: Schema.String,
  flow_id: Schema.String,
  channel: Schema.String,
  direction: JournalDirection,
  event_type: Schema.String,
  content_kind: Schema.String,
  occurred_at: Schema.String,
  recorded_at: Schema.String,
  producer: Schema.String,
  origin_system_id: Schema.String,
  source_event_id: Schema.NullOr(Schema.String),
  source_ref: Schema.String,
  route: Schema.String,
  classification: Schema.String,
  reason: Schema.String,
  investigation_state: Schema.String,
  investigation_result: Schema.String,
  telegram_chat_id: SafeInt64,
  telegram_message_id: Schema.NullOr(SafeInt64),
  telegram_update_id: Schema.NullOr(SafeInt64),
  in_reply_to_message_id: Schema.NullOr(SafeInt64),
  callback_query_id: Schema.NullOr(Schema.String),
  interaction_action: Schema.String,
  interaction_payload: Schema.String,
  interaction_outcome: Schema.String,
  chunk_index: Schema.NullOr(UInt16),
  revision: PositiveUInt32,
  attempt: PositiveUInt16,
  text: Schema.String,
  transport_text: Schema.String,
  content_hash: Schema.String,
  content_chars: UInt32,
  content_bytes: UInt32,
  delivery_state: Schema.String,
  error_code: Schema.String,
  metadata_json: Schema.String,
});

export interface JournalEvent extends Schema.Schema.Type<typeof JournalEvent> {}

export interface JournalEventInput {
  readonly messageKey: string;
  readonly flowId: string;
  readonly channel?: string;
  readonly direction: JournalDirection;
  readonly eventType: string;
  readonly contentKind?: string;
  readonly occurredAt?: Date | string;
  readonly recordedAt?: Date | string;
  readonly producer: string;
  readonly originSystemId: string;
  readonly sourceEventId?: string | null;
  readonly sourceRef?: string;
  readonly route?: string;
  readonly classification?: string;
  readonly reason?: string;
  readonly investigationState?: string;
  readonly investigationResult?: string;
  readonly telegramChatId: number;
  readonly telegramMessageId?: number | null;
  readonly telegramUpdateId?: number | null;
  readonly inReplyToMessageId?: number | null;
  readonly callbackQueryId?: string | null;
  readonly interactionAction?: string;
  readonly interactionPayload?: string;
  readonly interactionOutcome?: string;
  readonly chunkIndex?: number | null;
  readonly revision?: number;
  readonly attempt?: number;
  readonly text?: string;
  readonly transportText?: string;
  readonly deliveryState?: string;
  readonly errorCode?: string;
  readonly metadata?: unknown;
}

export interface JournalEventIdentityInput {
  readonly flowId: string;
  readonly direction: JournalDirection;
  readonly eventType: string;
  readonly messageId?: number | null;
  readonly chunkIndex?: number | null;
  readonly attempt?: number;
  readonly revision?: number;
  readonly callbackQueryId?: string | null;
}

function clickHouseTimestamp(value: Date | string | undefined, fallback: Date): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : fallback;
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function metadataJson(value: unknown): string {
  if (value === undefined) return "{}";
  return JSON.stringify(value);
}

export function deterministicJournalEventId(input: JournalEventIdentityInput): string {
  const identity = JSON.stringify([
    input.flowId,
    input.direction,
    input.eventType,
    input.messageId ?? null,
    input.chunkIndex ?? null,
    input.attempt ?? 1,
    input.revision ?? 1,
    input.callbackQueryId ?? null,
  ]);
  return createHash("sha256").update(identity).digest("hex");
}

export function createJournalEvent(
  input: JournalEventInput,
  now: () => Date = () => new Date()
): JournalEvent {
  const text = input.text ?? "";
  const transportText = input.transportText ?? text;
  const createdAt = now();
  const occurredAt = clickHouseTimestamp(input.occurredAt, createdAt);
  const recordedAt = clickHouseTimestamp(input.recordedAt, createdAt);
  const attempt = input.attempt ?? 1;
  const revision = input.revision ?? 1;
  const chunkIndex = input.chunkIndex ?? null;
  const callbackQueryId = input.callbackQueryId ?? null;

  return Schema.decodeUnknownSync(JournalEvent)({
    schema_version: 1,
    journal_event_id: deterministicJournalEventId({
      flowId: input.flowId,
      direction: input.direction,
      eventType: input.eventType,
      messageId: input.telegramMessageId,
      chunkIndex,
      attempt,
      revision,
      callbackQueryId,
    }),
    message_key: input.messageKey,
    flow_id: input.flowId,
    channel: input.channel ?? "telegram",
    direction: input.direction,
    event_type: input.eventType,
    content_kind: input.contentKind ?? "text",
    occurred_at: occurredAt,
    recorded_at: recordedAt,
    producer: input.producer,
    origin_system_id: input.originSystemId,
    source_event_id: input.sourceEventId ?? null,
    source_ref: input.sourceRef ?? "",
    route: input.route ?? "",
    classification: input.classification ?? "unclassified",
    reason: input.reason ?? "",
    investigation_state: input.investigationState ?? "",
    investigation_result: input.investigationResult ?? "",
    telegram_chat_id: input.telegramChatId,
    telegram_message_id: input.telegramMessageId ?? null,
    telegram_update_id: input.telegramUpdateId ?? null,
    in_reply_to_message_id: input.inReplyToMessageId ?? null,
    callback_query_id: callbackQueryId,
    interaction_action: input.interactionAction ?? "",
    interaction_payload: input.interactionPayload ?? "",
    interaction_outcome: input.interactionOutcome ?? "",
    chunk_index: chunkIndex,
    revision,
    attempt,
    text,
    transport_text: transportText,
    content_hash: createHash("sha256").update(transportText).digest("hex"),
    content_chars: [...transportText].length,
    content_bytes: Buffer.byteLength(transportText, "utf8"),
    delivery_state: input.deliveryState ?? "",
    error_code: input.errorCode ?? "",
    metadata_json: metadataJson(input.metadata),
  });
}
