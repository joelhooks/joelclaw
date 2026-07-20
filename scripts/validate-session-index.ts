#!/usr/bin/env bun
/** Validate the compacted SQLite session index without mutating its inputs. */
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Database } from "bun:sqlite";
import { chunkTurns, extractTurns, parseJsonl } from "../packages/memory/src/chunking";

interface ManifestRecord {
  run_id: string;
  keep: boolean;
  started_at: number;
  captured_at: number;
  jsonl_path: string;
  jsonl_bytes: number;
  jsonl_sha256: string;
}

interface Args {
  db: string;
  manifest: string;
  runStore: string;
  samples: number;
  queries: string[];
  probe: boolean;
}

const DEFAULT_QUERIES = ["Typesense Reboot Recovery", "run_chunks_dev", "ShitRat"];

function usage(): never {
  console.error(
    `Usage: bun scripts/validate-session-index.ts [options]\n\nOptions:\n  --db <path>          Session SQLite database\n  --manifest <path>    Manifest JSONL\n  --run-store <path>   Immutable Run store root\n  --samples <n>        Deterministic raw samples (default: 25)\n  --query <text>       Add an FTS/parity query\n`,
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const base = join(homedir(), ".joelclaw");
  const args: Args = {
    db: join(base, "search", "sessions.db"),
    manifest: join(base, "analysis", "run-manifest-2026-07-19.jsonl"),
    runStore: join(base, "runs-dev"),
    samples: 25,
    queries: [],
    probe: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => argv[++i] ?? usage();
    if (arg === "--db") args.db = resolve(next());
    else if (arg === "--manifest") args.manifest = resolve(next());
    else if (arg === "--run-store") args.runStore = resolve(next());
    else if (arg === "--samples") args.samples = Number(next());
    else if (arg === "--query") args.queries.push(next());
    else if (arg === "--probe") args.probe = true;
    else if (arg === "--help" || arg === "-h") usage();
    else usage();
  }
  if (!Number.isSafeInteger(args.samples) || args.samples < 1) usage();
  if (args.queries.length === 0) args.queries = DEFAULT_QUERIES;
  return args;
}

function ftsExpression(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" AND ");
}

function openReadOnly(path: string): Database {
  return new Database(path, { readonly: true, strict: true });
}

function querySqlite(
  db: Database,
  query: string,
  limit = 10,
): Array<{ run_id: string; chunk_idx: number; text: string }> {
  return db
    .query(`
    SELECT c.run_id, c.chunk_idx, c.text
    FROM chunk_fts f
    JOIN chunks c ON c.rowid = f.rowid
    WHERE chunk_fts MATCH $query
    ORDER BY bm25(chunk_fts), c.started_at DESC
    LIMIT $limit
  `)
    .all({ query: ftsExpression(query), limit }) as Array<{
    run_id: string;
    chunk_idx: number;
    text: string;
  }>;
}

function runProbe(args: Args): never {
  const processStart = performance.now();
  const openStart = performance.now();
  const db = openReadOnly(args.db);
  const opened = performance.now();
  const rows = querySqlite(db, args.queries[0]!, 1);
  const queried = performance.now();
  db.close(false);
  if (rows.length === 0) throw new Error(`probe query had no result: ${args.queries[0]}`);
  console.log(
    JSON.stringify({
      ok: true,
      query: args.queries[0],
      open_ms: opened - openStart,
      first_query_ms: queried - opened,
      process_to_first_query_ms: queried - processStart,
      run_id: rows[0]!.run_id,
    }),
  );
  process.exit(0);
}

// Fixed-seed generator keeps the validation sample reproducible.
function randomFactory(): () => number {
  let state = 0x5e55104;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

async function scanManifest(
  path: string,
  sampleCount: number,
): Promise<{
  samples: ManifestRecord[];
  kept: number;
  skipped: number;
  latestStarted: ManifestRecord;
  latestCaptured: ManifestRecord;
}> {
  const samples: ManifestRecord[] = [];
  const random = randomFactory();
  let kept = 0;
  let skipped = 0;
  let latestStarted: ManifestRecord | undefined;
  let latestCaptured: ManifestRecord | undefined;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as ManifestRecord;
    if (!record.keep) {
      skipped += 1;
      continue;
    }
    kept += 1;
    if (!latestStarted || record.started_at > latestStarted.started_at) latestStarted = record;
    if (!latestCaptured || record.captured_at > latestCaptured.captured_at) latestCaptured = record;
    if (samples.length < sampleCount) samples.push(record);
    else {
      const index = Math.floor(random() * kept);
      if (index < sampleCount) samples[index] = record;
    }
  }
  if (!latestStarted || !latestCaptured) throw new Error("manifest has no kept Runs");
  return { samples, kept, skipped, latestStarted, latestCaptured };
}

