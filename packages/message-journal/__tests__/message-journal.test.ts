import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import {
  ClickHouseClient,
  ClickHouseError,
  createJournalEvent,
  deterministicJournalEventId,
  JournalOutbox,
  type JournalWriteFailureReceipt,
  journalOutboxLayer,
  MessageJournalQuery,
  MessageJournalTelemetry,
  MessageJournalWriter,
  messageJournalQueryLayer,
  messageJournalWriterLayer,
  parseDuration,
  sqlString,
} from "../src";

const connection = {
  database: "joelclaw_private",
  table: "message_journal_events",
};

function fixtureEvent() {
  return createJournalEvent(
    {
      messageKey: "telegram:42:99",
      flowId: "flow-123",
      direction: "outbound",
      eventType: "delivery.confirmed",
      producer: "test",
      originSystemId: "test-system",
      telegramChatId: 42,
      telegramMessageId: 99,
      chunkIndex: 0,
      attempt: 1,
      revision: 1,
      text: "private exact text",
      transportText: "<b>private exact text</b>",
      classification: "action",
      reason: "fixture",
      deliveryState: "confirmed",
    },
    () => new Date("2026-07-15T12:00:00.000Z")
  );
}

describe("journal event identity", () => {
  test("is deterministic over the complete lifecycle identity", () => {
    const identity = {
      flowId: "flow-123",
      direction: "outbound" as const,
      eventType: "delivery.confirmed",
      messageId: 99,
      chunkIndex: 0,
      attempt: 2,
      revision: 3,
      callbackQueryId: "callback-1",
    };

    expect(deterministicJournalEventId(identity)).toBe(deterministicJournalEventId(identity));
    expect(
      deterministicJournalEventId({ ...identity, attempt: identity.attempt + 1 })
    ).not.toBe(deterministicJournalEventId(identity));
  });

  test("creates occurred_at once and preserves content hashes and counts", () => {
    const row = fixtureEvent();
    expect(row.occurred_at).toBe("2026-07-15 12:00:00.000");
    expect(row.recorded_at).toBe("2026-07-15 12:00:00.000");
    expect(row.content_chars).toBe(25);
    expect(row.content_bytes).toBe(25);
    expect(row.content_hash).toHaveLength(64);
  });

  test("rejects integers outside the ClickHouse column ranges", () => {
    expect(() =>
      createJournalEvent({
        messageKey: "invalid",
        flowId: "flow-invalid",
        direction: "outbound",
        eventType: "delivery.requested",
        producer: "test",
        originSystemId: "test",
        telegramChatId: 42.5,
        attempt: 65_536,
      })
    ).toThrow();
  });
});

describe("SQL helpers", () => {
  test("escapes apostrophes and backslashes", () => {
    expect(sqlString("Joel's \\ path")).toBe("'Joel\\'s \\\\ path'");
  });

  test("parses bounded duration units", () => {
    expect(parseDuration("24h")).toBe(86_400_000);
    expect(parseDuration("7d")).toBe(604_800_000);
    expect(() => parseDuration("24 hours")).toThrow();
    expect(() => parseDuration("0h")).toThrow();
  });
});

