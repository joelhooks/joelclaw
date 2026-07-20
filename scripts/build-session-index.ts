#!/usr/bin/env bun
/**
 * Build the compacted SQLite FTS5 session index from the proven Run manifest.
 *
 * The Run store is immutable input. The builder writes a new database beside
 * the target, verifies every kept blob against the manifest, then renames the
 * completed database into place.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Database } from "bun:sqlite";
import {
  chunkTurns,
  detectFormat,
  extractTurns,
  parseJsonl,
} from "../packages/memory/src/chunking";

interface ManifestRecord {
  run_id: string;
  user_id: string;
  machine_id: string;
  agent_runtime: string;
  conversation_id: string | null;
  parent_run_id: string | null;
  source_identity: string;
  prefix_group_identity: string;
  jsonl_bytes: number;
  jsonl_sha256: string;
  verdict: "exact_duplicate" | "strict_prefix" | "unique_tail" | "divergent_sibling";
  keep: boolean;
  started_at: number;
  captured_at: number;
  jsonl_path: string;
  covering_run_id?: string;
}

interface Args {
  manifest: string;
  runStore: string;
  output: string;
  force: boolean;
  limit: number;
}

function usage(): never {
  console.error(
    `Usage: bun scripts/build-session-index.ts [options]\n\nOptions:\n  --manifest <path>   Manifest JSONL\n  --run-store <path>  Immutable Run store root\n  --output <path>     SQLite target (default: ~/.joelclaw/search/sessions.db)\n  --limit <n>         Build only first n manifest records for testing\n  --force             Replace an existing output/temp database\n`,
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const base = join(homedir(), ".joelclaw");
  const args: Args = {
    manifest: join(base, "analysis", "run-manifest-2026-07-19.jsonl"),
    runStore: join(base, "runs-dev"),
    output: join(base, "search", "sessions.db"),
    force: false,
    limit: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => argv[++i] ?? usage();
    if (arg === "--manifest") args.manifest = resolve(next());
    else if (arg === "--run-store") args.runStore = resolve(next());
    else if (arg === "--output") args.output = resolve(next());
    else if (arg === "--limit") args.limit = Number(next());
    else if (arg === "--force") args.force = true;
    else if (arg === "--help" || arg === "-h") usage();
    else usage();
  }
  if (!Number.isSafeInteger(args.limit) || args.limit < 0) usage();
  return args;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function createSchema(db: Database): void {
  db.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -262144;
    PRAGMA foreign_keys = ON;

    CREATE TABLE build_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      agent_runtime TEXT NOT NULL,
      conversation_id TEXT,
      parent_run_id TEXT,
      source_identity TEXT NOT NULL,
      prefix_group_identity TEXT NOT NULL,
      verdict TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      captured_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      jsonl_path TEXT NOT NULL,
      jsonl_bytes INTEGER NOT NULL,
      jsonl_sha256 TEXT NOT NULL,
      turn_count INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE skipped_runs (
      run_id TEXT PRIMARY KEY,
      covering_run_id TEXT NOT NULL,
      source_identity TEXT NOT NULL,
      prefix_group_identity TEXT NOT NULL,
      verdict TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      captured_at INTEGER NOT NULL,
      jsonl_path TEXT NOT NULL,
      jsonl_bytes INTEGER NOT NULL,
      jsonl_sha256 TEXT NOT NULL
    ) STRICT;

    CREATE TABLE chunks (
      rowid INTEGER PRIMARY KEY,
      chunk_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      chunk_idx INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      token_count INTEGER NOT NULL,
      UNIQUE(run_id, chunk_idx)
    ) STRICT;

    CREATE VIRTUAL TABLE chunk_fts USING fts5(
      text,
      content='chunks',
      content_rowid='rowid',
      tokenize='unicode61'
    );
  `);
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const temp = `${args.output}.building`;
  if (!existsSync(args.manifest)) throw new Error(`manifest not found: ${args.manifest}`);
  if (!existsSync(args.runStore)) throw new Error(`Run store not found: ${args.runStore}`);
  if ((existsSync(args.output) || existsSync(temp)) && !args.force) {
    throw new Error(`output or temp exists; use --force: ${args.output}`);
  }
  if (args.force) rmSync(temp, { force: true });
  mkdirSync(dirname(args.output), { recursive: true });

  const started = performance.now();
  const db = new Database(temp, { create: true, strict: true });
  createSchema(db);

  const insertRun = db.prepare(`INSERT INTO runs VALUES (
    $run_id, $user_id, $machine_id, $agent_runtime, $conversation_id,
    $parent_run_id, $source_identity, $prefix_group_identity, $verdict,
    $started_at, $captured_at, $ended_at, $jsonl_path, $jsonl_bytes,
    $jsonl_sha256, $turn_count, $chunk_count
  )`);
  const insertSkipped = db.prepare(`INSERT INTO skipped_runs VALUES (
    $run_id, $covering_run_id, $source_identity, $prefix_group_identity,
    $verdict, $started_at, $captured_at, $jsonl_path, $jsonl_bytes, $jsonl_sha256
  )`);
  const insertChunk = db.prepare(`INSERT INTO chunks (
    chunk_id, run_id, chunk_idx, role, text, started_at, token_count
  ) VALUES ($chunk_id, $run_id, $chunk_idx, $role, $text, $started_at, $token_count)`);
  const insertFts = db.prepare("INSERT INTO chunk_fts(rowid, text) VALUES (?, ?)");

  let records = 0;
  let kept = 0;
  let skipped = 0;
  let chunks = 0;
  let bytes = 0;
  let transactionOpen = false;
  const begin = () => {
    if (!transactionOpen) {
      db.exec("BEGIN");
      transactionOpen = true;
    }
  };
  const commit = () => {
    if (transactionOpen) {
      db.exec("COMMIT");
      transactionOpen = false;
    }
  };

  try {
    begin();
    const lines = createInterface({ input: createReadStream(args.manifest), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as ManifestRecord;
      records += 1;
      if (!record.keep) {
        if (!record.covering_run_id)
          throw new Error(`skipped Run lacks covering_run_id: ${record.run_id}`);
        insertSkipped.run({
          run_id: record.run_id,
          covering_run_id: record.covering_run_id,
          source_identity: record.source_identity,
          prefix_group_identity: record.prefix_group_identity,
          verdict: record.verdict,
          started_at: record.started_at,
          captured_at: record.captured_at,
          jsonl_path: record.jsonl_path,
          jsonl_bytes: record.jsonl_bytes,
          jsonl_sha256: record.jsonl_sha256,
        });
        skipped += 1;
      } else {
        const path = join(args.runStore, record.jsonl_path);
        const blob = readFileSync(path);
        if (blob.length !== record.jsonl_bytes) {
          throw new Error(
            `byte mismatch for ${record.run_id}: manifest=${record.jsonl_bytes} disk=${blob.length}`,
          );
        }
        const digest = sha256(blob);
        if (digest !== record.jsonl_sha256) {
          throw new Error(
            `SHA-256 mismatch for ${record.run_id}: manifest=${record.jsonl_sha256} disk=${digest}`,
          );
        }
        const rawEntries = parseJsonl(blob.toString("utf8"));
        const turns = extractTurns(rawEntries, detectFormat(rawEntries));
        const candidates = chunkTurns(turns);
        const endedAt = turns[turns.length - 1]?.started_at ?? record.started_at;
        insertRun.run({
          run_id: record.run_id,
          user_id: record.user_id,
          machine_id: record.machine_id,
          agent_runtime: record.agent_runtime,
          conversation_id: record.conversation_id,
          parent_run_id: record.parent_run_id,
          source_identity: record.source_identity,
          prefix_group_identity: record.prefix_group_identity,
          verdict: record.verdict,
          started_at: record.started_at,
          captured_at: record.captured_at,
          ended_at: endedAt,
          jsonl_path: record.jsonl_path,
          jsonl_bytes: record.jsonl_bytes,
          jsonl_sha256: record.jsonl_sha256,
          turn_count: turns.length,
          chunk_count: candidates.length,
        });
        for (const candidate of candidates) {
          const result = insertChunk.run({
            chunk_id: `${record.run_id}:${candidate.chunk_idx}`,
            run_id: record.run_id,
            chunk_idx: candidate.chunk_idx,
            role: candidate.role,
            text: candidate.text,
            started_at: candidate.started_at,
            token_count: candidate.token_count,
          });
          insertFts.run(result.lastInsertRowid, candidate.text);
        }
        kept += 1;
        chunks += candidates.length;
        bytes += blob.length;
      }

      if (records % 250 === 0) {
        commit();
        begin();
      }
      if (records % 5000 === 0) {
        console.log(
          JSON.stringify({
            phase: "progress",
            records,
            kept,
            skipped,
            chunks,
            bytes,
            elapsed_ms: Math.round(performance.now() - started),
          }),
        );
      }
      if (args.limit > 0 && records >= args.limit) break;
    }
    commit();

    db.exec(`
      CREATE INDEX chunks_run_id_idx ON chunks(run_id);
      CREATE INDEX chunks_started_at_idx ON chunks(started_at DESC);
      CREATE INDEX runs_conversation_id_idx ON runs(conversation_id);
      CREATE INDEX runs_started_at_idx ON runs(started_at DESC);
      CREATE INDEX skipped_covering_run_id_idx ON skipped_runs(covering_run_id);
      PRAGMA optimize;
    `);
    const manifestBytes = readFileSync(args.manifest);
    const metadata = db.prepare("INSERT INTO build_metadata(key, value) VALUES (?, ?)");
    const builtAt = new Date().toISOString();
    db.transaction(() => {
      for (const [key, value] of Object.entries({
        schema_version: "1",
        built_at: builtAt,
        manifest_path: args.manifest,
        manifest_sha256: sha256(manifestBytes),
        run_store: args.runStore,
        parser: "packages/memory/src/chunking.ts",
        records: String(records),
        kept_runs: String(kept),
        skipped_runs: String(skipped),
        chunks: String(chunks),
        indexed_jsonl_bytes: String(bytes),
        complete_manifest: String(args.limit === 0),
      }))
        metadata.run(key, value);
    })();
    const integrity = db.query("PRAGMA integrity_check").get() as Record<string, string>;
    if (!Object.values(integrity).includes("ok"))
      throw new Error(`integrity_check failed: ${JSON.stringify(integrity)}`);
    db.close(false);
    renameSync(temp, args.output);
    console.log(
      JSON.stringify({
        phase: "done",
        output: args.output,
        records,
        kept,
        skipped,
        chunks,
        bytes,
        database_bytes: Bun.file(args.output).size,
        duration_ms: Math.round(performance.now() - started),
        manifest_sha256: sha256(manifestBytes),
        built_at: builtAt,
      }),
    );
  } catch (error) {
    if (transactionOpen) db.exec("ROLLBACK");
    db.close(false);
    throw error;
  }
}

await main();
