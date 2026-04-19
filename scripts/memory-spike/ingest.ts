#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import {
  type Chunk,
  chunkTurns,
  embed,
  embeddingModelTag,
  extractTurns,
  parseJsonl,
  RUN_CHUNKS_COLLECTION,
  runChunksSchema,
} from "../../packages/memory/src/index";

const TYPESENSE_URL = process.env.TYPESENSE_URL ?? "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY;
if (!TYPESENSE_API_KEY) {
  console.error("TYPESENSE_API_KEY not set; aborting.");
  process.exit(1);
}

const SPIKE_USER_ID = "joel";
const SPIKE_MACHINE_ID = "panda";
const EMBED_DIMS = 768;

interface TypesenseError {
  message?: string;
}

async function typesenseRequest(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(`${TYPESENSE_URL}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      "X-TYPESENSE-API-KEY": TYPESENSE_API_KEY!,
      "Content-Type": "application/json",
    },
  });
}

async function ensureCollection() {
  const existing = await typesenseRequest(
    `/collections/${RUN_CHUNKS_COLLECTION}`
  );
  if (existing.status === 200) return;
  if (existing.status !== 404) {
    const body = await existing.text();
    throw new Error(`typesense unexpected status ${existing.status}: ${body}`);
  }

  const schema = runChunksSchema(RUN_CHUNKS_COLLECTION, EMBED_DIMS);
  const res = await typesenseRequest("/collections", {
    method: "POST",
    body: JSON.stringify(schema),
  });
  if (!res.ok) {
    const err = (await res.json()) as TypesenseError;
    throw new Error(
      `typesense create collection failed: ${res.status} ${err.message ?? ""}`
    );
  }
  console.log(`✓ created collection ${RUN_CHUNKS_COLLECTION}`);
}

function newUlid(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 26);
}

async function main() {
  const jsonlPath = process.argv[2];
  if (!jsonlPath) {
    console.error("usage: bun scripts/memory-spike/ingest.ts <path-to-jsonl>");
    process.exit(1);
  }

  console.log(`reading ${jsonlPath}`);
  const raw = readFileSync(jsonlPath, "utf8");
  const stat = statSync(jsonlPath);
  const sha = createHash("sha256").update(raw).digest("hex");

  await ensureCollection();

  const runId = newUlid();
  console.log(`run_id = ${runId}`);

  const entries = parseJsonl(raw);
  const turns = extractTurns(entries);
  const candidates = chunkTurns(turns);

  console.log(
    `parsed ${entries.length} jsonl entries → ${turns.length} turns → ${candidates.length} chunks`
  );

  const modelTag = embeddingModelTag();
  const ts0 = performance.now();

  const chunks: Chunk[] = [];
  for (const cand of candidates) {
    const t0 = performance.now();
    const res = await embed(cand.text, { dimensions: EMBED_DIMS });
    const t1 = performance.now();
    const chunk: Chunk = {
      id: `${runId}:${cand.chunk_idx}`,
      run_id: runId,
      chunk_idx: cand.chunk_idx,
      role: cand.role,
      text: cand.text,
      embedding: res.embedding,
      embedding_model: modelTag,
      token_count: cand.token_count,
      started_at: cand.started_at,
      user_id: SPIKE_USER_ID,
      readable_by: [SPIKE_USER_ID],
      root_run_id: null,
      agent_runtime: "claude-code",
      conversation_id: null,
      tags: ["spike"],
      machine_id: SPIKE_MACHINE_ID,
    };
    chunks.push(chunk);
    if (chunks.length % 10 === 0 || chunks.length === candidates.length) {
      const rate = chunks.length / ((performance.now() - ts0) / 1000);
      console.log(
        `  embed ${chunks.length}/${candidates.length}  last=${(t1 - t0).toFixed(
          0
        )}ms  rate=${rate.toFixed(1)}/s`
      );
    }
  }
  const tsEmbed = performance.now();
  console.log(
    `✓ embedded ${chunks.length} chunks in ${((tsEmbed - ts0) / 1000).toFixed(
      1
    )}s`
  );

  const ndjson = chunks.map((c) => JSON.stringify(c)).join("\n");
  const importRes = await typesenseRequest(
    `/collections/${RUN_CHUNKS_COLLECTION}/documents/import?action=upsert`,
    {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: ndjson,
    }
  );
  if (!importRes.ok) {
    const body = await importRes.text();
    throw new Error(`typesense import failed: ${importRes.status} ${body}`);
  }
  const importResults = await importRes.text();
  const importLines = importResults.trim().split("\n");
  const errors = importLines.filter((l) => {
    try {
      const parsed = JSON.parse(l) as { success?: boolean };
      return parsed.success === false;
    } catch {
      return true;
    }
  });
  const tsIndex = performance.now();
  console.log(
    `✓ indexed ${chunks.length - errors.length}/${chunks.length} chunks in ${(
      (tsIndex - tsEmbed) /
      1000
    ).toFixed(2)}s (errors: ${errors.length})`
  );
  if (errors.length) {
    console.log("  first error:", errors[0]);
  }

  const totalSec = (tsIndex - ts0) / 1000;
  console.log("");
  console.log(
    `summary: ${chunks.length} chunks, ${totalSec.toFixed(
      1
    )}s total, ${(chunks.length / totalSec).toFixed(1)} chunks/s`
  );
  console.log("");
  console.log("run metadata:");
  console.log(
    JSON.stringify(
      {
        run_id: runId,
        user_id: SPIKE_USER_ID,
        machine_id: SPIKE_MACHINE_ID,
        agent_runtime: "claude-code",
        turn_count: turns.length,
        user_turn_count: turns.filter((t) => t.role === "user").length,
        assistant_turn_count: turns.filter((t) => t.role === "assistant")
          .length,
        tool_turn_count: turns.filter((t) => t.role === "tool").length,
        token_total: turns.reduce((a, t) => a + t.token_estimate, 0),
        jsonl_path: jsonlPath,
        jsonl_basename: basename(jsonlPath),
        jsonl_bytes: stat.size,
        jsonl_sha256: sha,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
