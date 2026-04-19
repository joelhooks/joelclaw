#!/usr/bin/env bun
/**
 * Walk ~/.claude/projects/ and ~/.pi/agent/sessions/ and ingest every jsonl file
 * into run_chunks_spike. Dedupes by sha256 via a local manifest so re-runs are safe.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, relative } from "node:path";
import { Glob } from "bun";
import {
  type Chunk,
  chunkTurns,
  detectFormat,
  embeddingModelTag,
  embedMany,
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
const EMBED_CONCURRENCY = 8;
const MANIFEST_DIR = `${homedir()}/.joelclaw`;
const MANIFEST_PATH = `${MANIFEST_DIR}/memory-spike-ingested.jsonl`;

interface ManifestEntry {
  jsonl_sha256: string;
  run_id: string;
  jsonl_path: string;
  chunks: number;
  ingested_at: string;
}

function loadManifest(): Map<string, ManifestEntry> {
  const map = new Map<string, ManifestEntry>();
  if (!existsSync(MANIFEST_PATH)) return map;
  for (const line of readFileSync(MANIFEST_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as ManifestEntry;
      map.set(entry.jsonl_sha256, entry);
    } catch {
      // ignore malformed lines
    }
  }
  return map;
}

function appendManifest(entry: ManifestEntry) {
  mkdirSync(MANIFEST_DIR, { recursive: true });
  const line = `${JSON.stringify(entry)}\n`;
  if (existsSync(MANIFEST_PATH)) {
    const current = readFileSync(MANIFEST_PATH, "utf8");
    writeFileSync(MANIFEST_PATH, current + line);
  } else {
    writeFileSync(MANIFEST_PATH, line);
  }
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
    throw new Error(`typesense status ${existing.status}: ${body}`);
  }
  const schema = runChunksSchema(RUN_CHUNKS_COLLECTION, EMBED_DIMS);
  const res = await typesenseRequest("/collections", {
    method: "POST",
    body: JSON.stringify(schema),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`typesense create collection failed: ${res.status} ${body}`);
  }
  console.log(`✓ created collection ${RUN_CHUNKS_COLLECTION}`);
}

function newRunId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 26);
}

function inferRuntime(path: string): "pi" | "claude-code" {
  return path.includes("/.pi/") ? "pi" : "claude-code";
}

async function findSessions(): Promise<string[]> {
  const paths: string[] = [];
  const claudeGlob = new Glob("**/*.jsonl");
  for await (const p of claudeGlob.scan({
    cwd: `${homedir()}/.claude/projects`,
    absolute: true,
  })) {
    paths.push(p);
  }
  const piGlob = new Glob("**/*.jsonl");
  for await (const p of piGlob.scan({
    cwd: `${homedir()}/.pi/agent/sessions`,
    absolute: true,
  })) {
    paths.push(p);
  }
  return paths;
}

interface IngestOutcome {
  path: string;
  status: "ingested" | "skipped-dupe" | "skipped-empty" | "error";
  chunks?: number;
  duration_ms?: number;
  error?: string;
}

