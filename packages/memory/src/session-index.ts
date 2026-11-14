import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chunkTurns, detectFormat, extractTurns, type JsonlFormat, parseJsonl } from "./chunking";
import {
  acquireSessionIndexConnection,
  commitSessionIndex,
  dropSessionIndexConnection,
  measureIndexPhase,
  type SessionIndexTimings,
} from "./session-index-connection";

export {
  closeSessionIndexConnections,
  handleTerminationSignal,
  migrateSessionIndex,
  peekSessionIndexConnection,
  SessionIndexReplacedError,
  sessionIndexConnectionStats,
} from "./session-index-connection";

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
  /** Fail-open alarm on a new handle without the manually prepared covering index. */
  onCursorIndexMissing?: () => void;
  checkpointEveryCommits?: number;
  checkpointMode?: "PASSIVE" | "RESTART" | "TRUNCATE";
}

export interface SessionCaptureAppendResult {
  status: "appended" | "already_indexed";
  run_id: string;
  chunk_count: number;
  turn_count: number;
  text_bytes: number;
  phase_ms: SessionIndexTimings;
  /** Verified incoming blob analysis, even when an existing row wins dedupe. */
  analysis: { turn_count: number; chunk_count: number; format: JsonlFormat };
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

export class SessionCaptureBlobReadError extends Error {
  constructor(cause: unknown) {
    super("session capture blob read failed", { cause });
  }
}

export class SessionCaptureBlobMismatchError extends Error {
  readonly code = "SESSION_CAPTURE_BLOB_MISMATCH";
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** What identifies one capture against the index: its Run, its bytes and its source cursor. */
export interface SessionCaptureIdentity {
  runId: string;
  sourceIdentity?: string;
  fromOffset?: number;
  toOffset?: number;
  jsonlBytes: number;
  jsonlSha256: string;
}

export interface IndexedRunByRunId {
  jsonl_sha256: string;
  jsonl_bytes: number;
  chunk_count: number;
  captured_at: number;
  source_identity: string;
  from_offset: number | null;
  to_offset: number | null;
  /** Absent on rows read by appendSessionCapture, which never needed it. */
  turn_count?: number;
}

export interface IndexedRunByCursor {
  run_id: string;
  jsonl_path: string;
  jsonl_bytes: number;
  jsonl_sha256: string;
  to_offset: number | null;
  chunk_count: number;
  captured_at: number;
  source_identity: string;
}

/**
 * The index rows that decide a capture's identity, read in precedence order:
 * the Run itself, then the exact source cursor, then any overlapping range.
 * Reading stops at the first row found, as the decision only needs that one.
 */
export type SessionIndexIdentityRows =
  | { kind: "run"; row: IndexedRunByRunId }
  | { kind: "cursor"; row: IndexedRunByCursor }
  | { kind: "overlap"; run_id: string }
  | { kind: "none" };

export type SessionIndexIdentityDecision =
  | {
      status: "already_indexed";
      /** Which row matched: the same Run, or another Run at the same cursor. */
      matched: "run" | "cursor";
      run_id: string;
      chunk_count: number;
      freshness_timestamp: number;
      source_identity: string;
      turn_count?: number;
    }
  | { status: "new" };

/** Throws when the blob on disk is not the one the capture names. */
export function verifySessionCaptureBlob(identity: SessionCaptureIdentity, blob: Uint8Array): void {
  if (blob.length !== identity.jsonlBytes) {
    throw new SessionCaptureBlobMismatchError(
      `session index byte mismatch for ${identity.runId}: event=${identity.jsonlBytes} disk=${blob.length}`,
    );
  }
  const digest = sha256(blob);
  if (digest !== identity.jsonlSha256) {
    throw new SessionCaptureBlobMismatchError(
      `session index SHA-256 mismatch for ${identity.runId}: event=${identity.jsonlSha256} disk=${digest}`,
    );
  }
}

/** Read the rows that decide a capture's identity. Needs the cursor columns. */
export function readSessionIndexIdentityRows(
  db: Database,
  identity: SessionCaptureIdentity,
  options: { withTurnCount?: boolean } = {},
): SessionIndexIdentityRows {
  const fromOffset = Number.isSafeInteger(identity.fromOffset) ? identity.fromOffset : undefined;
  const existing = db
    .query(`SELECT jsonl_sha256, jsonl_bytes, chunk_count, captured_at,
        source_identity, from_offset, to_offset${options.withTurnCount ? ", turn_count" : ""}
        FROM runs WHERE run_id = ?`)
    .get(identity.runId) as IndexedRunByRunId | null;
  if (existing) return { kind: "run", row: existing };

  const existingByCursor =
    identity.sourceIdentity !== undefined && fromOffset !== undefined
      ? (db
          .query(`SELECT run_id, jsonl_path, jsonl_bytes, jsonl_sha256, to_offset,
              chunk_count, captured_at, source_identity
              FROM runs WHERE source_identity = ? AND from_offset = ? LIMIT 1`)
          .get(identity.sourceIdentity, fromOffset) as IndexedRunByCursor | null)
      : null;
  if (existingByCursor) return { kind: "cursor", row: existingByCursor };

  if (
    identity.sourceIdentity !== undefined &&
    fromOffset !== undefined &&
    identity.toOffset !== undefined
  ) {
    const overlapping = db
      .query(`SELECT run_id FROM runs WHERE rowid = (
          SELECT rowid FROM runs
          WHERE source_identity = ? AND from_offset IS NOT NULL AND to_offset IS NOT NULL
            AND from_offset < ? AND to_offset > ? LIMIT 1
        )`)
      .get(identity.sourceIdentity, identity.toOffset, fromOffset) as { run_id: string } | null;
    if (overlapping) return { kind: "overlap", run_id: overlapping.run_id };
  }
  return { kind: "none" };
}

/**
 * Decide a capture's identity from the rows read for it. Pure apart from
 * `readIndexedBlob`, which loads an indexed blob only for a same-cursor row
 * with different bytes, to tell a related prefix from a conflict. It returns
 * null when that blob is gone. Throws SessionIndexConflictError on a conflict.
 */
export function decideSessionIndexIdentity(
  identity: SessionCaptureIdentity,
  rows: SessionIndexIdentityRows,
  blob: Uint8Array,
  readIndexedBlob: (path: string) => Uint8Array | null,
): SessionIndexIdentityDecision {
  if (rows.kind === "run") {
    const existing = rows.row;
    const sameRunIdentity =
      existing.jsonl_sha256 === identity.jsonlSha256 &&
      existing.jsonl_bytes === identity.jsonlBytes &&
      (identity.sourceIdentity === undefined ||
        (existing.source_identity === identity.sourceIdentity &&
          existing.from_offset === (identity.fromOffset ?? null) &&
          existing.to_offset === (identity.toOffset ?? null)));
    if (!sameRunIdentity) throw new SessionIndexConflictError(identity.runId);
    return {
      status: "already_indexed",
      matched: "run",
      run_id: identity.runId,
      chunk_count: existing.chunk_count,
      freshness_timestamp: existing.captured_at,
      source_identity: existing.source_identity,
      ...(existing.turn_count === undefined ? {} : { turn_count: existing.turn_count }),
    };
  }

  if (rows.kind === "cursor") {
    const existingByCursor = rows.row;
    const exactSegment =
      existingByCursor.jsonl_sha256 === identity.jsonlSha256 &&
      existingByCursor.jsonl_bytes === identity.jsonlBytes &&
      existingByCursor.to_offset === (identity.toOffset ?? null);
    let relatedPrefix = false;
    if (!exactSegment) {
      const indexedBlob = readIndexedBlob(existingByCursor.jsonl_path);
      if (indexedBlob) {
        relatedPrefix =
          (blob.length >= indexedBlob.length &&
            Buffer.compare(blob.subarray(0, indexedBlob.length), indexedBlob) === 0) ||
          (indexedBlob.length >= blob.length &&
            Buffer.compare(indexedBlob.subarray(0, blob.length), blob) === 0);
      }
    }
    if (!exactSegment && !relatedPrefix) {
      throw new SessionIndexConflictError(existingByCursor.run_id);
    }
    return {
      status: "already_indexed",
      matched: "cursor",
      run_id: existingByCursor.run_id,
      chunk_count: existingByCursor.chunk_count,
      freshness_timestamp: existingByCursor.captured_at,
      source_identity: existingByCursor.source_identity,
    };
  }

  // Different-start overlap: no exact-cursor row matched above, so any
  // range intersection means a segment that starts inside indexed bytes.
  // A well-behaved client cannot produce this; never store the same source
  // bytes twice. Reject loudly — raw JSONL on NAS stays durable.
  if (rows.kind === "overlap") throw new SessionIndexConflictError(rows.run_id);
  return { status: "new" };
}

/** Read an indexed blob for the prefix check; null when it no longer exists. */
export function readIndexedBlobIfPresent(path: string): Uint8Array | null {
  return existsSync(path) ? readFileSync(path) : null;
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
  const phase_ms: SessionIndexTimings = {};
  const timed = <T>(phase: string, operation: () => T) =>
    measureIndexPhase(phase_ms, phase, operation);
  const busyTimeoutMs = input.busyTimeoutMs ?? 5_000;
  const db = timed("connection_ms", () =>
    acquireSessionIndexConnection(
      input.databasePath,
      busyTimeoutMs,
      phase_ms,
      input.onCursorIndexMissing,
    ),
  );
  let transactionOpen = false;
  let insertChunk: ReturnType<Database["prepare"]> | undefined;
  let insertFts: ReturnType<Database["prepare"]> | undefined;
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
    // As in legacy, slow blob I/O and parsing happen before the write lock.
    const blob = timed("blob_read_ms", () => {
      try {
        return readFileSync(input.capturePath);
      } catch (error) {
        throw new SessionCaptureBlobReadError(error);
      }
    });
    timed("blob_hash_ms", () => verifySessionCaptureBlob(input, blob));
    const { turns, chunks, format } = timed("analysis_ms", () => {
      const entries = parseJsonl(blob.toString("utf8"));
      const format = detectFormat(entries);
      const turns = extractTurns(entries, format);
      return { turns, chunks: chunkTurns(turns), format };
    });
    const analysis = { turn_count: turns.length, chunk_count: chunks.length, format };
    timed("begin_ms", () => db.exec("BEGIN IMMEDIATE"));
    transactionOpen = true;

    const sourceIdentity = input.sourceIdentity ?? `legacy-run:${input.runId}`;
    const identity = timed("dedupe_ms", () =>
      decideSessionIndexIdentity(
        input,
        readSessionIndexIdentityRows(db, input),
        blob,
        readIndexedBlobIfPresent,
      ),
    );
    if (identity.status === "already_indexed") {
      commitSessionIndex(input.databasePath, db, input, phase_ms);
      transactionOpen = false;
      return {
        status: "already_indexed",
        run_id: identity.run_id,
        chunk_count: identity.chunk_count,
        turn_count: 0,
        text_bytes: 0,
        phase_ms,
        analysis,
        freshness_timestamp: identity.freshness_timestamp,
        source_identity: identity.source_identity,
        duration_ms: performance.now() - started,
      };
    }

    const endedAt = turns[turns.length - 1]?.started_at ?? input.startedAt;
    const insertStarted = performance.now();
    db.query(`INSERT INTO runs (
      run_id, user_id, machine_id, agent_runtime, conversation_id, parent_run_id,
      source_identity, prefix_group_identity, verdict, started_at, captured_at,
      ended_at, jsonl_path, jsonl_bytes, jsonl_sha256, turn_count, chunk_count,
      from_offset, to_offset, tags_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unique_tail', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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

    phase_ms.run_insert_ms = performance.now() - insertStarted;
    const chunksStarted = performance.now();
    insertChunk = db.prepare(`INSERT INTO chunks (
      chunk_id, run_id, chunk_idx, role, text, started_at, token_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    insertFts = db.prepare("INSERT INTO chunk_fts(rowid, text) VALUES (?, ?)");
    let textBytes = 0;
    for (const chunk of chunks) {
      textBytes += Buffer.byteLength(chunk.text, "utf8");
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

    phase_ms.chunks_fts_ms = performance.now() - chunksStarted;
    commitSessionIndex(input.databasePath, db, input, phase_ms);
    transactionOpen = false;
    return {
      status: "appended",
      run_id: input.runId,
      chunk_count: chunks.length,
      turn_count: turns.length,
      text_bytes: textBytes,
      phase_ms,
      analysis,
      freshness_timestamp: input.capturedAt,
      source_identity: sourceIdentity,
      duration_ms: performance.now() - started,
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* Preserve original error. */
      }
    }
    if (!(error instanceof SessionIndexConflictError))
      dropSessionIndexConnection(input.databasePath);
    throw error;
  } finally {
    // Cached db.query statements belong to the connection; these two do not.
    try {
      insertChunk?.finalize();
    } catch {
      /* A failed connection may have finalized it. */
    }
    try {
      insertFts?.finalize();
    } catch {
      /* Preserve original failure after close. */
    }
  }
}
