/**
 * joelclaw queue — Queue operator surface for @joelclaw/queue.
 * 
 * Commands:
 * - joelclaw queue emit <event> [-d <json>] — Emit an event to the queue
 * - joelclaw queue depth — Get queue depth and stats
 * - joelclaw queue stats [--hours <n>] [--limit <n>] — Summarize recent drainer success/failure + latency
 * - joelclaw queue observe [--hours <n>] [--limit <n>] [--since <iso|ms>] — Run the dry-run Sonnet operator surface
 * - joelclaw queue pause <family> [--ttl <duration>] [--reason <text>] — Pause one family deterministically
 * - joelclaw queue resume <family> [--reason <text>] — Resume one family deterministically
 * - joelclaw queue control status [--hours <n>] [--limit <n>] [--since <iso|ms>] — Inspect deterministic queue-control state
 * - joelclaw queue list [--limit <n>] — List recent messages
 * - joelclaw queue inspect <stream-id> — Inspect a message by ID
 */

import { Args, Command, Options } from "@effect/cli";
import {
  getQueueStats,
  init,
  inspectById,
  listActiveQueueFamilyPauses,
  listMessages,
  pauseQueueFamily,
  pauseStateToControlAction,
  type QueueConfig,
  type QueueFamilyPauseState,
  resumeQueueFamily,
  type TelemetryEmitter,
} from "@joelclaw/queue";
import { Console, Effect } from "effect";
import Redis from "ioredis";
import { loadConfig } from "../config";
import { createOtelEventPayload, ingestOtelPayload } from "../lib/otel-ingest";
import { enqueueQueueEventViaWorker } from "../lib/queue-admission";
import {
  __queueObserveCliTestUtils,
  runQueueControlOperatorView,
  runQueueObserveOperatorView,
} from "../lib/queue-observe";
import { type NextAction, respond, respondError } from "../response";
import { isTypesenseApiKeyError, resolveTypesenseApiKey } from "../typesense-auth";

const cfg = loadConfig();
const REDIS_URL = cfg.redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:6379";

// Queue configuration
const QUEUE_CONFIG: QueueConfig = {
  streamKey: "joelclaw:queue:events",
  priorityKey: "joelclaw:queue:priority",
  consumerGroup: "joelclaw:queue:cli",
  consumerName: "cli",
};

const pendingTelemetry = new Set<Promise<unknown>>();

const queueTelemetry: TelemetryEmitter = {
  emit(action, detail, extra) {
    const pending = ingestOtelPayload(
      createOtelEventPayload({
        level: "info",
        source: "cli",
        component: "queue",
        action,
        success: true,
        metadata: {
          detail,
          ...(extra ?? {}),
        },
      }),
    );

    pendingTelemetry.add(pending);
    void pending.finally(() => {
      pendingTelemetry.delete(pending);
    });
  },
};

type OptionalText = { _tag: "Some"; value: string } | { _tag: "None" };

let redisClient: Redis | undefined;

function parseOptionalText(value: OptionalText): string | undefined {
  if (value._tag !== "Some") return undefined;
  const normalized = value.value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis(REDIS_URL);
  }
  return redisClient;
}

async function ensureQueueInitialized(): Promise<void> {
  const redis = getRedisClient();
  await init(redis, QUEUE_CONFIG, { telemetry: queueTelemetry });
}

async function flushTelemetry(): Promise<void> {
  const pending = [...pendingTelemetry];
  if (pending.length === 0) return;
  await Promise.allSettled(pending);
}

async function closeRedisClient(): Promise<void> {
  const client = redisClient;
  redisClient = undefined;
  if (!client) {
    await flushTelemetry();
    return;
  }

  try {
    await client.quit();
  } catch {
    client.disconnect();
  }

  await flushTelemetry();
}

function withRedisCleanup<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return effect.pipe(
    Effect.ensuring(
      Effect.tryPromise({
        try: () => closeRedisClient(),
        catch: () => undefined,
      }),
    ),
  );
}

const TYPESENSE_URL = process.env.TYPESENSE_URL ?? "http://localhost:8108";
const OTEL_COLLECTION = "otel_events";
const OTEL_QUERY_BY = "action,error,component,source,metadata_json,search_text";
const QUEUE_DISPATCH_ACTIONS = [
  "queue.dispatch.started",
  "queue.dispatch.completed",
  "queue.dispatch.failed",
] as const;
const QUEUE_TRIAGE_ACTIONS = [
  "queue.triage.started",
  "queue.triage.completed",
  "queue.triage.failed",
  "queue.triage.fallback",
] as const;
const QUEUE_LATENCY_TARGET_P95_MS = 5_000;
const DEFAULT_QUEUE_STATS_LIMIT = 200;

type QueueDispatchAction = (typeof QUEUE_DISPATCH_ACTIONS)[number];
type QueueTriageAction = (typeof QUEUE_TRIAGE_ACTIONS)[number];

type QueueDepthSnapshot = {
  total: number;
  byPriority: Record<string, number>;
  oldestTimestamp: number | null;
  newestTimestamp: number | null;
};

type QueueDispatchEvent = {
  id: string;
  timestamp: number;
  action: QueueDispatchAction;
  success: boolean;
  error?: string;
  metadata: Record<string, unknown>;
};

type QueueTriageEvent = {
  id: string;
  timestamp: number;
  action: QueueTriageAction;
  success: boolean;
  error?: string;
  metadata: Record<string, unknown>;
};

type QueueStatsWindow = {
  hours: number;
  sinceTimestamp: number | null;
  sinceIso: string | null;
  found: number;
  sampled: number;
  truncated: boolean;
  filterBy: string;
};

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return undefined;
}

