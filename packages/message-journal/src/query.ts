import { Context, Data, Effect, Layer, Schema } from "effect";
import { ClickHouseClient, parseJsonEachRow } from "./clickhouse";
import type { MessageJournalConnection } from "./config";
import { JournalEvent, type JournalEvent as JournalEventRow } from "./schema";
import { parseDuration, qualifiedTable, sqlString } from "./sql";

export interface AuditMessagesInput {
  readonly since: string;
  readonly channel?: string;
  readonly category?: string;
  readonly direction?: string;
  readonly limit?: number;
}

export interface TraceMessageLookup {
  readonly lookup: string | number;
  readonly telegramChatId?: number;
}

export interface MessageTraceCandidate {
  readonly flowId: string;
  readonly telegramChatId: number;
  readonly telegramMessageId: number;
  readonly occurredAt: string;
}

export type MessageTraceResult =
  | {
      readonly kind: "trace";
      readonly flowId: string;
      readonly events: ReadonlyArray<JournalEventRow>;
    }
  | {
      readonly kind: "ambiguous";
      readonly lookup: string;
      readonly candidates: ReadonlyArray<MessageTraceCandidate>;
    }
  | {
      readonly kind: "not_found";
      readonly lookup: string;
    };

export class MessageJournalQueryError extends Data.TaggedError("MessageJournalQueryError")<{
  readonly operation: "audit" | "resolve-telegram-id" | "trace";
  readonly code: string;
  readonly cause?: unknown;
}> {}

export interface MessageJournalQueryService {
  readonly auditMessages: (
    input: AuditMessagesInput
  ) => Effect.Effect<ReadonlyArray<JournalEventRow>, MessageJournalQueryError>;
  readonly traceMessage: (
    lookup: string | number | TraceMessageLookup
  ) => Effect.Effect<MessageTraceResult, MessageJournalQueryError>;
}

export class MessageJournalQuery extends Context.Tag(
  "@joelclaw/message-journal/MessageJournalQuery"
)<MessageJournalQuery, MessageJournalQueryService>() {}

function decodeJournalRows(body: string): ReadonlyArray<JournalEventRow> {
  return parseJsonEachRow(body).map((row) => Schema.decodeUnknownSync(JournalEvent)(row));
}

