import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { getRedisClient } from "../../lib/redis";
import {
  assessStartupBudget,
  type CaptureGrowthFinding,
  type CaptureSegment,
  captureGrowthIncidentAlertId,
  detectCaptureGrowth,
  parseStartupBudgetMs,
  readSearchProjectionHealth,
  resolveHardAlert,
  type SearchProjectionHealth,
  type StartupBudgetAssessment,
  type StartupBudgetState,
  sendHardAlert,
  stableAlertId,
} from "../../lib/search-maintenance";
import * as typesense from "../../lib/typesense";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const CAPTURE_LEDGER_PREFIX = "search-maintenance:capture-ledger:";
const STARTUP_BUDGET_STATE_KEY = "search-maintenance:startup-budget:typesense-process";
const SEARCH_HEALTH_KEY = "search-maintenance:health:sessions-db";
const CAPTURE_LEDGER_TTL_SECONDS = 90 * 24 * 60 * 60;
const CAPTURE_INCIDENT_QUIET_MS = 24 * 60 * 60_000;
const STARTUP_INCIDENT_QUIET_MS = 24 * 60 * 60_000;
const HARD_ALERT_ATTEMPT_CAP = 3;
const CAPTURE_GROWTH_CHECK_TIMEOUT_MS = 2_000;
const MAX_CAPTURE_SEGMENTS_PER_SOURCE = 2_048;
const TYPESENSE_STARTUP_BUDGET_MS = parseStartupBudgetMs(
  process.env.TYPESENSE_STARTUP_BUDGET_MS,
);
const SESSION_INDEX_PATH =
  process.env.SESSION_INDEX_PATH ?? join(homedir(), ".joelclaw", "search", "sessions.db");

export interface SearchMaintenanceStateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CaptureGrowthDependencies {
  store: SearchMaintenanceStateStore;
  notify: (finding: CaptureGrowthFinding, eventId: string) => Promise<boolean | void>;
  resolve?: (sourceIdentity: string) => Promise<void>;
  now: () => number;
}

export interface StartupBudgetDependencies {
  store: SearchMaintenanceStateStore;
  probe: () => Promise<{ healthy: boolean; status: number | null; detail: string }>;
  readProjection: () => Promise<SearchProjectionHealth>;
  notify: (assessment: StartupBudgetAssessment, detail: string) => Promise<boolean | void>;
  resolve?: () => Promise<void>;
  now: () => number;
  budgetMs: number;
}

