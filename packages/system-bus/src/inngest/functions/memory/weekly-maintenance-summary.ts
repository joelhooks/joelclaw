import Redis from "ioredis";
import { inngest } from "../../client";
import * as typesense from "../../../lib/typesense";
import { emitOtelEvent } from "../../../observability/emit";

const OTEL_QUERY_BY = "action,error,component,source,metadata_json,search_text";
const OTEL_PER_PAGE = 100;

type WeeklyNightlyStats = {
  runs: number;
  failedRuns: number;
  mergeCount: number;
  staleTaggedCount: number;
  lastRunAt: number | null;
};

let redisClient: Redis | null = null;

function getRedisClient(): Redis {
  if (!redisClient) {
    const isTestEnv = process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";
    redisClient = new Redis({
      host: process.env.REDIS_HOST ?? "localhost",
      port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
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
        const [pendingBacklog, llmPendingBacklog, memoryCount, stale] = await Promise.all([
          redis.llen("memory:review:pending"),
          redis.llen("memory:review:llm-pending"),
          countMemoryDocuments(),
          countMemoryDocuments("stale:=true"),
        ]);

        return {
          windowHours: 7 * 24,
          nightly,
          triageBacklog: {
            pending: pendingBacklog,
            llmPending: llmPendingBacklog,
            total: pendingBacklog + llmPendingBacklog,
          },
          memory: {
            count: memoryCount.count,
            staleCount: stale.count,
            staleSupported: stale.supported,
            staleReason: stale.reason,
            staleRatio:
              memoryCount.count > 0 && stale.supported
                ? stale.count / memoryCount.count
                : 0,
          },
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
