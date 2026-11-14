import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  type Dir,
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  statfsSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { CapturedPayload } from "../types";
import { IntakeRequestError, syncDirectory } from "./stream";

export const ACK_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const ORPHAN_RETENTION_MS = 24 * 60 * 60_000;
export type IntakeMetadata = Omit<CapturedPayload, "jsonl_path">;
export interface IntakeRow {
  seq: number;
  id: string;
  run_id: string;
  metadata: IntakeMetadata;
  received_at: number;
  acked_at: number | null;
  owner: "appender" | "legacy";
  pruned_at: number | null;
  transfer_epoch: number;
}
interface StoredRow extends Omit<IntakeRow, "metadata"> {
  metadata: string;
  transfer_token: string | null;
}
export interface IntakeStore {
  db: Database;
  root: string;
  blobDir: string;
  /** In-flight publication is never garbage, even if the wall clock jumps. */
  publishing: Set<string>;
  orphanDirectory?: Dir;
  close(): void;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function durableDirectory(path: string): void {
  if (existsSync(path)) return;
  durableDirectory(dirname(path));
  mkdirSync(path, { mode: 0o700 });
  syncDirectory(dirname(path));
}
export function openIntake(
  root: string,
  options: { blobDir?: string; dbPath?: string } = {},
): IntakeStore {
  const blobDir = options.blobDir ?? join(root, "blobs");
  const dbPath = options.dbPath ?? join(root, "intake.db");
  durableDirectory(blobDir);
  durableDirectory(dirname(dbPath));
  const db = new Database(dbPath, { create: true, strict: true });
  chmodSync(dbPath, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS intake (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL UNIQUE, cursor_key TEXT UNIQUE,
      metadata TEXT NOT NULL, received_at INTEGER NOT NULL,
      acked_at INTEGER, owner TEXT NOT NULL DEFAULT 'appender', pruned_at INTEGER,
      transfer_token TEXT, transfer_epoch INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE INDEX IF NOT EXISTS intake_owed ON intake(owner, seq) WHERE acked_at IS NULL;
    CREATE INDEX IF NOT EXISTS intake_prune ON intake(acked_at) WHERE pruned_at IS NULL;
  `);
  const columns = db.query("PRAGMA table_info(intake)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "transfer_token"))
    db.exec("ALTER TABLE intake ADD COLUMN transfer_token TEXT");
  if (!columns.some((column) => column.name === "transfer_epoch"))
    db.exec("ALTER TABLE intake ADD COLUMN transfer_epoch INTEGER NOT NULL DEFAULT 0");
  syncDirectory(dirname(dbPath));
  const store: IntakeStore = {
    db,
    root,
    blobDir,
    publishing: new Set(),
    close: () => {
      store.orphanDirectory?.closeSync();
      store.orphanDirectory = undefined;
      db.close(false);
    },
  };
  return store;
}
export function blobPath(store: IntakeStore, id: string): string {
  if (!uuid.test(id)) throw new IntakeRequestError(400, "invalid_blob_id");
  return join(store.blobDir, `${id}.jsonl`);
}
function decode(row: StoredRow): IntakeRow {
  const { transfer_token: _capability, ...publicRow } = row;
  return { ...publicRow, metadata: JSON.parse(row.metadata) as IntakeMetadata };
}
export function getRow(store: IntakeStore, id: string): IntakeRow | null {
  const row = store.db.query("SELECT * FROM intake WHERE id=?").get(id) as StoredRow | null;
  return row ? decode(row) : null;
}
async function prefixDigest(path: string, bytes: number): Promise<string> {
  const hash = createHash("sha256");
  const reader = Bun.file(path).slice(0, bytes).stream().getReader();
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      hash.update(next.value);
      length += next.value.length;
    }
    if (length !== bytes) throw new Error("short prefix blob");
    return hash.digest("hex");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export async function commitIntake(
  store: IntakeStore,
  id: string,
  metadata: IntakeMetadata,
  now: number,
): Promise<IntakeRow> {
  const cursor =
    metadata.source_identity !== undefined && metadata.from_offset !== undefined
      ? createHash("sha256")
          .update(
            JSON.stringify([metadata.user_id, metadata.source_identity, metadata.from_offset]),
          )
          .digest("hex")
      : null;
  // Coalesced hook retries may include new tail bytes after a lost 202.
  // Hash their original prefix outside the SQLite write transaction.
  const candidate = store.db
    .query("SELECT * FROM intake WHERE run_id=? OR cursor_key=? LIMIT 1")
    .get(metadata.run_id, cursor) as StoredRow | null;
  const prior = candidate ? decode(candidate) : null;
  const prefix =
    prior && cursor && metadata.jsonl_bytes > prior.metadata.jsonl_bytes
      ? await prefixDigest(blobPath(store, id), prior.metadata.jsonl_bytes)
      : null;
  return store.db
    .transaction(() => {
      const byRun = store.db
        .query("SELECT * FROM intake WHERE run_id=?")
        .get(metadata.run_id) as StoredRow | null;
      const byCursor = cursor
        ? (store.db
            .query("SELECT * FROM intake WHERE cursor_key=?")
            .get(cursor) as StoredRow | null)
        : null;
      if (byRun && byCursor && byRun.id !== byCursor.id)
        throw new IntakeRequestError(409, "source_cursor_conflict");
      const existing = byRun ?? byCursor;
      if (existing) {
        const previous = decode(existing);
        for (const key of [
          "user_id",
          "machine_id",
          "agent_runtime",
          "source_identity",
          "from_offset",
        ] as const) {
          if (previous.metadata[key] !== metadata[key])
            throw new IntakeRequestError(409, "run_capture_conflict");
        }
        const exact =
          previous.metadata.jsonl_bytes === metadata.jsonl_bytes &&
          previous.metadata.jsonl_sha256 === metadata.jsonl_sha256 &&
          previous.metadata.to_offset === metadata.to_offset;
        const acceptedPrefix =
          cursor &&
          prior?.id === previous.id &&
          metadata.jsonl_bytes > previous.metadata.jsonl_bytes &&
          prefix === previous.metadata.jsonl_sha256;
        if (!exact && !acceptedPrefix) throw new IntakeRequestError(409, "run_capture_conflict");
        return previous;
      }
      store.db
        .query("INSERT INTO intake(id,run_id,cursor_key,metadata,received_at) VALUES (?,?,?,?,?)")
        .run(id, metadata.run_id, cursor, JSON.stringify(metadata), now);
      return getRow(store, id)!;
    })
    .immediate();
}
export function owedPage(
  store: IntakeStore,
  after = 0,
  limit = 100,
  includeLegacy = false,
): IntakeRow[] {
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new IntakeRequestError(400, "invalid_page");
  const rows = store.db
    .query(
      `SELECT * FROM intake WHERE acked_at IS NULL AND seq>? ${includeLegacy ? "" : "AND owner='appender'"} ORDER BY seq LIMIT ?`,
    )
    .all(after, limit) as StoredRow[];
  return rows.map(decode);
}
export function acknowledge(
  store: IntakeStore,
  id: string,
  digest: string,
  now: number,
  transferToken?: string,
): boolean {
  return store.db
    .transaction(() => {
      const row = store.db.query("SELECT * FROM intake WHERE id=?").get(id) as StoredRow | null;
      if (!row || decode(row).metadata.jsonl_sha256 !== digest) return false;
      // Ordinary appender acks cannot settle legacy debt. A returned/re-transferred
      // row also rejects the old drain's capability, including late lost replies.
      if (
        row.owner === "legacy"
          ? !row.transfer_token || row.transfer_token !== transferToken
          : transferToken !== undefined
      )
        return false;
      store.db.query("UPDATE intake SET acked_at=COALESCE(acked_at,?) WHERE id=?").run(now, id);
      return true;
    })
    .immediate();
}
export function transferToLegacy(
  store: IntakeStore,
  id: string,
  digest: string,
  legacyOnly = false,
  expectedEpoch = getRow(store, id)?.transfer_epoch,
): { transferred: boolean; transfer_token?: string } {
  return store.db
    .transaction(() => {
      store.db
        .query(
          `UPDATE intake SET owner='legacy', transfer_token=COALESCE(transfer_token,?),
       transfer_epoch=transfer_epoch+CASE WHEN owner='appender' OR transfer_token IS NULL THEN 1 ELSE 0 END
       WHERE id=? AND acked_at IS NULL ${legacyOnly ? "AND owner='legacy'" : ""}
       AND json_extract(metadata,'$.jsonl_sha256')=? AND transfer_epoch=?`,
        )
        .run(randomUUID(), id, digest, expectedEpoch ?? -1);
      // Bun's RunResult can include trigger side effects. SQLite changes()
      // reports this UPDATE alone, including an ignored/no-op transfer.
      const { changed } = store.db.query("SELECT changes() AS changed").get() as {
        changed: number;
      };
      if (!changed) return { transferred: false };
      const row = store.db.query("SELECT transfer_token FROM intake WHERE id=?").get(id) as {
        transfer_token: string;
      };
      return { transferred: true, transfer_token: row.transfer_token };
    })
    .immediate();
}
export function transferBackToAppender(
  store: IntakeStore,
  id: string,
  digest: string,
  transferToken: string,
): boolean {
  return store.db
    .transaction(() => {
      store.db
        .query(
          `UPDATE intake SET owner='appender', transfer_token=NULL, transfer_epoch=transfer_epoch+1
       WHERE id=? AND acked_at IS NULL AND owner='legacy' AND transfer_token=?
       AND json_extract(metadata,'$.jsonl_sha256')=?`,
        )
        .run(id, transferToken, digest);
      return (
        (store.db.query("SELECT changes() AS changed").get() as { changed: number }).changed > 0
      );
    })
    .immediate();
}
export function intakeHealth(store: IntakeStore, now = Date.now()) {
  const row = store.db
    .query(
      "SELECT COUNT(*) AS depth, MIN(received_at) AS oldest FROM intake WHERE acked_at IS NULL",
    )
    .get() as { depth: number; oldest: number | null };
  const disk = statfsSync(store.blobDir);
  return {
    ok: true,
    depth: row.depth,
    oldest_owed_age_ms: row.oldest === null ? null : Math.max(0, now - row.oldest),
    blob_disk_free_bytes: disk.bavail * disk.bsize,
  };
}
export function pruneIntake(store: IntakeStore, now = Date.now(), limit = 100): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("invalid prune limit");
  const rows = store.db
    .query(
      "SELECT * FROM intake WHERE acked_at IS NOT NULL AND acked_at<=? AND pruned_at IS NULL ORDER BY acked_at LIMIT ?",
    )
    .all(now - ACK_RETENTION_MS, limit) as StoredRow[];
  const pruned: string[] = [];
  for (const row of rows) {
    try {
      unlinkSync(blobPath(store, row.id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    syncDirectory(store.blobDir);
    store.db
      .query("UPDATE intake SET pruned_at=? WHERE id=? AND acked_at IS NOT NULL")
      .run(now, row.id);
    pruned.push(row.id);
  }
  // Keep identity tombstones: old retries must never revive a pruned run.
  return pruned;
}

/** Bounded, resumable scan: referenced, active, young and non-regular files survive. */
export function sweepOrphanBlobs(
  store: IntakeStore,
  now = Date.now(),
  limit = 100,
  scanLimit = 1000,
): string[] {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(scanLimit) ||
    scanLimit < 1 ||
    scanLimit > 1000
  )
    throw new Error("invalid orphan sweep limit");
  store.orphanDirectory ??= opendirSync(store.blobDir);
  const removed: string[] = [];
  for (let scanned = 0; scanned < scanLimit && removed.length < limit; scanned++) {
    const entry = store.orphanDirectory.readSync();
    if (!entry) {
      store.orphanDirectory.closeSync();
      store.orphanDirectory = undefined;
      break;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const id = entry.name.slice(0, -6);
    if (!uuid.test(id) || store.publishing.has(id)) continue;
    if (store.db.query("SELECT 1 FROM intake WHERE id=?").get(id)) continue;
    const path = blobPath(store, id);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.mtimeMs >= now - ORPHAN_RETENTION_MS) continue;
      unlinkSync(path);
      removed.push(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (removed.length) syncDirectory(store.blobDir);
  return removed;
}
