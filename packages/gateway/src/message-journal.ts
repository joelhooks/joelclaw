import {
  clickHouseClientLayer,
  createJournalEvent,
  type JournalEvent,
  type JournalEventInput,
  journalOutboxLayer,
  MessageJournalWriter,
  type MessageJournalWriterService,
  makeJournalOutbox,
  messageJournalTelemetryLive,
  messageJournalWriterLayer,
  resolveMessageJournalConnection,
} from "@joelclaw/message-journal";
import { emitGatewayOtel } from "@joelclaw/telemetry";
import { Effect, Layer } from "effect";

const JOURNAL_WRITE_TIMEOUT = "2 seconds";

type JournalWriteOverride = (row: JournalEvent) => Promise<void>;
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

async function writeWithTimeout(writer: MessageJournalWriterService, row: JournalEvent): Promise<boolean> {
  return Effect.runPromise(
    writer.write(row).pipe(
      Effect.as(true),
      Effect.timeout(JOURNAL_WRITE_TIMEOUT),
      Effect.catchAllCause(() => Effect.succeed(false)),
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
export async function journalMessage(input: JournalEventInput): Promise<void> {
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
    return;
  }

  try {
    if (writeOverride) {
      await writeOverride(row);
      return;
    }

    const writer = await getWriter();
    if (await writeWithTimeout(writer, row)) return;
  } catch {
    // Missing writer credentials and initialization defects fall back to the
    // private local outbox. The exact body never crosses into OTEL.
  }

  if (!(await enqueueFallback(row))) {
    void emitTerminalFailure(row);
  }
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
