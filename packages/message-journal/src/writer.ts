import { Context, Effect, Layer } from "effect";
import { ClickHouseClient } from "./clickhouse";
import type { MessageJournalConnection } from "./config";
import { JournalOutbox } from "./outbox";
import type { JournalEvent } from "./schema";
import { qualifiedTable } from "./sql";
import { MessageJournalTelemetry } from "./telemetry";

export interface JournalWriteReceipt {
  readonly journalEventId: string;
  readonly written: boolean;
  readonly queued: boolean;
}

export interface JournalReplayReceipt {
  readonly replayed: number;
  readonly failed: number;
}

export interface MessageJournalWriterService {
  readonly write: (row: JournalEvent) => Effect.Effect<JournalWriteReceipt>;
  readonly replayOutbox: (limit?: number) => Effect.Effect<JournalReplayReceipt>;
}

export class MessageJournalWriter extends Context.Tag(
  "@joelclaw/message-journal/MessageJournalWriter"
)<MessageJournalWriter, MessageJournalWriterService>() {}

function insertSql(connection: Pick<MessageJournalConnection, "database" | "table">): string {
  return `INSERT INTO ${qualifiedTable(connection.database, connection.table)} FORMAT JSONEachRow`;
}

export const messageJournalWriterLayer = (
  connection: Pick<MessageJournalConnection, "database" | "table">
) =>
  Layer.effect(
    MessageJournalWriter,
    Effect.gen(function* () {
      const clickHouse = yield* ClickHouseClient;
      const outbox = yield* JournalOutbox;
      const telemetry = yield* MessageJournalTelemetry;
      const sql = insertSql(connection);

      const emitFailure = (
        row: JournalEvent,
        stage: "clickhouse" | "outbox" | "replay",
        errorCode: string
      ) =>
        telemetry
          .writeFailed({
            journalEventId: row.journal_event_id,
            flowId: row.flow_id,
            stage,
            errorCode,
          })
          .pipe(Effect.catchAllCause(() => Effect.void));

      const write = Effect.fn("MessageJournal.Writer.write")(function* (row: JournalEvent) {
        const inserted = yield* clickHouse
          .execute({ sql, body: JSON.stringify(row) })
          .pipe(Effect.as(true), Effect.catchAllCause(() => Effect.succeed(false)));

        if (inserted) {
          return {
            journalEventId: row.journal_event_id,
            written: true,
            queued: false,
          };
        }

        const queued = yield* outbox
          .enqueue(row)
          .pipe(Effect.as(true), Effect.catchAllCause(() => Effect.succeed(false)));
        yield* emitFailure(row, "clickhouse", "CLICKHOUSE_INSERT_FAILED");
        if (!queued) yield* emitFailure(row, "outbox", "OUTBOX_ENQUEUE_FAILED");

        return {
          journalEventId: row.journal_event_id,
          written: false,
          queued,
        };
      });

      const replayOutbox = Effect.fn("MessageJournal.Writer.replayOutbox")(function* (limit = 100) {
        const claimed = yield* outbox
          .claim(limit)
          .pipe(Effect.catchAllCause(() => Effect.succeed([])));
        let replayed = 0;
        let failed = 0;

        for (const item of claimed) {
          const inserted = yield* clickHouse
            .execute({ sql, body: JSON.stringify(item.row) })
            .pipe(Effect.as(true), Effect.catchAllCause(() => Effect.succeed(false)));

          if (inserted) {
            const completed = yield* outbox
              .complete(item)
              .pipe(Effect.as(true), Effect.catchAllCause(() => Effect.succeed(false)));
            if (completed) replayed += 1;
            else failed += 1;
            continue;
          }

          failed += 1;
          yield* emitFailure(item.row, "replay", "CLICKHOUSE_REPLAY_FAILED");
          yield* outbox.retry(item).pipe(Effect.catchAllCause(() => Effect.void));
        }

        return { replayed, failed };
      });

      return MessageJournalWriter.of({ write, replayOutbox });
    })
  );

export const writeJournalEvent = (row: JournalEvent) =>
  Effect.flatMap(MessageJournalWriter, (writer) => writer.write(row));

export const replayJournalOutbox = (limit?: number) =>
  Effect.flatMap(MessageJournalWriter, (writer) => writer.replayOutbox(limit));