function queryFailure(
  operation: MessageJournalQueryError["operation"],
  code: string,
  cause: unknown
): MessageJournalQueryError {
  return new MessageJournalQueryError({ operation, code, cause });
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseCandidate(row: Record<string, unknown>): MessageTraceCandidate | undefined {
  const flowId = stringValue(row.flow_id);
  const telegramChatId = finiteNumber(row.telegram_chat_id);
  const telegramMessageId = finiteNumber(row.telegram_message_id);
  const occurredAt = stringValue(row.occurred_at);
  if (
    flowId === undefined ||
    telegramChatId === undefined ||
    telegramMessageId === undefined ||
    occurredAt === undefined
  ) {
    return undefined;
  }
  return { flowId, telegramChatId, telegramMessageId, occurredAt };
}

export const messageJournalQueryLayer = (
  connection: Pick<MessageJournalConnection, "database" | "table">
) =>
  Layer.effect(
    MessageJournalQuery,
    Effect.gen(function* () {
      const clickHouse = yield* ClickHouseClient;
      const table = qualifiedTable(connection.database, connection.table);

      const runRows = Effect.fn("MessageJournal.Query.runRows")(function* (
        operation: MessageJournalQueryError["operation"],
        sql: string
      ) {
        const body = yield* clickHouse
          .execute({ sql })
          .pipe(
            Effect.mapError((cause) =>
              queryFailure(operation, "CLICKHOUSE_QUERY_FAILED", cause)
            )
          );
        return yield* Effect.try({
          try: () => parseJsonEachRow(body),
          catch: (cause) => queryFailure(operation, "CLICKHOUSE_DECODE_FAILED", cause),
        });
      });

      const traceFlow = Effect.fn("MessageJournal.Query.traceFlow")(function* (flowId: string) {
        const rows = yield* runRows(
          "trace",
          `SELECT * FROM ${table} FINAL WHERE flow_id = ${sqlString(flowId)} ORDER BY occurred_at, journal_event_id FORMAT JSONEachRow`
        );
        const events = yield* Effect.try({
          try: () => rows.map((row) => Schema.decodeUnknownSync(JournalEvent)(row)),
          catch: (cause) => queryFailure("trace", "JOURNAL_ROW_DECODE_FAILED", cause),
        });
        if (events.length === 0) {
          return { kind: "not_found" as const, lookup: flowId };
        }
        return { kind: "trace" as const, flowId, events };
      });

      const auditMessages = Effect.fn("MessageJournal.Query.auditMessages")(function* (
        input: AuditMessagesInput
      ) {
        const durationMs = yield* Effect.try({
          try: () => parseDuration(input.since),
          catch: (cause) => queryFailure("audit", "INVALID_DURATION", cause),
        });
        const filters = [`occurred_at >= now64(3) - toIntervalMillisecond(${durationMs})`];
        if (input.channel) filters.push(`channel = ${sqlString(input.channel)}`);
        if (input.category) filters.push(`classification = ${sqlString(input.category)}`);
        if (input.direction) filters.push(`direction = ${sqlString(input.direction)}`);
        const limit = Math.min(1_000, Math.max(1, Math.trunc(input.limit ?? 100)));
        const rows = yield* runRows(
          "audit",
          `SELECT * FROM ${table} FINAL WHERE ${filters.join(" AND ")} ORDER BY occurred_at DESC LIMIT ${limit} FORMAT JSONEachRow`
        );
        return yield* Effect.try({
          try: () => decodeJournalRows(rows.map((row) => JSON.stringify(row)).join("\n")),
          catch: (cause) => queryFailure("audit", "JOURNAL_ROW_DECODE_FAILED", cause),
        });
      });

      const traceMessage = Effect.fn("MessageJournal.Query.traceMessage")(function* (
        lookupInput: string | number | TraceMessageLookup
      ) {
        const normalized =
          typeof lookupInput === "object"
            ? lookupInput
            : { lookup: lookupInput, telegramChatId: undefined };
        const lookup = String(normalized.lookup).trim();
        const numeric = /^\d+$/u.test(lookup) ? Number(lookup) : undefined;

        if (numeric === undefined || !Number.isSafeInteger(numeric)) {
          return yield* traceFlow(lookup);
        }

        const chatFilter =
          normalized.telegramChatId === undefined
            ? ""
            : ` AND telegram_chat_id = ${Math.trunc(normalized.telegramChatId)}`;
        const candidateRows = yield* runRows(
          "resolve-telegram-id",
          `SELECT telegram_chat_id, telegram_message_id, flow_id, min(occurred_at) AS occurred_at FROM ${table} FINAL WHERE telegram_message_id = ${numeric}${chatFilter} GROUP BY telegram_chat_id, telegram_message_id, flow_id ORDER BY occurred_at DESC FORMAT JSONEachRow`
        );
        const candidates = candidateRows.flatMap((row) => {
          const candidate = parseCandidate(row);
          return candidate ? [candidate] : [];
        });

        if (candidates.length === 0) return { kind: "not_found" as const, lookup };
        if (candidates.length > 1) {
          return { kind: "ambiguous" as const, lookup, candidates };
        }
        const candidate = candidates[0];
        if (!candidate) return { kind: "not_found" as const, lookup };
        return yield* traceFlow(candidate.flowId);
      });

      return MessageJournalQuery.of({ auditMessages, traceMessage });
    })
  );

export const auditMessages = (input: AuditMessagesInput) =>
  Effect.flatMap(MessageJournalQuery, (query) => query.auditMessages(input));

export const traceMessage = (lookup: string | number | TraceMessageLookup) =>
  Effect.flatMap(MessageJournalQuery, (query) => query.traceMessage(lookup));