function stateStore(): SearchMaintenanceStateStore {
  const redis = getRedisClient();
  return {
    get: (key) => redis.get(key),
    set: async (key, value, ttlSeconds) => {
      if (ttlSeconds === undefined) await redis.set(key, value);
      else await redis.set(key, value, "EX", ttlSeconds);
    },
    delete: async (key) => {
      await redis.del(key);
    },
  };
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function sourceKey(sourceIdentity: string): string {
  return createHash("sha256").update(sourceIdentity).digest("hex");
}

function captureSegment(data: Record<string, unknown>): CaptureSegment | null {
  if (
    typeof data.run_id !== "string" ||
    typeof data.source_identity !== "string" ||
    typeof data.from_offset !== "number" ||
    typeof data.to_offset !== "number" ||
    typeof data.jsonl_sha256 !== "string"
  ) {
    return null;
  }
  return {
    runId: data.run_id,
    sourceIdentity: data.source_identity,
    fromOffset: data.from_offset,
    toOffset: data.to_offset,
    jsonlSha256: data.jsonl_sha256,
  };
}

export async function processCaptureGrowth(
  data: Record<string, unknown>,
  dependencies: CaptureGrowthDependencies,
): Promise<{ checked: boolean; finding: CaptureGrowthFinding | null; alerted: boolean }> {
  const current = captureSegment(data);
  if (!current || current.toOffset <= current.fromOffset) {
    return { checked: false, finding: null, alerted: false };
  }

  const keySuffix = sourceKey(current.sourceIdentity);
  const ledgerKey = `${CAPTURE_LEDGER_PREFIX}${keySuffix}`;
  const prior = parseJson<CaptureSegment[]>(await dependencies.store.get(ledgerKey), []);
  const finding = detectCaptureGrowth(current, prior);
  const next = [...prior.filter((segment) => segment.runId !== current.runId), current]
    .slice(-MAX_CAPTURE_SEGMENTS_PER_SOURCE);
  await dependencies.store.set(ledgerKey, JSON.stringify(next), CAPTURE_LEDGER_TTL_SECONDS);

  if (!finding) {
    await dependencies.resolve?.(current.sourceIdentity);
    return { checked: true, finding: null, alerted: false };
  }

  const now = dependencies.now();
  const eventId = captureGrowthIncidentAlertId(current.sourceIdentity, now, current.runId);
  const notified = await dependencies.notify(finding, eventId);
  return { checked: true, finding, alerted: notified !== false };
}

export async function processStartupBudget(
  dependencies: StartupBudgetDependencies,
): Promise<{
  probe: { healthy: boolean; status: number | null; detail: string };
  assessment: StartupBudgetAssessment;
  projection: SearchProjectionHealth | null;
  targetHealthy: boolean;
  availabilityDetail: string;
}> {
  const checkedAt = dependencies.now();
  const probe = await dependencies.probe();
  let projection: SearchProjectionHealth | null = null;
  let projectionError: string | null = null;
  try {
    projection = await dependencies.readProjection();
    await dependencies.store.set(SEARCH_HEALTH_KEY, JSON.stringify(projection));
  } catch (error) {
    projectionError = String(error).slice(0, 180);
  }
  const targetHealthy = probe.healthy;
  const availabilityDetail = projectionError
    ? `${probe.detail}; sessions.db health failed independently: ${projectionError}`
    : probe.detail;
  const previous = parseJson<StartupBudgetState | null>(
    await dependencies.store.get(STARTUP_BUDGET_STATE_KEY),
    null,
  );
  const assessment = assessStartupBudget({
    target: "typesense:process",
    engine: "typesense",
    healthy: targetHealthy,
    checkedAt,
    budgetMs: dependencies.budgetMs,
    previous,
  });

  if (assessment.nextState) {
    await dependencies.store.set(
      STARTUP_BUDGET_STATE_KEY,
      JSON.stringify({ ...assessment.nextState, alertedAt: null }),
    );
  } else {
    await dependencies.store.delete(STARTUP_BUDGET_STATE_KEY);
    await dependencies.resolve?.();
  }

  if (assessment.exceeded) {
    await dependencies.notify(assessment, availabilityDetail);
  }

  return { probe, assessment, projection, targetHealthy, availabilityDetail };
}

async function probeTypesenseHealth(): Promise<{
  healthy: boolean;
  status: number | null;
  detail: string;
}> {
  try {
    const response = await fetch(`${typesense.TYPESENSE_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.text();
    let payloadOk = false;
    try {
      payloadOk = (JSON.parse(body) as { ok?: boolean }).ok === true;
    } catch {
      payloadOk = false;
    }
    return {
      healthy: response.ok && payloadOk,
      status: response.status,
      detail: `HTTP ${response.status}${payloadOk ? " ok" : " not-ready"}`,
    };
  } catch (error) {
    return { healthy: false, status: null, detail: String(error).slice(0, 180) };
  }
}

async function notifyCaptureGrowth(
  finding: CaptureGrowthFinding,
  eventId: string,
): Promise<boolean> {
  const message = [
    "🚨 Cumulative-prefix capture growth detected",
    `Source: ${finding.current.sourceIdentity}`,
    `Runs: ${finding.overlapping.runId} and ${finding.current.runId}`,
    `Ranges: [${finding.overlapping.fromOffset}, ${finding.overlapping.toOffset}) and [${finding.current.fromOffset}, ${finding.current.toOffset})`,
    `Overlap: ${finding.overlapBytes} bytes`,
    "Capture replay may be inflating the session index. Stop replay and inspect the source cursor.",
  ].join("\n");
  const receipt = await sendHardAlert({
    eventId,
    source: "typesense-recovery-capture-growth",
    message,
    latchKey: `typesense-recovery:capture-growth:${finding.current.sourceIdentity}`,
    quietWindowMs: CAPTURE_INCIDENT_QUIET_MS,
    attemptCap: HARD_ALERT_ATTEMPT_CAP,
  });
  return receipt.sent;
}

async function notifyStartupBudget(
  assessment: StartupBudgetAssessment,
  detail: string,
): Promise<boolean> {
  const eventId = stableAlertId(
    `search-startup-budget:${assessment.target}:${assessment.unavailableSince}`,
  );
  const message = [
    "🚨 Search startup budget exceeded",
    `Target: ${assessment.target}`,
    `Engine: ${assessment.engine}`,
    `Unavailable: ${Math.floor(assessment.unavailableForMs / 1000)}s`,
    `Budget: ${Math.floor(assessment.budgetMs / 1000)}s`,
    `Probe: ${detail}`,
    "Session search stays on SQLite. Other Typesense search collections remain unavailable until recovery.",
  ].join("\n");
  const receipt = await sendHardAlert({
    eventId,
    source: "typesense-recovery-startup-budget",
    message,
    latchKey: `typesense-recovery:startup-budget:${assessment.target}`,
    quietWindowMs: STARTUP_INCIDENT_QUIET_MS,
    attemptCap: HARD_ALERT_ATTEMPT_CAP,
  });
  return receipt.sent;
}

export async function readTypesenseRecoveryHealth(
  store: SearchMaintenanceStateStore = stateStore(),
  reportedAt = Date.now(),
): Promise<{
  startupBudget: StartupBudgetState | null;
  startupBudgetMs: number;
  search: SearchProjectionHealth | null;
}> {
  const [startupRaw, searchRaw] = await Promise.all([
    store.get(STARTUP_BUDGET_STATE_KEY),
    store.get(SEARCH_HEALTH_KEY),
  ]);
  const startupBudget = parseJson<StartupBudgetState | null>(startupRaw, null);
  const storedSearch = parseJson<SearchProjectionHealth | null>(searchRaw, null);
  const observedAt = storedSearch ? Date.parse(storedSearch.freshness.observedAt) : Number.NaN;
  const observationAgeMs = Number.isFinite(observedAt)
    ? Math.max(0, reportedAt - observedAt)
    : Number.MAX_SAFE_INTEGER;
  const stale = startupBudget !== null || observationAgeMs > 2 * 60_000;
  const search = storedSearch
    ? {
        ...storedSearch,
        ok: storedSearch.ok && !stale,
        detail: stale
          ? `stale search health; last success=${storedSearch.freshness.observedAt}; ${storedSearch.detail}`
          : storedSearch.detail,
        freshness: {
          ...storedSearch.freshness,
          reportedAt: new Date(reportedAt).toISOString(),
          observationAgeMs,
          stale,
        },
      }
    : null;
  return {
    startupBudget,
    startupBudgetMs: TYPESENSE_STARTUP_BUDGET_MS,
    search,
  };
}

export interface CaptureGrowthCheckReceipt {
  checked: boolean;
  finding: CaptureGrowthFinding | null;
  alerted: boolean;
  error?: string;
}

// Replaces the old per-source Inngest concurrency key. Captures for one source
// update a read-modify-write ledger, so this process applies them in order.
const captureGrowthQueues = new Map<string, Promise<unknown>>();

function serializeBySource<T>(
  sourceIdentity: string,
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const previous = captureGrowthQueues.get(sourceIdentity) ?? Promise.resolve();
  // The timeout applies inside the queue, so a hung store call releases the
  // next capture for this source instead of blocking it forever.
  const timed = () => withTimeout(operation(), timeoutMs);
  const result = previous.then(timed, timed);
  const tail = result.catch(() => undefined);
  captureGrowthQueues.set(sourceIdentity, tail);
  void tail.then(() => {
    if (captureGrowthQueues.get(sourceIdentity) === tail) {
      captureGrowthQueues.delete(sourceIdentity);
    }
  });
  return result;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`capture growth check timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Delivery shells out to the notify CLI and needs retries, so a finding goes to
// a durable function instead of running inside the capture's time budget.
async function queueCaptureGrowthAlert(
  finding: CaptureGrowthFinding,
  eventId: string,
): Promise<boolean> {
  await inngest.send({
    id: eventId,
    name: "search/capture-growth.detected",
    data: { event_id: eventId, finding },
  });
  return true;
}

/**
 * Cumulative-prefix growth check, run inline by memory/run.captured.
 *
 * This used to be its own `search/capture-prefix-growth-alert` function on the
 * same event, which doubled queue work per capture. The ledger check runs here;
 * only a finding costs a queue entry, for `search/capture-growth-notify`. It
 * never throws: a slow or unavailable state store must not hold back session
 * indexing.
 */
export async function checkCaptureGrowthForRun(
  data: Record<string, unknown>,
  dependencies: Partial<CaptureGrowthDependencies> & { timeoutMs?: number } = {},
): Promise<CaptureGrowthCheckReceipt> {
  const segment = captureSegment(data);
  if (!segment || segment.toOffset <= segment.fromOffset) {
    return { checked: false, finding: null, alerted: false };
  }

  try {
    const result = await serializeBySource(
      segment.sourceIdentity,
      () =>
        processCaptureGrowth(data, {
          store: dependencies.store ?? stateStore(),
          notify: dependencies.notify ?? queueCaptureGrowthAlert,
          resolve:
            dependencies.resolve ??
            (async (sourceIdentity) => {
              await resolveHardAlert({
                latchKey: `typesense-recovery:capture-growth:${sourceIdentity}`,
              });
            }),
          now: dependencies.now ?? Date.now,
        }),
      dependencies.timeoutMs ?? CAPTURE_GROWTH_CHECK_TIMEOUT_MS,
    );
    if (result.finding) {
      await emitOtelEvent({
        level: "fatal",
        source: "system-bus",
        component: "typesense-recovery-alerts",
        action: "search.capture.cumulative_prefix_growth",
        success: false,
        metadata: result,
      });
    }
    return result;
  } catch (error) {
    const message = String(error).slice(0, 180);
    await emitOtelEvent({
      level: "warn",
      source: "system-bus",
      component: "typesense-recovery-alerts",
      action: "search.capture.cumulative_prefix_growth.check_failed",
      success: false,
      metadata: { run_id: segment.runId, source_identity: segment.sourceIdentity, error: message },
    });
    return { checked: false, finding: null, alerted: false, error: message };
  }
}

export const captureGrowthNotify = inngest.createFunction(
  { id: "search/capture-growth-notify", retries: 3 },
  { event: "search/capture-growth.detected" },
  async ({ event, step }) => {
    const sent = await step.run("send-hard-alert", () =>
      notifyCaptureGrowth(event.data.finding, event.data.event_id)
    );
    return { event_id: event.data.event_id, sent };
  },
);

export const typesenseStartupBudgetCheck = inngest.createFunction(
  { id: "search/typesense-startup-budget", concurrency: { limit: 1 } },
  { cron: "*/1 * * * *" },
  async ({ step }) => {
    const result = await step.run("check-typesense-startup-budget", () =>
      processStartupBudget({
        store: stateStore(),
        probe: probeTypesenseHealth,
        readProjection: async () => readSearchProjectionHealth(SESSION_INDEX_PATH),
        notify: notifyStartupBudget,
        resolve: async () => {
          await resolveHardAlert({
            latchKey: "typesense-recovery:startup-budget:typesense:process",
          });
        },
        now: Date.now,
        budgetMs: TYPESENSE_STARTUP_BUDGET_MS,
      })
    );
    await step.run("emit-startup-budget-otel", () =>
      emitOtelEvent({
        level: result.assessment.exceeded ? "fatal" : result.targetHealthy ? "info" : "warn",
        source: "system-bus",
        component: "typesense-recovery-alerts",
        action: "search.index.startup_budget.checked",
        success: result.targetHealthy,
        metadata: result,
      })
    );
    return result;
  },
);

export const __typesenseRecoveryAlertTestUtils = {
  CAPTURE_LEDGER_PREFIX,
  CAPTURE_INCIDENT_QUIET_MS,
  STARTUP_BUDGET_STATE_KEY,
  SEARCH_HEALTH_KEY,
  captureSegment,
};
