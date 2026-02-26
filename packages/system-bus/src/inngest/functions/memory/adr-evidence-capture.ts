import Redis from "ioredis";
import { inngest } from "../../client";
import * as typesense from "../../../lib/typesense";
import { emitOtelEvent } from "../../../observability/emit";
import { getRedisPort } from "../../../lib/redis";

const OTEL_QUERY_BY = "action,error,component,source,metadata_json,search_text";
const OTEL_PER_PAGE = 100;
const ADR_EVIDENCE_WINDOW_DAYS = 7;
const ADR_EVIDENCE_HASH_KEY = "memory:adr-evidence:daily";

type DailySnapshot = {
  date: string;
  generatedAt: string;
  windowHours: number;
  adr0095: {
    observeRuns: number;
    categoryEvidenceRuns: number;
    totalStoredCount: number;
    totalCategorizedCount: number;
    categoryCoverageRatio: number;
    taxonomyVersions: string[];
    weeklyCategorySummaryEvents: number;
  };
  adr0096: {
    recallEvents: number;
    prefetchEvents: number;
    recallWithBudgetDiagnostics: number;
    prefetchWithBudgetDiagnostics: number;
    recallBudgetBreakdown: Array<{ profile: string; count: number; avgDurationMs: number }>;
    prefetchBudgetBreakdown: Array<{ profile: string; count: number; avgDurationMs: number }>;
    deepVsLeanLatencyDeltaMs: number | null;
  };
};

type BudgetRollup = {
  totalEvents: number;
  withDiagnostics: number;
  byProfile: Array<{ profile: string; count: number; avgDurationMs: number }>;
};

let redisClient: Redis | null = null;

