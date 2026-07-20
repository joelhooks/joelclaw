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
  db.exec(
    "CREATE INDEX IF NOT EXISTS runs_source_cursor ON runs(source_identity, from_offset)",
  );

  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;

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

    const sourceIdentity = input.sourceIdentity ?? `legacy-run:${input.runId}`;
    const fromOffset = Number.isSafeInteger(input.fromOffset) ? input.fromOffset : undefined;
    const existing = db
      .query(`SELECT jsonl_sha256, jsonl_bytes, chunk_count, captured_at,
        source_identity, from_offset, to_offset FROM runs WHERE run_id = ?`)
      .get(input.runId) as
      | {
          jsonl_sha256: string;
          jsonl_bytes: number;
          chunk_count: number;
          captured_at: number;
          source_identity: string;
          from_offset: number | null;
          to_offset: number | null;
        }
      | null;

    if (existing) {
      const sameRunIdentity =
        existing.jsonl_sha256 === input.jsonlSha256 &&
        existing.jsonl_bytes === input.jsonlBytes &&
        (input.sourceIdentity === undefined ||
          (existing.source_identity === input.sourceIdentity &&
            existing.from_offset === (input.fromOffset ?? null) &&
            existing.to_offset === (input.toOffset ?? null)));
      if (!sameRunIdentity) throw new SessionIndexConflictError(input.runId);
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

    const existingByCursor =
      input.sourceIdentity !== undefined && fromOffset !== undefined
        ? (db
            .query(`SELECT run_id, jsonl_path, jsonl_bytes, jsonl_sha256, to_offset,
              chunk_count, captured_at, source_identity
              FROM runs WHERE source_identity = ? AND from_offset = ? LIMIT 1`)
            .get(input.sourceIdentity, fromOffset) as
            | {
                run_id: string;
                jsonl_path: string;
                jsonl_bytes: number;
                jsonl_sha256: string;
                to_offset: number | null;
                chunk_count: number;
                captured_at: number;
                source_identity: string;
              }
            | null)
        : null;
    if (existingByCursor) {
      const exactSegment =
        existingByCursor.jsonl_sha256 === input.jsonlSha256 &&
        existingByCursor.jsonl_bytes === input.jsonlBytes &&
        existingByCursor.to_offset === (input.toOffset ?? null);
      let relatedPrefix = false;
      if (!exactSegment && existsSync(existingByCursor.jsonl_path)) {
        const indexedBlob = readFileSync(existingByCursor.jsonl_path);
        relatedPrefix =
          (blob.length >= indexedBlob.length &&
            blob.subarray(0, indexedBlob.length).equals(indexedBlob)) ||
          (indexedBlob.length >= blob.length && indexedBlob.subarray(0, blob.length).equals(blob));
      }
      if (!exactSegment && !relatedPrefix) {
        throw new SessionIndexConflictError(existingByCursor.run_id);
      }
      db.exec("COMMIT");
      transactionOpen = false;
      return {
        status: "already_indexed",
        run_id: existingByCursor.run_id,
        chunk_count: existingByCursor.chunk_count,
        freshness_timestamp: existingByCursor.captured_at,
        source_identity: existingByCursor.source_identity,
        duration_ms: performance.now() - started,
      };
    }

    // Different-start overlap: no exact-cursor row matched above, so any
    // range intersection means a segment that starts inside indexed bytes.
    // A well-behaved client cannot produce this; never store the same source
    // bytes twice. Reject loudly — raw JSONL on NAS stays durable.
    if (input.sourceIdentity !== undefined && fromOffset !== undefined && input.toOffset !== undefined) {
      const overlapping = db
        .query(`SELECT run_id FROM runs
          WHERE source_identity = ? AND from_offset IS NOT NULL AND to_offset IS NOT NULL
            AND from_offset < ? AND to_offset > ? LIMIT 1`)
        .get(input.sourceIdentity, input.toOffset, fromOffset) as { run_id: string } | null;
      if (overlapping) throw new SessionIndexConflictError(overlapping.run_id);
    }

    const entries = parseJsonl(blob.toString("utf8"));
    const turns = extractTurns(entries, detectFormat(entries));
    const chunks = chunkTurns(turns);
    const endedAt = turns[turns.length - 1]?.started_at ?? input.startedAt;
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
