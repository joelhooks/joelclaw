import Redis from "ioredis";
import { getRedisPort } from "../../lib/redis";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const SELF_HEALING_REDIS_HOST = process.env.REDIS_HOST ?? "localhost";
const SELF_HEALING_REDIS_PORT = getRedisPort();

const GATEWAY_SESSION_SET = "joelclaw:gateway:sessions";
const GATEWAY_EVENT_LIST = "joelclaw:events:gateway";
const GATEWAY_STREAM_KEY = "joelclaw:gateway:messages";
const GATEWAY_PRIORITY_KEY = "joelclaw:gateway:priority";
const GATEWAY_STREAM_GROUP = "gateway-session";

const GATEWAY_HEALING_DOMAIN = "gateway-bridge";
const GATEWAY_HEALTH_EVENT = "system/gateway.bridge.health.requested";
const SELF_HEALING_REQUEST_EVENT = "system/self.healing.requested";

const HEALING_RECONCILE_COOLDOWN_SECONDS = 15 * 60;
const OTEL_GUARD_COOLDOWN_SECONDS = 10 * 60;
const STALE_STREAM_AGE_MS = 6 * 60 * 60 * 1000;
const STALE_PENDING_IDLE_MS = 15 * 60 * 1000;
const EVENT_LIST_SAMPLE_LIMIT = 64;
const PENDING_SCAN_LIMIT = 256;
const ORPHAN_PRIORITY_SCAN_LIMIT = 512;
const STREAM_STALE_SCAN_LIMIT = 256;
const MAX_SESSION_COUNT_WARNING = 0;
const MAX_EVENT_QUEUE_WARNING = 400;
const MAX_STREAM_WARNING = 2_000;
const MAX_PENDING_WARNING = 256;
const MAX_ORPHAN_PRIORITY_WARNING = 40;

const HEALING_RECONCILE_STATE_KEY = "self-healing:gateway-bridge:reconcile:last";
const OTEL_CIRCUIT_KEY = "self-healing:gateway-bridge:otel-write:warn-last";

type HealthContextInput = {
  sourceEventId?: string;
  sourceEventName?: string;
  runContextKey?: string;
  flowTrace?: string[];
  sourceFunction?: string;
  targetComponent?: string;
  problemSummary?: string;
  attempt?: number;
  nextAttempt?: number;
  domain?: string;
  targetEventName?: string;
  routeToFunction?: string;
  routeToEventName?: string;
  retryPolicy?: {
    maxRetries?: number;
    sleepMinMs?: number;
    sleepMaxMs?: number;
    sleepStepMs?: number;
  };
  evidence?: Array<{ type: string; detail: string }> | string[];
  context?: Record<string, unknown>;
  playbook?: {
    actions?: string[];
    restart?: string[];
    kill?: string[];
    defer?: string[];
    notify?: string[];
    links?: string[];
  };
  owner?: string;
  deadlineAt?: string;
  requestedBy?: string;
  fallbackAction?: "escalate" | "manual";
  dryRun?: boolean;
};

type GatewayBridgeFlowContext = {
  runContextKey: string;
  flowTrace: string[];
  sourceEventName: string;
  sourceEventId?: string;
  attempt: number;
};

function buildGatewayBridgeFlowContext(input: {
  sourceFunction: string;
  targetComponent: string;
  targetEventName: string;
  domain: string;
  eventName: string;
  eventId: string | undefined;
  attempt: number;
}): GatewayBridgeFlowContext {
  const sourceFunction = toSafeText(input.sourceFunction, "system/self-healing.router");
  const targetComponent = toSafeText(input.targetComponent, "gateway-bridge");
  const eventName = toSafeText(input.eventName, "system/self.healing.requested");
  const targetEventName = toSafeText(input.targetEventName, "system/gateway.bridge.health.requested");
  const safeAttempt = Math.max(0, Math.floor(input.attempt));
  return {
    runContextKey: `${eventName}::${sourceFunction}::${targetComponent}::${toSafeText(input.domain, "gateway-bridge")}::${targetEventName}::a${safeAttempt}`,
    flowTrace: [
      eventName,
      "system/self-healing.router",
      `gateway-bridge:${targetComponent}`,
      toSafeText(input.domain, "gateway-bridge"),
      targetEventName,
      `attempt:${safeAttempt}`,
    ],
    sourceEventName: eventName,
    sourceEventId: input.eventId,
    attempt: safeAttempt,
  };
}

