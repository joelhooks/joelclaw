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

import { readFileSync } from "node:fs";
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

export const memoryRunCaptured = inngest.createFunction(
  {
    id: "memory-run-captured",
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
      jsonl_inline,
    } = event.data;

    await step.run("ensure-collections", async () => {
      await ensureCollections();
    });

    // Load jsonl from NAS or the inline event payload.
    const jsonl =
      jsonl_inline ??
      (await step.run("load-jsonl", async () => {
        return readFileSync(jsonl_path, "utf8");
      }));

    // Chunk using the memory package's format-aware chunker.
    const { turns, candidates, format } = await step.run("chunk", async () => {
      const entries = parseJsonl(jsonl);
      const format = detectFormat(entries);
      const turns = extractTurns(entries, format);
      const candidates = chunkTurns(turns);
      return { turns, candidates, format };
    });

    if (candidates.length === 0) {
      await step.run("emit-empty", async () => {
        emitOtelEvent("memory.run.captured.empty", {
          run_id,
          user_id,
          reason: "no usable turns extracted from jsonl",
          format,
        });
      });
      return {
        run_id,
        chunks_indexed: 0,
        reason: "empty",
      };
    }

    // Embed each chunk at ingest-realtime priority. The in-process priority
    // queue in @joelclaw/inference-router ensures query-priority requests
    // preempt these.
    const modelTag = embeddingModelTag();
    const chunks: Chunk[] = await step.run("embed", async () => {
      const texts = candidates.map((c) => c.text);
      const results = await Promise.all(
        texts.map((text) =>
          embed(text, { priority: "ingest-realtime", dimensions: EMBED_DIMS })
        )
      );
      return candidates.map<Chunk>((cand, i) => ({
        id: `${run_id}:${cand.chunk_idx}`,
        run_id,
        chunk_idx: cand.chunk_idx,
        role: cand.role,
        text: cand.text,
        embedding: results[i]!.embedding,
        embedding_model: modelTag,
        token_count: cand.token_count,
        started_at: cand.started_at,
        user_id,
        readable_by: [user_id],
        root_run_id: parent_run_id ?? null,
        agent_runtime,
        conversation_id: conversation_id ?? null,
        tags: tags ?? [],
        machine_id,
      }));
    });

    // Bulk import chunks to Typesense.
    const chunkImport = await step.run("index-chunks", async () => {
      const ndjson = chunks.map((c) => JSON.stringify(c)).join("\n");
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
          (l) =>
            l.trim() &&
            (() => {
              try {
                return (JSON.parse(l) as { success?: boolean }).success === false;
              } catch {
                return true;
              }
            })()
        );
      return { imported: chunks.length - errors.length, errors: errors.length };
    });

    // Build + upsert the Run row. Inline-deterministic metadata only
    // (entity extraction is a separate Inngest function, fire-and-forget).
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
      intent: turns.find((t) => t.role === "user")?.text.slice(0, 500) ?? "",
      started_at,
      ended_at: turns[turns.length - 1]?.started_at ?? started_at,
      duration_ms:
        (turns[turns.length - 1]?.started_at ?? started_at) - started_at,
      turn_count: turns.length,
      user_turn_count: turns.filter((t) => t.role === "user").length,
      assistant_turn_count: turns.filter((t) => t.role === "assistant").length,
      tool_turn_count: turns.filter((t) => t.role === "tool").length,
      token_total: turns.reduce((a, t) => a + t.token_estimate, 0),
      tool_call_count: turns.filter((t) => t.role === "tool").length,
      files_touched: [],
      skills_invoked: [],
      entities_mentioned: [],
      enriched_at: null,
      enrichment_model: null,
      status: "active",
      full_text: turns.map((t) => t.text).join("\n"),
      jsonl_path,
      jsonl_bytes,
      jsonl_sha256,
    };

    await step.run("index-run", async () => {
      const res = await typesenseRequest(
        `/collections/${RUNS_COLLECTION}/documents/import?action=upsert`,
        {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify(run),
        }
      );
      if (!res.ok) {
        throw new Error(`run import failed: ${res.status} ${await res.text()}`);
      }
    });

    const duration_ms = performance.now() - t0;

    await step.run("emit-otel", async () => {
      emitOtelEvent("memory.run.captured", {
        run_id,
        user_id,
        machine_id,
        agent_runtime,
        chunk_count: chunks.length,
        chunk_errors: chunkImport.errors,
        turn_count: turns.length,
        duration_ms: Math.round(duration_ms),
        format,
      });
    });

    await step.sendEvent("emit-indexed", {
      name: "memory/run.indexed",
      data: {
        run_id,
        user_id,
        chunk_count: chunks.length,
        index_duration_ms: Math.round(duration_ms),
      },
    });

    return {
      run_id,
      chunks_indexed: chunkImport.imported,
      chunk_errors: chunkImport.errors,
      turn_count: turns.length,
      duration_ms,
    };
  }
);
