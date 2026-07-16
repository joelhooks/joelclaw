import { emitGatewayOtel } from "@joelclaw/telemetry";
import { Context, Effect, Layer } from "effect";

export interface JournalWriteFailureReceipt {
  readonly journalEventId: string;
  readonly flowId: string;
  readonly stage: "clickhouse" | "outbox" | "replay";
  readonly errorCode: string;
}

export interface MessageJournalTelemetryService {
  readonly writeFailed: (receipt: JournalWriteFailureReceipt) => Effect.Effect<void>;
}

export class MessageJournalTelemetry extends Context.Tag(
  "@joelclaw/message-journal/MessageJournalTelemetry"
)<MessageJournalTelemetry, MessageJournalTelemetryService>() {}

export const messageJournalTelemetryLive = Layer.succeed(
  MessageJournalTelemetry,
  MessageJournalTelemetry.of({
    writeFailed: Effect.fn("MessageJournal.Telemetry.writeFailed")((receipt) =>
      Effect.promise(() =>
        emitGatewayOtel({
          level: "error",
          source: "message-journal",
          component: "message-journal",
          action: "message_journal.write.failed",
          success: false,
          error: "MESSAGE_JOURNAL_WRITE_FAILED",
          metadata: {
            journalEventId: receipt.journalEventId,
            flowId: receipt.flowId,
            stage: receipt.stage,
            errorCode: receipt.errorCode,
          },
        })
      ).pipe(Effect.catchAllCause(() => Effect.void))
    ),
  })
);
