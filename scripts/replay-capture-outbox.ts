#!/usr/bin/env bun
/**
 * Plan and supervise capture-outbox replay without mutating the outbox.
 *
 * Default mode is a read-only plan. Real POSTs require all of:
 *   --run --execute --catalog <reviewed-plan.json> --max-files <n>
 *
 * The script never deletes, moves, or rewrites outbox files. A stable run_id
 * plus the transformed JSONL SHA is the replay idempotency key. Checkpoints are
 * append-only and an inflight/accepted item is never resent automatically.
 */
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  type CaptureBody,
  type CapturedSibling,
  type CatalogEntry,
  canAttemptReplay,
  catalogEntryMatches,
  classifyPrefixGroup,
  deriveReplayBody,
  isPathInside,
  logicalGroupKey,
  parseCaptureBody,
  replayKey,
  sha256,
  verifiedCapturedSibling,
} from "./lib/capture-outbox-replay";

type PlanEntry = CatalogEntry & {
  archiveStatus?: "covered" | "full" | "suffix";
  replayBytes?: number;
  capturedRunId?: string;
  removedPrefixBytes?: number;
};

type PlanArtifact = {
  schemaVersion: 2;
  generatedAt: string;
  outbox: string;
  sourceCount: number;
  sourceBytes: number;
  representatives: number;
  entries: PlanEntry[];
};

type CheckpointRow = {
  at: string;
  key: string;
  runId: string;
  status: "inflight" | "accepted" | "indexed" | "covered" | "failed";
  sourceSha256: string;
  replaySha256: string;
  httpStatus?: number;
  detail?: string;
};

const HOME = homedir();
const args = process.argv.slice(2);
const flags = new Set(args.filter((value) => value.startsWith("--") && !value.includes("=")));

