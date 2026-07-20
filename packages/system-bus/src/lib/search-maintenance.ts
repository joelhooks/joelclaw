import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNS_COLLECTION } from "@joelclaw/memory";
import { emitOtelEvent } from "../observability/emit";

export type CaptureSegment = {
  runId: string;
  sourceIdentity: string;
  fromOffset: number;
  toOffset: number;
  jsonlSha256: string;
};

export type CaptureGrowthFinding = {
  current: CaptureSegment;
  overlapping: CaptureSegment;
  overlapBytes: number;
};

export type SearchFreshness = {
  observedAt: string;
  latestSourceAt: string | null;
  ageMs: number | null;
  reportedAt?: string;
  observationAgeMs?: number;
  stale?: boolean;
};

export type SearchProvenance = {
  engine: "typesense" | "sqlite";
  index: string;
  sourceOfTruth: "raw-run-jsonl";
  runId: string | null;
  sourceIdentity: string | null;
  fromOffset: number | null;
  toOffset: number | null;
  jsonlSha256: string | null;
  jsonlPath: string | null;
};

export type SearchProjectionHealth = {
  ok: boolean;
  detail: string;
  freshness: SearchFreshness;
  provenance: SearchProvenance;
};

export type StartupBudgetState = {
  unavailableSince: number;
  alertedAt: number | null;
};

