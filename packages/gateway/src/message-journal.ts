import {
  clickHouseClientLayer,
  createJournalEvent,
  type JournalEvent,
  type JournalEventInput,
  type JournalWriteReceipt,
  journalOutboxLayer,
  MessageJournalWriter,
  type MessageJournalWriterService,
  makeJournalOutbox,
  messageJournalQueryLayer,
  messageJournalTelemetryLive,
  messageJournalWriterLayer,
  resolveMessageJournalConnection,
  traceMessage,
} from "@joelclaw/message-journal";
import { emitGatewayOtel } from "@joelclaw/telemetry";
import { Effect, Layer } from "effect";

const JOURNAL_WRITE_TIMEOUT = "2 seconds";

type JournalWriteOverride = (row: JournalEvent) => Promise<void>;

export interface JournalPersistenceReceipt {
  readonly journalEventId: string;
  readonly persisted: boolean;
  readonly storage: "writer" | "outbox" | "failed";
}

export interface JournalActionDeclaration {
  readonly correlationId: string;
  readonly declaredActions: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
  }>;
  readonly platformMessageId: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function decodeActionDeclaration(metadataJson: string): JournalActionDeclaration | undefined {
  try {
    const metadata = asRecord(JSON.parse(metadataJson));
    const correlationId = metadata?.correlationId;
    const platformMessageId = metadata?.platformMessageId;
    const actions = metadata?.declaredActions;
    if (
      typeof correlationId !== "string"
      || typeof platformMessageId !== "string"
      || !Array.isArray(actions)
    ) {
      return undefined;
    }
    const declaredActions = actions.flatMap((value) => {
      const action = asRecord(value);
      return typeof action?.id === "string" && typeof action.label === "string"
        ? [{ id: action.id, label: action.label }]
        : [];
    });
    return declaredActions.length > 0
      ? { correlationId, declaredActions, platformMessageId }
      : undefined;
  } catch {
    return undefined;
  }
}

type FlowPersistenceOverride = {
  set: (key: string, flowId: string) => Promise<void>;
  get: (key: string) => Promise<string | undefined>;
};

let writerPromise: Promise<MessageJournalWriterService> | undefined;
let writeOverride: JournalWriteOverride | undefined;
let outboxOverride: JournalWriteOverride | undefined;
let flowPersistenceOverride: FlowPersistenceOverride | undefined;
const telegramFlowByMessage = new Map<string, string>();

function telegramMessageKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

async function createWriter(): Promise<MessageJournalWriterService> {
  const connection = await Effect.runPromise(resolveMessageJournalConnection("writer"));
  const dependencies = Layer.mergeAll(
    clickHouseClientLayer(connection),
    journalOutboxLayer(),
    messageJournalTelemetryLive,
  );
  const layer = messageJournalWriterLayer(connection).pipe(Layer.provide(dependencies));

  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* MessageJournalWriter;
    }).pipe(Effect.provide(layer)),
  );
}

function getWriter(): Promise<MessageJournalWriterService> {
  writerPromise ??= createWriter();
  return writerPromise;
}

async function writeWithTimeout(
  writer: MessageJournalWriterService,
  row: JournalEvent,
): Promise<JournalWriteReceipt | undefined> {
  return Effect.runPromise(
    writer.write(row).pipe(
      Effect.timeout(JOURNAL_WRITE_TIMEOUT),
      Effect.catchAllCause(() => Effect.succeed(undefined)),
    ),
  );
}

async function enqueueFallback(row: JournalEvent): Promise<boolean> {
  if (outboxOverride) {
    try {
      await outboxOverride(row);
      return true;
    } catch {
      return false;
    }
  }
  return Effect.runPromise(
    makeJournalOutbox().enqueue(row).pipe(
      Effect.as(true),
      Effect.catchAllCause(() => Effect.succeed(false)),
    ),
  );
}

async function emitTerminalFailure(row: JournalEvent): Promise<void> {
  await emitGatewayOtel({
    level: "error",
    source: "message-journal",
    component: "gateway-message-journal",
    action: "message_journal.write.failed",
    success: false,
    error: "MESSAGE_JOURNAL_WRITE_FAILED",
    metadata: {
      journalEventId: row.journal_event_id,
      flowId: row.flow_id,
      stage: "gateway_fail_open",
      errorCode: "WRITER_AND_OUTBOX_FAILED",
    },
  }).catch(() => undefined);
}

/**
 * Writes exact message text to the private journal without allowing journal
 * availability, credentials, or latency to block Telegram delivery.
 */
export async function journalMessage(
  input: JournalEventInput,
): Promise<JournalPersistenceReceipt> {
  let row: JournalEvent;
  try {
    row = createJournalEvent(input);
  } catch {
    void emitGatewayOtel({
      level: "error",
      source: "message-journal",
      component: "gateway-message-journal",
      action: "message_journal.write.failed",
      success: false,
      error: "MESSAGE_JOURNAL_WRITE_FAILED",
      metadata: {
        journalEventId: "construction-failed",
        flowId: input.flowId,
        stage: "event_construction",
        errorCode: "JOURNAL_EVENT_INVALID",
      },
    }).catch(() => undefined);
    return {
      journalEventId: "construction-failed",
      persisted: false,
      storage: "failed",
    };
  }

  try {
    if (writeOverride) {
      await writeOverride(row);
      return {
        journalEventId: row.journal_event_id,
        persisted: true,
        storage: "writer",
      };
    }

    const writer = await getWriter();
    const receipt = await writeWithTimeout(writer, row);
    if (receipt?.written || receipt?.queued) {
      return {
        journalEventId: row.journal_event_id,
        persisted: true,
        storage: receipt.written ? "writer" : "outbox",
      };
    }
  } catch {
    // Missing writer credentials and initialization defects fall back to the
    // private local outbox. The exact body never crosses into OTEL.
  }

  if (await enqueueFallback(row)) {
    return {
      journalEventId: row.journal_event_id,
      persisted: true,
      storage: "outbox",
    };
  }

  void emitTerminalFailure(row);
  return {
    journalEventId: row.journal_event_id,
    persisted: false,
    storage: "failed",
  };
}

