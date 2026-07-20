import { createHash } from "node:crypto";
import { getRedisClient } from "../../lib/redis";
import {
  assessStartupBudget,
  type CaptureGrowthFinding,
  type CaptureSegment,
  captureGrowthIncidentAlertId,
  detectCaptureGrowth,
  parseStartupBudgetMs,
  readSearchProjectionHealth,
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
const CAPTURE_ALERT_PREFIX = "search-maintenance:capture-alert:";
const STARTUP_BUDGET_STATE_KEY = "search-maintenance:startup-budget:typesense-runs-dev";
const SEARCH_HEALTH_KEY = "search-maintenance:health:runs-dev";
const CAPTURE_LEDGER_TTL_SECONDS = 90 * 24 * 60 * 60;
const CAPTURE_ALERT_TTL_SECONDS = 90 * 24 * 60 * 60;
// 24h, not 60m: during a bulk replay (~90 sources, 2026-07-20) hourly
// re-alerts produced sustained DM spam at ~1.5/min. Detection still records
// every finding (incident store + fatal OTEL); the DM fires once per source
// per day until the replay source is fixed.
const CAPTURE_INCIDENT_QUIET_MS = 24 * 60 * 60_000;
const MAX_CAPTURE_SEGMENTS_PER_SOURCE = 2_048;
const TYPESENSE_STARTUP_BUDGET_MS = parseStartupBudgetMs(
  process.env.TYPESENSE_STARTUP_BUDGET_MS,
);

export interface SearchMaintenanceStateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CaptureGrowthDependencies {
  store: SearchMaintenanceStateStore;
  notify: (finding: CaptureGrowthFinding, eventId: string) => Promise<void>;
  now: () => number;
}

type CaptureGrowthIncident = {
  eventId: string;
  startedAt: number;
  lastOverlapAt: number;
  confirmedAt: number | null;
};

export interface StartupBudgetDependencies {
  store: SearchMaintenanceStateStore;
  probe: () => Promise<{ healthy: boolean; status: number | null; detail: string }>;
  readProjection: () => Promise<SearchProjectionHealth>;
  notify: (assessment: StartupBudgetAssessment, detail: string) => Promise<void>;
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

  const incidentKey = `${CAPTURE_ALERT_PREFIX}${keySuffix}`;
  if (!finding) {
    await dependencies.store.delete(incidentKey);
    return { checked: true, finding: null, alerted: false };
  }

  const now = dependencies.now();
  const previousIncident = parseJson<CaptureGrowthIncident | null>(
    await dependencies.store.get(incidentKey),
    null,
  );
  const sameIncident = previousIncident !== null
    && (
      previousIncident.confirmedAt === null ||
      now - previousIncident.lastOverlapAt < CAPTURE_INCIDENT_QUIET_MS
    );
  const incident: CaptureGrowthIncident = sameIncident
    ? { ...previousIncident, lastOverlapAt: now }
    : {
        eventId: captureGrowthIncidentAlertId(current.sourceIdentity, now, current.runId),
        startedAt: now,
        lastOverlapAt: now,
        confirmedAt: null,
      };
  await dependencies.store.set(
    incidentKey,
    JSON.stringify(incident),
    CAPTURE_ALERT_TTL_SECONDS,
  );
  if (incident.confirmedAt !== null) {
    return { checked: true, finding, alerted: false };
  }

  await dependencies.notify(finding, incident.eventId);
  await dependencies.store.set(
    incidentKey,
    JSON.stringify({ ...incident, confirmedAt: now }),
    CAPTURE_ALERT_TTL_SECONDS,
  );
  return { checked: true, finding, alerted: true };
}

export async function processStartupBudget(
  dependencies: StartupBudgetDependencies,
): Promise<{
  probe: { healthy: boolean; status: number | null; detail: string };
  assessment: StartupBudgetAssessment;
  projection: SearchProjectionHealth | null;
  collectionHealthy: boolean;
  availabilityDetail: string;
}> {
  const checkedAt = dependencies.now();
  const probe = await dependencies.probe();
  let projection: SearchProjectionHealth | null = null;
  let projectionError: string | null = null;
  if (probe.healthy) {
    try {
      projection = await dependencies.readProjection();
      await dependencies.store.set(SEARCH_HEALTH_KEY, JSON.stringify(projection));
    } catch (error) {
      projectionError = String(error).slice(0, 180);
    }
  }
  const collectionHealthy = probe.healthy && projectionError === null;
  const availabilityDetail = projectionError
    ? `${probe.detail}; runs_dev query failed: ${projectionError}`
    : probe.detail;
  const previous = parseJson<StartupBudgetState | null>(
    await dependencies.store.get(STARTUP_BUDGET_STATE_KEY),
    null,
  );
  const assessment = assessStartupBudget({
    target: "typesense:runs_dev",
    engine: "typesense",
    healthy: collectionHealthy,
    checkedAt,
    budgetMs: dependencies.budgetMs,
    previous,
  });

  if (assessment.nextState) {
    const durableState = assessment.shouldAlert
      ? { ...assessment.nextState, alertedAt: null }
      : assessment.nextState;
    await dependencies.store.set(STARTUP_BUDGET_STATE_KEY, JSON.stringify(durableState));
  } else {
    await dependencies.store.delete(STARTUP_BUDGET_STATE_KEY);
  }

  if (assessment.shouldAlert) {
    await dependencies.notify(assessment, availabilityDetail);
    await dependencies.store.set(
      STARTUP_BUDGET_STATE_KEY,
      JSON.stringify({ ...assessment.nextState, alertedAt: checkedAt }),
    );
  }

  return { probe, assessment, projection, collectionHealthy, availabilityDetail };
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
): Promise<void> {
  const message = [
    "🚨 Cumulative-prefix capture growth detected",
    `Source: ${finding.current.sourceIdentity}`,
    `Runs: ${finding.overlapping.runId} and ${finding.current.runId}`,
    `Ranges: [${finding.overlapping.fromOffset}, ${finding.overlapping.toOffset}) and [${finding.current.fromOffset}, ${finding.current.toOffset})`,
    `Overlap: ${finding.overlapBytes} bytes`,
    "Capture replay may be inflating the session index. Stop replay and inspect the source cursor.",
  ].join("\n");
  await sendHardAlert({
    eventId,
    source: "typesense-recovery-capture-growth",
    message,
  });
}

async function notifyStartupBudget(
  assessment: StartupBudgetAssessment,
  detail: string,
): Promise<void> {
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
    "Raw Run JSONL remains the source of truth. Use the raw fallback while the index recovers.",
  ].join("\n");
  await sendHardAlert({
    eventId,
    source: "typesense-recovery-startup-budget",
    message,
  });
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

export const capturePrefixGrowthAlert = inngest.createFunction(
  {
    id: "search/capture-prefix-growth-alert",
    concurrency: { limit: 1, key: "event.data.source_identity" },
  },
  { event: "memory/run.captured" },
  async ({ event, step }) => {
    const result = await step.run("check-capture-ranges", () =>
      processCaptureGrowth(event.data as Record<string, unknown>, {
        store: stateStore(),
        notify: notifyCaptureGrowth,
        now: Date.now,
      })
    );
    if (result.finding) {
      await step.run("emit-capture-growth-otel", () =>
        emitOtelEvent({
          level: "fatal",
          source: "system-bus",
          component: "typesense-recovery-alerts",
          action: "search.capture.cumulative_prefix_growth",
          success: false,
          metadata: result,
        })
      );
    }
    return result;
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
        readProjection: () => readSearchProjectionHealth(typesense.typesenseRequest),
        notify: notifyStartupBudget,
        now: Date.now,
        budgetMs: TYPESENSE_STARTUP_BUDGET_MS,
      })
    );
    await step.run("emit-startup-budget-otel", () =>
      emitOtelEvent({
        level: result.assessment.exceeded ? "fatal" : result.collectionHealthy ? "info" : "warn",
        source: "system-bus",
        component: "typesense-recovery-alerts",
        action: "search.index.startup_budget.checked",
        success: result.collectionHealthy,
        metadata: result,
      })
    );
    return result;
  },
);

export const __typesenseRecoveryAlertTestUtils = {
  CAPTURE_LEDGER_PREFIX,
  CAPTURE_ALERT_PREFIX,
  CAPTURE_INCIDENT_QUIET_MS,
  STARTUP_BUDGET_STATE_KEY,
  SEARCH_HEALTH_KEY,
  captureSegment,
};
