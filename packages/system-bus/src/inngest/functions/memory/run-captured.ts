/**
 * ADR-0243: memory/run.captured — append a freshly-captured Run to sessions.db.
 *
 * Receives a Run that has already been persisted to NAS (authoritative storage,
 * Rule 10). This function maintains the local SQLite FTS projection. The
 * retired Typesense runs_dev/run_chunks_dev projections must not be recreated.
 *
 * The handler runs as plain code with no `step.*` checkpoints. On self-hosted
 * Inngest every step costs one executor round trip and queue hop, and those
 * hops, not SQLite, set the drain rate: a 2 MB append takes about 12 ms. One
 * invocation per Run is safe because every side effect is idempotent:
 * `appendSessionCapture` returns `already_indexed` for a repeated Run or source
 * cursor, the growth ledger replaces entries by run_id, and
 * `memory/run.indexed` carries a deterministic event id that Inngest dedupes.
 *
 * SQLite still serializes writers. The append transaction only covers the
 * index checks and inserts, so eight concurrent Runs wait milliseconds on the
 * write lock, well inside its 5 s busy timeout.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSessionCapture,
  chunkTurns,
  detectFormat,
  extractTurns,
  parseJsonl,
  SessionIndexConflictError,
} from "@joelclaw/memory";
import { NonRetriableError } from "inngest";
import { emitOtelEvent } from "../../../observability/emit";
import { inngest } from "../../client";
import {
  type CaptureGrowthCheckReceipt,
  checkCaptureGrowthForRun,
} from "../typesense-recovery-alerts";

function readCapture(jsonlPath: string) {
  const entries = parseJsonl(readFileSync(jsonlPath, "utf8"));
  const format = detectFormat(entries);
  const turns = extractTurns(entries, format);
  const candidates = chunkTurns(turns);
  return { candidates, format, turns };
}

function spoolInlineJsonl(runId: string, jsonl: string) {
  const sha256 = createHash("sha256").update(jsonl).digest("hex");
  const spoolDir = join(tmpdir(), "joelclaw-memory-run-capture");
  const path = join(spoolDir, `${sha256}.${randomUUID()}.jsonl`);
  const tempPath = `${path}.tmp`;

  mkdirSync(spoolDir, { recursive: true });
  try {
    writeFileSync(tempPath, jsonl, "utf8");
    renameSync(tempPath, path);
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // The successful rename already removed the temporary path.
    }
  }

  return {
    run_id: runId,
    path,
    bytes: Buffer.byteLength(jsonl),
    sha256,
  };
}

export interface RunCapturedDependencies {
  emitOtel: typeof emitOtelEvent;
  checkCaptureGrowth: (data: Record<string, unknown>) => Promise<CaptureGrowthCheckReceipt>;
  sendIndexed: (event: {
    id: string;
    name: "memory/run.indexed";
    data: {
      run_id: string;
      user_id: string;
      chunk_count: number;
      index_duration_ms: number;
    };
  }) => Promise<unknown>;
}

const defaultDependencies: RunCapturedDependencies = {
  emitOtel: emitOtelEvent,
  checkCaptureGrowth: (data) => checkCaptureGrowthForRun(data),
  sendIndexed: (event) => inngest.send(event),
};

let dependencies = defaultDependencies;

/**
 * Telemetry is best effort, not part of capture acknowledgement. The long-lived
 * worker lets these requests finish after the handler returns. A process crash
 * or restart can lose in-flight telemetry; indexed event delivery stays awaited.
 */
function emitCaptureOtel(input: Parameters<typeof emitOtelEvent>[0]): void {
  const emit = dependencies.emitOtel;
  void Promise.resolve()
    .then(() => emit(input))
    .then((result) => {
      // emitOtelEvent normally returns failures instead of throwing them.
      // Forward-mode HTTP failures live in result.forward, not result.error.
      const error = result.error ?? result.forward?.error;
      if (error) throw new Error(error);
      if (!result.stored && !result.skipped && !result.dropped) {
        throw new Error(result.clickhouse.error ?? "telemetry was not stored");
      }
    })
    .catch((error) => {
      console.warn("[memory-run-captured] telemetry failed", {
        action: input.action,
        run_id: input.metadata?.run_id,
        error: String(error),
      });
    });
}

/** Inngest dedupes events that share an id, so a retried Run sends one signal. */
export function runIndexedEventId(runId: string): string {
  return `memory-run-indexed:${runId}`;
}