describe("writer outbox", () => {
  test("writes a 0600 exact row and replays the identical JSONEachRow payload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "message-journal-"));
    const requests: Array<{ sql: string; body?: string }> = [];
    let fail = true;
    const clickHouse = ClickHouseClient.of({
      execute: (request) => {
        requests.push(request);
        if (fail) {
          return Effect.fail(
            new ClickHouseError({ operation: "insert", code: "TEST_FAILURE" })
          );
        }
        return Effect.succeed("");
      },
    });
    const failures: JournalWriteFailureReceipt[] = [];
    const telemetry = MessageJournalTelemetry.of({
      writeFailed: (receipt) => Effect.sync(() => failures.push(receipt)),
    });
    const dependencies = Layer.mergeAll(
      Layer.succeed(ClickHouseClient, clickHouse),
      journalOutboxLayer(directory),
      Layer.succeed(MessageJournalTelemetry, telemetry)
    );
    const writerLayer = messageJournalWriterLayer(connection).pipe(Layer.provide(dependencies));
    const row = fixtureEvent();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* MessageJournalWriter;
        const written = yield* service.write(row);
        fail = false;
        const replayed = yield* service.replayOutbox();
        return { written, replayed };
      }).pipe(Effect.provide(writerLayer))
    );

    expect(result.written).toEqual({
      journalEventId: row.journal_event_id,
      written: false,
      queued: true,
    });
    expect(result.replayed).toEqual({ replayed: 1, failed: 0 });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toBe(JSON.stringify(row));
    expect(requests[1]?.body).toBe(requests[0]?.body);
    expect(failures).toEqual([
      {
        journalEventId: row.journal_event_id,
        flowId: row.flow_id,
        stage: "clickhouse",
        errorCode: "CLICKHOUSE_INSERT_FAILED",
      },
    ]);
    expect(await readdir(directory)).toEqual([]);
  });

  test("does not steal an active claim for an old queued row", async () => {
    const directory = await mkdtemp(join(tmpdir(), "message-journal-lease-"));
    const outboxLayer = journalOutboxLayer(directory, 60_000);
    const row = fixtureEvent();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const outbox = yield* JournalOutbox;
        const path = yield* outbox.enqueue(row);
        yield* Effect.promise(() =>
          utimes(path, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"))
        );
        const active = yield* outbox.claim();
        const concurrent = yield* outbox.claim();
        const claimed = active[0];
        if (claimed) yield* outbox.complete(claimed);
        return { active, concurrent };
      }).pipe(Effect.provide(outboxLayer))
    );

    expect(result.active).toHaveLength(1);
    expect(result.concurrent).toHaveLength(0);
  });

  test("recovers a stale processing claim after a crash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "message-journal-recover-"));
    const outboxLayer = journalOutboxLayer(directory, 0);
    const row = fixtureEvent();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const outbox = yield* JournalOutbox;
        yield* outbox.enqueue(row);
        const abandoned = yield* outbox.claim();
        const recovered = yield* outbox.claim();
        const claimed = recovered[0];
        if (claimed) yield* outbox.complete(claimed);
        return { abandoned, recovered };
      }).pipe(Effect.provide(outboxLayer))
    );

    expect(result.abandoned).toHaveLength(1);
    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0]?.row).toEqual(row);
    expect(await readdir(directory)).toEqual([]);
  });

  test("queues before a telemetry defect can escape the fail-open boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "message-journal-defect-"));
    const dependencies = Layer.mergeAll(
      Layer.succeed(
        ClickHouseClient,
        ClickHouseClient.of({
          execute: () => Effect.fail(new ClickHouseError({ operation: "insert", code: "TEST" })),
        })
      ),
      journalOutboxLayer(directory),
      Layer.succeed(
        MessageJournalTelemetry,
        MessageJournalTelemetry.of({ writeFailed: () => Effect.die("telemetry defect") })
      )
    );
    const writerLayer = messageJournalWriterLayer(connection).pipe(Layer.provide(dependencies));

    const receipt = await Effect.runPromise(
      Effect.flatMap(MessageJournalWriter, (writer) => writer.write(fixtureEvent())).pipe(
        Effect.provide(writerLayer)
      )
    );

    expect(receipt).toMatchObject({ written: false, queued: true });
    expect((await readdir(directory)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });

  test("outbox file is private before replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "message-journal-mode-"));
    const outboxLayer = journalOutboxLayer(directory);
    const row = fixtureEvent();
    const path = await Effect.runPromise(
      Effect.flatMap(JournalOutbox, (outbox) => outbox.enqueue(row)).pipe(
        Effect.provide(outboxLayer)
      )
    );

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(row);
  });
});

describe("trace lookup", () => {
  test("returns candidates when a Telegram message ID is ambiguous", async () => {
    const candidateRows = [
      {
        telegram_chat_id: 42,
        telegram_message_id: 99,
        flow_id: "flow-a",
        occurred_at: "2026-07-15 12:00:00.000",
      },
      {
        telegram_chat_id: 43,
        telegram_message_id: 99,
        flow_id: "flow-b",
        occurred_at: "2026-07-15 11:00:00.000",
      },
    ];
    const sql: string[] = [];
    const clickHouse = ClickHouseClient.of({
      execute: (request) => {
        sql.push(request.sql);
        return Effect.succeed(candidateRows.map((row) => JSON.stringify(row)).join("\n"));
      },
    });
    const queryLayer = messageJournalQueryLayer(connection).pipe(
      Layer.provide(Layer.succeed(ClickHouseClient, clickHouse))
    );

    const result = await Effect.runPromise(
      Effect.flatMap(MessageJournalQuery, (query) => query.traceMessage(99)).pipe(
        Effect.provide(queryLayer)
      )
    );

    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates.map((candidate) => candidate.flowId)).toEqual([
        "flow-a",
        "flow-b",
      ]);
    }
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain("FROM joelclaw_private.message_journal_events FINAL");
  });
});
