import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chunkTurns, detectFormat, extractTurns, parseJsonl } from "./chunking";

export interface SessionCaptureAppendInput {
  databasePath: string;
  capturePath: string;
  runId: string;
  userId: string;
  machineId: string;
  agentRuntime: string;
  conversationId?: string;
  parentRunId?: string;
  sourceIdentity?: string;
  fromOffset?: number;
  toOffset?: number;
  tags?: string[];
  startedAt: number;
  capturedAt: number;
  jsonlPath: string;
  jsonlBytes: number;
  jsonlSha256: string;
  busyTimeoutMs?: number;
}

export interface SessionCaptureAppendResult {
  status: "appended" | "already_indexed";
  run_id: string;
  chunk_count: number;
  freshness_timestamp: number;
  source_identity: string;
  duration_ms: number;
}

export class SessionIndexConflictError extends Error {
  readonly code = "SESSION_INDEX_RUN_CONFLICT";

  constructor(readonly runId: string) {
    super(`session index Run ${runId} already exists with different JSONL bytes`);
    this.name = "SessionIndexConflictError";
  }
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Append one durable capture to the compacted FTS index.
 *
 * The Run row, content rows, and FTS rows share one immediate transaction.
 * Replaying the same Run and digest is a no-op. A reused Run ID with different
 * bytes is a hard conflict.
 */
export function appendSessionCapture(input: SessionCaptureAppendInput): SessionCaptureAppendResult {
  const started = performance.now();
  if (!existsSync(input.databasePath)) {
    throw new Error(`session index not found: ${input.databasePath}`);
  }
  const db = new Database(input.databasePath, { readwrite: true, strict: true });
  const busyTimeoutMs = input.busyTimeoutMs ?? 5_000;
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  const columns = new Set(
    (db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!columns.has("from_offset")) db.exec("ALTER TABLE runs ADD COLUMN from_offset INTEGER");
  if (!columns.has("to_offset")) db.exec("ALTER TABLE runs ADD COLUMN to_offset INTEGER");
  if (!columns.has("tags_json")) {
    db.exec("ALTER TABLE runs ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'");
  }

  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;

    const existing = db
      .query("SELECT jsonl_sha256, chunk_count, captured_at, source_identity FROM runs WHERE run_id = ?")
      .get(input.runId) as
      | { jsonl_sha256: string; chunk_count: number; captured_at: number; source_identity: string }
      | null;

    if (existing) {
      if (existing.jsonl_sha256 !== input.jsonlSha256) {
        throw new SessionIndexConflictError(input.runId);
      }
      db.exec("COMMIT");
      transactionOpen = false;
      return {
        status: "already_indexed",
        run_id: input.runId,
        chunk_count: existing.chunk_count,
        freshness_timestamp: existing.captured_at,
        source_identity: existing.source_identity,
        duration_ms: performance.now() - started,
      };
    }

    const blob = readFileSync(input.capturePath);
    if (blob.length !== input.jsonlBytes) {
      throw new Error(
        `session index byte mismatch for ${input.runId}: event=${input.jsonlBytes} disk=${blob.length}`,
      );
    }
    const digest = sha256(blob);
    if (digest !== input.jsonlSha256) {
      throw new Error(
        `session index SHA-256 mismatch for ${input.runId}: event=${input.jsonlSha256} disk=${digest}`,
      );
    }

    const entries = parseJsonl(blob.toString("utf8"));
    const turns = extractTurns(entries, detectFormat(entries));
    const chunks = chunkTurns(turns);
    const endedAt = turns[turns.length - 1]?.started_at ?? input.startedAt;
    const sourceIdentity = input.sourceIdentity ?? `legacy-run:${input.runId}`;

    db.query(`INSERT INTO runs (
      run_id, user_id, machine_id, agent_runtime, conversation_id, parent_run_id,
      source_identity, prefix_group_identity, verdict, started_at, captured_at,
      ended_at, jsonl_path, jsonl_bytes, jsonl_sha256, turn_count, chunk_count,
      from_offset, to_offset, tags_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unique_tail', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        input.runId,
        input.userId,
        input.machineId,
        input.agentRuntime,
        input.conversationId ?? null,
        input.parentRunId ?? null,
        sourceIdentity,
        sourceIdentity,
        input.startedAt,
        input.capturedAt,
        endedAt,
        input.jsonlPath,
        input.jsonlBytes,
        input.jsonlSha256,
        turns.length,
        chunks.length,
        input.fromOffset ?? null,
        input.toOffset ?? null,
        JSON.stringify(input.tags ?? []),
      );

    const insertChunk = db.prepare(`INSERT INTO chunks (
      chunk_id, run_id, chunk_idx, role, text, started_at, token_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertFts = db.prepare("INSERT INTO chunk_fts(rowid, text) VALUES (?, ?)");
    for (const chunk of chunks) {
      const inserted = insertChunk.run(
        `${input.runId}:${chunk.chunk_idx}`,
        input.runId,
        chunk.chunk_idx,
        chunk.role,
        chunk.text,
        chunk.started_at,
        chunk.token_count,
      );
      insertFts.run(inserted.lastInsertRowid, chunk.text);
    }

    db.exec("COMMIT");
    transactionOpen = false;
    return {
      status: "appended",
      run_id: input.runId,
      chunk_count: chunks.length,
      freshness_timestamp: input.capturedAt,
      source_identity: sourceIdentity,
      duration_ms: performance.now() - started,
    };
  } catch (error) {
    if (transactionOpen) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close(false);
  }
}
