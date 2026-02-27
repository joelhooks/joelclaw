import Redis from "ioredis";
import { getRedisPort } from "../../../lib/redis";
import * as typesense from "../../../lib/typesense";
import { emitOtelEvent } from "../../../observability/emit";
import { inngest } from "../../client";

const OTEL_QUERY_BY = "action,error,component,source,metadata_json,search_text";
const OTEL_PER_PAGE = 100;

type WeeklyNightlyStats = {
  runs: number;
  failedRuns: number;
  mergeCount: number;
  staleTaggedCount: number;
  lastRunAt: number | null;
};

type CategoryBucket = {
  id: string;
  count: number;
  ratio: number;
};

type CategorySummary = {
  supported: boolean;
  reason?: string;
  buckets: CategoryBucket[];
  categorizedCount: number;
  uncategorizedCount: number;
  coverageRatio: number;
  confidence: {
    supported: boolean;
    reason?: string;
    knownCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    highRatio: number;
  };
};

type WriteGateSummary = {
  supported: boolean;
  reason?: string;
  allowCount: number;
  holdCount: number;
  discardCount: number;
  fallbackCount: number;
  totalWithVerdict: number;
  holdRatio: number;
  discardRatio: number;
  fallbackRate: number;
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
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function countMemoryDocuments(filterBy?: string): Promise<{ count: number; supported: boolean; reason?: string }> {
  try {
    const result = await typesense.search({
      collection: "memory_observations",
      q: "*",
      query_by: "observation",
      per_page: 1,
      filter_by: filterBy,
    });
    return { count: result.found ?? 0, supported: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (filterBy && /filter field named `stale`/iu.test(message)) {
      return { count: 0, supported: false, reason: "stale field missing in Typesense schema" };
    }
    throw error;
  }
}

async function countMemoryDocumentsByField(
  filterBy: string,
  fieldName: string,
): Promise<{ count: number; supported: boolean; reason?: string }> {
  try {
    const result = await typesense.search({
      collection: "memory_observations",
      q: "*",
      query_by: "observation",
      per_page: 1,
      filter_by: filterBy,
    });
    return { count: result.found ?? 0, supported: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes(`filter field named \`${fieldName.toLowerCase()}\``)) {
      return {
        count: 0,
        supported: false,
        reason: `${fieldName} field missing in Typesense schema`,
      };
    }
    throw error;
  }
}

async function collectCategorySummary(memoryCount: number): Promise<CategorySummary> {
  let buckets: CategoryBucket[] = [];
  let categorizedCount = 0;
  let uncategorizedCount = memoryCount;
  let coverageRatio = 0;
  let categorySupported = true;
  let categoryReason: string | undefined;

  try {
    const facetResult = await typesense.search({
      collection: "memory_observations",
      q: "*",
      query_by: "observation",
      per_page: 1,
      facet_by: "category_id",
      max_facet_values: 50,
      include_fields: "id,category_id",
    });

    const categoryFacet = (facetResult.facet_counts ?? []).find(
      (facet) => facet.field_name === "category_id"
    );

    buckets = (categoryFacet?.counts ?? [])
      .map((entry) => {
        const id = String(entry.value ?? "").trim();
        const count = asFiniteNumber(entry.count, 0);
        return {
          id,
          count,
          ratio: memoryCount > 0 ? count / memoryCount : 0,
        };
      })
      .filter((entry) => entry.id.length > 0 && entry.count > 0)
      .sort((a, b) => b.count - a.count);

    categorizedCount = buckets.reduce((sum, entry) => sum + entry.count, 0);
    uncategorizedCount = Math.max(0, memoryCount - categorizedCount);
    coverageRatio = memoryCount > 0 ? categorizedCount / memoryCount : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/facet|category_id/iu.test(message)) {
      categorySupported = false;
      categoryReason = "category_id facet unsupported or missing in Typesense schema";
    } else {
      throw error;
    }
  }

  const [high, medium, low] = await Promise.all([
    countMemoryDocumentsByField("category_confidence:>=0.8", "category_confidence"),
    countMemoryDocumentsByField("category_confidence:>=0.6 && category_confidence:<0.8", "category_confidence"),
    countMemoryDocumentsByField("category_confidence:<0.6", "category_confidence"),
  ]);

  const confidenceSupported = high.supported && medium.supported && low.supported;
  const knownCount = high.count + medium.count + low.count;

  return {
    supported: categorySupported,
    reason: categoryReason,
    buckets,
    categorizedCount,
    uncategorizedCount,
    coverageRatio,
    confidence: {
      supported: confidenceSupported,
      reason: confidenceSupported ? undefined : high.reason ?? medium.reason ?? low.reason,
      knownCount,
      highCount: high.count,
      mediumCount: medium.count,
      lowCount: low.count,
      highRatio: knownCount > 0 ? high.count / knownCount : 0,
    },
  };
}

async function collectWriteGateSummary(): Promise<WriteGateSummary> {
  const [allow, hold, discard, fallback] = await Promise.all([
    countMemoryDocumentsByField("write_verdict:=allow", "write_verdict"),
    countMemoryDocumentsByField("write_verdict:=hold", "write_verdict"),
    countMemoryDocumentsByField("write_verdict:=discard", "write_verdict"),
    countMemoryDocumentsByField("write_gate_fallback:=true", "write_gate_fallback"),
  ]);

  const supported = allow.supported && hold.supported && discard.supported && fallback.supported;
  const totalWithVerdict = allow.count + hold.count + discard.count;

  return {
    supported,
    reason: supported ? undefined : allow.reason ?? hold.reason ?? discard.reason ?? fallback.reason,
    allowCount: allow.count,
    holdCount: hold.count,
    discardCount: discard.count,
    fallbackCount: fallback.count,
    totalWithVerdict,
    holdRatio: totalWithVerdict > 0 ? hold.count / totalWithVerdict : 0,
    discardRatio: totalWithVerdict > 0 ? discard.count / totalWithVerdict : 0,
    fallbackRate: totalWithVerdict > 0 ? fallback.count / totalWithVerdict : 0,
  };
}

async function collectNightlyStats(cutoffUnix: number): Promise<WeeklyNightlyStats> {
  const filterBy = `timestamp:>=${cutoffUnix} && component:=nightly-maintenance && action:=[nightly-maintenance.completed,nightly-maintenance.failed]`;
  let page = 1;
  let runs = 0;
  let failedRuns = 0;
  let mergeCount = 0;
  let staleTaggedCount = 0;
  let lastRunAt: number | null = null;

  for (;;) {
    const response = await typesense.search({
      collection: "otel_events",
      q: "*",
      query_by: OTEL_QUERY_BY,
      per_page: OTEL_PER_PAGE,
      page,
      sort_by: "timestamp:desc",
      include_fields: "id,timestamp,action,metadata_json",
      filter_by: filterBy,
    });

    const hits = Array.isArray(response.hits) ? response.hits : [];
    for (const hit of hits) {
      const document = (hit.document ?? {}) as Record<string, unknown>;
      const action = typeof document.action === "string" ? document.action : "";
      const timestamp = asFiniteNumber(document.timestamp, NaN);
      if (Number.isFinite(timestamp)) {
        lastRunAt = lastRunAt == null ? timestamp : Math.max(lastRunAt, timestamp);
      }

      if (action === "nightly-maintenance.failed") {
        failedRuns += 1;
        continue;
      }

      if (action !== "nightly-maintenance.completed") {
        continue;
      }

      runs += 1;
      const metadata = parseMetadataJson(document.metadata_json);
      mergeCount += asFiniteNumber(metadata.mergeCount, asFiniteNumber(metadata.merged, 0));
      staleTaggedCount += asFiniteNumber(metadata.staleCount, asFiniteNumber(metadata.staleTagged, 0));
    }

    if (hits.length < OTEL_PER_PAGE) break;
    page += 1;
  }

  return {
    runs,
    failedRuns,
    mergeCount,
    staleTaggedCount,
    lastRunAt,
  };
}

export const weeklyMaintenanceSummary = inngest.createFunction(
  {
    id: "system/memory-weekly-maintenance-summary",
    name: "Memory Weekly Maintenance Summary",
    concurrency: 1,
  },
  [{ cron: "0 13 * * 1" }, { event: "memory/maintenance.weekly.requested" }],
  async ({ event, step }) => {
    const startedAt = Date.now();
    const eventId = (event as { id?: string }).id ?? null;

    await step.run("otel-weekly-maintenance-start", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "weekly-maintenance",
        action: "weekly-maintenance.started",
        success: true,
        metadata: {
          eventId,
        },
      });
    });

    try {
      const summary = await step.run("collect-weekly-maintenance-stats", async () => {
        const cutoffUnix = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const nightly = await collectNightlyStats(cutoffUnix);
        const redis = getRedisClient();
        const [pendingBacklog, llmPendingBacklog, memoryCountState, stale] = await Promise.all([
          redis.llen("memory:review:pending"),
          redis.llen("memory:review:llm-pending"),
          countMemoryDocuments(),
          countMemoryDocuments("stale:=true"),
        ]);

        const categorySummary = await collectCategorySummary(memoryCountState.count);
        const writeGateSummary = await collectWriteGateSummary();

        return {
          windowHours: 7 * 24,
          nightly,
          triageBacklog: {
            pending: pendingBacklog,
            llmPending: llmPendingBacklog,
            total: pendingBacklog + llmPendingBacklog,
          },
          memory: {
            count: memoryCountState.count,
            staleCount: stale.count,
            staleSupported: stale.supported,
            staleReason: stale.reason,
            staleRatio:
              memoryCountState.count > 0 && stale.supported
                ? stale.count / memoryCountState.count
                : 0,
          },
          categories: categorySummary,
          writeGate: writeGateSummary,
        };
      });

      await step.run("otel-weekly-maintenance-completed", async () => {
        await emitOtelEvent({
          level: summary.nightly.failedRuns > 0 ? "warn" : "info",
          source: "worker",
          component: "weekly-maintenance",
          action: "weekly-maintenance.completed",
          success: summary.nightly.failedRuns === 0,
          duration_ms: Date.now() - startedAt,
          metadata: {
            eventId,
            observationCount: summary.memory.count,
            proposalCount: summary.triageBacklog.total,
            mergeCount: summary.nightly.mergeCount,
            staleCount: summary.memory.staleCount,
            staleTaggedCount: summary.nightly.staleTaggedCount,
            nightlyRuns: summary.nightly.runs,
            nightlyFailedRuns: summary.nightly.failedRuns,
            lastNightlyRunAt: summary.nightly.lastRunAt,
            triageBacklog: summary.triageBacklog,
            staleRatio: summary.memory.staleRatio,
            categoryCoverageRatio: summary.categories.coverageRatio,
            categorizedCount: summary.categories.categorizedCount,
            uncategorizedCount: summary.categories.uncategorizedCount,
            categoryConfidenceHighRatio: summary.categories.confidence.highRatio,
            categoryConfidenceKnownCount: summary.categories.confidence.knownCount,
            topCategories: summary.categories.buckets.slice(0, 5),
            writeGateAllowCount: summary.writeGate.allowCount,
            writeGateHoldCount: summary.writeGate.holdCount,
            writeGateDiscardCount: summary.writeGate.discardCount,
            writeGateFallbackCount: summary.writeGate.fallbackCount,
            writeGateFallbackRate: summary.writeGate.fallbackRate,
          },
        });
      });

      await step.sendEvent("emit-weekly-category-summary", {
        name: "memory/category-summary.weekly.created",
        data: {
          generatedAt: new Date().toISOString(),
          windowHours: summary.windowHours,
          memoryCount: summary.memory.count,
          categoryCoverageRatio: summary.categories.coverageRatio,
          categories: summary.categories.buckets,
          confidence: summary.categories.confidence,
          writeGate: summary.writeGate,
        },
      });

      await step.run("otel-weekly-category-summary-emitted", async () => {
        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "weekly-maintenance",
          action: "weekly-category-summary.emitted",
          success: true,
          metadata: {
            eventId,
            categoryCoverageRatio: summary.categories.coverageRatio,
            topCategories: summary.categories.buckets.slice(0, 5),
            writeGateFallbackRate: summary.writeGate.fallbackRate,
          },
        });
      });

      return {
        status: "ok",
        ...summary,
      };
    } catch (error) {
      await step.run("otel-weekly-maintenance-failed", async () => {
        await emitOtelEvent({
          level: "error",
          source: "worker",
          component: "weekly-maintenance",
          action: "weekly-maintenance.failed",
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