function arg(name: string, fallback?: string): string | undefined {
  const direct = args.find((value) => value.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function intArg(name: string, fallback: number): number {
  const value = Number(arg(name, String(fallback)));
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${name} must be a non-negative number`);
  return Math.floor(value);
}

function configValue(name: string): string | undefined {
  const fromProcess = process.env[name]?.trim();
  if (fromProcess) return fromProcess;
  const envPath = join(HOME, ".config", "system-bus.env");
  if (!existsSync(envPath)) return undefined;
  const line = readFileSync(envPath, "utf8")
    .split("\n")
    .find((candidate) => candidate.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim() || undefined;
}

const outbox = resolve(arg("--outbox", join(HOME, ".joelclaw", "outbox"))!);
const catalogPath = resolve(arg("--catalog", "/tmp/capture-outbox-plan.json")!);
const receiptPath = resolve(arg("--receipt", "/tmp/capture-outbox-replay-receipt.json")!);
const checkpointPath = resolve(
  arg("--checkpoint", join(HOME, ".joelclaw", "capture-outbox-replay-checkpoint.jsonl"))!,
);
const stopFile = resolve(arg("--stop-file", join(HOME, ".joelclaw", "capture-outbox.STOP"))!);
const centralUrl = (
  arg("--central-url") ??
  configValue("JOELCLAW_CENTRAL_URL") ??
  "http://127.0.0.1:3111"
).replace(/\/$/u, "");
const sessionsDbPath = resolve(
  arg("--sessions-db") ??
    configValue("SESSION_INDEX_PATH") ??
    join(HOME, ".joelclaw", "search", "sessions.db"),
);
const runStorePath = resolve(
  arg("--run-store") ?? configValue("RUN_STORE_PATH") ?? join(HOME, ".joelclaw", "runs-dev"),
);
const isRun = flags.has("--run");
const execute = flags.has("--execute");
const maxFiles = intArg("--max-files", 0);
const maxFileBytes = intArg("--max-file-bytes", 64 * 1024 * 1024);
const maxBatchBytes = intArg("--max-batch-bytes", 256 * 1024 * 1024);
const rateMs = intArg("--rate-ms", 1_000);
const batchSize = intArg("--batch-size", 25);
const batchPauseMs = intArg("--batch-pause-ms", 30_000);
const indexWaitMs = intArg("--index-wait-ms", 120_000);
const retryFailedRun = arg("--retry-failed-run");
let stopRequested = false;
process.on("SIGINT", () => {
  stopRequested = true;
});
process.on("SIGTERM", () => {
  stopRequested = true;
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function readBody(path: string): CaptureBody {
  return parseCaptureBody(JSON.parse(readFileSync(path, "utf8")));
}

function scanSource(path: string): { body: CaptureBody; entry: CatalogEntry } {
  const raw = readFileSync(path);
  const body = parseCaptureBody(JSON.parse(raw.toString("utf8")));
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`capture source is not a regular file: ${path}`);
  return {
    body,
    entry: {
      path,
      file: basename(path),
      fileBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      runId: body.run_id,
      runtime: body.agent_runtime,
      conversationId: body.conversation_id,
      parentRunId: body.parent_run_id,
      sourceIdentity: body.source_identity,
      fromOffset: body.from_offset,
      startedAt: body.started_at,
      jsonlChars: body.jsonl.length,
      jsonlBytes: Buffer.byteLength(body.jsonl, "utf8"),
      jsonlSha256: sha256(body.jsonl),
      bodySha256: sha256(raw),
    },
  };
}

function scanEntry(path: string): CatalogEntry {
  return scanSource(path).entry;
}

function validateCatalogSource(expected: CatalogEntry, realOutbox: string): CaptureBody {
  const realPath = realpathSync(expected.path);
  const pathFromOutbox = relative(realOutbox, realPath);
  if (!isPathInside(realOutbox, realPath, pathFromOutbox) || basename(realPath) !== expected.file) {
    throw new Error(`catalog source escapes reviewed outbox: ${expected.path}`);
  }
  const actual = scanSource(realPath);
  if (!catalogEntryMatches(expected, actual.entry)) {
    throw new Error(`catalog source changed after review: ${expected.path}`);
  }
  return actual.body;
}

// sessions.db is the canonical session index (ADR-backed successor to the
// retired Typesense runs_dev collection). Central writes it synchronously on
// capture ingest, so index verification reads it directly.
type IndexedRun = {
  run_id: string;
  parent_run_id: string | null;
  source_identity: string | null;
  jsonl_path: string | null;
  jsonl_sha256: string | null;
};

let sessionsDb: Database | undefined;
function sessionIndex(): Database {
  if (!sessionsDb) {
    if (!existsSync(sessionsDbPath))
      throw new Error(`session index not found: ${sessionsDbPath}`);
    // The index is WAL-mode and its -wal/-shm sidecars vanish between writer
    // sessions; a readonly connection then fails with SQLITE_CANTOPEN because
    // it may not create them. Open read-write, enforce no-writes per-connection.
    sessionsDb = new Database(sessionsDbPath);
    sessionsDb.run("PRAGMA query_only = ON");
  }
  return sessionsDb;
}

function exactRun(runId: string): IndexedRun | undefined {
  const row = sessionIndex()
    .query<IndexedRun, [string]>(
      "SELECT run_id, parent_run_id, source_identity, jsonl_path, jsonl_sha256 FROM runs WHERE run_id = ?",
    )
    .get(runId);
  return row ?? undefined;
}

function capturedSiblings(body: CaptureBody): CapturedSibling[] {
  if (!body.conversation_id) return [];
  const rows = sessionIndex()
    .query<IndexedRun, [string, string]>(
      "SELECT run_id, parent_run_id, source_identity, jsonl_path, jsonl_sha256 FROM runs WHERE agent_runtime = ? AND conversation_id = ?",
    )
    .all(body.agent_runtime, body.conversation_id);
  const siblings: CapturedSibling[] = [];
  for (const row of rows) {
    if ((row.parent_run_id ?? undefined) !== (body.parent_run_id ?? undefined)) continue;
    if (body.source_identity && row.source_identity !== body.source_identity) continue;
    if (!row.jsonl_path) continue;
    // sessions.db stores run-store-relative jsonl paths (same convention as
    // `joelclaw sessions`); absolute paths are legacy rows.
    const jsonlPath = row.jsonl_path.startsWith("/")
      ? row.jsonl_path
      : join(runStorePath, row.jsonl_path);
    if (!existsSync(jsonlPath)) continue;
    siblings.push(
      verifiedCapturedSibling(
        row.run_id,
        readFileSync(jsonlPath, "utf8"),
        row.jsonl_sha256 ?? undefined,
      ),
    );
  }
  return siblings;
}

async function plan(): Promise<void> {
  const files = readdirSync(outbox)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(outbox, name));
  const scanned = files.map(scanEntry);
  const groups = new Map<string, CatalogEntry[]>();
  for (const entry of scanned) {
    const key = logicalGroupKey(entry);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  const classified: PlanEntry[] = [];
  for (const entries of groups.values()) {
    classified.push(...classifyPrefixGroup(entries, (entry) => readBody(entry.path).jsonl));
  }

  for (const entry of classified.filter(
    (candidate) => candidate.disposition === "representative",
  )) {
    const body = readBody(entry.path);
    const derivation = deriveReplayBody(body, capturedSiblings(body));
    entry.archiveStatus = derivation.status;
    if (derivation.status === "covered") {
      entry.capturedRunId = derivation.capturedRunId;
    } else {
      entry.replayBytes = Buffer.byteLength(derivation.body.jsonl, "utf8");
      if (derivation.status === "suffix") {
        entry.capturedRunId = derivation.capturedRunId;
        entry.removedPrefixBytes = derivation.removedPrefixBytes;
      }
    }
  }

  const artifact: PlanArtifact = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    outbox,
    sourceCount: classified.length,
    sourceBytes: classified.reduce((sum, entry) => sum + entry.fileBytes, 0),
    representatives: classified.filter((entry) => entry.disposition === "representative").length,
    entries: classified,
  };
  mkdirSync(dirname(catalogPath), { recursive: true });
  writeFileSync(catalogPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  const summary = {
    ok: true,
    mode: "plan",
    readOnly: true,
    catalogPath,
    sourceCount: artifact.sourceCount,
    sourceBytes: artifact.sourceBytes,
    representatives: artifact.representatives,
    dispositions: Object.fromEntries(
      ["redundant-prefix", "redundant-exact", "representative"].map((status) => [
        status,
        classified.filter((entry) => entry.disposition === status).length,
      ]),
    ),
    archiveStatus: Object.fromEntries(
      ["covered", "suffix", "full"].map((status) => [
        status,
        classified.filter((entry) => entry.archiveStatus === status).length,
      ]),
    ),
    replayBytes: classified.reduce((sum, entry) => sum + (entry.replayBytes ?? 0), 0),
    next: `Review ${catalogPath}; then use --run --execute --catalog ${catalogPath} --max-files <n>`,
  };
  writeFileSync(receiptPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function loadCheckpoint(): Map<string, CheckpointRow> {
  const latest = new Map<string, CheckpointRow>();
  if (!existsSync(checkpointPath)) return latest;
  for (const line of readFileSync(checkpointPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as CheckpointRow;
    latest.set(row.key, row);
  }
  return latest;
}

function checkpoint(row: Omit<CheckpointRow, "at">): CheckpointRow {
  const value = { ...row, at: new Date().toISOString() };
  mkdirSync(dirname(checkpointPath), { recursive: true });
  appendFileSync(checkpointPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return value;
}

async function waitForIndex(
  runId: string,
  replaySha256: string,
): Promise<"indexed" | "conflict" | "timeout"> {
  const deadline = Date.now() + indexWaitMs;
  while (Date.now() <= deadline) {
    const doc = exactRun(runId);
    if (doc) return doc.jsonl_sha256 === replaySha256 ? "indexed" : "conflict";
    if (Date.now() >= deadline) break;
    await sleep(Math.min(2_000, Math.max(1, deadline - Date.now())));
  }
  return "timeout";
}

async function run(): Promise<void> {
  if (!execute) throw new Error("real replay requires --execute");
  if (maxFiles <= 0) throw new Error("real replay requires --max-files > 0");
  if (!existsSync(catalogPath)) throw new Error(`reviewed catalog not found: ${catalogPath}`);
  const authPath = join(HOME, ".joelclaw", "auth.json");
  const token = (JSON.parse(readFileSync(authPath, "utf8")) as { token?: string }).token;
  if (!token) throw new Error("capture auth token missing");
  const artifact = JSON.parse(readFileSync(catalogPath, "utf8")) as PlanArtifact;
  if (artifact.schemaVersion !== 2 || resolve(artifact.outbox) !== outbox) {
    throw new Error("catalog schema/outbox does not match this run");
  }
  const realOutbox = realpathSync(outbox);
  if (realpathSync(artifact.outbox) !== realOutbox) {
    throw new Error("catalog outbox resolves outside the reviewed source");
  }

  const latest = loadCheckpoint();
  const candidates = artifact.entries
    .filter((entry) => entry.disposition === "representative" && entry.archiveStatus !== "covered")
    .sort((a, b) => a.fileBytes - b.fileBytes || a.mtimeMs - b.mtimeMs);
  const receipt = {
    mode: "run",
    catalogPath,
    attempted: 0,
    indexed: 0,
    covered: 0,
    failed: 0,
    bytes: 0,
    stopped: false,
    rows: [] as CheckpointRow[],
  };

  for (const entry of candidates) {
    if (receipt.attempted >= maxFiles || stopRequested || existsSync(stopFile)) {
      receipt.stopped = true;
      break;
    }
    if (entry.fileBytes > maxFileBytes || receipt.bytes + entry.fileBytes > maxBatchBytes) {
      continue;
    }
    const source = validateCatalogSource(entry, realOutbox);
    const derivation = deriveReplayBody(source, capturedSiblings(source));
    if (derivation.status === "covered") {
      const key = replayKey(source.run_id, entry.bodySha256, entry.jsonlSha256);
      const row = checkpoint({
        key,
        runId: source.run_id,
        status: "covered",
        sourceSha256: entry.bodySha256,
        replaySha256: entry.jsonlSha256,
        detail: `covered by ${derivation.capturedRunId}`,
      });
      latest.set(key, row);
      receipt.rows.push(row);
      receipt.covered += 1;
      continue;
    }

    const targetRunId = derivation.body.run_id;
    const key = replayKey(targetRunId, entry.bodySha256, derivation.replaySha256);
    const prior = latest.get(key);
    if (prior && !canAttemptReplay(prior.status, targetRunId, retryFailedRun)) {
      if (prior.status === "indexed" || prior.status === "covered") continue;
      const indexed = await waitForIndex(targetRunId, derivation.replaySha256);
      if (indexed === "indexed") {
        const row = checkpoint({
          key,
          runId: targetRunId,
          status: "indexed",
          sourceSha256: entry.bodySha256,
          replaySha256: derivation.replaySha256,
          detail: "resume check",
        });
        latest.set(key, row);
        receipt.rows.push(row);
        receipt.indexed += 1;
        continue;
      }
      const retryHint =
        prior.status === "failed"
          ? ` Use --retry-failed-run ${targetRunId} only after review.`
          : "";
      throw new Error(
        `run ${targetRunId} is ${prior.status} but not indexed; refusing automatic resend (${indexed}).${retryHint}`,
      );
    }

    const existing = exactRun(targetRunId);
    if (existing) {
      if (existing.jsonl_sha256 !== derivation.replaySha256) {
        throw new Error(`run_id conflict for ${targetRunId}; refusing overwrite`);
      }
      const row = checkpoint({
        key,
        runId: targetRunId,
        status: "indexed",
        sourceSha256: entry.bodySha256,
        replaySha256: derivation.replaySha256,
        detail: "already indexed preflight",
      });
      latest.set(key, row);
      receipt.rows.push(row);
      receipt.indexed += 1;
      continue;
    }

    let row = checkpoint({
      key,
      runId: targetRunId,
      status: "inflight",
      sourceSha256: entry.bodySha256,
      replaySha256: derivation.replaySha256,
    });
    latest.set(key, row);
    receipt.rows.push(row);
    if (stopRequested || existsSync(stopFile)) {
      row = checkpoint({
        key,
        runId: targetRunId,
        status: "failed",
        sourceSha256: entry.bodySha256,
        replaySha256: derivation.replaySha256,
        detail: "stop requested immediately before POST",
      });
      latest.set(key, row);
      receipt.rows.push(row);
      receipt.failed += 1;
      receipt.stopped = true;
      break;
    }
    receipt.attempted += 1;
    receipt.bytes += Buffer.byteLength(derivation.body.jsonl, "utf8");
    const response = await fetch(`${centralUrl}/api/runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(derivation.body),
    });
    if (!response.ok) {
      row = checkpoint({
        key,
        runId: targetRunId,
        status: "failed",
        sourceSha256: entry.bodySha256,
        replaySha256: derivation.replaySha256,
        httpStatus: response.status,
        detail: (await response.text()).slice(0, 160),
      });
      latest.set(key, row);
      receipt.rows.push(row);
      receipt.failed += 1;
      break;
    }
    row = checkpoint({
      key,
      runId: targetRunId,
      status: "accepted",
      sourceSha256: entry.bodySha256,
      replaySha256: derivation.replaySha256,
      httpStatus: response.status,
    });
    latest.set(key, row);
    receipt.rows.push(row);
    const indexed = await waitForIndex(targetRunId, derivation.replaySha256);
    if (indexed !== "indexed") {
      throw new Error(
        `accepted run ${targetRunId} did not index safely (${indexed}); stopping without resend`,
      );
    }
    row = checkpoint({
      key,
      runId: targetRunId,
      status: "indexed",
      sourceSha256: entry.bodySha256,
      replaySha256: derivation.replaySha256,
    });
    latest.set(key, row);
    receipt.rows.push(row);
    receipt.indexed += 1;
    await sleep(rateMs);
    if (batchSize > 0 && receipt.attempted % batchSize === 0) await sleep(batchPauseMs);
  }

  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ...receipt, rows: receipt.rows.length }, null, 2)}\n`);
}

async function main(): Promise<void> {
  if (isRun) await run();
  else await plan();
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(
      `capture outbox replay stopped: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
