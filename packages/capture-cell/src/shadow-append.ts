import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  chunkTurns,
  decideSessionIndexIdentity,
  detectFormat,
  extractTurns,
  parseJsonl,
  readIndexedBlobIfPresent,
  readSessionIndexIdentityRows,
  type SessionCaptureIdentity,
  SessionIndexConflictError,
  type SessionIndexIdentityRows,
  verifySessionCaptureBlob,
} from "@joelclaw/memory";
import {
  BlobMismatchError,
  BlobUnreadableError,
  isSqliteBusy,
  isUnreadableBlobError,
  SessionsDbUnavailableError,
  ShadowReadTimeoutError,
} from "./failure";
import type { AppendObservation, CapturedPayload } from "./types";

/*
 * Shadow mode's `append`: the same identity checks and chunking as
 * `appendSessionCapture`, reading only. The blob is parsed before any read
 * transaction; the read is one short transaction on a connection opened for
 * this verdict alone and closed straight after.
 */

export interface ShadowReadOptions {
  sessionsDbPath: string;
  readTimeoutMs: number;
  /** Test seam: a hook that runs inside the read transaction. */
  duringRead?: (db: Database) => void;
}

export function identityOf(payload: CapturedPayload): SessionCaptureIdentity {
  return {
    runId: payload.run_id,
    sourceIdentity: payload.source_identity,
    fromOffset: payload.from_offset,
    toOffset: payload.to_offset,
    jsonlBytes: payload.jsonl_bytes,
    jsonlSha256: payload.jsonl_sha256,
  };
}

function readBlob(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    if (isUnreadableBlobError(error)) throw new BlobUnreadableError(path, error);
    throw error;
  }
}

/**
 * Read the identity rows in one deferred read transaction, bounded in time:
 * `busy_timeout` caps any lock wait at the bound, and a read that still ran
 * over it is discarded as a transient timeout.
 */
export function readIdentityRowsBounded(
  identity: SessionCaptureIdentity,
  options: ShadowReadOptions,
): SessionIndexIdentityRows {
  if (!existsSync(options.sessionsDbPath)) {
    throw new SessionsDbUnavailableError("session index not found");
  }
  const started = performance.now();
  let db: Database | undefined;
  try {
    db = new Database(options.sessionsDbPath, { readonly: true, strict: true });
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.readTimeoutMs))}`);
    db.exec("BEGIN");
    let rows: SessionIndexIdentityRows;
    try {
      const columns = new Set(
        (db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((c) => c.name),
      );
      if (!columns.has("from_offset") || !columns.has("to_offset")) {
        throw new SessionsDbUnavailableError("sessions.db runs table lacks cursor columns");
      }
      options.duringRead?.(db);
      rows = readSessionIndexIdentityRows(db, identity, { withTurnCount: true });
    } finally {
      if (db.inTransaction) db.exec("ROLLBACK");
    }
    const elapsed = performance.now() - started;
    if (elapsed > options.readTimeoutMs) {
      throw new ShadowReadTimeoutError(elapsed, options.readTimeoutMs);
    }
    return rows;
  } catch (error) {
    if (isSqliteBusy(error)) {
      throw new ShadowReadTimeoutError(performance.now() - started, options.readTimeoutMs, error);
    }
    throw error;
  } finally {
    db?.close(false);
  }
}

/** Decide the shadow outcome for one captured run. Writes nothing anywhere. */
export function shadowAppend(
  payload: CapturedPayload,
  options: ShadowReadOptions,
): AppendObservation {
  const started = performance.now();
  const identity = identityOf(payload);
  const blob = readBlob(payload.jsonl_path);
  try {
    verifySessionCaptureBlob(identity, blob);
  } catch (error) {
    throw new BlobMismatchError((error as Error).message);
  }

  // Parse outside any read transaction, once: chunk_count, turn_count, format.
  const entries = parseJsonl(blob.toString("utf8"));
  const format = detectFormat(entries);
  const turns = extractTurns(entries, format);
  const chunkCount = chunkTurns(turns).length;
  const parsed = {
    turn_count: turns.length,
    format,
    computed_chunk_count: chunkCount,
    computed_turn_count: turns.length,
    computed_format: format,
  };

  const rows = readIdentityRowsBounded(identity, options);
  const ownSourceIdentity = payload.source_identity ?? `legacy-run:${payload.run_id}`;
  // The prefix comparison may read another blob: after the transaction closed.
  try {
    const decision = decideSessionIndexIdentity(identity, rows, blob, readIndexedBlobIfPresent);
    if (decision.status === "new") {
      return {
        observed: "appended",
        matched: null,
        matched_run_id: null,
        chunk_count: chunkCount,
        ...parsed,
        source_identity: ownSourceIdentity,
        duration_ms: performance.now() - started,
      };
    }
    return {
      observed: "already_indexed",
      matched: decision.matched,
      matched_run_id: decision.run_id,
      chunk_count: decision.chunk_count,
      ...parsed,
      source_identity: decision.source_identity,
      duration_ms: performance.now() - started,
    };
  } catch (error) {
    if (!(error instanceof SessionIndexConflictError)) throw error;
    return {
      observed: "conflict",
      matched: rows.kind === "none" ? null : rows.kind,
      matched_run_id: error.runId,
      chunk_count: chunkCount,
      ...parsed,
      source_identity: ownSourceIdentity,
      duration_ms: performance.now() - started,
    };
  }
}

/** The WAL guard: how big sessions.db's write-ahead log is right now. */
export function walBytes(sessionsDbPath: string): number {
  try {
    return statSync(`${sessionsDbPath}-wal`).size;
  } catch {
    return 0;
  }
}