function parseSinceTimestamp(value: string): number {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("--since requires an ISO timestamp or epoch value");
  }

  if (/^\d+$/u.test(normalized)) {
    const numeric = Number(normalized);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      throw new Error(`Invalid --since timestamp: ${value}`);
    }

    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid --since value: ${value}. Use ISO-8601 or epoch milliseconds.`);
  }

  return parsed;
}

function parseDurationToMs(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  const direct = Number.parseInt(trimmed, 10);
  if (Number.isFinite(direct) && direct > 0 && /^\d+$/u.test(trimmed)) {
    return direct * 1000;
  }

  const match = /^(\d+)(s|m|h|d)$/u.exec(trimmed);
  if (!match) return null;

  const value = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = match[2];
  if (unit === "s") return value * 1000;
  if (unit === "m") return value * 60 * 1000;
  if (unit === "h") return value * 60 * 60 * 1000;
  if (unit === "d") return value * 24 * 60 * 60 * 1000;
  return null;
}

async function emitQueueControlTelemetry(input: {
  level: "info" | "warn";
  action: "queue.control.applied" | "queue.control.expired" | "queue.control.rejected";
  success: boolean;
  error?: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  await ingestOtelPayload(
    createOtelEventPayload({
      level: input.level,
      source: "cli",
      component: "queue-control",
      action: input.action,
      success: input.success,
      error: input.error,
      metadata: input.metadata,
    }),
  );
}

function compactPauseState(pause: QueueFamilyPauseState) {
  return {
    family: pause.family,
    ttlMs: pause.ttlMs,
    reason: pause.reason,
    sourceType: pause.source,
    mode: pause.mode,
    appliedAt: pause.appliedAt,
    expiresAt: pause.expiresAt,
    expiresInMs: Math.max(0, pause.expiresAtMs - Date.now()),
    snapshotId: pause.snapshotId ?? null,
    actor: pause.actor ?? null,
  };
}

function parseMetadataJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.trim().length === 0) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed metadata JSON and fall back to empty object
  }

  return {};
}

function isQueueDispatchAction(value: unknown): value is QueueDispatchAction {
  return typeof value === "string"
    && (QUEUE_DISPATCH_ACTIONS as readonly string[]).includes(value);
}

function isQueueTriageAction(value: unknown): value is QueueTriageAction {
  return typeof value === "string"
    && (QUEUE_TRIAGE_ACTIONS as readonly string[]).includes(value);
}

function percentile(values: readonly number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? null;
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function parseQueueDispatchHit(hit: unknown): QueueDispatchEvent | null {
  const doc = (hit as { document?: Record<string, unknown> })?.document;
  if (!doc) return null;

  const action = doc.action;
  const timestamp = asFiniteNumber(doc.timestamp);
  if (!isQueueDispatchAction(action) || timestamp == null) return null;

  return {
    id: asNonEmptyString(doc.id) ?? `${action}-${timestamp}`,
    timestamp,
    action,
    success: doc.success !== false,
    error: asNonEmptyString(doc.error),
    metadata: parseMetadataJson(doc.metadata_json),
  };
}

function parseQueueTriageHit(hit: unknown): QueueTriageEvent | null {
  const doc = (hit as { document?: Record<string, unknown> })?.document;
  if (!doc) return null;

  const action = doc.action;
  const timestamp = asFiniteNumber(doc.timestamp);
  if (!isQueueTriageAction(action) || timestamp == null) return null;

  return {
    id: asNonEmptyString(doc.id) ?? `${action}-${timestamp}`,
    timestamp,
    action,
    success: doc.success !== false,
    error: asNonEmptyString(doc.error),
    metadata: parseMetadataJson(doc.metadata_json),
  };
}

async function loadQueueDispatchEvents(hours: number, limit: number, sinceTimestamp?: number): Promise<{
  found: number;
  events: QueueDispatchEvent[];
  filterBy: string;
}> {
  const apiKey = resolveTypesenseApiKey();
  const lowerBound = sinceTimestamp ?? Math.floor(Date.now() - hours * 60 * 60 * 1000);
  const filterBy = [
    `timestamp:>=${lowerBound}`,
    "source:=restate",
    "component:=queue-drainer",
    `action:=[${QUEUE_DISPATCH_ACTIONS.join(",")}]`,
  ].join(" && ");

  const searchParams = new URLSearchParams({
    q: "*",
    query_by: OTEL_QUERY_BY,
    filter_by: filterBy,
    per_page: String(limit),
    page: "1",
    sort_by: "timestamp:desc",
    include_fields: "id,timestamp,action,success,error,metadata_json",
  });

  const response = await fetch(
    `${TYPESENSE_URL}/collections/${OTEL_COLLECTION}/documents/search?${searchParams}`,
    {
      headers: {
        "X-TYPESENSE-API-KEY": apiKey,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Typesense query failed (${response.status}): ${await response.text()}`);
  }

  const payload = await response.json() as {
    found?: unknown;
    hits?: unknown[];
  };

  const hits = Array.isArray(payload.hits) ? payload.hits : [];
  const events = hits
    .map(parseQueueDispatchHit)
    .filter((event): event is QueueDispatchEvent => event !== null);

  return {
    found: asFiniteNumber(payload.found) ?? events.length,
    events,
    filterBy,
  };
}