function getRedisClient(): Redis {
  if (!redisClient) {
    const isTestEnv = process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";
    redisClient = new Redis({
      host: process.env.REDIS_HOST ?? "localhost",
      port: getRedisPort(),
      lazyConnect: true,
      retryStrategy: isTestEnv ? () => null : undefined,
    });
    redisClient.on("error", () => {});
  }
  return redisClient;
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function parseMetadataJson(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object") {
    return input as Record<string, unknown>;
  }
  if (typeof input !== "string" || input.trim().length === 0) return {};

  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function normalizeBudgetProfile(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  if (normalized === "lean") return "lean";
  if (normalized === "balanced") return "balanced";
  if (normalized === "deep") return "deep";
  if (normalized === "auto") return "auto";
  return "unknown";
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function getRecentDateStrings(anchorIsoDate: string, days: number): string[] {
  const anchor = new Date(`${anchorIsoDate}T00:00:00.000Z`);
  const result: string[] = [];

  for (let offset = 0; offset < days; offset += 1) {
    const current = new Date(anchor);
    current.setUTCDate(anchor.getUTCDate() - offset);
    result.push(toIsoDate(current));
  }

  return result;
}

async function countOtelEvents(filterBy: string): Promise<number> {
  const result = await typesense.search({
    collection: "otel_events",
    q: "*",
    query_by: OTEL_QUERY_BY,
    per_page: 1,
    filter_by: filterBy,
  });
  return result.found ?? 0;
}

async function collectObserveCategoryEvidence(cutoffUnix: number): Promise<DailySnapshot["adr0095"]> {
  const filterBy = `timestamp:>=${cutoffUnix} && component:=observe && action:=observe.store.completed && success:=true`;

  let page = 1;
  let observeRuns = 0;
  let categoryEvidenceRuns = 0;
  let totalStoredCount = 0;
  let totalCategorizedCount = 0;
  const taxonomyVersions = new Set<string>();

  for (;;) {
    const response = await typesense.search({
      collection: "otel_events",
      q: "*",
      query_by: OTEL_QUERY_BY,
      per_page: OTEL_PER_PAGE,
      page,
      sort_by: "timestamp:desc",
      include_fields: "id,metadata_json",
      filter_by: filterBy,
    });

    const hits = Array.isArray(response.hits) ? response.hits : [];
    for (const hit of hits) {
      observeRuns += 1;
      const metadata = parseMetadataJson(hit.document?.metadata_json);

      const storedCount = asFiniteNumber(metadata.storedCount, 0);
      const categorizedCount = asFiniteNumber(metadata.categorizedCount, 0);
      totalStoredCount += storedCount;
      totalCategorizedCount += categorizedCount;

      const hasCategoryEvidence =
        metadata.categoryBuckets != null
        || metadata.categorySourceBuckets != null
        || metadata.categorizedCount != null
        || metadata.taxonomyVersions != null;
      if (hasCategoryEvidence) {
        categoryEvidenceRuns += 1;
      }

      if (Array.isArray(metadata.taxonomyVersions)) {
        for (const version of metadata.taxonomyVersions) {
          if (typeof version === "string" && version.trim().length > 0) {
            taxonomyVersions.add(version.trim());
          }
        }
      }
    }

    if (hits.length < OTEL_PER_PAGE) break;
    page += 1;
  }

  const weeklyCategorySummaryEvents = await countOtelEvents(
    `timestamp:>=${cutoffUnix} && component:=weekly-maintenance && action:=weekly-category-summary.emitted && success:=true`
  );

  return {
    observeRuns,
    categoryEvidenceRuns,
    totalStoredCount,
    totalCategorizedCount,
    categoryCoverageRatio: totalStoredCount > 0 ? totalCategorizedCount / totalStoredCount : 0,
    taxonomyVersions: [...taxonomyVersions].sort(),
    weeklyCategorySummaryEvents,
  };
}

async function collectBudgetEvidenceForAction(
  cutoffUnix: number,
  component: string,
  action: string,
): Promise<BudgetRollup> {
  const filterBy = `timestamp:>=${cutoffUnix} && component:=${component} && action:=${action} && success:=true`;

  let page = 1;
  let totalEvents = 0;
  let withDiagnostics = 0;
  const rollup = new Map<string, { count: number; durationMs: number }>();

  for (;;) {
    const response = await typesense.search({
      collection: "otel_events",
      q: "*",
      query_by: OTEL_QUERY_BY,
      per_page: OTEL_PER_PAGE,
      page,
      sort_by: "timestamp:desc",
      include_fields: "id,duration_ms,metadata_json",
      filter_by: filterBy,
    });

    const hits = Array.isArray(response.hits) ? response.hits : [];

    for (const hit of hits) {
      totalEvents += 1;
      const doc = (hit.document ?? {}) as Record<string, unknown>;
      const metadata = parseMetadataJson(doc.metadata_json);

      const profile = normalizeBudgetProfile(
        metadata.budgetApplied ?? metadata.budget_profile ?? metadata.budgetRequested
      );
      const hasDiagnostics =
        profile !== "unknown"
        || typeof metadata.budgetReason === "string"
        || metadata.budgetRequested != null;
      if (hasDiagnostics) {
        withDiagnostics += 1;
      }

      const durationMs = asFiniteNumber(doc.duration_ms, asFiniteNumber(metadata.durationMs, 0));
      const bucket = rollup.get(profile) ?? { count: 0, durationMs: 0 };
      bucket.count += 1;
      bucket.durationMs += durationMs;
      rollup.set(profile, bucket);
    }

    if (hits.length < OTEL_PER_PAGE) break;
    page += 1;
  }

  const byProfile = [...rollup.entries()]
    .map(([profile, value]) => ({
      profile,
      count: value.count,
      avgDurationMs: value.count > 0 ? value.durationMs / value.count : 0,
    }))
    .sort((a, b) => b.count - a.count || a.profile.localeCompare(b.profile));

  return {
    totalEvents,
    withDiagnostics,
    byProfile,
  };
}

function averageDurationByProfile(
  buckets: Array<{ profile: string; count: number; avgDurationMs: number }>,
  profile: string,
): number | null {
  const entry = buckets.find((bucket) => bucket.profile === profile);
  return entry ? entry.avgDurationMs : null;
}

function parseDailySnapshot(raw: string): DailySnapshot | null {
  try {
    const parsed = JSON.parse(raw) as DailySnapshot;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.date !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function persistAndReadWindow(snapshot: DailySnapshot): Promise<{
  daysCaptured: number;
  missingDates: string[];
  windowSnapshots: DailySnapshot[];
}> {
  const redis = getRedisClient();
  await redis.hset(ADR_EVIDENCE_HASH_KEY, snapshot.date, JSON.stringify(snapshot));
  await redis.expire(ADR_EVIDENCE_HASH_KEY, 60 * 24 * 60 * 60);

  const raw = await redis.hgetall(ADR_EVIDENCE_HASH_KEY);
  const byDate = new Map<string, DailySnapshot>();

  for (const [date, value] of Object.entries(raw)) {
    const parsed = parseDailySnapshot(value);
    if (!parsed) continue;
    byDate.set(date, parsed);
  }

  const expectedDates = getRecentDateStrings(snapshot.date, ADR_EVIDENCE_WINDOW_DAYS);
  const windowSnapshots = expectedDates
    .map((date) => byDate.get(date))
    .filter((value): value is DailySnapshot => value != null);
  const missingDates = expectedDates.filter((date) => !byDate.has(date));

  return {
    daysCaptured: windowSnapshots.length,
    missingDates,
    windowSnapshots,
  };
}

export const adrEvidenceCapture = inngest.createFunction(
  {
    id: "system/memory-adr-evidence-capture",
    name: "Memory ADR Evidence Capture",
    concurrency: 1,
  },
  [
    { cron: "15 13 * * *" },
    { event: "memory/adr-evidence.capture.requested" },
  ],
  async ({ event, step }) => {
    const startedAt = Date.now();
    const eventId = (event as { id?: string }).id ?? null;

    await step.run("otel-adr-evidence-start", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "memory-adr-evidence",
        action: "memory.adr_evidence.started",
        success: true,
        metadata: {
          eventId,
        },
      });
    });

    try {
      const summary = await step.run("capture-adr-evidence", async () => {
        const generatedAt = new Date().toISOString();
        const date = generatedAt.slice(0, 10);
        const windowHours = Math.max(1, asFiniteNumber(event.data?.windowHours, 24));
        const cutoffUnix = Math.floor(Date.now() - windowHours * 60 * 60 * 1000);

        const [adr0095, recallBudget, prefetchBudget] = await Promise.all([
          collectObserveCategoryEvidence(cutoffUnix),
          collectBudgetEvidenceForAction(cutoffUnix, "recall-cli", "memory.recall.completed"),
          collectBudgetEvidenceForAction(cutoffUnix, "memory-context-prefetch", "memory.context_prefetch.completed"),
        ]);

        const adr0096: DailySnapshot["adr0096"] = {
          recallEvents: recallBudget.totalEvents,
          prefetchEvents: prefetchBudget.totalEvents,
          recallWithBudgetDiagnostics: recallBudget.withDiagnostics,
          prefetchWithBudgetDiagnostics: prefetchBudget.withDiagnostics,
          recallBudgetBreakdown: recallBudget.byProfile,
          prefetchBudgetBreakdown: prefetchBudget.byProfile,
          deepVsLeanLatencyDeltaMs: (() => {
            const deep = averageDurationByProfile(recallBudget.byProfile, "deep");
            const lean = averageDurationByProfile(recallBudget.byProfile, "lean");
            if (deep == null || lean == null) return null;
            return deep - lean;
          })(),
        };

        const snapshot: DailySnapshot = {
          date,
          generatedAt,
          windowHours,
          adr0095,
          adr0096,
        };

        const window = await persistAndReadWindow(snapshot);
        const ready = window.missingDates.length === 0;

        const adr0095SignalReady =
          ready
          && window.windowSnapshots.some((entry) => entry.adr0095.weeklyCategorySummaryEvents > 0)
          && window.windowSnapshots.every((entry) => entry.adr0095.categoryEvidenceRuns > 0);
        const adr0096SignalReady =
          ready
          && window.windowSnapshots.every((entry) =>
            entry.adr0096.recallWithBudgetDiagnostics > 0
            && entry.adr0096.prefetchWithBudgetDiagnostics > 0
          );

        return {
          snapshot,
          rollingWindow: {
            windowDays: ADR_EVIDENCE_WINDOW_DAYS,
            daysCaptured: window.daysCaptured,
            missingDates: window.missingDates,
            ready,
          },
          gates: {
            adr0095SignalReady,
            adr0096SignalReady,
          },
        };
      });

      await step.sendEvent("emit-adr-evidence-captured", {
        name: "memory/adr-evidence.daily.captured",
        data: {
          generatedAt: summary.snapshot.generatedAt,
          date: summary.snapshot.date,
          windowHours: summary.snapshot.windowHours,
          adr0095: summary.snapshot.adr0095,
          adr0096: summary.snapshot.adr0096,
          rollingWindow: summary.rollingWindow,
          gates: summary.gates,
        },
      });

      await step.run("otel-adr-evidence-completed", async () => {
        await emitOtelEvent({
          level: summary.rollingWindow.ready ? "info" : "debug",
          source: "worker",
          component: "memory-adr-evidence",
          action: "memory.adr_evidence.daily_captured",
          success: true,
          duration_ms: Date.now() - startedAt,
          metadata: {
            eventId,
            date: summary.snapshot.date,
            windowHours: summary.snapshot.windowHours,
            rollingWindow: summary.rollingWindow,
            gates: summary.gates,
            adr0095: {
              observeRuns: summary.snapshot.adr0095.observeRuns,
              categoryEvidenceRuns: summary.snapshot.adr0095.categoryEvidenceRuns,
              categoryCoverageRatio: summary.snapshot.adr0095.categoryCoverageRatio,
              weeklyCategorySummaryEvents: summary.snapshot.adr0095.weeklyCategorySummaryEvents,
            },
            adr0096: {
              recallEvents: summary.snapshot.adr0096.recallEvents,
              prefetchEvents: summary.snapshot.adr0096.prefetchEvents,
              recallWithBudgetDiagnostics: summary.snapshot.adr0096.recallWithBudgetDiagnostics,
              prefetchWithBudgetDiagnostics: summary.snapshot.adr0096.prefetchWithBudgetDiagnostics,
              deepVsLeanLatencyDeltaMs: summary.snapshot.adr0096.deepVsLeanLatencyDeltaMs,
            },
          },
        });
      });

      if (summary.rollingWindow.ready) {
        await step.run("otel-adr-evidence-window7", async () => {
          await emitOtelEvent({
            level: summary.gates.adr0095SignalReady && summary.gates.adr0096SignalReady ? "info" : "warn",
            source: "worker",
            component: "memory-adr-evidence",
            action: "memory.adr_evidence.window7_evaluated",
            success: summary.gates.adr0095SignalReady && summary.gates.adr0096SignalReady,
            metadata: {
              eventId,
              date: summary.snapshot.date,
              rollingWindow: summary.rollingWindow,
              gates: summary.gates,
            },
          });
        });
      }

      return {
        status: "ok",
        ...summary,
      };
    } catch (error) {
      await step.run("otel-adr-evidence-failed", async () => {
        await emitOtelEvent({
          level: "error",
          source: "worker",
          component: "memory-adr-evidence",
          action: "memory.adr_evidence.failed",
          success: false,
          error: error instanceof Error ? error.message : String(error),
          duration_ms: Date.now() - startedAt,
          metadata: {
            eventId,
          },
        });
      });
      throw error;
    }
  }
);
