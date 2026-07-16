import { Args, Command, Options } from "@effect/cli";
import {
  type AuditMessagesInput,
  auditMessages,
  clickHouseClientLayer,
  type JournalEvent,
  type MessageTraceResult,
  messageJournalQueryLayer,
  parseDuration,
  resolveMessageJournalConnection,
  traceMessage,
} from "@joelclaw/message-journal";
import { Console, Effect, Layer, Option } from "effect";
import {
  buildErrorEnvelope,
  buildSuccessEnvelope,
  type JoelclawEnvelope,
  type NextAction,
} from "../response";

type MessagesDependencies = {
  readonly auditMessages: (
    input: AuditMessagesInput,
  ) => Effect.Effect<ReadonlyArray<JournalEvent>, unknown>;
  readonly traceMessage: (
    lookup: string | number,
  ) => Effect.Effect<MessageTraceResult, unknown>;
};

type JournalMetadata = Record<string, unknown>;

function asRecord(value: unknown): JournalMetadata {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JournalMetadata)
    : {};
}

function parseMetadata(raw: string): JournalMetadata {
  if (!raw) return {};
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return { parseError: "invalid metadata_json" };
  }
}

function scalar(value: unknown): string | number | boolean | null {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? value
    : null;
}

function outcomeFor(row: JournalEvent): string {
  const eventType = row.event_type.toLowerCase();
  const deliveryState = row.delivery_state.toLowerCase();
  if (eventType.includes("suppress") || deliveryState === "suppressed") return "suppressed";
  if (deliveryState === "confirmed" || deliveryState === "delivered" || deliveryState === "sent") {
    return "sent";
  }
  if (eventType.includes("fail") || deliveryState === "failed" || row.error_code) return "failed";
  return deliveryState || "recorded";
}

/**
 * Exact message bodies are intentionally exposed only inside the private
 * `messages` command result. Errors and follow-up commands use IDs only.
 */
export function formatJournalEvent(row: JournalEvent) {
  const metadata = parseMetadata(row.metadata_json);
  const importance = scalar(metadata.importance) ?? scalar(metadata.priority);
  const hasInteraction = Boolean(
    row.callback_query_id ||
      row.interaction_action ||
      row.interaction_payload ||
      row.interaction_outcome,
  );

  return {
    journalEventId: row.journal_event_id,
    messageKey: row.message_key,
    flowId: row.flow_id,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    channel: row.channel,
    direction: row.direction,
    eventType: row.event_type,
    contentKind: row.content_kind,
    body: {
      text: row.text,
      transportText: row.transport_text,
      chars: row.content_chars,
      bytes: row.content_bytes,
      sha256: row.content_hash,
    },
    source: {
      producer: row.producer,
      originSystemId: row.origin_system_id,
      sourceEventId: row.source_event_id,
      sourceRef: row.source_ref,
      route: row.route,
    },
    decision: {
      category: row.classification,
      importance,
      outcome: outcomeFor(row),
      reason: row.reason,
      investigation: {
        state: row.investigation_state,
        result: row.investigation_result,
      },
    },
    delivery: {
      state: row.delivery_state,
      errorCode: row.error_code || null,
      attempt: row.attempt,
      revision: row.revision,
      chunkIndex: row.chunk_index,
    },
    telegram: {
      chatId: row.telegram_chat_id,
      messageId: row.telegram_message_id,
      updateId: row.telegram_update_id,
      inReplyToMessageId: row.in_reply_to_message_id,
    },
    interaction: hasInteraction
      ? {
          callbackQueryId: row.callback_query_id,
          action: row.interaction_action,
          payload: row.interaction_payload,
          outcome: row.interaction_outcome,
        }
      : null,
    metadata,
  };
}

export function parseMessagesSince(value: string): number {
  return parseDuration(value);
}

export function normalizeMessagesLimit(value = 100): number {
  return Math.min(1_000, Math.max(1, Math.trunc(value)));
}

function auditNextActions(): readonly NextAction[] {
  return [
    {
      command: "messages trace <message-id-or-flow-id>",
      description: "Trace one message lifecycle",
      params: {
        "message-id-or-flow-id": {
          description: "Telegram message ID or journal flow ID",
          required: true,
        },
      },
    },
  ];
}