async function loadQueueTriageEvents(hours: number, limit: number, sinceTimestamp?: number): Promise<{
  found: number;
  events: QueueTriageEvent[];
  filterBy: string;
}> {
  const apiKey = resolveTypesenseApiKey();
  const lowerBound = sinceTimestamp ?? Math.floor(Date.now() - hours * 60 * 60 * 1000);
  const filterBy = [
    `timestamp:>=${lowerBound}`,
    "source:=worker",
    "component:=queue-triage",
    `action:=[${QUEUE_TRIAGE_ACTIONS.join(",")}]`,
  ].join(" && ");

  const searchParams = new URLSearchParams({
    q: "*",
    query_by: OTEL_QUERY_BY,
    filter_by: filterBy,
    per_page: String(limit),
    page: "1",
    sort_by: "timestamp:desc",
    include_fields: "id,timestamp,action,success,error,metadata_json",
  });

  const response = await fetch(
    `${TYPESENSE_URL}/collections/${OTEL_COLLECTION}/documents/search?${searchParams}`,
    {
      headers: {
        "X-TYPESENSE-API-KEY": apiKey,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Typesense query failed (${response.status}): ${await response.text()}`);
  }

  const payload = await response.json() as {
    found?: unknown;
    hits?: unknown[];
  };

  const hits = Array.isArray(payload.hits) ? payload.hits : [];
  const events = hits
    .map(parseQueueTriageHit)
    .filter((event): event is QueueTriageEvent => event !== null);

  return {
    found: asFiniteNumber(payload.found) ?? events.length,
    events,
    filterBy,
  };
}

function summarizeQueueStats(
  events: readonly QueueDispatchEvent[],
  depth: QueueDepthSnapshot,
  window: QueueStatsWindow,
): {
  window: QueueStatsWindow;
  currentDepth: {
    total: number;
    byPriority: Record<string, number>;
    oldestTimestamp: number | null;
    newestTimestamp: number | null;
    oldestAgeSeconds: number | null;
  };
  dispatches: {
    started: number;
    completed: number;
    failed: number;
    terminal: number;
    successRate: number | null;
  };
  queueLatencyMs: {
    count: number;
    average: number | null;
    p50: number | null;
    p95: number | null;
    max: number | null;
    targetP95: number;
    withinTarget: boolean | null;
  };
  dispatchDurationMs: {
    count: number;
    average: number | null;
    p50: number | null;
    p95: number | null;
    max: number | null;
  };
  promotions: number;
  eventFamilies: Array<{ name: string; count: number }>;
  recentFailures: Array<{
    at: string;
    streamId: string | null;
    eventName: string | null;
    error: string;
  }>;
} {
  const started = events.filter((event) => event.action === "queue.dispatch.started");
  const completed = events.filter((event) => event.action === "queue.dispatch.completed");
  const failed = events.filter((event) => event.action === "queue.dispatch.failed");
  const terminal = completed.length + failed.length;

  const waitTimes = started
    .map((event) => asFiniteNumber(event.metadata.waitTimeMs))
    .filter((value): value is number => value != null && value >= 0);

  const dispatchDurations: number[] = [];
  const startedByStreamId = new Map<string, QueueDispatchEvent>();
  for (const event of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
    const streamId = asNonEmptyString(event.metadata.streamId);
    if (!streamId) continue;

    if (event.action === "queue.dispatch.started") {
      startedByStreamId.set(streamId, event);
      continue;
    }

    if (event.action === "queue.dispatch.completed" || event.action === "queue.dispatch.failed") {
      const start = startedByStreamId.get(streamId);
      if (start) {
        dispatchDurations.push(Math.max(0, event.timestamp - start.timestamp));
      }
    }
  }

  const eventFamilyCounts = new Map<string, number>();
  for (const event of started) {
    const eventName = asNonEmptyString(event.metadata.eventName) ?? "unknown";
    eventFamilyCounts.set(eventName, (eventFamilyCounts.get(eventName) ?? 0) + 1);
  }

  const recentFailures = failed.slice(0, 5).map((event) => ({
    at: new Date(event.timestamp).toISOString(),
    streamId: asNonEmptyString(event.metadata.streamId) ?? null,
    eventName: asNonEmptyString(event.metadata.eventName) ?? null,
    error: event.error ?? "dispatch_failed",
  }));

  const p95 = percentile(waitTimes, 0.95);

  return {
    window,
    currentDepth: {
      total: depth.total,
      byPriority: depth.byPriority,
      oldestTimestamp: depth.oldestTimestamp,
      newestTimestamp: depth.newestTimestamp,
      oldestAgeSeconds: depth.oldestTimestamp
        ? Math.floor((Date.now() - depth.oldestTimestamp) / 1000)
        : null,
    },
    dispatches: {
      started: started.length,
      completed: completed.length,
      failed: failed.length,
      terminal,
      successRate: terminal > 0 ? completed.length / terminal : null,
    },
    queueLatencyMs: {
      count: waitTimes.length,
      average: average(waitTimes),
      p50: percentile(waitTimes, 0.5),
      p95,
      max: waitTimes.length > 0 ? Math.max(...waitTimes) : null,
      targetP95: QUEUE_LATENCY_TARGET_P95_MS,
      withinTarget: p95 == null ? null : p95 <= QUEUE_LATENCY_TARGET_P95_MS,
    },
    dispatchDurationMs: {
      count: dispatchDurations.length,
      average: average(dispatchDurations),
      p50: percentile(dispatchDurations, 0.5),
      p95: percentile(dispatchDurations, 0.95),
      max: dispatchDurations.length > 0 ? Math.max(...dispatchDurations) : null,
    },
    promotions: started.filter((event) => asFiniteNumber(event.metadata.promotedFrom) != null).length,
    eventFamilies: [...eventFamilyCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count })),
    recentFailures,
  };
}

function triageFamilyName(event: QueueTriageEvent): string {
  return asNonEmptyString(event.metadata.family)
    ?? asNonEmptyString(event.metadata.queueEventName)
    ?? "unknown";
}

function isTriageDisagreement(event: QueueTriageEvent): boolean {
  const suggestedPriority = asNonEmptyString(event.metadata.suggestedPriority);
  const finalPriority = asNonEmptyString(event.metadata.finalPriority);
  const suggestedDedupKey = asNonEmptyString(event.metadata.suggestedDedupKey) ?? null;
  const finalDedupKey = asNonEmptyString(event.metadata.finalDedupKey) ?? null;
  const routeCheck = asNonEmptyString(event.metadata.routeCheck) ?? "confirm";

  return (suggestedPriority != null && finalPriority != null && suggestedPriority !== finalPriority)
    || suggestedDedupKey !== finalDedupKey
    || routeCheck === "mismatch";
}

function summarizeQueueTriageStats(
  events: readonly QueueTriageEvent[],
  window: QueueStatsWindow,
): {
  window: QueueStatsWindow;
  attempts: number;
  completed: number;
  failed: number;
  fallbacks: number;
  terminal: number;
  successRate: number | null;
  disagreements: number;
  appliedChanges: number;
  suggestedNotApplied: number;
  routeMismatches: number;
  fallbackByReason: Array<{ reason: string; count: number }>;
  latencyMs: {
    count: number;
    average: number | null;
    p50: number | null;
    p95: number | null;
    max: number | null;
  };
  families: Array<{
    name: string;
    attempts: number;
    completed: number;
    failed: number;
    fallbacks: number;
    disagreements: number;
    appliedChanges: number;
    suggestedNotApplied: number;
    routeMismatches: number;
  }>;
  recentMismatchSamples: Array<{
    at: string;
    family: string;
    mode: string | null;
    suggestedPriority: string | null;
    finalPriority: string | null;
    suggestedDedupKey: string | null;
    finalDedupKey: string | null;
    routeCheck: string | null;
    applied: boolean;
  }>;
  recentFallbacks: Array<{
    at: string;
    family: string;
    reason: string;
    mode: string | null;
    finalPriority: string | null;
    routeCheck: string | null;
    latencyMs: number | null;
  }>;
} {
  const started = events.filter((event) => event.action === "queue.triage.started");
  const completed = events.filter((event) => event.action === "queue.triage.completed");
  const failed = events.filter((event) => event.action === "queue.triage.failed");
  const fallbacks = events.filter((event) => event.action === "queue.triage.fallback");
  const terminal = completed.length + fallbacks.length;

  const fallbackReasons = new Map<string, number>();
  const familyCounts = new Map<string, {
    attempts: number;
    completed: number;
    failed: number;
    fallbacks: number;
    disagreements: number;
    appliedChanges: number;
    suggestedNotApplied: number;
    routeMismatches: number;
  }>();

  const ensureFamily = (name: string) => {
    const existing = familyCounts.get(name);
    if (existing) return existing;

    const created = {
      attempts: 0,
      completed: 0,
      failed: 0,
      fallbacks: 0,
      disagreements: 0,
      appliedChanges: 0,
      suggestedNotApplied: 0,
      routeMismatches: 0,
    };
    familyCounts.set(name, created);
    return created;
  };

  for (const event of started) {
    ensureFamily(triageFamilyName(event)).attempts += 1;
  }

  const disagreementEvents = completed.filter(isTriageDisagreement);
  for (const event of completed) {
    const bucket = ensureFamily(triageFamilyName(event));
    bucket.completed += 1;

    const applied = asBoolean(event.metadata.applied) === true;
    const routeCheck = asNonEmptyString(event.metadata.routeCheck);
    const disagreement = isTriageDisagreement(event);

    if (disagreement) {
      bucket.disagreements += 1;
      if (!applied) {
        bucket.suggestedNotApplied += 1;
      }
    }

    if (applied) {
      bucket.appliedChanges += 1;
    }

    if (routeCheck === "mismatch") {
      bucket.routeMismatches += 1;
    }
  }

  for (const event of failed) {
    ensureFamily(triageFamilyName(event)).failed += 1;
  }

  for (const event of fallbacks) {
    const bucket = ensureFamily(triageFamilyName(event));
    bucket.fallbacks += 1;

    const reason = asNonEmptyString(event.metadata.fallbackReason) ?? "unknown";
    fallbackReasons.set(reason, (fallbackReasons.get(reason) ?? 0) + 1);
  }

  const latencySamples = [...completed, ...fallbacks]
    .map((event) => asFiniteNumber(event.metadata.latencyMs))
    .filter((value): value is number => value != null && value >= 0);

  return {
    window,
    attempts: started.length,
    completed: completed.length,
    failed: failed.length,
    fallbacks: fallbacks.length,
    terminal,
    successRate: terminal > 0 ? completed.length / terminal : null,
    disagreements: disagreementEvents.length,
    appliedChanges: completed.filter((event) => asBoolean(event.metadata.applied) === true).length,
    suggestedNotApplied: disagreementEvents.filter((event) => asBoolean(event.metadata.applied) !== true).length,
    routeMismatches: completed.filter((event) => asNonEmptyString(event.metadata.routeCheck) === "mismatch").length,
    fallbackByReason: [...fallbackReasons.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, count]) => ({ reason, count })),
    latencyMs: {
      count: latencySamples.length,
      average: average(latencySamples),
      p50: percentile(latencySamples, 0.5),
      p95: percentile(latencySamples, 0.95),
      max: latencySamples.length > 0 ? Math.max(...latencySamples) : null,
    },
    families: [...familyCounts.entries()]
      .sort((a, b) => {
        const attemptDelta = b[1].attempts - a[1].attempts;
        if (attemptDelta !== 0) return attemptDelta;
        const disagreementDelta = b[1].disagreements - a[1].disagreements;
        if (disagreementDelta !== 0) return disagreementDelta;
        return a[0].localeCompare(b[0]);
      })
      .map(([name, counts]) => ({ name, ...counts })),
    recentMismatchSamples: disagreementEvents.slice(0, 5).map((event) => ({
      at: new Date(event.timestamp).toISOString(),
      family: triageFamilyName(event),
      mode: asNonEmptyString(event.metadata.mode) ?? null,
      suggestedPriority: asNonEmptyString(event.metadata.suggestedPriority) ?? null,
      finalPriority: asNonEmptyString(event.metadata.finalPriority) ?? null,
      suggestedDedupKey: asNonEmptyString(event.metadata.suggestedDedupKey) ?? null,
      finalDedupKey: asNonEmptyString(event.metadata.finalDedupKey) ?? null,
      routeCheck: asNonEmptyString(event.metadata.routeCheck) ?? null,
      applied: asBoolean(event.metadata.applied) === true,
    })),
    recentFallbacks: fallbacks.slice(0, 5).map((event) => ({
      at: new Date(event.timestamp).toISOString(),
      family: triageFamilyName(event),
      reason: asNonEmptyString(event.metadata.fallbackReason) ?? "unknown",
      mode: asNonEmptyString(event.metadata.mode) ?? null,
      finalPriority: asNonEmptyString(event.metadata.finalPriority) ?? null,
      routeCheck: asNonEmptyString(event.metadata.routeCheck) ?? null,
      latencyMs: asFiniteNumber(event.metadata.latencyMs) ?? null,
    })),
  };
}

/**
 * joelclaw queue emit <event> [-d <json>] — Emit an event to the queue.
 */
const emitCmd = Command.make(
  "emit",
  {
    event: Args.text({ name: "event" }).pipe(
      Args.withDescription("Event name (e.g., discovery/noted)")
    ),
    data: Options.text("data").pipe(
      Options.withAlias("d"),
      Options.withDescription("Event data as JSON"),
      Options.optional
    ),
    priority: Options.text("priority").pipe(
      Options.withAlias("p"),
      Options.withDescription("Priority (P0, P1, P2, P3)"),
      Options.optional
    ),
  },
  ({ event, data, priority }) =>
    Effect.gen(function* () {
      const dataText = parseOptionalText(data);
      const priorityText = parseOptionalText(priority);

      let eventData: Record<string, unknown> = {};
      if (dataText) {
        try {
          const parsed = JSON.parse(dataText);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            eventData = parsed as Record<string, unknown>;
          } else {
            yield* Effect.fail(new Error("Event data must be a JSON object"));
          }
        } catch (error) {
          yield* Effect.fail(new Error(`Invalid JSON data: ${error}`));
        }
      }

      if (priorityText && !["P0", "P1", "P2", "P3"].includes(priorityText.toUpperCase())) {
        yield* Effect.fail(new Error(`Invalid priority: ${priorityText}. Must be P0, P1, P2, or P3`));
      }

      const result = yield* Effect.tryPromise({
        try: () => enqueueQueueEventViaWorker({
          name: event,
          data: eventData,
          source: "cli",
          priority: priorityText?.toUpperCase() as "P0" | "P1" | "P2" | "P3" | undefined,
        }),
        catch: (error) => new Error(`Failed to enqueue event via worker admission surface: ${error}`),
      });

      const next: NextAction[] = [
        {
          command: "joelclaw queue inspect <stream-id>",
          description: "Inspect the enqueued message",
          params: {
            "stream-id": {
              value: result.streamId,
              required: true,
              description: "Redis stream ID",
            },
          },
        },
        {
          command: "joelclaw queue depth",
          description: "Check queue depth",
          params: {},
        },
      ];

      yield* Console.log(
        respond("queue emit", {
          ok: true,
          streamId: result.streamId,
          priority: result.priority,
          event,
          eventId: result.eventId,
          triageMode: result.triageMode,
          triage: result.triage,
        }, next)
      );
    })
);

/**
 * joelclaw queue depth — Get queue depth and stats.
 */
const depthCmd = Command.make(
  "depth",
  {},
  () =>
    withRedisCleanup(Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => ensureQueueInitialized(),
        catch: (error) => new Error(`Failed to initialize queue: ${error}`),
      });

      const stats = yield* Effect.tryPromise({
        try: () => getQueueStats(),
        catch: (error) => new Error(`Failed to get queue stats: ${error}`),
      });

      const next: NextAction[] = [
        {
          command: "joelclaw queue list [--limit <n>]",
          description: "List queued messages",
          params: {
            limit: {
              value: 10,
              default: 10,
              description: "Number of messages to list",
            },
          },
        },
      ];

      yield* Console.log(
        respond("queue depth", {
          ok: true,
          total: stats.total,
          byPriority: stats.byPriority,
          oldestTimestamp: stats.oldestTimestamp,
          newestTimestamp: stats.newestTimestamp,
          oldestAge: stats.oldestTimestamp
            ? Math.floor((Date.now() - stats.oldestTimestamp) / 1000)
            : null,
        }, next)
      );
    }))
);

/**
 * joelclaw queue stats [--hours <n>] [--limit <n>] [--since <iso|ms>] — Summarize recent drainer behavior.
 */
const statsCmd = Command.make(
  "stats",
  {
    hours: Options.integer("hours").pipe(
      Options.withAlias("h"),
      Options.withDefault(24),
      Options.withDescription("Lookback window in hours"),
    ),
    limit: Options.integer("limit").pipe(
      Options.withAlias("n"),
      Options.withDefault(DEFAULT_QUEUE_STATS_LIMIT),
      Options.withDescription("Max dispatch OTEL events to sample"),
    ),
    since: Options.optional(
      Options.text("since").pipe(
        Options.withDescription("Override the lower bound with an ISO timestamp or epoch milliseconds"),
      ),
    ),
  },
  ({ hours, limit, since }) =>
    withRedisCleanup(Effect.gen(function* () {
      const statsResult = yield* Effect.tryPromise({
        try: async () => {
          await ensureQueueInitialized();
          const depth = await getQueueStats();
          const normalizedLimit = Math.min(Math.max(1, limit), DEFAULT_QUEUE_STATS_LIMIT);
          const sinceText = parseOptionalText(since);
          const parsedSince = sinceText ? parseSinceTimestamp(sinceText) : undefined;
          const dispatchWindow = await loadQueueDispatchEvents(hours, normalizedLimit, parsedSince);
          const triageWindow = await loadQueueTriageEvents(hours, normalizedLimit, parsedSince);

          const dispatchSummary = summarizeQueueStats(
            dispatchWindow.events,
            {
              total: depth.total,
              byPriority: depth.byPriority,
              oldestTimestamp: depth.oldestTimestamp,
              newestTimestamp: depth.newestTimestamp,
            },
            {
              hours,
              sinceTimestamp: parsedSince ?? null,
              sinceIso: parsedSince ? new Date(parsedSince).toISOString() : null,
              found: dispatchWindow.found,
              sampled: dispatchWindow.events.length,
              truncated: dispatchWindow.found > dispatchWindow.events.length,
              filterBy: dispatchWindow.filterBy,
            },
          );

          return {
            ...dispatchSummary,
            triage: summarizeQueueTriageStats(
              triageWindow.events,
              {
                hours,
                sinceTimestamp: parsedSince ?? null,
                sinceIso: parsedSince ? new Date(parsedSince).toISOString() : null,
                found: triageWindow.found,
                sampled: triageWindow.events.length,
                truncated: triageWindow.found > triageWindow.events.length,
                filterBy: triageWindow.filterBy,
              },
            ),
          };
        },
        catch: (error) => error,
      }).pipe(Effect.either);

      if (statsResult._tag === "Left") {
        const error = statsResult.left;
        const next: NextAction[] = [
          {
            command: "joelclaw queue depth",
            description: "Check live queue depth",
            params: {},
          },
          {
            command: "joelclaw status",
            description: "Check worker/server health",
            params: {},
          },
        ];

        if (isTypesenseApiKeyError(error)) {
          yield* Console.log(
            respondError("queue stats", error.message, error.code, error.fix, next),
          );
          return;
        }

        yield* Console.log(
          respondError(
            "queue stats",
            error instanceof Error ? error.message : String(error),
            "QUEUE_STATS_FAILED",
            "Check Typesense reachability plus queue drainer OTEL events, then retry.",
            next,
          ),
        );
        return;
      }

      const summary = statsResult.right;
      const next: NextAction[] = [
        {
          command: "joelclaw queue depth",
          description: "Check live queue depth",
          params: {},
        },
        {
          command: "joelclaw queue list --limit <n>",
          description: "Inspect currently queued messages",
          params: {
            n: {
              value: 20,
              default: 20,
              description: "Number of messages to list",
            },
          },
        },
        {
          command: `joelclaw otel search "queue.triage.fallback" --hours ${hours}`,
          description: "Inspect triage fallback telemetry",
          params: {},
        },
        {
          command: `joelclaw otel search "queue.triage.completed" --hours ${hours}`,
          description: "Inspect successful triage samples",
          params: {},
        },
      ];

      yield* Console.log(
        respond("queue stats", {
          ok: true,
          ...summary,
        }, next),
      );
    })),
);

/**
 * joelclaw queue observe [--hours <n>] [--limit <n>] [--since <iso|ms>] — Run the dry-run Sonnet operator surface.
 */
const observeCmd = Command.make(
  "observe",
  {
    hours: Options.integer("hours").pipe(
      Options.withAlias("h"),
      Options.withDefault(24),
      Options.withDescription("Lookback window in hours for related OTEL history"),
    ),
    limit: Options.integer("limit").pipe(
      Options.withAlias("n"),
      Options.withDefault(DEFAULT_QUEUE_STATS_LIMIT),
      Options.withDescription("Max OTEL events to sample per history surface"),
    ),
    since: Options.optional(
      Options.text("since").pipe(
        Options.withDescription("Override the lower bound with an ISO timestamp or epoch milliseconds"),
      ),
    ),
  },
  ({ hours, limit, since }) =>
    withRedisCleanup(Effect.gen(function* () {
      const observeResult = yield* Effect.tryPromise({
        try: async () => {
          await ensureQueueInitialized();
          const depth = await getQueueStats();
          const normalizedLimit = Math.min(Math.max(1, limit), DEFAULT_QUEUE_STATS_LIMIT);
          const sinceText = parseOptionalText(since);
          const parsedSince = sinceText ? parseSinceTimestamp(sinceText) : undefined;
          const messages = await listMessages(Math.max(1, depth.total));

          return runQueueObserveOperatorView({
            redis: getRedisClient(),
            depth: {
              total: depth.total,
              byPriority: depth.byPriority,
              oldestTimestamp: depth.oldestTimestamp,
              newestTimestamp: depth.newestTimestamp,
            },
            messages,
            hours,
            limit: normalizedLimit,
            sinceTimestamp: parsedSince,
          });
        },
        catch: (error) => error,
      }).pipe(Effect.either);

      if (observeResult._tag === "Left") {
        const error = observeResult.left;
        const next: NextAction[] = [
          {
            command: "joelclaw queue stats",
            description: "Check queue drainer and triage history",
            params: {},
          },
          {
            command: "joelclaw queue depth",
            description: "Check live queue depth",
            params: {},
          },
        ];

        if (isTypesenseApiKeyError(error) || __queueObserveCliTestUtils.isTypesenseApiKeyError(error)) {
          yield* Console.log(
            respondError("queue observe", error.message, error.code, error.fix, next),
          );
          return;
        }

        yield* Console.log(
          respondError(
            "queue observe",
            error instanceof Error ? error.message : String(error),
            "QUEUE_OBSERVE_FAILED",
            "Check Typesense reachability, queue OTEL history, and Sonnet inference health, then retry.",
            next,
          ),
        );
        return;
      }

      const summary = observeResult.right;
      const next: NextAction[] = [
        {
          command: "joelclaw queue control status [--hours <hours>] [--since <since>]",
          description: "Inspect active pauses, expirations, and recent deterministic control actions",
          params: {
            hours: {
              value: hours,
              default: hours,
              description: "Lookback window in hours",
            },
            since: {
              value: summary.observeHistory.window.sinceIso ?? undefined,
              description: "Optional lower bound for anchored windows",
            },
          },
        },
        {
          command: "joelclaw queue stats [--hours <hours>] [--since <since>]",
          description: "Compare the dry-run observation with queue drainer + triage history",
          params: {
            hours: {
              value: hours,
              default: hours,
              description: "Lookback window in hours",
            },
            since: {
              value: summary.observeHistory.window.sinceIso ?? undefined,
              description: "Optional lower bound for anchored windows",
            },
          },
        },
        {
          command: `joelclaw otel search "queue-control" --hours ${hours}`,
          description: "Inspect raw queue-control OTEL for the same window",
          params: {},
        },
      ];

      yield* Console.log(
        respond("queue observe", {
          ok: true,
          mode: "dry-run",
          snapshot: summary.snapshot,
          decision: summary.decision,
          history: summary.observeHistory,
          control: summary.control,
        }, next),
      );
    })),
);

/**
 * joelclaw queue pause <family> [--ttl <duration>] [--reason <text>] — Pause one family deterministically.
 */
const pauseCmd = Command.make(
  "pause",
  {
    family: Args.text({ name: "family" }).pipe(
      Args.withDescription("Exact queue family to pause (e.g., content/updated)"),
    ),
    ttl: Options.text("ttl").pipe(
      Options.withDefault("15m"),
      Options.withDescription("Pause TTL as <n>s|m|h|d (minimum 60s, maximum 1d)"),
    ),
    reason: Options.optional(
      Options.text("reason").pipe(
        Options.withDescription("Operator-visible reason for the pause"),
      ),
    ),
  },
  ({ family, ttl, reason }) =>
    withRedisCleanup(Effect.gen(function* () {
      const ttlMs = parseDurationToMs(ttl);
      if (ttlMs == null || ttlMs < 60_000 || ttlMs > 86_400_000) {
        yield* Console.log(
          respondError(
            "queue pause",
            `Invalid --ttl value: ${ttl}`,
            "QUEUE_CONTROL_INVALID_TTL",
            "Use a positive duration between 60s and 1d, for example --ttl 10m.",
            [{ command: "joelclaw queue pause <family> --ttl 10m --reason <text>", description: "Retry with a valid TTL" }],
          ),
        );
        return;
      }

      const pause = yield* Effect.tryPromise({
        try: () => pauseQueueFamily(getRedisClient(), {
          family,
          ttlMs,
          reason: parseOptionalText(reason) ?? `Manual pause from joelclaw queue pause for ${family}`,
          actor: "joelclaw queue pause",
        }),
        catch: (error) => new Error(`Failed to pause queue family: ${error}`),
      });

      yield* Effect.tryPromise({
        try: () => emitQueueControlTelemetry({
          level: "info",
          action: "queue.control.applied",
          success: true,
          metadata: {
            snapshotId: pause.snapshotId ?? null,
            mode: pause.mode,
            model: pause.model ?? null,
            family: pause.family,
            sourceType: pause.source,
            actor: pause.actor ?? null,
            appliedAt: pause.appliedAt,
            expiresAt: pause.expiresAt,
            reason: pause.reason,
            action: pauseStateToControlAction(pause),
          },
        }),
        catch: (error) => new Error(`Failed to emit queue-control telemetry: ${error}`),
      });

      yield* Console.log(
        respond("queue pause", {
          ok: true,
          pause: compactPauseState(pause),
        }, [
          {
            command: "joelclaw queue control status [--hours <hours>]",
            description: "Inspect active pause state and recent control actions",
            params: {
              hours: { value: 1, default: 24, description: "Lookback window in hours" },
            },
          },
          {
            command: "joelclaw queue observe [--hours <hours>]",
            description: "See how the dry-run observer now reports the active pause",
            params: {
              hours: { value: 1, default: 24, description: "Lookback window in hours" },
            },
          },
          {
            command: `joelclaw queue resume ${family}`,
            description: "Clear the pause deterministically",
            params: {},
          },
        ]),
      );
    })),
);

/**
 * joelclaw queue resume <family> [--reason <text>] — Resume one family deterministically.
 */
const resumeCmd = Command.make(
  "resume",
  {
    family: Args.text({ name: "family" }).pipe(
      Args.withDescription("Exact queue family to resume (e.g., content/updated)"),
    ),
    reason: Options.optional(
      Options.text("reason").pipe(
        Options.withDescription("Operator-visible reason for the resume"),
      ),
    ),
  },
  ({ family, reason }) =>
    withRedisCleanup(Effect.gen(function* () {
      const resumeReason = parseOptionalText(reason) ?? `Manual resume from joelclaw queue resume for ${family}`;
      const result = yield* Effect.tryPromise({
        try: () => resumeQueueFamily(getRedisClient(), { family }),
        catch: (error) => new Error(`Failed to resume queue family: ${error}`),
      });

      if (!result.removed) {
        const action = { kind: "resume_family", family, reason: resumeReason };
        yield* Effect.tryPromise({
          try: () => emitQueueControlTelemetry({
            level: "warn",
            action: "queue.control.rejected",
            success: false,
            error: `queue family ${family} is not paused`,
            metadata: {
              snapshotId: result.pause?.snapshotId ?? null,
              mode: "manual",
              model: null,
              family,
              sourceType: "manual",
              actor: "joelclaw queue resume",
              reason: `queue family ${family} is not paused`,
              action,
            },
          }),
          catch: (error) => new Error(`Failed to emit queue-control telemetry: ${error}`),
        });

        yield* Console.log(
          respondError(
            "queue resume",
            `Queue family ${family} is not paused`,
            "QUEUE_FAMILY_NOT_PAUSED",
            "Check queue control status for currently active pauses, then retry with one of those families.",
            [
              {
                command: "joelclaw queue control status [--hours <hours>]",
                description: "Inspect active deterministic pause state",
                params: {
                  hours: { value: 1, default: 24, description: "Lookback window in hours" },
                },
              },
            ],
          ),
        );
        return;
      }

      const action = {
        kind: "resume_family",
        family,
        reason: resumeReason,
      };
      yield* Effect.tryPromise({
        try: () => emitQueueControlTelemetry({
          level: "info",
          action: "queue.control.applied",
          success: true,
          metadata: {
            snapshotId: result.pause?.snapshotId ?? null,
            mode: "manual",
            model: result.pause?.model ?? null,
            family,
            sourceType: result.pause?.source ?? "manual",
            actor: "joelclaw queue resume",
            appliedAt: result.pause?.appliedAt ?? null,
            expiresAt: result.pause?.expiresAt ?? null,
            reason: resumeReason,
            action,
          },
        }),
        catch: (error) => new Error(`Failed to emit queue-control telemetry: ${error}`),
      });

      yield* Console.log(
        respond("queue resume", {
          ok: true,
          family,
          resumed: true,
          previousPause: result.pause ? compactPauseState(result.pause) : null,
        }, [
          {
            command: "joelclaw queue control status [--hours <hours>]",
            description: "Confirm the family is no longer paused",
            params: {
              hours: { value: 1, default: 24, description: "Lookback window in hours" },
            },
          },
          {
            command: "joelclaw queue depth",
            description: "Check whether deferred work has started draining",
            params: {},
          },
        ]),
      );
    })),
);

/**
 * joelclaw queue control status [--hours <n>] [--limit <n>] [--since <iso|ms>] — Inspect deterministic queue-control state.
 */
const controlStatusCmd = Command.make(
  "status",
  {
    hours: Options.integer("hours").pipe(
      Options.withAlias("h"),
      Options.withDefault(24),
      Options.withDescription("Lookback window in hours for queue-control telemetry"),
    ),
    limit: Options.integer("limit").pipe(
      Options.withAlias("n"),
      Options.withDefault(DEFAULT_QUEUE_STATS_LIMIT),
      Options.withDescription("Max queue-control OTEL events to sample"),
    ),
    since: Options.optional(
      Options.text("since").pipe(
        Options.withDescription("Override the lower bound with an ISO timestamp or epoch milliseconds"),
      ),
    ),
  },
  ({ hours, limit, since }) =>
    withRedisCleanup(Effect.gen(function* () {
      const sinceText = parseOptionalText(since);
      const parsedSince = sinceText ? parseSinceTimestamp(sinceText) : undefined;
      const statusResult = yield* Effect.tryPromise({
        try: async () => runQueueControlOperatorView({
          redis: getRedisClient(),
          hours,
          limit: Math.min(Math.max(1, limit), DEFAULT_QUEUE_STATS_LIMIT),
          sinceTimestamp: parsedSince,
        }),
        catch: (error) => error,
      }).pipe(Effect.either);

      if (statusResult._tag === "Left") {
        const error = statusResult.left;
        const next: NextAction[] = [
          {
            command: "joelclaw queue observe [--hours <hours>]",
            description: "Compare the observer surface against control history",
            params: {
              hours: { value: hours, default: 24, description: "Lookback window in hours" },
            },
          },
          {
            command: "joelclaw queue depth",
            description: "Check whether deferred work is still queued",
            params: {},
          },
        ];

        if (isTypesenseApiKeyError(error) || __queueObserveCliTestUtils.isTypesenseApiKeyError(error)) {
          yield* Console.log(
            respondError("queue control status", error.message, error.code, error.fix, next),
          );
          return;
        }

        yield* Console.log(
          respondError(
            "queue control status",
            error instanceof Error ? error.message : String(error),
            "QUEUE_CONTROL_STATUS_FAILED",
            "Check Typesense reachability and queue-control OTEL history, then retry.",
            next,
          ),
        );
        return;
      }

      const summary = statusResult.right;
      yield* Console.log(
        respond("queue control status", {
          ok: true,
          control: summary,
        }, [
          {
            command: "joelclaw queue observe [--hours <hours>] [--since <since>]",
            description: "Compare active control state with the latest dry-run observer decision",
            params: {
              hours: { value: hours, default: 24, description: "Lookback window in hours" },
              since: { value: summary.window.sinceIso ?? undefined, description: "Optional lower bound for anchored windows" },
            },
          },
          {
            command: `joelclaw otel search "queue-control" --hours ${hours}`,
            description: "Inspect raw queue-control OTEL for the same window",
            params: {},
          },
          {
            command: "joelclaw queue list --limit <n>",
            description: "Inspect currently deferred queue items",
            params: {
              n: { value: 20, default: 20, description: "Number of messages to list" },
            },
          },
        ]),
      );
    })),
);

const controlCmd = Command.make("control", {}).pipe(
  Command.withDescription("Deterministic queue-control operator surface"),
  Command.withSubcommands([controlStatusCmd]),
);

/**
 * joelclaw queue list [--limit <n>] — List recent messages.
 */
const listCmd = Command.make(
  "list",
  {
    limit: Options.integer("limit").pipe(
      Options.withDescription("Number of messages to list"),
      Options.withDefault(10)
    ),
  },
  ({ limit }) =>
    withRedisCleanup(Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => ensureQueueInitialized(),
        catch: (error) => new Error(`Failed to initialize queue: ${error}`),
      });

      const messages = yield* Effect.tryPromise({
        try: () => listMessages(limit),
        catch: (error) => new Error(`Failed to list messages: ${error}`),
      });

      const next: NextAction[] = messages.slice(0, 3).map((msg) => ({
        command: "joelclaw queue inspect <stream-id>",
        description: `Inspect ${msg.id}`,
        params: {
          "stream-id": {
            value: msg.id,
            required: true,
            description: "Redis stream ID",
          },
        },
      }));

      next.push({
        command: "joelclaw queue depth",
        description: "Check queue depth",
        params: {},
      });

      yield* Console.log(
        respond("queue list", {
          ok: true,
          count: messages.length,
          messages: messages.map((msg) => ({
            id: msg.id,
            priority: msg.priority,
            timestamp: msg.timestamp,
            age: Math.floor((Date.now() - msg.timestamp) / 1000),
            acked: msg.acked,
            payload: msg.payload,
          })),
        }, next)
      );
    }))
);

/**
 * joelclaw queue inspect <stream-id> — Inspect a message by ID.
 */
const inspectCmd = Command.make(
  "inspect",
  {
    streamId: Args.text({ name: "stream-id" }).pipe(
      Args.withDescription("Redis stream ID")
    ),
  },
  ({ streamId }) =>
    withRedisCleanup(Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => ensureQueueInitialized(),
        catch: (error) => new Error(`Failed to initialize queue: ${error}`),
      });

      const message = yield* Effect.tryPromise({
        try: () => inspectById(streamId),
        catch: (error) => new Error(`Failed to inspect message: ${error}`),
      });

      if (!message) {
        const next: NextAction[] = [
          {
            command: "joelclaw queue list",
            description: "List current queued messages",
            params: {},
          },
          {
            command: "joelclaw queue depth",
            description: "Check current queue depth",
            params: {},
          },
        ];

        yield* Console.log(
          respondError(
            "queue inspect",
            `Message not found: ${streamId}`,
            "QUEUE_MESSAGE_MISSING",
            "The message may already be acked or expired; inspect current queue state and retry with a fresh stream ID.",
            next,
          )
        );
        return;
      }

      const next: NextAction[] = [
        {
          command: "joelclaw queue list",
          description: "List other queued messages",
          params: {},
        },
        {
          command: "joelclaw queue depth",
          description: "Check queue depth",
          params: {},
        },
      ];

      yield* Console.log(
        respond("queue inspect", {
          ok: true,
          message: {
            id: message.id,
            priority: message.priority,
            timestamp: message.timestamp,
            age: Math.floor((Date.now() - message.timestamp) / 1000),
            acked: message.acked,
            payload: message.payload,
            metadata: message.metadata,
          },
        }, next)
      );
    }))
);

/**
 * joelclaw queue — Queue operator surface.
 */
export const queueCmd = Command.make("queue", {}).pipe(
  Command.withDescription("Queue operator surface for @joelclaw/queue"),
  Command.withSubcommands([emitCmd, depthCmd, statsCmd, observeCmd, pauseCmd, resumeCmd, controlCmd, listCmd, inspectCmd])
);

export const __queueTestUtils = {
  parseDurationToMs,
  parseSinceTimestamp,
  percentile,
  summarizeQueueControlHistory: __queueObserveCliTestUtils.summarizeQueueControlHistory,
  summarizeQueueObserveHistory: __queueObserveCliTestUtils.summarizeQueueObserveHistory,
  summarizeQueueStats,
  summarizeQueueTriageStats,
};