export const memoryRunCaptured = inngest.createFunction(
  {
    // Never rename: queued memory/run.captured events are bound to this id.
    // v3 intentionally created a fresh Inngest concurrency bucket after
    // decoupling slow embedding work. Earlier versions accumulated poisoned
    // queues whose Runs never reached indexing. Raw Run blobs remain
    // authoritative and are backfilled separately.
    id: "memory-run-captured-v3",
    name: "memory/run.captured",
    concurrency: { limit: 8 },
    retries: 3,
  },
  { event: "memory/run.captured" },
  async ({ event }) => {
    const t0 = performance.now();
    const {
      run_id,
      user_id,
      machine_id,
      agent_runtime,
      jsonl_path,
      jsonl_bytes,
      jsonl_sha256,
      started_at,
      parent_run_id,
      conversation_id,
      tags,
      from_offset,
      to_offset,
      source_identity,
      jsonl_inline,
    } = event.data;

    // Start the growth check before the synchronous append so its state-store
    // round trip overlaps the SQLite work. It never throws.
    const growthCheck = dependencies.checkCaptureGrowth(event.data as Record<string, unknown>);

    // Older events carry the transcript inline. Spool it to disk for the
    // append, which verifies size and SHA-256 against the event.
    const capturePath =
      jsonl_inline === undefined ? jsonl_path : spoolInlineJsonl(run_id, jsonl_inline).path;

    try {
      let sessionAppend: ReturnType<typeof appendSessionCapture>;
      try {
        sessionAppend = appendSessionCapture({
          databasePath:
            process.env.SESSION_INDEX_PATH ?? join(homedir(), ".joelclaw", "search", "sessions.db"),
          capturePath,
          runId: run_id,
          userId: user_id,
          machineId: machine_id,
          agentRuntime: agent_runtime,
          conversationId: conversation_id,
          parentRunId: parent_run_id,
          sourceIdentity: source_identity,
          fromOffset: from_offset,
          toOffset: to_offset,
          tags,
          startedAt: started_at,
          capturedAt: Date.now(),
          jsonlPath: jsonl_path,
          jsonlBytes: jsonl_bytes,
          jsonlSha256: jsonl_sha256,
        });
      } catch (error) {
        await growthCheck;
        if (!(error instanceof SessionIndexConflictError)) throw error;
        emitCaptureOtel({
          level: "error",
          source: "system-bus",
          component: "memory-run-captured",
          action: "memory.run.session-index.append",
          success: false,
          metadata: {
            run_id,
            source_identity: source_identity ?? `legacy-run:${run_id}`,
            conflict: true,
          },
        });
        throw new NonRetriableError(error.message, { cause: error });
      }

      const { candidates, format, turns } = readCapture(capturePath);
      const growth = await growthCheck;
      const duration_ms = performance.now() - t0;
      const empty = candidates.length === 0;

      emitCaptureOtel({
        level: "info",
        source: "system-bus",
        component: "memory-run-captured",
        action: "memory.run.session-index.append",
        success: true,
        duration_ms: Math.round(sessionAppend.duration_ms),
        metadata: {
          run_id,
          status: sessionAppend.status,
          freshness_timestamp: sessionAppend.freshness_timestamp,
          source_identity: sessionAppend.source_identity,
          chunk_count: sessionAppend.chunk_count,
          turn_count: sessionAppend.turn_count,
          text_bytes: sessionAppend.text_bytes,
          conflict: false,
        },
      });
      if (empty) {
        emitCaptureOtel({
          level: "warn",
          source: "system-bus",
          component: "memory-run-captured",
          action: "memory.run.captured.empty",
          success: true,
          metadata: {
            run_id,
            user_id,
            reason: "no usable turns extracted from jsonl",
            format,
          },
        });
      } else {
        emitCaptureOtel({
          level: "info",
          source: "system-bus",
          component: "memory-run-captured",
          action: "memory.run.captured",
          success: true,
          duration_ms: Math.round(duration_ms),
          metadata: {
            run_id,
            user_id,
            machine_id,
            agent_runtime,
            chunk_count: sessionAppend.chunk_count,
            turn_count: turns.length,
            format,
            session_index_status: sessionAppend.status,
            session_index_freshness: sessionAppend.freshness_timestamp,
            source_identity: sessionAppend.source_identity,
            capture_growth_checked: growth.checked,
            capture_growth_detected: growth.finding !== null,
          },
        });
      }

      if (empty) {
        return {
          run_id,
          chunks_indexed: 0,
          reason: "empty",
          session_index_status: sessionAppend.status,
          session_index_run_id: sessionAppend.run_id,
        };
      }

      await dependencies.sendIndexed({
        id: runIndexedEventId(run_id),
        name: "memory/run.indexed",
        data: {
          run_id,
          user_id,
          chunk_count: sessionAppend.chunk_count,
          index_duration_ms: Math.round(duration_ms),
        },
      });

      return {
        run_id,
        chunks_indexed: sessionAppend.chunk_count,
        turn_count: turns.length,
        duration_ms,
        session_index_status: sessionAppend.status,
        session_index_run_id: sessionAppend.run_id,
      };
    } finally {
      if (jsonl_inline !== undefined) {
        try {
          unlinkSync(capturePath);
        } catch {
          // Best effort: a leftover temp spool must not mask the indexing
          // result or error, and no later run reads it.
        }
      }
    }
  },
);

export const __runCapturedTestUtils = {
  setDependencies(overrides: Partial<RunCapturedDependencies>) {
    dependencies = { ...defaultDependencies, ...overrides };
  },
  resetDependencies() {
    dependencies = defaultDependencies;
  },
};
