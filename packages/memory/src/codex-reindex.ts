import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  type ChunkCandidate,
  chunkTurns,
  countCodexDuplicateRepresentations,
  extractTurns,
  parseJsonl,
} from "./chunking";

export interface CodexSessionReindexResult {
  readonly applied: boolean;
  readonly scanned_runs: number;
  readonly affected_runs: number;
  readonly raw_duplicate_representations_before: number;
  readonly verified_runs_after: number;
  readonly chunks_before: number;
  readonly chunks_after: number;
}

interface CodexIndexedRun {
  readonly run_id: string;
  readonly jsonl_path: string;
  readonly jsonl_bytes: number;
  readonly jsonl_sha256: string;
  readonly started_at: number;
}

interface PlannedRun {
  readonly run: CodexIndexedRun;
  readonly sourcePath: string;
  readonly sourceIdentity: {
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
    readonly mtimeMs: number;
  };
  readonly turns: ReturnType<typeof extractTurns>;
  readonly chunks: ChunkCandidate[];
  readonly chunksBefore: number;
  readonly duplicates: number;
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

const sameRun = (left: CodexIndexedRun, right: CodexIndexedRun | null) =>
  right !== null &&
  left.run_id === right.run_id &&
  left.jsonl_path === right.jsonl_path &&
  left.jsonl_bytes === right.jsonl_bytes &&
  left.jsonl_sha256 === right.jsonl_sha256 &&
  left.started_at === right.started_at;

const buildPlan = (databasePath: string, runStorePath: string) => {
  const runStoreRoot = realpathSync(resolve(runStorePath));
  const db = new Database(databasePath, { readonly: true, strict: true });
  try {
    const runs = db
      .query(`SELECT run_id, jsonl_path, jsonl_bytes, jsonl_sha256, started_at
        FROM runs WHERE agent_runtime = 'codex' ORDER BY run_id`)
      .all() as CodexIndexedRun[];
    const plans: PlannedRun[] = [];
    for (const run of runs) {
      const candidate = isAbsolute(run.jsonl_path)
        ? run.jsonl_path
        : join(runStoreRoot, run.jsonl_path);
      let sourcePath: string;
      try {
        sourcePath = realpathSync(candidate);
      } catch {
        throw new Error("codex session reindex failed: source-invalid");
      }
      const relativePath = relative(runStoreRoot, sourcePath);
      const metadata = statSync(sourcePath);
      if (
        relativePath === "" ||
        relativePath.startsWith("..") ||
        isAbsolute(relativePath) ||
        !metadata.isFile()
      ) {
        throw new Error("codex session reindex failed: source-invalid");
      }
      const bytes = readFileSync(sourcePath);
      if (bytes.length !== run.jsonl_bytes || sha256(bytes) !== run.jsonl_sha256) {
        throw new Error("codex session reindex failed: source-integrity");
      }
      const entries = parseJsonl(bytes.toString("utf8"));
      const duplicates = countCodexDuplicateRepresentations(entries);
      if (duplicates === 0) continue;
      const turns = extractTurns(entries, "codex");
      const chunks = chunkTurns(turns);
      const chunksBefore = Number(
        (
          db.query("SELECT count(*) AS count FROM chunks WHERE run_id = ?").get(run.run_id) as {
            count: number;
          }
        ).count,
      );
      plans.push({
        run,
        sourcePath,
        sourceIdentity: {
          dev: metadata.dev,
          ino: metadata.ino,
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
        },
        turns,
        chunks,
        chunksBefore,
        duplicates,
      });
    }
    return { scannedRuns: runs.length, plans };
  } finally {
    db.close(false);
  }
};

export function reindexCodexSessionChunks(input: {
  readonly databasePath: string;
  readonly runStorePath: string;
  readonly apply?: boolean;
  readonly busyTimeoutMs?: number;
}): CodexSessionReindexResult {
  const plan = buildPlan(input.databasePath, input.runStorePath);
  const receipt = {
    applied: input.apply === true,
    scanned_runs: plan.scannedRuns,
    affected_runs: plan.plans.length,
    raw_duplicate_representations_before: plan.plans.reduce(
      (sum, item) => sum + item.duplicates,
      0,
    ),
    verified_runs_after: 0,
    chunks_before: plan.plans.reduce((sum, item) => sum + item.chunksBefore, 0),
    chunks_after: plan.plans.reduce((sum, item) => sum + item.chunks.length, 0),
  };
  if (input.apply !== true || plan.plans.length === 0) return receipt;

  const db = new Database(input.databasePath, { strict: true });
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(input.busyTimeoutMs ?? 5_000))}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  let transactionOpen = false;
  let verifiedRuns = 0;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const findRun = db.prepare(`SELECT run_id, jsonl_path, jsonl_bytes, jsonl_sha256, started_at
      FROM runs WHERE run_id = ? AND agent_runtime = 'codex'`);
    const findChunks = db.prepare(
      "SELECT rowid, text FROM chunks WHERE run_id = ? ORDER BY chunk_idx",
    );
    const deleteFts = db.prepare(
      "INSERT INTO chunk_fts(chunk_fts, rowid, text) VALUES('delete', ?, ?)",
    );
    const deleteChunks = db.prepare("DELETE FROM chunks WHERE run_id = ?");
    const insertChunk = db.prepare(`INSERT INTO chunks (
      chunk_id, run_id, chunk_idx, role, text, started_at, token_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertFts = db.prepare("INSERT INTO chunk_fts(rowid, text) VALUES (?, ?)");
    const updateRun = db.prepare(
      "UPDATE runs SET ended_at = ?, turn_count = ?, chunk_count = ? WHERE run_id = ?",
    );

    for (const item of plan.plans) {
      const current = findRun.get(item.run.run_id) as CodexIndexedRun | null;
      const metadata = statSync(item.sourcePath);
      if (
        !sameRun(item.run, current) ||
        metadata.dev !== item.sourceIdentity.dev ||
        metadata.ino !== item.sourceIdentity.ino ||
        metadata.size !== item.sourceIdentity.size ||
        metadata.mtimeMs !== item.sourceIdentity.mtimeMs
      ) {
        throw new Error("codex session reindex failed: source-changed");
      }
      const oldChunks = findChunks.all(item.run.run_id) as Array<{
        rowid: number;
        text: string;
      }>;
      for (const chunk of oldChunks) deleteFts.run(chunk.rowid, chunk.text);
      deleteChunks.run(item.run.run_id);
      for (const chunk of item.chunks) {
        const inserted = insertChunk.run(
          `${item.run.run_id}:${chunk.chunk_idx}`,
          item.run.run_id,
          chunk.chunk_idx,
          chunk.role,
          chunk.text,
          chunk.started_at,
          chunk.token_count,
        );
        insertFts.run(inserted.lastInsertRowid, chunk.text);
      }
      updateRun.run(
        item.turns[item.turns.length - 1]?.started_at ?? item.run.started_at,
        item.turns.length,
        item.chunks.length,
        item.run.run_id,
      );
      const stored = db
        .query("SELECT role, text FROM chunks WHERE run_id = ? ORDER BY chunk_idx")
        .all(item.run.run_id) as Array<{ role: string; text: string }>;
      if (
        stored.length !== item.chunks.length ||
        stored.some(
          (chunk, index) =>
            chunk.role !== item.chunks[index]?.role ||
            chunk.text !== item.chunks[index]?.text,
        )
      ) {
        throw new Error("codex session reindex failed: write-verification");
      }
      verifiedRuns += 1;
    }
    const quickCheck = db.query("PRAGMA quick_check").get() as {
      quick_check?: string;
    } | null;
    if (quickCheck?.quick_check !== "ok") {
      throw new Error("codex session reindex failed: integrity-check");
    }
    db.exec("COMMIT");
    transactionOpen = false;
    return { ...receipt, verified_runs_after: verifiedRuns };
  } catch (error) {
    if (transactionOpen) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close(false);
  }
}