function traceNextActions(result: MessageTraceResult): readonly NextAction[] {
  if (result.kind === "trace") {
    return [
      {
        command: "otel search <flow-id> --hours 24",
        description: "Correlate body-free delivery telemetry",
        params: {
          "flow-id": {
            description: "Journal flow ID",
            value: result.flowId,
            required: true,
          },
        },
      },
      {
        command: "messages audit --since 24h",
        description: "Return to the recent message audit",
      },
    ];
  }

  if (result.kind === "ambiguous") {
    return result.candidates.slice(0, 10).map((candidate) => ({
      command: "messages trace <flow-id>",
      description: `Trace Telegram chat ${candidate.telegramChatId}, message ${candidate.telegramMessageId}`,
      params: {
        "flow-id": {
          description: "Unambiguous journal flow ID",
          value: candidate.flowId,
          required: true,
        },
      },
    }));
  }

  return [
    {
      command: "messages audit --since 24h",
      description: "Find recent message or flow IDs",
    },
  ];
}

function errorDetails(error: unknown): {
  readonly message: string;
  readonly code: string;
  readonly fix: string;
} {
  const record = asRecord(error);
  const tag = typeof record._tag === "string" ? record._tag : "";
  const code = typeof record.code === "string" ? record.code : "MESSAGE_JOURNAL_QUERY_FAILED";

  if (tag === "MessageJournalConfigError") {
    const missing = Array.isArray(record.missing)
      ? record.missing.filter((value): value is string => typeof value === "string")
      : [];
    return {
      message: `Message journal reader credentials are missing${missing.length > 0 ? `: ${missing.join(", ")}` : ""}`,
      code: "MESSAGE_JOURNAL_CONFIG_MISSING",
      fix: "Configure the scoped MESSAGE_JOURNAL_READER_USER and MESSAGE_JOURNAL_READER_PASSWORD values, then retry.",
    };
  }

  const operation = typeof record.operation === "string" ? record.operation : "query";
  return {
    message: `Message journal ${operation} failed (${code})`,
    code,
    fix: "Check the private ClickHouse journal reader access and retry.",
  };
}

function queryLayer(connection: {
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly database: string;
  readonly table: string;
}) {
  return messageJournalQueryLayer(connection).pipe(
    Layer.provide(clickHouseClientLayer(connection)),
  );
}

const defaultDependencies: MessagesDependencies = {
  auditMessages: (input) =>
    Effect.flatMap(resolveMessageJournalConnection("reader"), (connection) =>
      auditMessages(input).pipe(Effect.provide(queryLayer(connection))),
    ),
  traceMessage: (lookup) =>
    Effect.flatMap(resolveMessageJournalConnection("reader"), (connection) =>
      traceMessage(lookup).pipe(Effect.provide(queryLayer(connection))),
    ),
};

export function executeMessagesAudit(
  input: AuditMessagesInput,
  dependencies: MessagesDependencies = defaultDependencies,
): Effect.Effect<JoelclawEnvelope> {
  try {
    parseMessagesSince(input.since);
  } catch {
    return Effect.succeed(
      buildErrorEnvelope(
        "messages audit",
        `Invalid --since duration: ${input.since}`,
        "INVALID_DURATION",
        "Use a positive duration such as 30m, 24h, or 7d.",
        [
          {
            command: "messages audit --since 24h",
            description: "Retry with the default lookback",
          },
        ],
      ),
    );
  }

  const normalizedInput = {
    ...input,
    limit: normalizeMessagesLimit(input.limit),
  };

  return dependencies.auditMessages(normalizedInput).pipe(
    Effect.match({
      onFailure: (error) => {
        const details = errorDetails(error);
        return buildErrorEnvelope(
          "messages audit",
          details.message,
          details.code,
          details.fix,
          [
            {
              command: "messages audit --since 1h",
              description: "Retry a smaller window",
            },
          ],
        );
      },
      onSuccess: (events) =>
        buildSuccessEnvelope(
          "messages audit",
          {
            filters: {
              since: input.since,
              channel: input.channel ?? null,
              category: input.category ?? null,
              direction: input.direction ?? null,
              limit: normalizedInput.limit,
            },
            count: events.length,
            events: events.map(formatJournalEvent),
          },
          auditNextActions(),
        ),
    }),
  );
}

