import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Context, Data, Effect, Layer } from "effect";
import {
  ClickHouseClient,
  type ClickHouseClientService,
  makeClickHouseClient,
  parseJsonEachRow,
} from "./clickhouse";
import {
  DEFAULT_JOURNAL_DATABASE,
  type MessageJournalConnection,
  resolveMessageJournalConnection,
} from "./config";
import { qualifiedTable, sqlString } from "./sql";

const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../migrations", import.meta.url));
const MIGRATION_FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/u;

export class MessageJournalMigrationError extends Data.TaggedError(
  "MessageJournalMigrationError"
)<{
  readonly operation: "discover" | "load" | "query" | "apply" | "record" | "identity";
  readonly migration?: string;
  readonly cause?: unknown;
}> {}

export interface MigrationReceipt {
  readonly applied: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
}

export interface MessageJournalMigrationRunnerService {
  readonly run: () => Effect.Effect<MigrationReceipt, MessageJournalMigrationError>;
}

export class MessageJournalMigrationRunner extends Context.Tag(
  "@joelclaw/message-journal/MessageJournalMigrationRunner"
)<MessageJournalMigrationRunner, MessageJournalMigrationRunnerService>() {}

interface MigrationFile {
  readonly version: string;
  readonly file: string;
  readonly sql: string;
}

function migrationTable(database: string): string {
  return qualifiedTable(database, "message_journal_schema_migrations");
}

function makeRunner(
  clickHouse: ClickHouseClientService,
  connection: Pick<MessageJournalConnection, "database">,
  directory = DEFAULT_MIGRATIONS_DIRECTORY
): MessageJournalMigrationRunnerService {
  const run = Effect.fn("MessageJournal.Migrations.run")(function* () {
    const names = yield* Effect.tryPromise({
      try: () => readdir(directory),
      catch: (cause) => new MessageJournalMigrationError({ operation: "discover", cause }),
    });
    const migrationNames = names.filter((name) => MIGRATION_FILE_PATTERN.test(name)).sort();
    const migrations: MigrationFile[] = [];
    for (const file of migrationNames) {
      const match = MIGRATION_FILE_PATTERN.exec(file);
      if (!match?.[1]) continue;
      const sql = yield* Effect.tryPromise({
        try: () => readFile(`${directory}/${file}`, "utf8"),
        catch: (cause) =>
          new MessageJournalMigrationError({ operation: "load", migration: file, cause }),
      });
      migrations.push({ version: match[1], file, sql: sql.trim() });
    }

    if (migrations.length === 0) {
      return yield* Effect.fail(
        new MessageJournalMigrationError({ operation: "discover", cause: "no migrations found" })
      );
    }

    const databaseMigration = migrations[0];
    if (!databaseMigration) {
      return yield* Effect.fail(
        new MessageJournalMigrationError({ operation: "discover", cause: "database migration missing" })
      );
    }
    yield* clickHouse.execute({ sql: databaseMigration.sql }).pipe(
      Effect.mapError(
        (cause) =>
          new MessageJournalMigrationError({
            operation: "apply",
            migration: databaseMigration.file,
            cause,
          })
      )
    );

    const ledger = migrationTable(connection.database);
    yield* clickHouse
      .execute({
        sql: `CREATE TABLE IF NOT EXISTS ${ledger} (version String, file String, applied_at DateTime64(3, 'UTC') DEFAULT now64(3)) ENGINE = MergeTree ORDER BY version`,
      })
      .pipe(
        Effect.mapError(
          (cause) => new MessageJournalMigrationError({ operation: "query", cause })
        )
      );
    const appliedBody = yield* clickHouse
      .execute({ sql: `SELECT version FROM ${ledger} ORDER BY version FORMAT JSONEachRow` })
      .pipe(
        Effect.mapError(
          (cause) => new MessageJournalMigrationError({ operation: "query", cause })
        )
      );
    const alreadyApplied = new Set(
      parseJsonEachRow(appliedBody).flatMap((row) =>
        typeof row.version === "string" ? [row.version] : []
      )
    );

    const applied: string[] = [];
    const skipped: string[] = [];
    for (const migration of migrations) {
      if (alreadyApplied.has(migration.version)) {
        skipped.push(migration.file);
        continue;
      }
      if (migration !== databaseMigration) {
        yield* clickHouse.execute({ sql: migration.sql }).pipe(
          Effect.mapError(
            (cause) =>
              new MessageJournalMigrationError({
                operation: "apply",
                migration: migration.file,
                cause,
              })
          )
        );
      }
      yield* clickHouse
        .execute({
          sql: `INSERT INTO ${ledger} (version, file) VALUES (${sqlString(migration.version)}, ${sqlString(migration.file)})`,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new MessageJournalMigrationError({
                operation: "record",
                migration: migration.file,
                cause,
              })
          )
        );
      applied.push(migration.file);
    }

    return { applied, skipped };
  });

  return MessageJournalMigrationRunner.of({ run });
}

export const messageJournalMigrationRunnerLayer = (
  connection: Pick<MessageJournalConnection, "database">,
  directory?: string
) =>
  Layer.effect(
    MessageJournalMigrationRunner,
    Effect.map(ClickHouseClient, (client) => makeRunner(client, connection, directory))
  );

export const runMessageJournalMigrations = () =>
  Effect.flatMap(MessageJournalMigrationRunner, (runner) => runner.run());

export const runMessageJournalMigrationsFromEnvironment = (
  env: NodeJS.ProcessEnv = process.env,
  fileEnv?: Record<string, string>
) =>
  Effect.gen(function* () {
    const connection = yield* resolveMessageJournalConnection("admin", env, fileEnv);
    if (connection.database !== DEFAULT_JOURNAL_DATABASE) {
      return yield* Effect.fail(
        new MessageJournalMigrationError({
          operation: "identity",
          cause: `Migrations target ${DEFAULT_JOURNAL_DATABASE}; received ${connection.database}`,
        })
      );
    }
    const runner = makeRunner(makeClickHouseClient(connection), connection);
    return yield* runner.run();
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof MessageJournalMigrationError
        ? cause
        : new MessageJournalMigrationError({ operation: "identity", cause })
    )
  );