export async function journalMessageActionRequest(input: {
  readonly flowId: string;
  readonly correlationId: string;
  readonly actionId: string;
  readonly rawEventId: string;
  readonly platformMessageId: string;
  readonly conversationId: string;
  readonly actorId: string;
  readonly occurredAt: string;
}): Promise<JournalPersistenceReceipt> {
  const telegramMessageId = Number(input.platformMessageId.split(":").at(-1));
  const telegramChatId = Number(input.conversationId.split(":").at(-1));
  return journalMessage({
    messageKey: `telegram:${input.platformMessageId}:callback:${input.rawEventId}`,
    flowId: input.flowId,
    channel: "telegram",
    direction: "interaction",
    eventType: "message.action.requested",
    contentKind: "callback",
    occurredAt: input.occurredAt,
    producer: "gateway-chat-sdk",
    originSystemId: input.correlationId,
    sourceEventId: input.rawEventId,
    sourceRef: input.platformMessageId,
    telegramChatId: Number.isSafeInteger(telegramChatId) ? telegramChatId : 0,
    telegramMessageId: Number.isSafeInteger(telegramMessageId) ? telegramMessageId : null,
    callbackQueryId: input.rawEventId,
    interactionAction: input.actionId,
    interactionPayload: input.actionId,
    interactionOutcome: "requested",
    deliveryState: "requested",
    metadata: {
      actorId: input.actorId,
      correlationId: input.correlationId,
      platformMessageId: input.platformMessageId,
    },
  });
}

export async function resolveMessageActionDeclarationFromJournal(
  flowId: string,
): Promise<JournalActionDeclaration | undefined> {
  const connection = await Effect.runPromise(resolveMessageJournalConnection("reader"));
  const queryLayer = messageJournalQueryLayer(connection).pipe(
    Layer.provide(clickHouseClientLayer(connection)),
  );
  const result = await Effect.runPromise(
    traceMessage(flowId).pipe(Effect.provide(queryLayer)),
  );
  if (result.kind !== "trace") return undefined;
  for (const row of [...result.events].reverse()) {
    if (row.event_type !== "message.outbound.confirmed") continue;
    const declaration = decodeActionDeclaration(row.metadata_json);
    if (declaration) return declaration;
  }
  return undefined;
}

export async function rememberTelegramMessageFlow(
  chatId: number,
  messageId: number,
  flowId: string,
): Promise<void> {
  const key = telegramMessageKey(chatId, messageId);
  telegramFlowByMessage.set(key, flowId);
  if (telegramFlowByMessage.size > 2_000) {
    const oldest = telegramFlowByMessage.keys().next().value;
    if (oldest) telegramFlowByMessage.delete(oldest);
  }

  const redisKey = `joelclaw:message-journal:telegram-flow:${key}`;
  try {
    if (flowPersistenceOverride) {
      await flowPersistenceOverride.set(redisKey, flowId);
    } else {
      const { getRedisClient } = await import("./channels/redis");
      await getRedisClient()?.set(redisKey, flowId);
    }
  } catch {
    // The journal row remains authoritative; Redis is only the restart-safe
    // callback lookup index.
  }
}

export async function resolveTelegramMessageFlow(
  chatId: number | undefined,
  messageId: number | undefined,
): Promise<string | undefined> {
  if (chatId === undefined || messageId === undefined) return undefined;
  const key = telegramMessageKey(chatId, messageId);
  const cached = telegramFlowByMessage.get(key);
  if (cached) return cached;

  try {
    const redisKey = `joelclaw:message-journal:telegram-flow:${key}`;
    const persisted = flowPersistenceOverride
      ? await flowPersistenceOverride.get(redisKey)
      : await (async () => {
          const { getRedisClient } = await import("./channels/redis");
          return getRedisClient()?.get(redisKey);
        })();
    if (persisted) {
      telegramFlowByMessage.set(key, persisted);
      return persisted;
    }
  } catch {
    // Fall through to an explicit unresolved callback flow.
  }
  return undefined;
}

export const __messageJournalTestUtils = {
  setWriteOverride(override: JournalWriteOverride | undefined): void {
    writeOverride = override;
  },
  setOutboxOverride(override: JournalWriteOverride | undefined): void {
    outboxOverride = override;
  },
  setFlowPersistenceOverride(override: FlowPersistenceOverride | undefined): void {
    flowPersistenceOverride = override;
  },
  clearMemoryFlowIndex(): void {
    telegramFlowByMessage.clear();
  },
  clear(): void {
    writeOverride = undefined;
    outboxOverride = undefined;
    flowPersistenceOverride = undefined;
    writerPromise = undefined;
    telegramFlowByMessage.clear();
  },
};