export function executeMessagesTrace(
  lookup: string,
  dependencies: MessagesDependencies = defaultDependencies,
): Effect.Effect<JoelclawEnvelope> {
  const normalizedLookup = lookup.trim();
  if (!normalizedLookup) {
    return Effect.succeed(
      buildErrorEnvelope(
        "messages trace",
        "A Telegram message ID or journal flow ID is required",
        "MESSAGE_LOOKUP_REQUIRED",
        "Pass an ID from messages audit.",
        auditNextActions(),
      ),
    );
  }

  return dependencies.traceMessage(normalizedLookup).pipe(
    Effect.match({
      onFailure: (error) => {
        const details = errorDetails(error);
        return buildErrorEnvelope(
          "messages trace",
          details.message,
          details.code,
          details.fix,
          [
            {
              command: "messages audit --since 24h",
              description: "Find recent message or flow IDs",
            },
          ],
        );
      },
      onSuccess: (result) =>
        buildSuccessEnvelope(
          "messages trace",
          result.kind === "trace"
            ? {
                kind: result.kind,
                flowId: result.flowId,
                eventCount: result.events.length,
                events: result.events.map(formatJournalEvent),
              }
            : result.kind === "ambiguous"
              ? {
                  kind: result.kind,
                  lookup: result.lookup,
                  candidates: result.candidates.map((candidate) => ({
                    flowId: candidate.flowId,
                    telegramChatId: candidate.telegramChatId,
                    telegramMessageId: candidate.telegramMessageId,
                    occurredAt: candidate.occurredAt,
                  })),
                }
              : { kind: result.kind, lookup: result.lookup },
          traceNextActions(result),
        ),
    }),
  );
}

const sinceOption = Options.text("since").pipe(
  Options.withDefault("24h"),
  Options.withDescription("Lookback duration, for example 24h or 7d"),
);
const channelOption = Options.text("channel").pipe(
  Options.optional,
  Options.withDescription("Filter by channel"),
);
const categoryOption = Options.text("category").pipe(
  Options.optional,
  Options.withDescription("Filter by journal classification/category"),
);
const directionOption = Options.choice("direction", ["inbound", "outbound", "interaction"] as const).pipe(
  Options.optional,
  Options.withDescription("Filter by message direction"),
);
const limitOption = Options.integer("limit").pipe(
  Options.withDefault(100),
  Options.withDescription("Maximum journal events (query caps at 1000)"),
);

const auditCmd = Command.make(
  "audit",
  {
    since: sinceOption,
    channel: channelOption,
    category: categoryOption,
    direction: directionOption,
    limit: limitOption,
  },
  ({ since, channel, category, direction, limit }) =>
    Effect.gen(function* () {
      const envelope = yield* executeMessagesAudit({
        since,
        channel: Option.getOrUndefined(channel),
        category: Option.getOrUndefined(category),
        direction: Option.getOrUndefined(direction),
        limit,
      });
      yield* Console.log(JSON.stringify(envelope, null, 2));
    }),
).pipe(Command.withDescription("Audit recent private channel messages"));

const lookupArgument = Args.text({ name: "message-id-or-flow-id" }).pipe(
  Args.withDescription("Telegram message ID or journal flow ID"),
);

const traceCmd = Command.make(
  "trace",
  { lookup: lookupArgument },
  ({ lookup }) =>
    Effect.gen(function* () {
      const envelope = yield* executeMessagesTrace(lookup);
      yield* Console.log(JSON.stringify(envelope, null, 2));
    }),
).pipe(Command.withDescription("Trace one message, delivery, and button lifecycle"));

export const messagesCmd = Command.make("messages").pipe(
  Command.withDescription("Private message journal"),
  Command.withSubcommands([auditCmd, traceCmd]),
);
