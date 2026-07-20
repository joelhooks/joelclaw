#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { appendSessionCapture } from "../packages/memory/src/session-index";

interface CaptureMetadata {
  run_id: string;
  user_id?: string;
  machine_id?: string;
  agent_runtime?: string;
  conversation_id?: string | null;
  parent_run_id?: string | null;
  source_identity?: string | null;
  from_offset?: number | null;
  to_offset?: number | null;
  tags?: string[];
  started_at?: number;
  captured_at?: number;
  jsonl_path?: string;
  jsonl_sha256?: string | null;
}

interface Args {
  database: string;
  runStore: string;
  apply: boolean;
}

function usage(): never {
  console.error(
    "Usage: bun scripts/backfill-session-index.ts [--db <sessions.db>] [--run-store <runs-dev>] [--apply]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const base = join(homedir(), ".joelclaw");
  const args: Args = {
    database: join(base, "search", "sessions.db"),
    runStore: join(base, "runs-dev"),
    apply: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = () => argv[++index] ?? usage();
    if (arg === "--db") args.database = resolve(next());
    else if (arg === "--run-store") args.runStore = resolve(next());
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--help" || arg === "-h") usage();
    else usage();
  }
  return args;
}

function metadataPaths(root: string): string[] {
  const paths: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".metadata.json")) paths.push(path);
    }
  };
  visit(root);
  return paths;
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const args = parseArgs(Bun.argv.slice(2));
for (const path of [args.database, args.runStore]) {
  if (!existsSync(path)) throw new Error(`required path not found: ${path}`);
}

const db = new Database(args.database, { readwrite: true, strict: true });
const existing = new Set(
  (
    db.query("SELECT run_id FROM runs UNION ALL SELECT run_id FROM skipped_runs").all() as Array<{
      run_id: string;
    }>
  ).map((row) => row.run_id),
);
db.close(false);

const pending = metadataPaths(args.runStore)
  .map((metadataPath) => ({
    metadataPath,
    metadata: JSON.parse(readFileSync(metadataPath, "utf8")) as CaptureMetadata,
  }))
  .filter(({ metadata }) => metadata.run_id && !existing.has(metadata.run_id))
  .sort((left, right) => (left.metadata.captured_at ?? 0) - (right.metadata.captured_at ?? 0));

let appended = 0;
let chunks = 0;
let bytes = 0;
let latestCapturedAt = 0;
for (const { metadataPath, metadata } of pending) {
  const siblingPath = metadataPath.replace(/\.metadata\.json$/u, ".jsonl");
  const storedPath = metadata.jsonl_path;
  const capturePath = storedPath
    ? isAbsolute(storedPath)
      ? storedPath
      : join(args.runStore, storedPath)
    : siblingPath;
  if (!existsSync(capturePath)) throw new Error(`capture missing for ${metadata.run_id}: ${capturePath}`);
  const jsonlBytes = statSync(capturePath).size;
  bytes += jsonlBytes;
  latestCapturedAt = Math.max(latestCapturedAt, metadata.captured_at ?? 0);
  if (!args.apply) continue;

  const result = appendSessionCapture({
    databasePath: args.database,
    capturePath,
    runId: metadata.run_id,
    userId: metadata.user_id ?? "unknown",
    machineId: metadata.machine_id ?? "unknown",
    agentRuntime: metadata.agent_runtime ?? "other",
    conversationId: metadata.conversation_id ?? undefined,
    parentRunId: metadata.parent_run_id ?? undefined,
    sourceIdentity: metadata.source_identity ?? undefined,
    fromOffset: metadata.from_offset ?? undefined,
    toOffset: metadata.to_offset ?? undefined,
    tags: metadata.tags ?? [],
    startedAt: metadata.started_at ?? metadata.captured_at ?? 0,
    capturedAt: metadata.captured_at ?? Date.now(),
    jsonlPath: storedPath ?? capturePath,
    jsonlBytes,
    jsonlSha256: metadata.jsonl_sha256 ?? digest(capturePath),
  });
  if (result.status === "appended") appended += 1;
  chunks += result.chunk_count;
}

console.log(
  JSON.stringify({
    ok: true,
    mode: args.apply ? "apply" : "dry-run",
    database: args.database,
    run_store: args.runStore,
    pending_runs: pending.length,
    appended_runs: appended,
    chunks,
    jsonl_bytes: bytes,
    latest_captured_at: latestCapturedAt || null,
  }),
);
