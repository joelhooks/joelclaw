import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { JournalEvent, type JournalEvent as JournalEventRow } from "./schema";

export const DEFAULT_MESSAGE_JOURNAL_OUTBOX_DIR = join(
  homedir(),
  ".joelclaw",
  "spool",
  "message-journal"
);
export const DEFAULT_PROCESSING_STALE_MS = 5 * 60 * 1_000;

export class JournalOutboxError extends Data.TaggedError("JournalOutboxError")<{
  readonly operation: string;
  readonly code: string;
  readonly cause?: unknown;
}> {}

export interface ClaimedJournalEvent {
  readonly row: JournalEventRow;
  readonly path: string;
}

export interface JournalOutboxService {
  readonly enqueue: (row: JournalEventRow) => Effect.Effect<string, JournalOutboxError>;
  readonly claim: (limit?: number) => Effect.Effect<ReadonlyArray<ClaimedJournalEvent>, JournalOutboxError>;
  readonly complete: (claimed: ClaimedJournalEvent) => Effect.Effect<void, JournalOutboxError>;
  readonly retry: (claimed: ClaimedJournalEvent) => Effect.Effect<void, JournalOutboxError>;
}

export class JournalOutbox extends Context.Tag("@joelclaw/message-journal/JournalOutbox")<
  JournalOutbox,
  JournalOutboxService
>() {}

function outboxFileName(row: JournalEventRow): string {
  const occurredAt = row.occurred_at.replace(/\D/gu, "");
  return `${occurredAt}-${row.journal_event_id}-${randomUUID()}.json`;
}

export function makeJournalOutbox(
  directory = DEFAULT_MESSAGE_JOURNAL_OUTBOX_DIR,
  processingStaleMs = DEFAULT_PROCESSING_STALE_MS
): JournalOutboxService {
  const ensureDirectory = Effect.fn("MessageJournal.Outbox.ensureDirectory")(function* () {
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
      },
      catch: (cause) =>
        new JournalOutboxError({
          operation: "ensure-directory",
          code: "OUTBOX_DIRECTORY_FAILED",
          cause,
        }),
    });
  });

  const enqueue = Effect.fn("MessageJournal.Outbox.enqueue")(function* (row: JournalEventRow) {
    yield* ensureDirectory();
    const finalPath = join(directory, outboxFileName(row));
    const temporaryPath = `${finalPath}.tmp-${process.pid}-${randomUUID()}`;
    yield* Effect.tryPromise({
      try: async () => {
        await writeFile(temporaryPath, JSON.stringify(row), { encoding: "utf8", mode: 0o600 });
        await rename(temporaryPath, finalPath);
        await chmod(finalPath, 0o600);
      },
      catch: (cause) =>
        new JournalOutboxError({
          operation: "enqueue",
          code: "OUTBOX_ENQUEUE_FAILED",
          cause,
        }),
    });
    return finalPath;
  });

  const claim = Effect.fn("MessageJournal.Outbox.claim")(function* (limit = 100) {
    yield* ensureDirectory();
    const files = yield* Effect.tryPromise({
      try: async () => {
        const names = await readdir(directory);
        for (const name of names.filter((candidate) => candidate.endsWith(".json.processing"))) {
          const processingPath = join(directory, name);
          const fileStat = await stat(processingPath);
          // stat times carry sub-ms precision while Date.now() is integer ms;
          // floor so a same-millisecond claim cannot produce a negative age.
          const leaseTimestamp = Math.floor(Math.max(fileStat.mtimeMs, fileStat.ctimeMs));
          if (Date.now() - leaseTimestamp < processingStaleMs) continue;
          await rename(processingPath, processingPath.replace(/\.processing$/u, "")).catch(() => {});
        }
        return (await readdir(directory))
          .filter((name) => name.endsWith(".json"))
          .sort()
          .slice(0, Math.max(0, limit));
      },
      catch: (cause) =>
        new JournalOutboxError({
          operation: "list",
          code: "OUTBOX_LIST_FAILED",
          cause,
        }),
    });

    const claimed: ClaimedJournalEvent[] = [];
    for (const file of files) {
      const path = join(directory, file);
      const processingPath = `${path}.processing`;
      const claimedPath = yield* Effect.tryPromise({
        try: async () => {
          try {
            await rename(path, processingPath);
            return processingPath;
          } catch {
            return null;
          }
        },
        catch: (cause) =>
          new JournalOutboxError({
            operation: "claim",
            code: "OUTBOX_CLAIM_FAILED",
            cause,
          }),
      });
      if (!claimedPath) continue;

      const row = yield* Effect.tryPromise({
        try: async () => {
          const parsed: unknown = JSON.parse(await readFile(claimedPath, "utf8"));
          return Schema.decodeUnknownSync(JournalEvent)(parsed);
        },
        catch: (cause) =>
          new JournalOutboxError({
            operation: "read",
            code: "OUTBOX_READ_FAILED",
            cause,
          }),
      }).pipe(
        Effect.catchAll((error) =>
          Effect.tryPromise({
            try: () => rename(claimedPath, `${claimedPath}.invalid`),
            catch: () => error,
          }).pipe(Effect.zipRight(Effect.fail(error)))
        )
      );
      claimed.push({ row, path: claimedPath });
    }
    return claimed;
  });

  const complete = Effect.fn("MessageJournal.Outbox.complete")((claimed: ClaimedJournalEvent) =>
    Effect.tryPromise({
      try: () => rm(claimed.path, { force: true }),
      catch: (cause) =>
        new JournalOutboxError({
          operation: "complete",
          code: "OUTBOX_COMPLETE_FAILED",
          cause,
        }),
    })
  );

  const retry = Effect.fn("MessageJournal.Outbox.retry")((claimed: ClaimedJournalEvent) =>
    Effect.tryPromise({
      try: () => rename(claimed.path, claimed.path.replace(/\.processing$/u, "")),
      catch: (cause) =>
        new JournalOutboxError({
          operation: "retry",
          code: "OUTBOX_RETRY_FAILED",
          cause,
        }),
    })
  );

  return JournalOutbox.of({ enqueue, claim, complete, retry });
}

export const journalOutboxLayer = (directory?: string, processingStaleMs?: number) =>
  Layer.succeed(JournalOutbox, makeJournalOutbox(directory, processingStaleMs));
