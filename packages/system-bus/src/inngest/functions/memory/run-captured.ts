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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { embed } from "@joelclaw/inference-router";
import {
  type Chunk,
  chunkTurns,
  detectFormat,
  embeddingModelTag,
  extractTurns,
  parseJsonl,
  RUN_CHUNKS_COLLECTION,
  RUNS_COLLECTION,
  type Run,
  runChunksSchema,
  runsSchema,
} from "@joelclaw/memory";
import { emitOtelEvent } from "../../../observability/emit";
import { inngest } from "../../client";

const TYPESENSE_URL = process.env.TYPESENSE_URL ?? "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY ?? "";
const EMBED_DIMS = 768;
const RUN_CAPTURE_EMBEDDINGS = /^(1|true|yes)$/i.test(
  process.env.RUN_CAPTURE_EMBEDDINGS ?? "false"
);
const PENDING_EMBEDDING = Array.from({ length: EMBED_DIMS }, () => 0);

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
  for (const [name, schema] of [
    [RUN_CHUNKS_COLLECTION, runChunksSchema(RUN_CHUNKS_COLLECTION, EMBED_DIMS)],
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

    await step.run("ensure-collections", async () => {
      await ensureCollections();
    });

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

    // Text indexing is the availability path. Embedding is optional enrichment:
    // a slow or unhealthy local model must not block fresh Runs from search.
    // Pending zero vectors satisfy the existing Typesense schema and are replaced
    // by the embedding backfill path when local inference is healthy.
    const chunkImport = await step.run("index-chunks", async () => {
      const { candidates } = readCapture(capturePath);
      const modelTag = RUN_CAPTURE_EMBEDDINGS ? embeddingModelTag() : "pending";
      const embeddings = RUN_CAPTURE_EMBEDDINGS
        ? await Promise.all(
            candidates.map((candidate) =>
              embed(candidate.text, {
                priority: "ingest-realtime",
                dimensions: EMBED_DIMS,
              }).then((result) => result.embedding)
            )
          )
        : candidates.map(() => PENDING_EMBEDDING);
      const chunks = candidates.map<Chunk>((candidate, index) => ({
        id: `${run_id}:${candidate.chunk_idx}`,
        run_id,
        chunk_idx: candidate.chunk_idx,
        role: candidate.role,
        text: candidate.text,
        embedding: embeddings[index]!,
        embedding_model: modelTag,
        token_count: candidate.token_count,
        started_at: candidate.started_at,
        user_id,
        readable_by: [user_id],
        root_run_id: parent_run_id ?? null,
        agent_runtime,
        conversation_id: conversation_id ?? null,
        tags: RUN_CAPTURE_EMBEDDINGS
          ? (tags ?? [])
          : [...(tags ?? []), "embedding:pending"],
        machine_id,
      }));

      const ndjson = chunks.map((chunk) => JSON.stringify(chunk)).join("\n");
      const res = await typesenseRequest(
        `/collections/${RUN_CHUNKS_COLLECTION}/documents/import?action=upsert`,
        {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: ndjson,
        }
      );
      if (!res.ok) {
        throw new Error(`chunk import failed: ${res.status} ${await res.text()}`);
      }
      const body = await res.text();
      const errors = body
        .split("\n")
        .filter(
          (line) =>
            line.trim() &&
            (() => {
              try {
                return (JSON.parse(line) as { success?: boolean }).success === false;
              } catch {
                return true;
              }
            })()
        ).length;
      return {
        imported: chunks.length - errors,
        errors,
        chunk_count: chunks.length,
      };
    });

    await indexRun();

    const duration_ms = performance.now() - t0;

    await step.run("emit-otel", async () => {
      const { format } = readCapture(capturePath);
      await emitOtelEvent({
        level: "info",
        source: "system-bus",
        component: "memory-run-captured",
        action: "memory.run.captured",
        success: chunkImport.errors === 0,
        duration_ms: Math.round(duration_ms),
        metadata: {
          run_id,
          user_id,
          machine_id,
          agent_runtime,
          chunk_count: chunkImport.chunk_count,
          chunk_errors: chunkImport.errors,
          embedding_status: RUN_CAPTURE_EMBEDDINGS ? "embedded" : "pending",
          turn_count: analysis.turn_count,
          format,
        },
      });
    });

    await step.sendEvent("emit-indexed", {
      name: "memory/run.indexed",
      data: {
        run_id,
        user_id,
        chunk_count: chunkImport.chunk_count,
        index_duration_ms: Math.round(duration_ms),
      },
    });
    await cleanupInlineSpool();

    return {
      run_id,
      chunks_indexed: chunkImport.imported,
      chunk_errors: chunkImport.errors,
      turn_count: analysis.turn_count,
      duration_ms,
    };
  }
);