async function ingestOne(
  path: string,
  manifest: Map<string, ManifestEntry>
): Promise<IngestOutcome> {
  const t0 = performance.now();
  const raw = readFileSync(path, "utf8");
  const stat = statSync(path);
  const sha = createHash("sha256").update(raw).digest("hex");

  if (manifest.has(sha)) {
    return { path, status: "skipped-dupe" };
  }

  const entries = parseJsonl(raw);
  const format = detectFormat(entries);
  const turns = extractTurns(entries, format);
  const candidates = chunkTurns(turns);

  if (candidates.length === 0) {
    return { path, status: "skipped-empty" };
  }

  const runId = newRunId();
  const modelTag = embeddingModelTag();
  const runtime = inferRuntime(path);

  const texts = candidates.map((c) => c.text);
  const embeds = await embedMany(texts, {
    dimensions: EMBED_DIMS,
    concurrency: EMBED_CONCURRENCY,
  });

  const chunks: Chunk[] = candidates.map((cand, i) => ({
    id: `${runId}:${cand.chunk_idx}`,
    run_id: runId,
    chunk_idx: cand.chunk_idx,
    role: cand.role,
    text: cand.text,
    embedding: embeds[i]!.embedding,
    embedding_model: modelTag,
    token_count: cand.token_count,
    started_at: cand.started_at,
    user_id: SPIKE_USER_ID,
    readable_by: [SPIKE_USER_ID],
    root_run_id: null,
    agent_runtime: runtime,
    conversation_id: null,
    tags: ["spike", `runtime:${runtime}`],
    machine_id: SPIKE_MACHINE_ID,
  }));

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
    const body = await res.text();
    return { path, status: "error", error: `typesense ${res.status}: ${body.slice(0, 300)}` };
  }
  const importBody = await res.text();
  const errors = importBody
    .trim()
    .split("\n")
    .filter((l) => {
      try {
        return (JSON.parse(l) as { success?: boolean }).success === false;
      } catch {
        return true;
      }
    });
  if (errors.length > 0) {
    return {
      path,
      status: "error",
      error: `${errors.length}/${chunks.length} chunks failed: ${errors[0]!.slice(0, 200)}`,
    };
  }

  const duration_ms = performance.now() - t0;
  appendManifest({
    jsonl_sha256: sha,
    run_id: runId,
    jsonl_path: path,
    chunks: chunks.length,
    ingested_at: new Date().toISOString(),
  });

  void stat;
  return {
    path,
    status: "ingested",
    chunks: chunks.length,
    duration_ms,
  };
}

async function main() {
  await ensureCollection();
  const manifest = loadManifest();
  const paths = await findSessions();
  console.log(
    `found ${paths.length} jsonl files; manifest has ${manifest.size} already ingested`
  );
  console.log("");

  const t0 = performance.now();
  let ingested = 0;
  let skipped = 0;
  let errors = 0;
  let totalChunks = 0;

  for (let i = 0; i < paths.length; i++) {
    const p = paths[i]!;
    const rel = relative(homedir(), p);
    try {
      const outcome = await ingestOne(p, manifest);
      if (outcome.status === "ingested") {
        ingested += 1;
        totalChunks += outcome.chunks ?? 0;
        const rate = totalChunks / ((performance.now() - t0) / 1000);
        console.log(
          `[${i + 1}/${paths.length}] ✓ ${outcome.chunks} chunks in ${(
            outcome.duration_ms! / 1000
          ).toFixed(1)}s  (running ${rate.toFixed(1)} ch/s)  ~/${rel}`
        );
      } else if (outcome.status === "skipped-dupe") {
        skipped += 1;
        console.log(`[${i + 1}/${paths.length}] = dupe  ~/${rel}`);
      } else if (outcome.status === "skipped-empty") {
        skipped += 1;
        console.log(`[${i + 1}/${paths.length}] = empty ~/${rel}`);
      } else {
        errors += 1;
        console.log(`[${i + 1}/${paths.length}] ✗ ${outcome.error}  ~/${rel}`);
      }
    } catch (err) {
      errors += 1;
      console.log(
        `[${i + 1}/${paths.length}] ✗ ${(err as Error).message}  ~/${rel}`
      );
    }
  }

  const totalSec = (performance.now() - t0) / 1000;
  console.log("");
  console.log("=".repeat(60));
  console.log(`done: ${ingested} ingested, ${skipped} skipped, ${errors} errors`);
  console.log(
    `total: ${totalChunks} chunks in ${totalSec.toFixed(0)}s (${(
      totalChunks / totalSec
    ).toFixed(1)} ch/s)`
  );
  console.log(`manifest: ${MANIFEST_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// suppress unused lint
void basename;
void dirname;
