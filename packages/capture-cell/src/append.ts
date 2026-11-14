import {
  appendSessionCapture,
  SessionCaptureBlobMismatchError,
  SessionCaptureBlobReadError,
} from "@joelclaw/memory";
import { BlobMismatchError, BlobUnreadableError, isUnreadableBlobError } from "./failure";
import type { ShadowReadOptions } from "./shadow-append";
import type { AppendObservation, CapturedPayload } from "./types";

/** The canonical writer verifies/analyzes the blob once, outside its write lock. */
export function appendCapture(
  payload: CapturedPayload,
  options: ShadowReadOptions & { onCursorIndexMissing?: () => void },
  now = Date.now(),
): AppendObservation {
  const started = performance.now();
  let result: ReturnType<typeof appendSessionCapture>;
  try {
    result = appendSessionCapture({
      databasePath: options.sessionsDbPath,
      capturePath: payload.jsonl_path,
      runId: payload.run_id,
      userId: payload.user_id,
      machineId: payload.machine_id,
      agentRuntime: payload.agent_runtime,
      conversationId: payload.conversation_id,
      parentRunId: payload.parent_run_id,
      sourceIdentity: payload.source_identity,
      fromOffset: payload.from_offset,
      toOffset: payload.to_offset,
      tags: payload.tags,
      startedAt: payload.started_at,
      capturedAt: now,
      jsonlPath: payload.jsonl_path,
      jsonlBytes: payload.jsonl_bytes,
      jsonlSha256: payload.jsonl_sha256,
      busyTimeoutMs: options.readTimeoutMs,
      onCursorIndexMissing: options.onCursorIndexMissing,
    });
  } catch (error) {
    if (error instanceof SessionCaptureBlobMismatchError)
      throw new BlobMismatchError(error.message);
    if (error instanceof SessionCaptureBlobReadError && isUnreadableBlobError(error.cause))
      throw new BlobUnreadableError(payload.jsonl_path, error.cause);
    throw error;
  }
  return {
    observed: result.status,
    matched:
      result.status === "appended" ? null : result.run_id === payload.run_id ? "run" : "cursor",
    matched_run_id: result.status === "appended" ? null : result.run_id,
    chunk_count: result.chunk_count,
    turn_count: result.analysis.turn_count,
    format: result.analysis.format,
    computed_chunk_count: result.analysis.chunk_count,
    computed_turn_count: result.analysis.turn_count,
    computed_format: result.analysis.format,
    source_identity: result.source_identity,
    duration_ms: performance.now() - started,
    text_bytes: result.text_bytes,
    canonical_duration_ms: result.duration_ms,
    phase_ms: result.phase_ms,
  };
}