export type StartupBudgetAssessment = {
  target: string;
  engine: "typesense" | "sqlite";
  budgetMs: number;
  unavailableSince: number | null;
  unavailableForMs: number;
  exceeded: boolean;
  shouldAlert: boolean;
  nextState: StartupBudgetState | null;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type CommandRunner = (args: readonly string[]) => Promise<CommandResult>;

type SearchRequest = (path: string) => Promise<Response>;

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toSegment(document: Record<string, unknown>): CaptureSegment | null {
  const runId = nonEmptyString(document.id);
  const sourceIdentity = nonEmptyString(document.source_identity);
  const fromOffset = finiteNumber(document.from_offset);
  const toOffset = finiteNumber(document.to_offset);
  const jsonlSha256 = nonEmptyString(document.jsonl_sha256);
  if (!runId || !sourceIdentity || fromOffset === null || toOffset === null || !jsonlSha256) {
    return null;
  }
  return { runId, sourceIdentity, fromOffset, toOffset, jsonlSha256 };
}

export function detectCaptureGrowth(
  current: CaptureSegment,
  candidates: readonly CaptureSegment[],
): CaptureGrowthFinding | null {
  for (const candidate of candidates) {
    if (candidate.runId === current.runId || candidate.sourceIdentity !== current.sourceIdentity) {
      continue;
    }
    const overlapBytes = Math.min(current.toOffset, candidate.toOffset)
      - Math.max(current.fromOffset, candidate.fromOffset);
    if (overlapBytes > 0) {
      return { current, overlapping: candidate, overlapBytes };
    }
  }
  return null;
}

export async function findCaptureGrowth(
  request: SearchRequest,
  current: CaptureSegment,
): Promise<CaptureGrowthFinding | null> {
  const params = new URLSearchParams({
    q: "*",
    query_by: "full_text",
    filter_by: [
      `source_identity:=\`${current.sourceIdentity}\``,
      `id:!=\`${current.runId}\``,
      `from_offset:<${current.toOffset}`,
      `to_offset:>${current.fromOffset}`,
    ].join(" && "),
    include_fields: "id,source_identity,from_offset,to_offset,jsonl_sha256",
    per_page: "10",
  });
  const response = await request(`/collections/${RUNS_COLLECTION}/documents/search?${params}`);
  if (!response.ok) {
    throw new Error(`capture growth query failed: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json() as { hits?: Array<{ document?: Record<string, unknown> }> };
  const candidates = (payload.hits ?? [])
    .map((hit) => hit.document ? toSegment(hit.document) : null)
    .filter((segment): segment is CaptureSegment => segment !== null);
  return detectCaptureGrowth(current, candidates);
}

export function classifySearchProjection(
  document: Record<string, unknown> | null,
  observedAt: number,
): SearchProjectionHealth {
  const latestSourceAt = document
    ? finiteNumber(document.ended_at) ?? finiteNumber(document.started_at)
    : null;
  const runId = document ? nonEmptyString(document.id) : null;
  const sourceIdentity = document ? nonEmptyString(document.source_identity) : null;
  const fromOffset = document ? finiteNumber(document.from_offset) : null;
  const toOffset = document ? finiteNumber(document.to_offset) : null;
  const jsonlSha256 = document ? nonEmptyString(document.jsonl_sha256) : null;
  const jsonlPath = document ? nonEmptyString(document.jsonl_path) : null;
  const ageMs = latestSourceAt === null ? null : Math.max(0, observedAt - latestSourceAt);
  const provenance: SearchProvenance = {
    engine: "typesense",
    index: RUNS_COLLECTION,
    sourceOfTruth: "raw-run-jsonl",
    runId,
    sourceIdentity,
    fromOffset,
    toOffset,
    jsonlSha256,
    jsonlPath,
  };
  const freshness: SearchFreshness = {
    observedAt: new Date(observedAt).toISOString(),
    latestSourceAt: latestSourceAt === null ? null : new Date(latestSourceAt).toISOString(),
    ageMs,
  };
  const hasProvenance = Boolean(runId && jsonlSha256 && jsonlPath);
  return {
    ok: hasProvenance,
    detail: hasProvenance
      ? `latest=${freshness.latestSourceAt}; ageMs=${ageMs}; source=raw-run-jsonl; run=${runId}`
      : "runs_dev has no indexed Run with source provenance",
    freshness,
    provenance,
  };
}

export async function readSearchProjectionHealth(
  request: SearchRequest,
  observedAt = Date.now(),
): Promise<SearchProjectionHealth> {
  const params = new URLSearchParams({
    q: "*",
    query_by: "full_text",
    sort_by: "ended_at:desc,started_at:desc",
    include_fields: "id,started_at,ended_at,jsonl_path,jsonl_sha256,from_offset,to_offset,source_identity",
    per_page: "1",
  });
  const response = await request(`/collections/${RUNS_COLLECTION}/documents/search?${params}`);
  if (!response.ok) {
    throw new Error(`search projection query failed: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json() as { hits?: Array<{ document?: Record<string, unknown> }> };
  return classifySearchProjection(payload.hits?.[0]?.document ?? null, observedAt);
}

export function parseStartupBudgetMs(
  value: string | undefined,
  fallbackMs = 900_000,
  minimumMs = 60_000,
): number {
  const normalized = value?.trim();
  if (!normalized || !/^[0-9]+$/.test(normalized)) return fallbackMs;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) return fallbackMs;
  return Math.max(minimumMs, parsed);
}

export function assessStartupBudget(input: {
  target: string;
  engine: "typesense" | "sqlite";
  healthy: boolean;
  checkedAt: number;
  budgetMs: number;
  previous: StartupBudgetState | null;
}): StartupBudgetAssessment {
  const budgetMs = Math.max(1, Math.floor(input.budgetMs));
  if (input.healthy) {
    return {
      target: input.target,
      engine: input.engine,
      budgetMs,
      unavailableSince: null,
      unavailableForMs: 0,
      exceeded: false,
      shouldAlert: false,
      nextState: null,
    };
  }

  const unavailableSince = input.previous?.unavailableSince ?? input.checkedAt;
  const unavailableForMs = Math.max(0, input.checkedAt - unavailableSince);
  const exceeded = unavailableForMs >= budgetMs;
  return {
    target: input.target,
    engine: input.engine,
    budgetMs,
    unavailableSince,
    unavailableForMs,
    exceeded,
    shouldAlert: exceeded && input.previous?.alertedAt == null,
    nextState: {
      unavailableSince,
      alertedAt: exceeded ? input.previous?.alertedAt ?? input.checkedAt : null,
    },
  };
}

async function defaultCommandRunner(args: readonly string[]): Promise<CommandResult> {
  const captureDir = await mkdtemp(join(tmpdir(), "search-maintenance-alert-"));
  const stdoutPath = join(captureDir, "stdout.txt");
  const stderrPath = join(captureDir, "stderr.txt");
  try {
    const proc = Bun.spawn([...args], {
      env: process.env,
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
    });
    const exitCode = await proc.exited;
    const [stdout, stderr] = await Promise.all([
      readFile(stdoutPath, "utf8").catch(() => ""),
      readFile(stderrPath, "utf8").catch(() => ""),
    ]);
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  } finally {
    await rm(captureDir, { recursive: true, force: true });
  }
}

function requireCommandSuccess(
  result: CommandResult,
  label: string,
): { ok: true; result?: Record<string, unknown> } {
  if (result.exitCode !== 0) {
    throw new Error(`${label} exited ${result.exitCode}: ${result.stderr || result.stdout || "no output"}`);
  }
  let envelope: {
    ok?: boolean;
    result?: Record<string, unknown>;
    error?: { message?: string };
  };
  try {
    envelope = JSON.parse(result.stdout) as typeof envelope;
  } catch {
    throw new Error(`${label} returned non-JSON output`);
  }
  if (envelope.ok !== true) {
    throw new Error(`${label} failed: ${envelope.error?.message ?? "ok was not true"}`);
  }
  return envelope as { ok: true; result?: Record<string, unknown> };
}

export function stableAlertId(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function captureGrowthIncidentAlertId(
  sourceIdentity: string,
  incidentStartedAt: number,
  triggerRunId: string,
): string {
  return stableAlertId(
    `search-capture-growth:${sourceIdentity}:${incidentStartedAt}:${triggerRunId}`,
  );
}

export interface HardAlertReceipt {
  sent: true;
  receiptConfirmed: boolean;
  receiptDetail: string | null;
}

/**
 * Sends the alert, then waits for the terminal delivery receipt. A failed or
 * missing receipt must NOT throw: the platform message already went out, and a
 * throw makes retrying callers re-send the same alert (2026-07-20 Telegram
 * spam incident). Only a failed send throws.
 */
export async function sendHardAlert(input: {
  eventId: string;
  source: string;
  message: string;
  runCommand?: CommandRunner;
}): Promise<HardAlertReceipt> {
  const runCommand = input.runCommand ?? defaultCommandRunner;
  const sent = await runCommand([
    "joelclaw",
    "notify",
    "send",
    "--kind",
    "alert",
    "--priority",
    "high",
    "--source",
    input.source,
    "--event-id",
    input.eventId,
    input.message,
  ]);
  const sendEnvelope = requireCommandSuccess(sent, "joelclaw notify send");
  if (sendEnvelope.result?.eventId !== input.eventId) {
    throw new Error("joelclaw notify send returned the wrong eventId");
  }

  try {
    const confirmed = await runCommand([
      "joelclaw",
      "notify",
      "wait",
      input.eventId,
      "--source",
      input.source,
      "--timeout",
      "15s",
    ]);
    const waitEnvelope = requireCommandSuccess(confirmed, "joelclaw notify wait");
    if (
      waitEnvelope.result?.deliveryState !== "confirmed" ||
      typeof waitEnvelope.result.platformMessageId !== "string" ||
      waitEnvelope.result.platformMessageId.length === 0
    ) {
      return unconfirmedReceipt(input, "notify wait did not confirm a platform message");
    }
    return { sent: true, receiptConfirmed: true, receiptDetail: null };
  } catch (error) {
    return unconfirmedReceipt(input, String(error).slice(0, 300));
  }
}

async function unconfirmedReceipt(
  input: { eventId: string; source: string },
  detail: string,
): Promise<HardAlertReceipt> {
  try {
    await emitOtelEvent({
      level: "warn",
      source: "system-bus",
      component: "search-maintenance",
      action: "alert.receipt.unconfirmed",
      success: false,
      metadata: { eventId: input.eventId, alertSource: input.source, detail },
    });
  } catch {
    // Telemetry must never turn a delivered alert into a retry storm.
  }
  return { sent: true, receiptConfirmed: false, receiptDetail: detail };
}
