import { SessionIndexConflictError } from "@joelclaw/memory";
import type { Failure } from "./types";

/*
 * Failures are classified before anything is marked dead. Deterministic
 * ones fail the same way on every attempt, so they go dead at once with
 * the reason and the replay command. Transient ones back off and never go
 * dead; an unrecognised failure counts as transient.
 */

/** The run's blob is missing or can't be read. Deterministic. */
export class BlobUnreadableError extends Error {
  readonly code = "CAPTURE_CELL_BLOB_UNREADABLE";

  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(`run blob unreadable: ${(cause as NodeJS.ErrnoException)?.code ?? String(cause)}`, {
      cause,
    });
    this.name = "BlobUnreadableError";
  }
}

/** The blob on disk isn't the one the capture names. Deterministic. */
export class BlobMismatchError extends Error {
  readonly code = "CAPTURE_CELL_BLOB_MISMATCH";

  constructor(message: string) {
    super(message);
    this.name = "BlobMismatchError";
  }
}

/** The captured row is missing or unparseable. Deterministic. */
export class CapturedRowError extends Error {
  readonly code = "CAPTURE_CELL_CAPTURED_ROW";

  constructor(message: string) {
    super(message);
    this.name = "CapturedRowError";
  }
}

/** A shadow read went over its time bound. Transient. */
export class ShadowReadTimeoutError extends Error {
  readonly code = "CAPTURE_CELL_READ_TIMEOUT";

  constructor(
    readonly elapsedMs: number,
    readonly timeoutMs: number,
    cause?: unknown,
  ) {
    super(`sessions.db read took ${Math.round(elapsedMs)}ms (bound ${timeoutMs}ms)`, { cause });
    this.name = "ShadowReadTimeoutError";
  }
}

/** sessions.db is absent or lacks the cursor columns. Transient. */
export class SessionsDbUnavailableError extends Error {
  readonly code = "CAPTURE_CELL_SESSIONS_DB_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "SessionsDbUnavailableError";
  }
}

/** The OTEL endpoint refused the event as invalid. Deterministic. */
export class OtelRejectedError extends Error {
  readonly code = "CAPTURE_CELL_OTEL_REJECTED";

  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`otel emit rejected: HTTP ${status} ${detail}`.trim());
    this.name = "OtelRejectedError";
  }
}

const DETERMINISTIC_ERRORS = [
  SessionIndexConflictError,
  BlobUnreadableError,
  BlobMismatchError,
  CapturedRowError,
  OtelRejectedError,
];

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : undefined;
}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  return code && !message.includes(code) ? `${code}: ${message}` : message;
}

export function classifyFailure(error: unknown): Failure {
  const deterministic = DETERMINISTIC_ERRORS.some((type) => error instanceof type);
  return {
    class: deterministic ? "deterministic" : "transient",
    reason: reasonOf(error).slice(0, 500),
  };
}

/** Errors reading a blob that mean it is gone or unreadable, not that the disk hiccupped. */
const UNREADABLE_BLOB_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR", "EACCES", "EPERM"]);

export function isUnreadableBlobError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && UNREADABLE_BLOB_CODES.has(code);
}

export function isSqliteBusy(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    /database is (locked|busy)/iu.test(String(error))
  );
}
