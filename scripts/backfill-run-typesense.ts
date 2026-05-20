#!/usr/bin/env bun
/**
 * Backfill ADR-0243 Run blobs into the derived Typesense indexes.
 *
 * Source of truth is ~/.joelclaw/runs-dev/<user>/<yyyy-mm>/*.metadata.json +
 * *.jsonl. Typesense `runs_dev` / `run_chunks_dev` are rebuildable indexes.
 * Use this when memory/run.captured was accepted but the derived index wedged.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { embed } from "../packages/inference-router/src/embeddings";
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
} from "../packages/memory/src/index";

const TYPESENSE_URL = process.env.TYPESENSE_URL ?? "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY;
const EMBED_DIMS = 768;

interface Args {
  user: string;
  month: string;
  since: number;
  until: number;
  machine?: string;
  runtime?: string;
  limit: number;
  dryRun: boolean;
  sleepMs: number;
}

interface RunMetadata {
  run_id?: string;
  user_id?: string;
  machine_id?: string;
  agent_runtime?: Run["agent_runtime"];
  parent_run_id?: string | null;
  conversation_id?: string | null;
  tags?: string[];
  started_at?: number;
  captured_at?: number;
  jsonl_path?: string;
}

function usage(): never {
  console.error(`Usage: TYPESENSE_API_KEY=... bun scripts/backfill-run-typesense.ts [options]\n\nOptions:\n  --user <id>           User partition (default: joel)\n  --month <yyyy-mm>     Run store month (default: current UTC month)\n  --since <iso|ms>      Include runs at/after this start time\n  --until <iso|ms>      Include runs before this start time (default: now)\n  --machine <id>        Filter machine_id\n  --runtime <runtime>   Filter agent_runtime\n  --limit <n>           Max missing runs to index; 0 = all (default: 100)\n  --sleep-ms <n>        Delay after each run to avoid starving live embeds (default: 100)\n  --dry-run             Print planned work only\n`);
  process.exit(2);
}

function parseTime(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`invalid timestamp: ${value}`);
  return parsed;
}

function defaultMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    user: "joel",
    month: defaultMonth(),
    since: 0,
    until: Date.now() + 1,
    limit: 100,
    dryRun: false,
    sleepMs: 100,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => argv[++i] ?? usage();
    if (arg === "--user") args.user = next();
    else if (arg === "--month") args.month = next();
    else if (arg === "--since") args.since = parseTime(next(), args.since);
    else if (arg === "--until") args.until = parseTime(next(), args.until);
    else if (arg === "--machine") args.machine = next();
    else if (arg === "--runtime") args.runtime = next();
    else if (arg === "--limit") args.limit = Number(next());
    else if (arg === "--sleep-ms") args.sleepMs = Number(next());
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") usage();
    else usage();
  }

  if (!Number.isFinite(args.limit) || args.limit < 0) usage();
  if (!Number.isFinite(args.sleepMs) || args.sleepMs < 0) usage();
  return args;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function typesenseRequest(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  if (!TYPESENSE_API_KEY) throw new Error("TYPESENSE_API_KEY not set");
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
      throw new Error(`typesense status ${existing.status} for ${name}: ${await existing.text()}`);
    }
    const res = await typesenseRequest("/collections", {
      method: "POST",
      body: JSON.stringify(schema),
    });
    if (!res.ok) throw new Error(`create ${name} failed: ${res.status} ${await res.text()}`);
  }
}

async function loadExistingRunIds(): Promise<Set<string>> {
  const res = await typesenseRequest(`/collections/${RUNS_COLLECTION}/documents/export?include_fields=id`);
  if (!res.ok) throw new Error(`export ${RUNS_COLLECTION} failed: ${res.status} ${await res.text()}`);
  const ids = new Set<string>();
  for (const line of (await res.text()).split("\n")) {
    if (!line.trim()) continue;
    try {
      const doc = JSON.parse(line) as { id?: string };
      if (doc.id) ids.add(doc.id);
    } catch {
      // ignore malformed export lines
    }
  }
  return ids;
}

function runStoreDir(user: string, month: string): string {
  return join(process.env.MEMORY_RUN_STORE ?? join(homedir(), ".joelclaw", "runs-dev"), user, month);
}

function loadCandidates(args: Args, existingIds: Set<string>): Array<{ metadata: RunMetadata; metadataPath: string; jsonlPath: string }> {
  const dir = runStoreDir(args.user, args.month);
  if (!existsSync(dir)) throw new Error(`run store directory not found: ${dir}`);

  const candidates: Array<{ metadata: RunMetadata; metadataPath: string; jsonlPath: string }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".metadata.json")) continue;
    const metadataPath = join(dir, name);
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as RunMetadata;
    const runId = metadata.run_id ?? name.replace(/\.metadata\.json$/, "");
    if (existingIds.has(runId)) continue;

    const startedAt = Number(metadata.started_at ?? 0);
    if (startedAt < args.since || startedAt >= args.until) continue;
    if (args.machine && metadata.machine_id !== args.machine) continue;
    if (args.runtime && metadata.agent_runtime !== args.runtime) continue;

    const jsonlPath = metadata.jsonl_path ?? join(dir, `${runId}.jsonl`);
    if (!existsSync(jsonlPath)) continue;
    candidates.push({ metadata: { ...metadata, run_id: runId }, metadataPath, jsonlPath });
  }

  candidates.sort((a, b) => Number(a.metadata.started_at ?? 0) - Number(b.metadata.started_at ?? 0));
  return args.limit === 0 ? candidates : candidates.slice(0, args.limit);
}

async function importNdjson(collection: string, docs: unknown[]): Promise<void> {
  if (docs.length === 0) return;
  const res = await typesenseRequest(`/collections/${collection}/documents/import?action=upsert`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: docs.map((doc) => JSON.stringify(doc)).join("\n"),
  });
  if (!res.ok) throw new Error(`${collection} import failed: ${res.status} ${await res.text()}`);
  const body = await res.text();
  const failures = body
    .split("\n")
    .filter((line) => line.trim())
    .filter((line) => {
      try {
        return (JSON.parse(line) as { success?: boolean }).success === false;
      } catch {
        return true;
      }
    });
  if (failures.length > 0) {
    throw new Error(`${collection} import had ${failures.length}/${docs.length} failures: ${failures[0]!.slice(0, 300)}`);
  }
}

async function indexRun(entry: { metadata: RunMetadata; jsonlPath: string }): Promise<{ chunks: number; bytes: number }> {
  const metadata = entry.metadata;
  const runId = metadata.run_id!;
  const userId = metadata.user_id ?? "joel";
  const machineId = metadata.machine_id ?? "unknown";
  const agentRuntime = metadata.agent_runtime ?? "other";
  const startedAt = Number(metadata.started_at ?? statSync(entry.jsonlPath).mtimeMs);
  const jsonl = readFileSync(entry.jsonlPath, "utf8");
  const jsonlBytes = Buffer.byteLength(jsonl, "utf8");
  const jsonlSha256 = createHash("sha256").update(jsonl).digest("hex");

  const entries = parseJsonl(jsonl);
  const format = detectFormat(entries);
  const turns = extractTurns(entries, format);
  const candidates = chunkTurns(turns);

  const modelTag = embeddingModelTag();
  const chunks: Chunk[] = [];
  for (const cand of candidates) {
    const result = await embed(cand.text, {
      priority: "ingest-bulk",
      dimensions: EMBED_DIMS,
    });
    chunks.push({
      id: `${runId}:${cand.chunk_idx}`,
      run_id: runId,
      chunk_idx: cand.chunk_idx,
      role: cand.role,
      text: cand.text,
      embedding: result.embedding,
      embedding_model: modelTag,
      token_count: cand.token_count,
      started_at: cand.started_at,
      user_id: userId,
      readable_by: [userId],
      root_run_id: metadata.parent_run_id ?? null,
      agent_runtime: agentRuntime,
      conversation_id: metadata.conversation_id ?? null,
      tags: metadata.tags ?? [],
      machine_id: machineId,
    });
  }

  await importNdjson(RUN_CHUNKS_COLLECTION, chunks);

  const run: Partial<Run> & { id: string } = {
    id: runId,
    user_id: userId,
    machine_id: machineId,
    agent_runtime: agentRuntime,
    agent_version: "",
    model: "",
    parent_run_id: metadata.parent_run_id ?? null,
    root_run_id: metadata.parent_run_id ?? null,
    conversation_id: metadata.conversation_id ?? null,
    tags: metadata.tags ?? [],
    readable_by: [userId],
    intent: turns.find((turn) => turn.role === "user")?.text.slice(0, 500) ?? "",
    started_at: startedAt,
    ended_at: turns[turns.length - 1]?.started_at ?? startedAt,
    duration_ms: (turns[turns.length - 1]?.started_at ?? startedAt) - startedAt,
    turn_count: turns.length,
    user_turn_count: turns.filter((turn) => turn.role === "user").length,
    assistant_turn_count: turns.filter((turn) => turn.role === "assistant").length,
    tool_turn_count: turns.filter((turn) => turn.role === "tool").length,
    token_total: turns.reduce((sum, turn) => sum + turn.token_estimate, 0),
    tool_call_count: turns.filter((turn) => turn.role === "tool").length,
    files_touched: [],
    skills_invoked: [],
    entities_mentioned: [],
    enriched_at: null,
    enrichment_model: null,
    status: "active",
    full_text: turns.map((turn) => turn.text).join("\n"),
    jsonl_path: entry.jsonlPath,
    jsonl_bytes: jsonlBytes,
    jsonl_sha256: jsonlSha256,
  };

  await importNdjson(RUNS_COLLECTION, [run]);
  return { chunks: chunks.length, bytes: jsonlBytes };
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  await ensureCollections();
  const existingIds = await loadExistingRunIds();
  const candidates = loadCandidates(args, existingIds);
  console.log(JSON.stringify({ phase: "plan", candidates: candidates.length, args }));

  if (args.dryRun) {
    for (const c of candidates.slice(0, 20)) {
      console.log(JSON.stringify({ run_id: c.metadata.run_id, started_at: new Date(Number(c.metadata.started_at ?? 0)).toISOString(), machine_id: c.metadata.machine_id, agent_runtime: c.metadata.agent_runtime, jsonl_path: c.jsonlPath }));
    }
    return;
  }

  let indexed = 0;
  let chunks = 0;
  let errors = 0;
  const t0 = performance.now();
  for (const candidate of candidates) {
    const started = performance.now();
    try {
      const result = await indexRun(candidate);
      indexed += 1;
      chunks += result.chunks;
      console.log(JSON.stringify({ phase: "indexed", run_id: candidate.metadata.run_id, machine_id: candidate.metadata.machine_id, chunks: result.chunks, bytes: result.bytes, duration_ms: Math.round(performance.now() - started) }));
    } catch (err) {
      errors += 1;
      console.error(JSON.stringify({ phase: "error", run_id: candidate.metadata.run_id, error: String(err) }));
    }
    if (args.sleepMs > 0) await sleep(args.sleepMs);
  }

  console.log(JSON.stringify({ phase: "done", indexed, chunks, errors, duration_ms: Math.round(performance.now() - t0) }));
  if (errors > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
