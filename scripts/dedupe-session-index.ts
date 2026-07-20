#!/usr/bin/env bun
/**
 * Remove byte-proven overlapping Runs from sessions.db without touching raw JSONL.
 *
 * Default mode is read-only and writes a manifest. Apply mode requires that
 * reviewed manifest, takes a locked file backup, verifies its SHA-256, then
 * removes only the proved Run/chunk/FTS rows in one transaction.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

interface RunRow {
  run_id: string;
  source_identity: string;
  from_offset: number;
  to_offset: number;
  jsonl_path: string;
  jsonl_bytes: number;
  jsonl_sha256: string;
  chunk_count: number;
  captured_at: number;
}

interface Proof {
  removed_run_id: string;
  covering_run_id: string;
  source_identity: string;
  removed_range: [number, number];
  covering_range: [number, number];
  covering_slice_offset: number;
  bytes: number;
  removed_sha256: string;
  covering_slice_sha256: string;
  removed_path: string;
  covering_path: string;
  removed_chunks: number;
}

interface UnresolvedOverlap {
  left_run_id: string;
  right_run_id: string;
  source_identity: string;
  left_range: [number, number];
  right_range: [number, number];
  reason: string;
}

interface Counts {
  runs: number;
  chunks: number;
  fts_chunks: number;
  skipped_runs: number;
  overlap_pairs: number;
  overlap_sources: number;
}

interface Manifest {
  schema_version: 1;
  generated_at: string;
  database: string;
  run_store: string;
  counts_before: Counts;
  affected_sources: string[];
  removals: Proof[];
  unresolved: UnresolvedOverlap[];
  expected_after: { runs: number; chunks: number; fts_chunks: number; skipped_runs: number };
}

const argv = Bun.argv.slice(2);
const flags = new Set(argv.filter((value) => value.startsWith("--") && !value.includes("=")));
function arg(name: string, fallback?: string): string | undefined {
  const direct = argv.find((value) => value.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

const base = join(homedir(), ".joelclaw");
const databasePath = resolve(arg("--db", join(base, "search", "sessions.db"))!);
const runStorePath = resolve(arg("--run-store", join(base, "runs-dev"))!);
const manifestPath = resolve(arg("--manifest", "/tmp/session-index-dedupe-manifest.json")!);
const receiptPath = resolve(arg("--receipt", "/tmp/session-index-dedupe-receipt.json")!);
const apply = flags.has("--apply");
const backupPath = resolve(
  arg(
    "--backup",
    join(base, "search", `sessions.db.pre-dedupe-${new Date().toISOString().replaceAll(":", "-")}`),
  )!,
);

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function sha256File(path: string): string {
  const result = Bun.spawnSync({ cmd: ["shasum", "-a", "256", path], stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`SHA-256 failed for ${path}: ${result.stderr.toString().trim()}`);
  }
  const digest = result.stdout.toString().trim().split(/\s+/u)[0];
  if (!digest || !/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`invalid SHA-256 output for ${path}`);
  return digest;
}

function runPath(row: RunRow): string {
  return isAbsolute(row.jsonl_path) ? row.jsonl_path : join(runStorePath, row.jsonl_path);
}

function counts(db: Database): Counts {
  return db.query(`WITH overlaps AS (
      SELECT a.source_identity
      FROM runs a JOIN runs b
        ON a.source_identity = b.source_identity AND a.run_id < b.run_id
       AND a.from_offset IS NOT NULL AND a.to_offset IS NOT NULL
       AND b.from_offset IS NOT NULL AND b.to_offset IS NOT NULL
       AND a.from_offset < b.to_offset AND a.to_offset > b.from_offset
    )
    SELECT
      (SELECT count(*) FROM runs) AS runs,
      (SELECT count(*) FROM chunks) AS chunks,
      (SELECT count(*) FROM chunk_fts) AS fts_chunks,
      (SELECT count(*) FROM skipped_runs) AS skipped_runs,
      (SELECT count(*) FROM overlaps) AS overlap_pairs,
      (SELECT count(DISTINCT source_identity) FROM overlaps) AS overlap_sources`).get() as Counts;
}

function readVerified(row: RunRow): Buffer {
  const path = runPath(row);
  if (!existsSync(path)) throw new Error(`raw Run is missing: ${path}`);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`raw Run is not a regular file: ${path}`);
  const bytes = readFileSync(path);
  if (bytes.length !== row.jsonl_bytes || row.to_offset - row.from_offset !== bytes.length) {
    throw new Error(`raw Run byte/range mismatch: ${row.run_id}`);
  }
  if (sha256(bytes) !== row.jsonl_sha256) {
    throw new Error(`raw Run SHA-256 mismatch: ${row.run_id}`);
  }
  return bytes;
}

function canonicalEqualRange(left: RunRow, right: RunRow): [RunRow, RunRow] {
  if (left.captured_at !== right.captured_at) {
    return left.captured_at < right.captured_at ? [left, right] : [right, left];
  }
  return left.run_id < right.run_id ? [left, right] : [right, left];
}

function chooseCover(candidates: Proof[], rows: Map<string, RunRow>): Proof {
  return [...candidates].sort((left, right) => {
    const a = rows.get(left.covering_run_id)!;
    const b = rows.get(right.covering_run_id)!;
    const lengthDelta = (b.to_offset - b.from_offset) - (a.to_offset - a.from_offset);
    if (lengthDelta !== 0) return lengthDelta;
    if (a.captured_at !== b.captured_at) return a.captured_at - b.captured_at;
    return a.run_id.localeCompare(b.run_id);
  })[0]!;
}

export function buildManifest(db: Database): Manifest {
  const before = counts(db);
  const pairs = db.query(`SELECT
      a.run_id AS a_run_id, b.run_id AS b_run_id
    FROM runs a JOIN runs b
      ON a.source_identity = b.source_identity AND a.run_id < b.run_id
     AND a.from_offset IS NOT NULL AND a.to_offset IS NOT NULL
     AND b.from_offset IS NOT NULL AND b.to_offset IS NOT NULL
     AND a.from_offset < b.to_offset AND a.to_offset > b.from_offset
    ORDER BY a.source_identity, a.from_offset, b.from_offset`).all() as Array<{
      a_run_id: string;
      b_run_id: string;
    }>;
  const ids = [...new Set(pairs.flatMap((pair) => [pair.a_run_id, pair.b_run_id]))];
  const byId = new Map<string, RunRow>();
  const findRun = db.query("SELECT * FROM runs WHERE run_id = ?");
  for (const id of ids) byId.set(id, findRun.get(id) as RunRow);

  const proofCandidates = new Map<string, Proof[]>();
  const unresolved: UnresolvedOverlap[] = [];
  const raw = new Map<string, Buffer>();
  const bytes = (row: RunRow) => {
    const cached = raw.get(row.run_id);
    if (cached) return cached;
    const verified = readVerified(row);
    raw.set(row.run_id, verified);
    return verified;
  };

  for (const pair of pairs) {
    const left = byId.get(pair.a_run_id)!;
    const right = byId.get(pair.b_run_id)!;
    let covering: RunRow;
    let removed: RunRow;
    const leftContains = left.from_offset <= right.from_offset && left.to_offset >= right.to_offset;
    const rightContains = right.from_offset <= left.from_offset && right.to_offset >= left.to_offset;
    if (!leftContains && !rightContains) {
      unresolved.push({
        left_run_id: left.run_id,
        right_run_id: right.run_id,
        source_identity: left.source_identity,
        left_range: [left.from_offset, left.to_offset],
        right_range: [right.from_offset, right.to_offset],
        reason: "partial overlap; neither Run covers the other",
      });
      continue;
    }
    if (leftContains && rightContains) [covering, removed] = canonicalEqualRange(left, right);
    else [covering, removed] = leftContains ? [left, right] : [right, left];

    const removedBytes = bytes(removed);
    const coveringBytes = bytes(covering);
    const sliceOffset = removed.from_offset - covering.from_offset;
    const coveringSlice = coveringBytes.subarray(sliceOffset, sliceOffset + removedBytes.length);
    if (!coveringSlice.equals(removedBytes)) {
      unresolved.push({
        left_run_id: left.run_id,
        right_run_id: right.run_id,
        source_identity: left.source_identity,
        left_range: [left.from_offset, left.to_offset],
        right_range: [right.from_offset, right.to_offset],
        reason: "range containment exists but raw bytes differ",
      });
      continue;
    }
    const proof: Proof = {
      removed_run_id: removed.run_id,
      covering_run_id: covering.run_id,
      source_identity: removed.source_identity,
      removed_range: [removed.from_offset, removed.to_offset],
      covering_range: [covering.from_offset, covering.to_offset],
      covering_slice_offset: sliceOffset,
      bytes: removedBytes.length,
      removed_sha256: sha256(removedBytes),
      covering_slice_sha256: sha256(coveringSlice),
      removed_path: runPath(removed),
      covering_path: runPath(covering),
      removed_chunks: removed.chunk_count,
    };
    proofCandidates.set(removed.run_id, [...(proofCandidates.get(removed.run_id) ?? []), proof]);
  }

  const removals = [...proofCandidates.values()]
    .map((candidates) => chooseCover(candidates, byId))
    .sort((a, b) => a.source_identity.localeCompare(b.source_identity)
      || a.removed_range[0] - b.removed_range[0]
      || a.removed_run_id.localeCompare(b.removed_run_id));
  const affectedSources = [...new Set(removals.map((proof) => proof.source_identity))].sort();
  const removedChunks = removals.reduce((sum, proof) => sum + proof.removed_chunks, 0);
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    database: databasePath,
    run_store: runStorePath,
    counts_before: before,
    affected_sources: affectedSources,
    removals,
    unresolved,
    expected_after: {
      runs: before.runs - removals.length,
      chunks: before.chunks - removedChunks,
      fts_chunks: before.fts_chunks - removedChunks,
      skipped_runs: before.skipped_runs,
    },
  };
}

function comparableProofs(manifest: Manifest): string {
  return JSON.stringify(manifest.removals.map((proof) => ({
    removed_run_id: proof.removed_run_id,
    covering_run_id: proof.covering_run_id,
    source_identity: proof.source_identity,
    removed_range: proof.removed_range,
    covering_range: proof.covering_range,
    covering_slice_offset: proof.covering_slice_offset,
    bytes: proof.bytes,
    removed_sha256: proof.removed_sha256,
    covering_slice_sha256: proof.covering_slice_sha256,
    removed_chunks: proof.removed_chunks,
  })));
}

function plan(): void {
  if (!existsSync(databasePath)) throw new Error(`session index not found: ${databasePath}`);
  const db = new Database(databasePath, { readwrite: true, strict: true });
  db.exec("PRAGMA query_only = ON");
  try {
    const manifest = buildManifest(db);
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const summary = {
      ok: manifest.unresolved.length === 0,
      mode: "plan",
      read_only: true,
      manifest: manifestPath,
      counts_before: manifest.counts_before,
      affected_sources: manifest.affected_sources.length,
      removals: manifest.removals.length,
      removed_chunks: manifest.removals.reduce((sum, proof) => sum + proof.removed_chunks, 0),
      unresolved: manifest.unresolved.length,
      expected_after: manifest.expected_after,
    };
    writeFileSync(receiptPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(summary, null, 2));
    if (manifest.unresolved.length > 0) process.exitCode = 1;
  } finally {
    db.close(false);
  }
}

function applyManifest(): void {
  if (!existsSync(manifestPath)) throw new Error(`reviewed manifest not found: ${manifestPath}`);
  if (existsSync(backupPath)) throw new Error(`backup already exists: ${backupPath}`);
  const reviewed = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  if (reviewed.schema_version !== 1 || resolve(reviewed.database) !== databasePath) {
    throw new Error("manifest schema/database does not match this apply");
  }
  if (reviewed.unresolved.length > 0) throw new Error("manifest has unresolved overlaps");

  const db = new Database(databasePath, { readwrite: true, strict: true });
  db.exec("PRAGMA busy_timeout = 30000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const current = buildManifest(db);
    if (current.unresolved.length > 0 || comparableProofs(current) !== comparableProofs(reviewed)) {
      throw new Error("live overlap set differs from reviewed manifest; re-plan before apply");
    }

    mkdirSync(dirname(backupPath), { recursive: true });
    copyFileSync(databasePath, backupPath);
    const databaseSha256 = sha256File(databasePath);
    const backupSha256 = sha256File(backupPath);
    if (databaseSha256 !== backupSha256) throw new Error("backup SHA-256 differs from locked database");

    const selectChunks = db.query("SELECT rowid FROM chunks WHERE run_id = ? ORDER BY rowid");
    const deleteFts = db.prepare("DELETE FROM chunk_fts WHERE rowid = ?");
    const deleteChunks = db.prepare("DELETE FROM chunks WHERE run_id = ?");
    const deleteRun = db.prepare("DELETE FROM runs WHERE run_id = ?");
    for (const proof of reviewed.removals) {
      const rows = selectChunks.all(proof.removed_run_id) as Array<{ rowid: number }>;
      if (rows.length !== proof.removed_chunks) {
        throw new Error(`chunk count changed for ${proof.removed_run_id}`);
      }
      for (const row of rows) deleteFts.run(row.rowid);
      const chunksDeleted = deleteChunks.run(proof.removed_run_id).changes;
      const runsDeleted = deleteRun.run(proof.removed_run_id).changes;
      if (chunksDeleted !== proof.removed_chunks || runsDeleted !== 1) {
        throw new Error(`delete count mismatch for ${proof.removed_run_id}`);
      }
    }

    const after = counts(db);
    if (
      after.runs !== current.expected_after.runs
      || after.chunks !== current.expected_after.chunks
      || after.fts_chunks !== current.expected_after.fts_chunks
      || after.skipped_runs !== current.expected_after.skipped_runs
      || after.overlap_pairs !== 0
    ) {
      throw new Error(`post-dedupe counts differ: ${JSON.stringify(after)}`);
    }
    const integrity = db.query("PRAGMA integrity_check").get() as Record<string, string>;
    if (!Object.values(integrity).includes("ok")) {
      throw new Error(`integrity_check failed: ${JSON.stringify(integrity)}`);
    }
    db.exec("COMMIT");
    transactionOpen = false;

    const receipt = {
      ok: true,
      mode: "apply",
      database: databasePath,
      backup: backupPath,
      backup_bytes: statSync(backupPath).size,
      database_sha256_before: databaseSha256,
      backup_sha256: backupSha256,
      counts_before: current.counts_before,
      counts_after: after,
      affected_sources: reviewed.affected_sources,
      removals: reviewed.removals.length,
      removed_chunks: reviewed.removals.reduce((sum, proof) => sum + proof.removed_chunks, 0),
      raw_run_jsonl_mutated: false,
      integrity_check: "ok",
    };
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(receipt, null, 2));
  } catch (error) {
    if (transactionOpen) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close(false);
  }
}

if (import.meta.main) {
  try {
    if (apply) applyManifest();
    else plan();
  } catch (error) {
    console.error(`session index dedupe stopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