async function typesenseHealth(): Promise<{ green: boolean; status: number | null; body: string }> {
  try {
    const response = await fetch(`${process.env.TYPESENSE_URL ?? "http://localhost:8108"}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.text();
    let ok = false;
    try {
      ok = (JSON.parse(body) as { ok?: boolean }).ok === true;
    } catch {
      /* body is recorded below */
    }
    return { green: response.ok && ok, status: response.status, body: body.slice(0, 200) };
  } catch (error) {
    return { green: false, status: null, body: String(error) };
  }
}

async function typesenseQuery(query: string): Promise<Set<string>> {
  const key = process.env.TYPESENSE_API_KEY;
  if (!key) throw new Error("TYPESENSE_API_KEY is required when Typesense health is green");
  const base = process.env.TYPESENSE_URL ?? "http://localhost:8108";
  const params = new URLSearchParams({
    q: query,
    query_by: "text",
    per_page: "25",
    include_fields: "run_id",
  });
  const response = await fetch(`${base}/collections/run_chunks_dev/documents/search?${params}`, {
    headers: { "X-TYPESENSE-API-KEY": key },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(
      `Typesense query failed: ${response.status} ${(await response.text()).slice(0, 200)}`,
    );
  const body = (await response.json()) as { hits?: Array<{ document?: { run_id?: string } }> };
  return new Set(
    (body.hits ?? []).map((hit) => hit.document?.run_id).filter((id): id is string => Boolean(id)),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  if (args.probe) runProbe(args);
  for (const path of [args.db, args.manifest, args.runStore]) {
    if (!existsSync(path)) throw new Error(`required path not found: ${path}`);
  }

  const failures: string[] = [];
  const db = openReadOnly(args.db);
  const integrity = db.query("PRAGMA integrity_check").get() as Record<string, string>;
  if (!Object.values(integrity).includes("ok"))
    failures.push(`integrity_check: ${JSON.stringify(integrity)}`);

  const manifest = await scanManifest(args.manifest, args.samples);
  const counts = db
    .query(`SELECT
    (SELECT count(*) FROM runs) AS runs,
    (SELECT count(*) FROM skipped_runs) AS skipped,
    (SELECT count(*) FROM chunks) AS chunks,
    (SELECT count(*) FROM chunk_fts) AS fts_chunks,
    (SELECT count(*) FROM skipped_runs s LEFT JOIN runs r ON r.run_id = s.covering_run_id WHERE r.run_id IS NULL) AS missing_covering_runs,
    (SELECT count(*) FROM runs WHERE verdict = 'divergent_sibling') AS divergent_siblings
  `)
    .get() as {
    runs: number;
    skipped: number;
    chunks: number;
    fts_chunks: number;
    missing_covering_runs: number;
    divergent_siblings: number;
  };
  if (counts.runs !== manifest.kept)
    failures.push(`kept count: db=${counts.runs} manifest=${manifest.kept}`);
  if (counts.skipped !== manifest.skipped)
    failures.push(`skipped count: db=${counts.skipped} manifest=${manifest.skipped}`);
  if (counts.chunks !== counts.fts_chunks)
    failures.push(`FTS count: chunks=${counts.chunks} fts=${counts.fts_chunks}`);
  if (counts.missing_covering_runs !== 0)
    failures.push(`skipped lineage has ${counts.missing_covering_runs} missing covering Runs`);

  let sampledChunks = 0;
  for (const record of manifest.samples) {
    const blob = readFileSync(join(args.runStore, record.jsonl_path));
    const turns = extractTurns(parseJsonl(blob.toString("utf8")));
    const expected = chunkTurns(turns);
    const actual = db
      .query(
        "SELECT chunk_idx, role, text, started_at, token_count FROM chunks WHERE run_id = ? ORDER BY chunk_idx",
      )
      .all(record.run_id) as Array<{
      chunk_idx: number;
      role: string;
      text: string;
      started_at: number;
      token_count: number;
    }>;
    if (actual.length !== expected.length) {
      failures.push(`sample ${record.run_id}: chunks db=${actual.length} raw=${expected.length}`);
      continue;
    }
    for (let i = 0; i < expected.length; i += 1) {
      const a = actual[i]!;
      const e = expected[i]!;
      if (
        a.chunk_idx !== e.chunk_idx ||
        a.role !== e.role ||
        a.text !== e.text ||
        a.started_at !== e.started_at ||
        a.token_count !== e.token_count
      ) {
        failures.push(
          `sample ${record.run_id}:${e.chunk_idx}: chunk differs from raw parser output`,
        );
        break;
      }
    }
    sampledChunks += expected.length;
  }

  const latestDb = db
    .query("SELECT run_id, started_at, captured_at FROM runs ORDER BY started_at DESC LIMIT 1")
    .get() as {
    run_id: string;
    started_at: number;
    captured_at: number;
  };
  const latestCapturedDb = db
    .query("SELECT run_id, captured_at FROM runs ORDER BY captured_at DESC LIMIT 1")
    .get() as {
    run_id: string;
    captured_at: number;
  };
  if (
    latestDb.run_id !== manifest.latestStarted.run_id ||
    latestDb.started_at !== manifest.latestStarted.started_at
  ) {
    failures.push(
      `latest started Run differs: db=${latestDb.run_id} manifest=${manifest.latestStarted.run_id}`,
    );
  }
  if (
    latestCapturedDb.run_id !== manifest.latestCaptured.run_id ||
    latestCapturedDb.captured_at !== manifest.latestCaptured.captured_at
  ) {
    failures.push(
      `latest captured Run differs: db=${latestCapturedDb.run_id} manifest=${manifest.latestCaptured.run_id}`,
    );
  }

  const ftsResults: Record<string, { hits: number; run_ids: string[] }> = {};
  for (const query of args.queries) {
    const rows = querySqlite(db, query, 25);
    if (rows.length === 0) failures.push(`FTS query had no hits: ${query}`);
    ftsResults[query] = { hits: rows.length, run_ids: [...new Set(rows.map((row) => row.run_id))] };
  }
  db.close(false);

  const probeStarted = performance.now();
  const probeArgs = [
    "run",
    import.meta.path,
    "--probe",
    "--db",
    args.db,
    "--query",
    args.queries[0]!,
  ];
  const probe = Bun.spawnSync({
    cmd: [process.execPath, ...probeArgs],
    stdout: "pipe",
    stderr: "pipe",
  });
  const probeWallMs = performance.now() - probeStarted;
  if (probe.exitCode !== 0)
    failures.push(`restart probe failed: ${probe.stderr.toString().slice(0, 500)}`);
  let restartProbe: Record<string, unknown> = { wall_ms: probeWallMs };
  if (probe.exitCode === 0)
    restartProbe = { ...JSON.parse(probe.stdout.toString()), wall_ms: probeWallMs };

  const fallbackQuery = args.queries.find((query) => !query.includes(" ")) ?? args.queries[0]!;
  const fallbackStarted = performance.now();
  const fallback = Bun.spawnSync({
    cmd: [
      "rg",
      "--files-with-matches",
      "--fixed-strings",
      "--max-count",
      "1",
      "--glob",
      "*.jsonl",
      fallbackQuery,
      args.runStore,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const fallbackMs = performance.now() - fallbackStarted;
  const fallbackPaths = fallback.stdout.toString().trim().split("\n").filter(Boolean);
  if (fallback.exitCode !== 0 || fallbackPaths.length === 0) {
    failures.push(
      `raw ripgrep fallback failed (${fallback.exitCode}): ${fallback.stderr.toString().slice(0, 300)}`,
    );
  }

  const health = await typesenseHealth();
  const typesenseParity: Record<string, unknown> = {
    status: health.status,
    health: health.body,
    skipped: !health.green,
  };
  if (health.green) {
    const parity: Record<string, { sqlite_runs: number; typesense_runs: number; overlap: number }> =
      {};
    for (const query of args.queries) {
      const sqliteIds = new Set(ftsResults[query]!.run_ids);
      const typesenseIds = await typesenseQuery(query);
      const overlap = [...sqliteIds].filter((id) => typesenseIds.has(id)).length;
      parity[query] = { sqlite_runs: sqliteIds.size, typesense_runs: typesenseIds.size, overlap };
      if (sqliteIds.size > 0 && typesenseIds.size > 0 && overlap === 0)
        failures.push(`Typesense parity has no Run overlap: ${query}`);
    }
    typesenseParity.skipped = false;
    typesenseParity.queries = parity;
  }

  const report = {
    ok: failures.length === 0,
    database: args.db,
    database_bytes: Bun.file(args.db).size,
    counts,
    manifest: { kept: manifest.kept, skipped: manifest.skipped },
    raw_samples: { runs: manifest.samples.length, chunks: sampledChunks },
    latest: { started: latestDb, captured: latestCapturedDb },
    fts: ftsResults,
    raw_ripgrep_fallback: {
      query: fallbackQuery,
      matches: fallbackPaths.length,
      first_path: fallbackPaths[0] ?? null,
      duration_ms: fallbackMs,
    },
    restart_probe: restartProbe,
    typesense_parity: typesenseParity,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

await main();
