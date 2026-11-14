import { Database } from "bun:sqlite";
import { statSync } from "node:fs";

/** Ported from the reviewed legacy session-index-cache/index-conn lifecycle. */
export class SessionIndexReplacedError extends Error {
  readonly code = "SESSION_INDEX_REPLACED";
  constructor(
    readonly databasePath: string,
    readonly previous: { dev: number; ino: number },
    readonly current: { dev: number; ino: number },
  ) {
    super(
      `session index ${databasePath} was replaced while open; stop the indexer, preserve both DB/WAL/SHM sets and recover a matching snapshot before restart`,
    );
    this.name = "SessionIndexReplacedError";
  }
}
export type SessionIndexTimings = Record<string, number>;
export function measureIndexPhase<T>(
  timings: SessionIndexTimings,
  phase: string,
  operation: () => T,
): T {
  const start = performance.now();
  try {
    return operation();
  } finally {
    timings[phase] = (timings[phase] ?? 0) + performance.now() - start;
  }
}
const connections = new Map<string, { db: Database; dev: number; ino: number; commits: number }>();
const replaced = new Map<string, SessionIndexReplacedError>();
let opens = 0;
let checkpointBusy = 0;
let exitHooksInstalled = false;
// Same on-demand 32 MiB budget and override bounds as legacy commit 4a416e4f.
function sessionIndexCacheKiB(): number {
  const configured = process.env.SESSION_INDEX_CACHE_KIB;
  if (configured === undefined) return 32_768;
  const kib = Number(configured);
  if (!/^\d+$/u.test(configured) || !Number.isSafeInteger(kib) || kib < 1 || kib > 524_288)
    throw new RangeError("SESSION_INDEX_CACHE_KIB must be an integer from 1 to 524288 (KiB)");
  return kib;
}
function openConnection(
  path: string,
  busyTimeoutMs: number,
  timings: SessionIndexTimings,
  onCursorIndexMissing?: () => void,
): Database {
  const cacheKiB = sessionIndexCacheKiB();
  const db = measureIndexPhase(
    timings,
    "open_ms",
    () => new Database(path, { readwrite: true, strict: true }),
  );
  opens++;
  try {
    measureIndexPhase(timings, "schema_ms", () => {
      db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
      db.exec(`PRAGMA cache_size = -${cacheKiB}`);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = FULL");
      db.exec("PRAGMA foreign_keys = ON");
      migrateSchema(db, timings, "open");
      if (!hasCursorIndex(db)) {
        try {
          console.warn(
            JSON.stringify({
              action: "capture.session_index.cursor_index_missing",
              command: "capture-intake index-migrate --db <sessions-db>",
            }),
          );
        } catch {
          /* An alarm must not stop capture delivery. */
        }
        try {
          onCursorIndexMissing?.();
        } catch {
          /* Same fail-open observer contract. */
        }
      }
    });
  } catch (error) {
    try {
      db.close(true);
    } catch {
      /* Preserve the opening error. */
    }
    throw error;
  }
  return db;
}
function hasCursorIndex(db: Database): boolean {
  return (
    db
      .query("SELECT 1 FROM sqlite_master WHERE type='index' AND name='runs_source_cursor_to'")
      .get() !== null
  );
}
/** Only explicit index-migrate may build the covering index. */
function migrateSchema(
  db: Database,
  timings: SessionIndexTimings,
  mode: "open" | "index-migrate",
): boolean {
  if (mode === "open") {
    const columns = new Set(
      (db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    const indexes = new Set(
      (
        db.query("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
          name: string;
        }>
      ).map((i) => i.name),
    );
    // Compatible opens need no schema write lock, even while another writer is active.
    if (
      ["from_offset", "to_offset", "tags_json"].every((c) => columns.has(c)) &&
      ["runs_source_cursor", "runs_ended_at_idx"].every((i) => indexes.has(i))
    )
      return false;
  }
  // Legacy compatibility DDL and explicit creation are serialized across processes.
  measureIndexPhase(timings, "migration_begin_wait_ms", () => db.exec("BEGIN IMMEDIATE"));
  const locked = performance.now();
  try {
    const columns = new Set(
      (db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!columns.has("from_offset")) db.exec("ALTER TABLE runs ADD COLUMN from_offset INTEGER");
    if (!columns.has("to_offset")) db.exec("ALTER TABLE runs ADD COLUMN to_offset INTEGER");
    if (!columns.has("tags_json"))
      db.exec("ALTER TABLE runs ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'");
    const existed = hasCursorIndex(db);
    if (mode === "index-migrate")
      measureIndexPhase(timings, "cursor_index_ms", () =>
        db.exec(
          "CREATE INDEX IF NOT EXISTS runs_source_cursor_to ON runs(source_identity, from_offset, to_offset)",
        ),
      );
    // Retain the old index for older writers; the range scan must choose the covering one.
    db.exec("CREATE INDEX IF NOT EXISTS runs_source_cursor ON runs(source_identity, from_offset)");
    db.exec("CREATE INDEX IF NOT EXISTS runs_ended_at_idx ON runs(ended_at)");
    db.exec("COMMIT");
    return mode === "index-migrate" && !existed;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* A failed/ambiguous COMMIT must retain its original error. */
    }
    throw error;
  } finally {
    timings.migration_write_lock_ms = performance.now() - locked;
  }
}

/** One-shot offline preparation. Existing DB only; never creates an empty index. */
export function migrateSessionIndex(
  databasePath: string,
  busyTimeoutMs = 60_000,
): {
  created: boolean;
  phase_ms: SessionIndexTimings;
} {
  const db = new Database(databasePath, { readwrite: true, strict: true });
  const phase_ms: SessionIndexTimings = {};
  try {
    db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.trunc(busyTimeoutMs))}`);
    db.exec("PRAGMA journal_mode=WAL");
    return { created: migrateSchema(db, phase_ms, "index-migrate"), phase_ms };
  } finally {
    db.close(true);
  }
}

export function acquireSessionIndexConnection(
  path: string,
  busyTimeoutMs = 5000,
  timings: SessionIndexTimings = {},
  onCursorIndexMissing?: () => void,
): Database {
  const poisoned = replaced.get(path);
  if (poisoned) throw poisoned;
  const { dev, ino } = statSync(path);
  const cached = connections.get(path);
  if (cached) {
    if (cached.dev === dev && cached.ino === ino) return cached.db;
    const error = new SessionIndexReplacedError(
      path,
      { dev: cached.dev, ino: cached.ino },
      { dev, ino },
    );
    replaced.set(path, error);
    dropSessionIndexConnection(path);
    throw error;
  }
  const db = openConnection(path, busyTimeoutMs, timings, onCursorIndexMissing);
  connections.set(path, { db, dev, ino, commits: 0 });
  installExitHooks();
  return db;
}
export function dropSessionIndexConnection(path: string, checkpoint = false): void {
  const entry = connections.get(path);
  if (!entry) return;
  connections.delete(path);
  if (checkpoint) {
    try {
      entry.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      checkpointBusy++;
    }
  }
  try {
    entry.db.close(true);
  } catch {
    try {
      entry.db.close(false);
    } catch {
      /* Keep original failure. */
    }
  }
}
export function commitSessionIndex(
  path: string,
  db: Database,
  options: { checkpointEveryCommits?: number; checkpointMode?: "PASSIVE" | "RESTART" | "TRUNCATE" },
  timings: SessionIndexTimings,
): void {
  measureIndexPhase(timings, "commit_ms", () => db.exec("COMMIT"));
  const every = options.checkpointEveryCommits ?? 100;
  const entry = connections.get(path);
  if (every <= 0 || !entry) return;
  if (++entry.commits < every) return;
  entry.commits = 0;
  measureIndexPhase(timings, "checkpoint_ms", () => {
    try {
      const row = db
        .query(`PRAGMA wal_checkpoint(${options.checkpointMode ?? "PASSIVE"})`)
        .get() as { busy?: number } | null;
      if (row?.busy) checkpointBusy++;
    } catch {
      checkpointBusy++;
    }
  });
}
const SIGNAL_NUMBERS = { SIGINT: 2, SIGTERM: 15 } as const;
export function handleTerminationSignal(
  signal: keyof typeof SIGNAL_NUMBERS,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  closeSessionIndexConnections();
  if (process.listenerCount(signal) <= 1) exit(128 + SIGNAL_NUMBERS[signal]);
}
function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  process.on("exit", closeSessionIndexConnections);
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => handleTerminationSignal(signal));
}
export function closeSessionIndexConnections(): void {
  for (const path of [...connections.keys()]) dropSessionIndexConnection(path, true);
  replaced.clear();
}
export function sessionIndexConnectionStats(): {
  opens: number;
  cached: number;
  checkpointBusy: number;
} {
  return { opens, cached: connections.size, checkpointBusy };
}
export function peekSessionIndexConnection(path: string): Database | undefined {
  return connections.get(path)?.db;
}