type PendingEntry = {
  id: string;
  consumer?: string;
  idleMs: number;
  deliveries: number;
  lastSeenTimestamp: number;
};

type BridgeHealthSummary = {
  sessions: number;
  eventQueueLength: number;
  eventQueueInvalidSamples: number;
  streamLength: number;
  priorityIndexLength: number;
  pendingCount: number;
  stalePendingCount: number;
  stalePendingIds: string[];
  oldestPendingAgeMs: number | null;
  streamStaleCleanupCount: number;
  orphanPriorityRemoved: number;
  eventQueuePurged: number;
};

function asPositiveInt(value: unknown, fallback: number, min = 1): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = Math.floor(value);
    return n >= min ? n : fallback;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
  }
  return fallback;
}

function trimForMetadata(value: unknown, max = 220): string {
  if (typeof value !== "string") return "";
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, Math.max(max - 3, 1))}...`;
}

function toSafeText(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function toSafeBool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function pickRetryPolicy(policy: HealthContextInput["retryPolicy"] | undefined) {
  return {
    maxRetries: asPositiveInt(policy?.maxRetries, 8),
    sleepMinMs: asPositiveInt(policy?.sleepMinMs, 60_000),
    sleepMaxMs: asPositiveInt(policy?.sleepMaxMs, 10 * 60_000),
    sleepStepMs: asPositiveInt(policy?.sleepStepMs, 30_000),
  };
}

async function openRedis(): Promise<Redis> {
  const redis = new Redis({
    host: SELF_HEALING_REDIS_HOST,
    port: SELF_HEALING_REDIS_PORT,
    lazyConnect: true,
    connectTimeout: 3_000,
    commandTimeout: 4_000,
  });
  redis.on("error", () => {});
  await redis.connect();
  return redis;
}

function parsePendingEntries(raw: unknown): PendingEntry[] {
  if (!Array.isArray(raw)) return [];

  const entries: PendingEntry[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 4) continue;
    const id = typeof item[0] === "string" ? item[0] : "";
    const consumer = typeof item[1] === "string" ? item[1] : "";
    const idleRaw = item[2];
    const deliveriesRaw = item[3];
    const idle = typeof idleRaw === "number" ? idleRaw : Number.parseInt(String(idleRaw), 10);
    const deliveries = typeof deliveriesRaw === "number" ? deliveriesRaw : Number.parseInt(String(deliveriesRaw), 10);
    if (!id || !Number.isFinite(idle) || !Number.isFinite(deliveries)) continue;
    entries.push({
      id,
      consumer,
      idleMs: idle,
      deliveries: deliveries >= 0 ? deliveries : 0,
      lastSeenTimestamp: Date.now() - idle,
    });
  }
  return entries;
}

function parsePendingCount(raw: unknown): number {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  }
  if (Array.isArray(raw) && raw.length > 0) {
    const rawCount = raw[0];
    if (typeof rawCount === "number") {
      return Number.isFinite(rawCount) ? Math.max(0, Math.floor(rawCount)) : 0;
    }
    const parsed = Number.parseInt(String(rawCount), 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }
  return 0;
}

async function readPendingEntries(redis: Redis, limit: number): Promise<PendingEntry[]> {
  try {
    const raw = await redis.xpending(
      GATEWAY_STREAM_KEY,
      GATEWAY_STREAM_GROUP,
      "-",
      "+",
      Math.max(1, limit),
    );
    return parsePendingEntries(raw);
  } catch {
    return [];
  }
}

async function shouldRunReconcile(redis: Redis): Promise<boolean> {
  const existing = await redis.get(HEALING_RECONCILE_STATE_KEY);
  if (existing) return false;

  await redis.set(
    HEALING_RECONCILE_STATE_KEY,
    String(Date.now()),
    "EX",
    HEALING_RECONCILE_COOLDOWN_SECONDS,
    "NX",
  );
  return true;
}

async function shouldWarnOtelGap(redis: Redis): Promise<boolean> {
  const existing = await redis.get(OTEL_CIRCUIT_KEY);
  if (existing) return false;
  await redis.set(OTEL_CIRCUIT_KEY, String(Date.now()), "EX", OTEL_GUARD_COOLDOWN_SECONDS, "NX");
  return true;
}

async function collectHealthSummary(redis: Redis): Promise<BridgeHealthSummary> {
  const sessions = await redis.scard(GATEWAY_SESSION_SET);
  const eventQueueLength = await redis.llen(GATEWAY_EVENT_LIST);
  const streamLength = await redis.xlen(GATEWAY_STREAM_KEY);
  const priorityIndexLength = await redis.zcard(GATEWAY_PRIORITY_KEY);

  const pendingSummary = await redis.xpending(GATEWAY_STREAM_KEY, GATEWAY_STREAM_GROUP).catch(() => null);
  const pendingCount = parsePendingCount(pendingSummary);

  const now = Date.now();
  const pending = await readPendingEntries(redis, Math.max(1, pendingCount));
  const stalePending = pending.filter((entry) => entry.idleMs >= STALE_PENDING_IDLE_MS);

  const sampleCount = Math.min(EVENT_LIST_SAMPLE_LIMIT, Math.max(0, eventQueueLength));
  const eventsToSample = sampleCount > 0
    ? await redis.lrange(
      GATEWAY_EVENT_LIST,
      0,
      sampleCount - 1,
    )
    : [];
  const invalidSamples = eventsToSample.reduce((count, raw) => {
    try {
      JSON.parse(raw);
      return count;
    } catch {
      return count + 1;
    }
  }, 0);

  let streamStaleCleanupCount = 0;
  let orphanPriorityRemoved = 0;
  let eventQueuePurged = 0;

  if (eventQueueLength > MAX_EVENT_QUEUE_WARNING) {
    if (eventsToSample.length > 0 && invalidSamples / eventsToSample.length >= 0.75) {
      eventQueuePurged = await redis.del(GATEWAY_EVENT_LIST);
    }
  }

  const shouldCleanupOrphans = await shouldRunReconcile(redis);
  if (shouldCleanupOrphans && streamLength > 0) {
    const cutoff = now - STALE_STREAM_AGE_MS;
    const cutoffId = `${Math.floor(cutoff)}-0`;
    const staleEntries = await redis.xrange(
      GATEWAY_STREAM_KEY,
      "-",
      cutoffId,
      "COUNT",
      `${STREAM_STALE_SCAN_LIMIT}`,
    );

    if (Array.isArray(staleEntries) && staleEntries.length > 0) {
      const pendingSet = new Set(stalePending.map((entry) => entry.id));
      for (const item of staleEntries) {
        if (!Array.isArray(item) || item.length < 1) continue;
        const streamId = typeof item[0] === "string" ? item[0] : "";
        if (!streamId || pendingSet.has(streamId)) continue;
        try {
          const removed = await redis.xdel(GATEWAY_STREAM_KEY, streamId);
          if (removed > 0) {
            await redis.zrem(GATEWAY_PRIORITY_KEY, streamId);
            streamStaleCleanupCount += 1;
          }
        } catch {
          // no-op
        }
      }
    }

    if (priorityIndexLength > 0) {
      const endIndex = Math.min(
        ORPHAN_PRIORITY_SCAN_LIMIT - 1,
        Math.max(priorityIndexLength - 1, 0),
      );
      const priorityIds = await redis.zrange(GATEWAY_PRIORITY_KEY, 0, endIndex);

      if (Array.isArray(priorityIds) && priorityIds.length > 0) {
        for (const candidate of priorityIds) {
          if (typeof candidate !== "string") continue;
          const existing = await redis.xrange(GATEWAY_STREAM_KEY, candidate, candidate);
          if (!Array.isArray(existing) || existing.length === 0) {
            await redis.zrem(GATEWAY_PRIORITY_KEY, candidate);
            orphanPriorityRemoved += 1;
          }
        }
      }
    }
  }

  return {
    sessions,
    eventQueueLength,
    eventQueueInvalidSamples: invalidSamples,
    streamLength,
    priorityIndexLength,
    pendingCount,
    stalePendingCount: stalePending.length,
    stalePendingIds: stalePending.map((item) => item.id),
    oldestPendingAgeMs: stalePending.length > 0
      ? Math.max(...stalePending.map((entry) => entry.idleMs))
      : null,
    streamStaleCleanupCount,
    orphanPriorityRemoved,
    eventQueuePurged,
  };
}

function diagnose(summary: BridgeHealthSummary): { degraded: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (summary.sessions <= MAX_SESSION_COUNT_WARNING) reasons.push("no-active-sessions");
  if (summary.eventQueueLength > MAX_EVENT_QUEUE_WARNING) reasons.push(`event-queue-${summary.eventQueueLength}`);
  if (summary.streamLength > MAX_STREAM_WARNING) reasons.push(`stream-depth-${summary.streamLength}`);
  if (summary.pendingCount > MAX_PENDING_WARNING) reasons.push(`pending-${summary.pendingCount}`);
  if (summary.stalePendingCount > 0) reasons.push(`stale-pending-${summary.stalePendingCount}`);
  if (
    summary.stalePendingCount > 0
    && summary.oldestPendingAgeMs !== null
    && summary.oldestPendingAgeMs > STALE_PENDING_IDLE_MS
  ) {
    reasons.push(`stale-pending-age-${summary.oldestPendingAgeMs}`);
  }
  if (summary.orphanPriorityRemoved > MAX_ORPHAN_PRIORITY_WARNING) {
    reasons.push(`orphan-priority-${summary.orphanPriorityRemoved}`);
  }
  if (summary.eventQueuePurged > 0) reasons.push("event-queue-sanitized");

  return { degraded: reasons.length > 0, reasons };
}

export const selfHealingGatewayBridge = inngest.createFunction(
  {
    id: "system/self-healing.gateway-bridge",
    name: "Reconcile Gateway Bridge State",
    concurrency: { limit: 1 },
    retries: 1,
  },
  [
    { cron: "TZ=America/Los_Angeles */10 * * * *" },
    { event: GATEWAY_HEALTH_EVENT },
    { event: SELF_HEALING_REQUEST_EVENT },
  ],
  async ({ event, step }) => {
    const data = event.data as HealthContextInput;
    const sourceEventName = event.name;
    const domain = toSafeText(data.domain, "unknown").toLowerCase();
    const shouldRun = sourceEventName === GATEWAY_HEALTH_EVENT || domain === GATEWAY_HEALING_DOMAIN;
    if (!shouldRun) {
      return {
        status: "skipped",
        reason: `unsupported domain ${toSafeText(domain, "unknown")}`,
      };
    }

    const dryRun = toSafeBool(data.dryRun, false);
    const attempt = asPositiveInt(data.attempt, 0, 0);
    const retryPolicy = pickRetryPolicy(data.retryPolicy);
    const sourceFunction = toSafeText(data.sourceFunction, "system/self-healing.router");
    const targetComponent = toSafeText(data.targetComponent, "gateway-bridge");
    const problemSummary = toSafeText(data.problemSummary, "Gateway bridge health drift detected.");
    const flowContext = buildGatewayBridgeFlowContext({
      sourceFunction,
      targetComponent,
      targetEventName: toSafeText(data.targetEventName, GATEWAY_HEALTH_EVENT),
      domain: GATEWAY_HEALING_DOMAIN,
      eventName: sourceEventName,
      eventId: event.id,
      attempt,
    });
    const shouldEmitCompleted = sourceEventName === GATEWAY_HEALTH_EVENT || sourceEventName === SELF_HEALING_REQUEST_EVENT;
    const runStartedAt = Date.now();
    const nextAttempt = attempt + 1;

    const redis = await openRedis();

    try {
      const summary = await collectHealthSummary(redis);
      const diagnosis = diagnose(summary);
      const staleReconciled =
        summary.streamStaleCleanupCount + summary.orphanPriorityRemoved + summary.eventQueuePurged;
      const remediated = staleReconciled > 0 && !dryRun;
      const detected = diagnosis.degraded ? 1 : 0;
      const inspected = 1;
      const remediationState = remediated ? "remediated" : diagnosis.degraded ? "detected" : "noop";

      const metadata = {
        mode: "gateway-bridge-health",
        problemSummary: trimForMetadata(problemSummary),
        runContext: {
          runContextKey: flowContext.runContextKey,
          flowTrace: flowContext.flowTrace,
          sourceEventName: flowContext.sourceEventName,
          sourceEventId: flowContext.sourceEventId,
          attempt: flowContext.attempt,
          nextAttempt,
        },
        sourceFunction,
        targetComponent,
        attempt,
        dryRun,
        detected,
        inspected,
        staleReconciled,
        sessionSet: GATEWAY_SESSION_SET,
        eventList: GATEWAY_EVENT_LIST,
        streamKey: GATEWAY_STREAM_KEY,
        reasonCount: diagnosis.reasons.length,
        reasons: diagnosis.reasons,
        ...summary,
      };

      if (diagnosis.degraded && summary.sessions <= MAX_SESSION_COUNT_WARNING) {
        await emitOtelEvent({
          level: "warn",
          source: "worker",
          component: "self-healing",
          action: "system.self-healing.gateway-bridge.no-session",
          success: false,
          error: "no gateway session in bridge registry",
          metadata: {
            ...metadata,
            issue: {
              type: "no-session",
              eventName: GATEWAY_HEALTH_EVENT,
            },
          },
        });
      }

      const otelResult = await emitOtelEvent({
        level: diagnosis.degraded ? "warn" : "info",
        source: "worker",
        component: "gateway-bridge",
        action: "system.self-healing.gateway-bridge.health",
        success: !diagnosis.degraded,
        error: diagnosis.degraded ? diagnosis.reasons.join(" | ") : undefined,
        duration_ms: Date.now() - runStartedAt,
        metadata,
      });

      if (diagnosis.degraded && !otelResult.stored && await shouldWarnOtelGap(redis)) {
        await emitOtelEvent({
          level: "warn",
          source: "worker",
          component: "self-healing",
          action: "system.self-healing.gateway-bridge.otel-gap",
          success: false,
          error: "gateway bridge OTEL write failed",
          metadata: {
            runContext: {
              runContextKey: flowContext.runContextKey,
              flowTrace: flowContext.flowTrace,
              sourceEventName: flowContext.sourceEventName,
              sourceEventId: flowContext.sourceEventId,
              attempt: flowContext.attempt,
              nextAttempt,
            },
            sourceFunction,
            attempt,
            nextAttempt,
            retryPolicy,
            cause: "bridge-health-summary",
            otelSummary: {
              stored: otelResult.stored,
              dropped: otelResult.dropped,
              dropReason: otelResult.dropReason,
              typesenseWritten: otelResult.typesense.written,
              convexWritten: otelResult.convex.written,
              sentryWritten: otelResult.sentry.written,
            },
          },
        });
      }

      if (shouldEmitCompleted) {
        await step.sendEvent("emit-self-healing-completed", {
          name: "system/self.healing.completed",
          data: {
            domain: GATEWAY_HEALING_DOMAIN,
            status: remediationState as
              | "noop"
              | "detected"
              | "remediated"
              | "invalid"
              | "scheduled"
              | "exhausted"
              | "escalated"
              | "blocked",
            sourceFunction,
            targetComponent,
            attempt,
            nextAttempt,
            routeToEventName: GATEWAY_HEALTH_EVENT,
            detected,
            inspected,
            dryRun,
            remediationDetail: summary.stalePendingIds.length > 0
              ? `stale-pending=${trimForMetadata(summary.stalePendingIds.slice(0, 3).join(","), 120)}`
              : undefined,
            sampleRunIds: summary.stalePendingIds.slice(0, 5),
            context: {
              runContext: {
                runContextKey: flowContext.runContextKey,
                flowTrace: flowContext.flowTrace,
                sourceEventName: flowContext.sourceEventName,
                sourceEventId: flowContext.sourceEventId,
                attempt: flowContext.attempt,
              },
              diagnosis: diagnosis.reasons,
              staleReconciled,
              attemptContext: {
                stalePendingCount: summary.stalePendingCount,
                pendingCount: summary.pendingCount,
                oldestPendingAgeMs: summary.oldestPendingAgeMs,
                streamLength: summary.streamLength,
              },
            },
          },
        });
      }

      return {
        status: remediationState,
        domain: GATEWAY_HEALING_DOMAIN,
        diagnosis: diagnosis.reasons,
        summary,
        retryPolicy,
        attempt,
        nextAttempt,
        otelStored: otelResult.stored,
        otelTypesenseWritten: otelResult.typesense.written,
        attemptContext: {
          problemSummary: trimForMetadata(problemSummary),
          sessions: summary.sessions,
          pendingCount: summary.pendingCount,
          stalePendingCount: summary.stalePendingCount,
        },
      };
    } finally {
      redis.disconnect();
    }
  },
);
