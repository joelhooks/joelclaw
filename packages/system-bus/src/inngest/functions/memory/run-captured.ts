/**
 * ADR-0243: memory/run.captured — chunk + embed + index a freshly-captured Run.
 *
 * Receives a Run that has already been persisted to NAS (authoritative storage,
 * Rule 10). This function is the derived-index path: chunks the jsonl,
 * requests embeddings at ingest-realtime priority (via the in-process queue
 * in @joelclaw/inference-router so queries are never starved), and writes
 * chunks + Run metadata to Typesense.
 *
 * Concurrency: limit 4. Ollama itself serializes embed calls internally, so
 * the priority queue in the router keeps query latency bounded even when
 * multiple Runs are mid-ingest.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSessionCapture,
  chunkTurns,
  detectFormat,
  extractTurns,
  parseJsonl,
  RUNS_COLLECTION,
  type Run,
  runsSchema,
  SessionIndexConflictError,
} from "@joelclaw/memory";
import { NonRetriableError } from "inngest";
import { emitOtelEvent } from "../../../observability/emit";
import { inngest } from "../../client";

const TYPESENSE_URL = process.env.TYPESENSE_URL ?? "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY ?? "";

async function typesenseRequest(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(`${TYPESENSE_URL}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      "X-TYPESENSE-API-KEY": TYPESENSE_API_KEY,
      "Content-Type": "application/json",
    },
  });
}

async function ensureCollections(): Promise<void> {
  // run_chunks_dev retired 2026-07-20 (Joel-approved cutover): full-transcript
  // chunks live in sessions.db only. Never recreate the Typesense collection.
  for (const [name, schema] of [
    [RUNS_COLLECTION, runsSchema(RUNS_COLLECTION)],
  ] as const) {
    const existing = await typesenseRequest(`/collections/${name}`);
    if (existing.status === 200) continue;
    if (existing.status !== 404) {
      const body = await existing.text();
      throw new Error(`typesense status ${existing.status} for ${name}: ${body}`);
    }
    const res = await typesenseRequest("/collections", {
      method: "POST",
      body: JSON.stringify(schema),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`create ${name} failed: ${res.status} ${body}`);
    }
  }
}

async function upsertRunDocument(run: Partial<Run> & { id: string }): Promise<void> {
  const res = await typesenseRequest(
    `/collections/${RUNS_COLLECTION}/documents?action=upsert`,
    {
      method: "POST",
      body: JSON.stringify(run),
    }
  );
  if (!res.ok) {
    throw new Error(`run upsert failed: ${res.status} ${await res.text()}`);
  }
}

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

export const memoryRunCaptured = inngest.createFunction(
  {
    // v3 intentionally creates a fresh Inngest concurrency bucket after
    // decoupling slow embedding work. Earlier versions accumulated poisoned
    // queues whose Runs never reached indexing. Raw Run blobs remain
    // authoritative and are backfilled separately.
    id: "memory-run-captured-v3",
    name: "memory/run.captured",
    concurrency: { limit: 4 },
    retries: 3,
  },
  { event: "memory/run.captured" },
  async ({ event, step }) => {
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

    // Inngest persists every step result. Keep transcript-scale data on disk and
    // reopen it inside the steps that need it instead of returning it through
    // durable step state.
    const capturePath =
      jsonl_inline === undefined
        ? jsonl_path
        : (
            await step.run("spool-inline-jsonl", async () =>
              spoolInlineJsonl(run_id, jsonl_inline)
            )
          ).path;

    let sessionAppend: ReturnType<typeof appendSessionCapture>;
    try {
      sessionAppend = await step.run("append-session-index", async () =>
        appendSessionCapture({
          databasePath:
            process.env.SESSION_INDEX_PATH ??
            join(homedir(), ".joelclaw", "search", "sessions.db"),
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
        })
      );
    } catch (error) {
      if (!(error instanceof SessionIndexConflictError)) throw error;
      await step.run("emit-session-index-conflict", async () => {
        await emitOtelEvent({
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
      });
      throw new NonRetriableError(error.message, { cause: error });
    }

    await step.run("emit-session-index-append", async () => {
      await emitOtelEvent({
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
          conflict: false,
        },
      });
    });

    await step.run("ensure-collections", async () => {
      await ensureCollections();
    });

    const analysis = await step.run("chunk", async () => {
      const { candidates, turns } = readCapture(capturePath);
      return {
        turn_count: turns.length,
        candidate_count: candidates.length,
      };
    });

    const cleanupInlineSpool = () =>
      jsonl_inline === undefined
        ? Promise.resolve()
        : step.run("cleanup-inline-jsonl", async () => {
            try {
              unlinkSync(capturePath);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            return { run_id };
          });

    const indexRun = () =>
      step.run("index-run", async () => {
        const { turns } = readCapture(capturePath);
        const lastTurnStartedAt = turns[turns.length - 1]?.started_at ?? started_at;
        const run: Partial<Run> & { id: string } = {
          id: run_id,
          user_id,
          machine_id,
          agent_runtime,
          agent_version: "",
          model: "",
          parent_run_id: parent_run_id ?? null,
          root_run_id: parent_run_id ?? null,
          conversation_id: conversation_id ?? null,
          tags: tags ?? [],
          readable_by: [user_id],
          intent: turns.find((turn) => turn.role === "user")?.text.slice(0, 500) ?? "",
          started_at,
          ended_at: lastTurnStartedAt,
          duration_ms: lastTurnStartedAt - started_at,
          turn_count: turns.length,
          user_turn_count: turns.filter((turn) => turn.role === "user").length,
          assistant_turn_count: turns.filter((turn) => turn.role === "assistant").length,
          tool_turn_count: turns.filter((turn) => turn.role === "tool").length,
          token_total: turns.reduce((total, turn) => total + turn.token_estimate, 0),
          tool_call_count: turns.filter((turn) => turn.role === "tool").length,
          files_touched: [],
          skills_invoked: [],
          entities_mentioned: [],
          enriched_at: null,
          enrichment_model: null,
          status: "active",
          full_text: turns.map((turn) => turn.text).join("\n"),
          jsonl_path,
          jsonl_bytes,
          jsonl_sha256,
          from_offset,
          to_offset,
          source_identity,
        };

        await upsertRunDocument(run);
        return { run_id, turn_count: turns.length };
      });

    if (analysis.candidate_count === 0) {
      await indexRun();
      await step.run("emit-empty", async () => {
        const { format } = readCapture(capturePath);
        await emitOtelEvent({
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
      });
      await cleanupInlineSpool();
      return {
        run_id,
        chunks_indexed: 0,
        reason: "empty",
      };
    }

    // run_chunks_dev retired 2026-07-20: sessions.db (appended above, before
    // any Typesense work) is the only full-transcript chunk index. Typesense
    // keeps Run metadata (runs_dev) for provenance and health only.
    await indexRun();

    const duration_ms = performance.now() - t0;

    await step.run("emit-otel", async () => {
      const { format } = readCapture(capturePath);
      await emitOtelEvent({
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
          turn_count: analysis.turn_count,
          format,
          session_index_status: sessionAppend.status,
          session_index_freshness: sessionAppend.freshness_timestamp,
          source_identity: sessionAppend.source_identity,
        },
      });
    });

    await step.sendEvent("emit-indexed", {
      name: "memory/run.indexed",
      data: {
        run_id,
        user_id,
        chunk_count: sessionAppend.chunk_count,
        index_duration_ms: Math.round(duration_ms),
      },
    });
    await cleanupInlineSpool();

    return {
      run_id,
      chunks_indexed: sessionAppend.chunk_count,
      turn_count: analysis.turn_count,
      duration_ms,
    };
  }
);
