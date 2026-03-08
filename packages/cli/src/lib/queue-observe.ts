import {
  DEFAULT_QUEUE_CONTROL_CONFIG,
  expireQueueFamilyPauses,
  listActiveQueueFamilyPauses,
  pauseStateToControlAction,
  type QueueFamilyPauseState,
  type QueueObservationDecision,
  type QueueObservationDownstreamState,
  type QueueObservationSnapshot,
  type StoredMessage,
} from "@joelclaw/queue";
import {
  buildQueueObservationSnapshot,
  observeQueueSnapshot,
} from "@joelclaw/system-bus/src/lib/queue-observe.ts";
import type Redis from "ioredis";
import { isTypesenseApiKeyError, resolveTypesenseApiKey } from "../typesense-auth";
import { createOtelEventPayload, ingestOtelPayload } from "./otel-ingest";

const TYPESENSE_URL = process.env.TYPESENSE_URL ?? "http://localhost:8108";
const OTEL_COLLECTION = "otel_events";
const OTEL_QUERY_BY = "action,error,component,source,metadata_json,search_text";
const DEFAULT_LIMIT = 200;
const SYSTEM_SLEEP_KEY = "system:sleep";
const GATEWAY_HEALTH_MUTED_CHANNELS_KEY = "gateway:health:muted-channels";
const QUEUE_LATENCY_TARGET_P95_MS = 5_000;

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
const QUEUE_OBSERVE_ACTIONS = [
  "queue.observe.started",
  "queue.observe.completed",
  "queue.observe.failed",
  "queue.observe.fallback",
] as const;
const QUEUE_CONTROL_ACTIONS = [
  "queue.control.applied",
  "queue.control.expired",
  "queue.control.rejected",
] as const;

type QueueDispatchAction = (typeof QUEUE_DISPATCH_ACTIONS)[number];
type QueueTriageAction = (typeof QUEUE_TRIAGE_ACTIONS)[number];
type QueueObserveOtelAction = (typeof QUEUE_OBSERVE_ACTIONS)[number];
type QueueControlOtelAction = (typeof QUEUE_CONTROL_ACTIONS)[number];

export type QueueDepthSnapshot = {
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

type QueueObserveEvent = {
  id: string;
  timestamp: number;
  action: QueueObserveOtelAction;
  success: boolean;
  error?: string;
  metadata: Record<string, unknown>;
};

type QueueControlEvent = {
  id: string;
  timestamp: number;
  action: QueueControlOtelAction;
  success: boolean;
  error?: string;
  metadata: Record<string, unknown>;
};

export type QueueStatsWindow = {
  hours: number;
  sinceTimestamp: number | null;
  sinceIso: string | null;
  found: number;
  sampled: number;
  truncated: boolean;
  filterBy: string;
};

type GatewaySummary = {
  sleepMode: boolean;
  quietHours: boolean | null;
  mutedChannels: string[];
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

function parseStringArrayJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))]
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
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

function isQuietHours(): boolean {
  const pstString = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
  const pstHour = new Date(pstString).getHours();
  return pstHour >= 23 || pstHour < 7;
}

function windowFor(hours: number, found: number, sampled: number, filterBy: string, sinceTimestamp?: number): QueueStatsWindow {
  return {
    hours,
    sinceTimestamp: sinceTimestamp ?? null,
    sinceIso: sinceTimestamp ? new Date(sinceTimestamp).toISOString() : null,
    found,
    sampled,
    truncated: found > sampled,
    filterBy,
  };
}

function minutesInWindow(hours: number, sinceTimestamp?: number): number {
  const lowerBound = sinceTimestamp ?? Math.floor(Date.now() - hours * 60 * 60 * 1000);
  return Math.max(1, Math.round((Date.now() - lowerBound) / 60_000));
}

function triageFamilyName(event: QueueTriageEvent): string {
  return asNonEmptyString(event.metadata.family)
    ?? asNonEmptyString(event.metadata.queueEventName)
    ?? "unknown";
}

function isQueueDispatchAction(value: unknown): value is QueueDispatchAction {
  return typeof value === "string"
    && (QUEUE_DISPATCH_ACTIONS as readonly string[]).includes(value);
}

function isQueueTriageAction(value: unknown): value is QueueTriageAction {
  return typeof value === "string"
    && (QUEUE_TRIAGE_ACTIONS as readonly string[]).includes(value);
}

function isQueueObserveAction(value: unknown): value is QueueObserveOtelAction {
  return typeof value === "string"
    && (QUEUE_OBSERVE_ACTIONS as readonly string[]).includes(value);
}

function isQueueControlAction(value: unknown): value is QueueControlOtelAction {
  return typeof value === "string"
    && (QUEUE_CONTROL_ACTIONS as readonly string[]).includes(value);
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

function parseQueueObserveHit(hit: unknown): QueueObserveEvent | null {
  const doc = (hit as { document?: Record<string, unknown> })?.document;
  if (!doc) return null;

  const action = doc.action;
  const timestamp = asFiniteNumber(doc.timestamp);
  if (!isQueueObserveAction(action) || timestamp == null) return null;

  return {
    id: asNonEmptyString(doc.id) ?? `${action}-${timestamp}`,
    timestamp,
    action,
    success: doc.success !== false,
    error: asNonEmptyString(doc.error),
    metadata: parseMetadataJson(doc.metadata_json),
  };
}

function parseQueueControlHit(hit: unknown): QueueControlEvent | null {
  const doc = (hit as { document?: Record<string, unknown> })?.document;
  if (!doc) return null;

  const action = doc.action;
  const timestamp = asFiniteNumber(doc.timestamp);
  if (!isQueueControlAction(action) || timestamp == null) return null;

  return {
    id: asNonEmptyString(doc.id) ?? `${action}-${timestamp}`,
    timestamp,
    action,
    success: doc.success !== false,
    error: asNonEmptyString(doc.error),
    metadata: parseMetadataJson(doc.metadata_json),
  };
}

async function loadOtelWindow<T>(input: {
  component: string;
  source?: string;
  actions: readonly string[];
  hours: number;
  limit: number;
  sinceTimestamp?: number;
  parser: (hit: unknown) => T | null;
}): Promise<{ found: number; events: T[]; filterBy: string }> {
  const apiKey = resolveTypesenseApiKey();
  const lowerBound = input.sinceTimestamp ?? Math.floor(Date.now() - input.hours * 60 * 60 * 1000);
  const filterBy = [
    `timestamp:>=${lowerBound}`,
    ...(input.source ? [`source:=${input.source}`] : []),
    `component:=${input.component}`,
    `action:=[${input.actions.join(",")}]`,
  ].join(" && ");

  const searchParams = new URLSearchParams({
    q: "*",
    query_by: OTEL_QUERY_BY,
    filter_by: filterBy,
    per_page: String(Math.min(Math.max(1, input.limit), DEFAULT_LIMIT)),
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
    .map(input.parser)
    .filter((event): event is T => event !== null);

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
) {
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
      p95: percentile(waitTimes, 0.95),
      max: waitTimes.length > 0 ? Math.max(...waitTimes) : null,
      targetP95: QUEUE_LATENCY_TARGET_P95_MS,
      withinTarget: waitTimes.length === 0 ? null : (percentile(waitTimes, 0.95) ?? 0) <= QUEUE_LATENCY_TARGET_P95_MS,
    },
    dispatchDurationMs: {
      count: dispatchDurations.length,
      average: average(dispatchDurations),
      p50: percentile(dispatchDurations, 0.5),
      p95: percentile(dispatchDurations, 0.95),
      max: dispatchDurations.length > 0 ? Math.max(...dispatchDurations) : null,
    },
  };
}

function summarizeQueueTriageStats(events: readonly QueueTriageEvent[]) {
  const completed = events.filter((event) => event.action === "queue.triage.completed");
  const failed = events.filter((event) => event.action === "queue.triage.failed");
  const fallbacks = events.filter((event) => event.action === "queue.triage.fallback");
  const latencySamples = [...completed, ...fallbacks]
    .map((event) => asFiniteNumber(event.metadata.latencyMs))
    .filter((value): value is number => value != null && value >= 0);

  const fallbackReasons = new Map<string, number>();
  for (const event of fallbacks) {
    const reason = asNonEmptyString(event.metadata.fallbackReason) ?? "unknown";
    fallbackReasons.set(reason, (fallbackReasons.get(reason) ?? 0) + 1);
  }

  return {
    attempts: events.filter((event) => event.action === "queue.triage.started").length,
    completed: completed.length,
    failed: failed.length,
    fallbacks: fallbacks.length,
    fallbackByReason: Object.fromEntries([...fallbackReasons.entries()]) as Record<string, number>,
    routeMismatches: completed.filter((event) => asNonEmptyString(event.metadata.routeCheck) === "mismatch").length,
    latencyMs: {
      p50: percentile(latencySamples, 0.5),
      p95: percentile(latencySamples, 0.95),
    },
  };
}

function deriveDrainerState(input: {
  depth: QueueDepthSnapshot;
  dispatchSummary: ReturnType<typeof summarizeQueueStats>;
}): QueueObservationDownstreamState {
  if (input.depth.total > 0 && input.dispatchSummary.dispatches.started === 0) {
    return "down";
  }

  if (
    input.dispatchSummary.dispatches.failed > 0
    || input.dispatchSummary.queueLatencyMs.withinTarget === false
  ) {
    return "degraded";
  }

  return "healthy";
}

async function loadGatewaySummary(redis: Pick<Redis, "mget">): Promise<GatewaySummary> {
  const [sleepRaw, mutedRaw] = await redis.mget(SYSTEM_SLEEP_KEY, GATEWAY_HEALTH_MUTED_CHANNELS_KEY);
  return {
    sleepMode: typeof sleepRaw === "string" && sleepRaw.trim().length > 0,
    quietHours: isQuietHours(),
    mutedChannels: parseStringArrayJson(mutedRaw),
  };
}

export function summarizeQueueObserveHistory(events: readonly QueueObserveEvent[], window: QueueStatsWindow) {
  const completed = events.filter((event) => event.action === "queue.observe.completed");
  const failed = events.filter((event) => event.action === "queue.observe.failed");
  const fallbacks = events.filter((event) => event.action === "queue.observe.fallback");
  const terminal = completed.length + fallbacks.length;

  const latencySamples = [...completed, ...fallbacks]
    .map((event) => asFiniteNumber(event.metadata.latencyMs))
    .filter((value): value is number => value != null && value >= 0);

  const fallbackReasons = new Map<string, number>();
  for (const event of fallbacks) {
    const reason = asNonEmptyString(event.metadata.fallbackReason) ?? "unknown";
    fallbackReasons.set(reason, (fallbackReasons.get(reason) ?? 0) + 1);
  }

  return {
    window,
    attempts: events.filter((event) => event.action === "queue.observe.started").length,
    completed: completed.length,
    failed: failed.length,
    fallbacks: fallbacks.length,
    terminal,
    successRate: terminal > 0 ? completed.length / terminal : null,
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
    recentDecisions: completed.slice(0, 5).map((event) => ({
      at: new Date(event.timestamp).toISOString(),
      snapshotId: asNonEmptyString(event.metadata.snapshotId) ?? null,
      mode: asNonEmptyString(event.metadata.mode) ?? null,
      queuePressure: asNonEmptyString(event.metadata.queuePressure) ?? null,
      downstreamState: asNonEmptyString(event.metadata.downstreamState) ?? null,
      summary: asNonEmptyString(event.metadata.summary) ?? null,
      suggestedCount: asFiniteNumber(event.metadata.suggestedCount) ?? null,
      finalCount: asFiniteNumber(event.metadata.finalCount) ?? null,
      appliedCount: asFiniteNumber(event.metadata.appliedCount) ?? null,
      suggestedActionKinds: Array.isArray(event.metadata.suggestedActionKinds)
        ? event.metadata.suggestedActionKinds.filter((value): value is string => typeof value === "string")
        : [],
      finalActionKinds: Array.isArray(event.metadata.finalActionKinds)
        ? event.metadata.finalActionKinds.filter((value): value is string => typeof value === "string")
        : [],
      latencyMs: asFiniteNumber(event.metadata.latencyMs) ?? null,
    })),
    recentFallbacks: fallbacks.slice(0, 5).map((event) => ({
      at: new Date(event.timestamp).toISOString(),
      snapshotId: asNonEmptyString(event.metadata.snapshotId) ?? null,
      mode: asNonEmptyString(event.metadata.mode) ?? null,
      reason: asNonEmptyString(event.metadata.fallbackReason) ?? "unknown",
      queuePressure: asNonEmptyString(event.metadata.queuePressure) ?? null,
      downstreamState: asNonEmptyString(event.metadata.downstreamState) ?? null,
      summary: asNonEmptyString(event.metadata.summary) ?? null,
      latencyMs: asFiniteNumber(event.metadata.latencyMs) ?? null,
    })),
  };
}

export function summarizeQueueControlHistory(
  events: readonly QueueControlEvent[],
  window: QueueStatsWindow,
  activePauses: readonly QueueFamilyPauseState[],
) {
  return {
    window,
    available: true,
    activePauses: activePauses.map((pause) => ({
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
    })),
    counts: {
      applied: events.filter((event) => event.action === "queue.control.applied").length,
      expired: events.filter((event) => event.action === "queue.control.expired").length,
      rejected: events.filter((event) => event.action === "queue.control.rejected").length,
    },
    recentEvents: events.slice(0, 5).map((event) => ({
      at: new Date(event.timestamp).toISOString(),
      action: event.action,
      snapshotId: asNonEmptyString(event.metadata.snapshotId) ?? null,
      mode: asNonEmptyString(event.metadata.mode) ?? null,
      family: asNonEmptyString(event.metadata.family)
        ?? asNonEmptyString((event.metadata.action as { family?: unknown } | null | undefined)?.family)
        ?? null,
      sourceType: asNonEmptyString(event.metadata.sourceType) ?? null,
      actor: asNonEmptyString(event.metadata.actor) ?? null,
      expiresAt: asNonEmptyString(event.metadata.expiresAt) ?? null,
      expiredAt: asNonEmptyString(event.metadata.expiredAt) ?? null,
      reason: asNonEmptyString(event.metadata.reason) ?? event.error ?? null,
      actionMetadata: event.metadata.action ?? null,
    })),
  };
}

async function emitExpiredQueueControlTelemetry(
  pauses: Awaited<ReturnType<typeof expireQueueFamilyPauses>>,
): Promise<void> {
  await Promise.all(pauses.map((pause) => ingestOtelPayload(createOtelEventPayload({
    level: "info",
    source: "cli",
    component: "queue-control",
    action: "queue.control.expired",
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
      expiredAt: pause.expiredAt,
      reason: pause.reason,
      action: pauseStateToControlAction(pause),
    },
  }))));
}

async function refreshQueueControlState(redis: Pick<Redis, "hdel" | "hget" | "hgetall" | "hset" | "mget" | "zadd" | "zrangebyscore" | "zrem">) {
  const expiredPauses = await expireQueueFamilyPauses(redis, {
    config: DEFAULT_QUEUE_CONTROL_CONFIG,
  });
  if (expiredPauses.length > 0) {
    await emitExpiredQueueControlTelemetry(expiredPauses);
  }

  const activePauses = await listActiveQueueFamilyPauses(redis, {
    config: DEFAULT_QUEUE_CONTROL_CONFIG,
  });

  return {
    expiredPauses,
    activePauses,
  };
}

export async function runQueueControlOperatorView(input: {
  redis: Pick<Redis, "hdel" | "hget" | "hgetall" | "hset" | "mget" | "zadd" | "zrangebyscore" | "zrem">;
  hours: number;
  limit: number;
  sinceTimestamp?: number;
}): Promise<ReturnType<typeof summarizeQueueControlHistory>> {
  const normalizedLimit = Math.min(Math.max(1, input.limit), DEFAULT_LIMIT);
  const [{ activePauses }, controlWindow] = await Promise.all([
    refreshQueueControlState(input.redis),
    loadOtelWindow({
      component: "queue-control",
      actions: QUEUE_CONTROL_ACTIONS,
      hours: input.hours,
      limit: normalizedLimit,
      sinceTimestamp: input.sinceTimestamp,
      parser: parseQueueControlHit,
    }),
  ]);

  return summarizeQueueControlHistory(
    controlWindow.events,
    windowFor(input.hours, controlWindow.found, controlWindow.events.length, controlWindow.filterBy, input.sinceTimestamp),
    activePauses,
  );
}

export async function runQueueObserveOperatorView(input: {
  redis: Pick<Redis, "hdel" | "hget" | "hgetall" | "hset" | "mget" | "zadd" | "zrangebyscore" | "zrem">;
  depth: QueueDepthSnapshot;
  messages: ReadonlyArray<StoredMessage>;
  hours: number;
  limit: number;
  sinceTimestamp?: number;
}): Promise<{
  snapshot: QueueObservationSnapshot;
  decision: QueueObservationDecision;
  observeHistory: ReturnType<typeof summarizeQueueObserveHistory>;
  control: ReturnType<typeof summarizeQueueControlHistory>;
}> {
  const normalizedLimit = Math.min(Math.max(1, input.limit), DEFAULT_LIMIT);
  const [dispatchWindow, triageWindow, gateway, { activePauses }, controlWindow] = await Promise.all([
    loadOtelWindow({
      component: "queue-drainer",
      source: "restate",
      actions: QUEUE_DISPATCH_ACTIONS,
      hours: input.hours,
      limit: normalizedLimit,
      sinceTimestamp: input.sinceTimestamp,
      parser: parseQueueDispatchHit,
    }),
    loadOtelWindow({
      component: "queue-triage",
      source: "worker",
      actions: QUEUE_TRIAGE_ACTIONS,
      hours: input.hours,
      limit: normalizedLimit,
      sinceTimestamp: input.sinceTimestamp,
      parser: parseQueueTriageHit,
    }),
    loadGatewaySummary(input.redis),
    refreshQueueControlState(input.redis),
    loadOtelWindow({
      component: "queue-control",
      actions: QUEUE_CONTROL_ACTIONS,
      hours: input.hours,
      limit: normalizedLimit,
      sinceTimestamp: input.sinceTimestamp,
      parser: parseQueueControlHit,
    }),
  ]);

  const control = summarizeQueueControlHistory(
    controlWindow.events,
    windowFor(input.hours, controlWindow.found, controlWindow.events.length, controlWindow.filterBy, input.sinceTimestamp),
    activePauses,
  );

  const dispatchSummary = summarizeQueueStats(
    dispatchWindow.events,
    input.depth,
    windowFor(input.hours, dispatchWindow.found, dispatchWindow.events.length, dispatchWindow.filterBy, input.sinceTimestamp),
  );
  const triageSummary = summarizeQueueTriageStats(triageWindow.events);

  const snapshot = buildQueueObservationSnapshot({
    stats: input.depth,
    messages: input.messages,
    triage: triageSummary,
    drainer: {
      state: deriveDrainerState({ depth: input.depth, dispatchSummary }),
      recentDispatches: dispatchSummary.dispatches.started,
      recentFailures: dispatchSummary.dispatches.failed,
      throughputPerMinute: Number((dispatchSummary.dispatches.started / minutesInWindow(input.hours, input.sinceTimestamp)).toFixed(2)),
    },
    gateway,
    control: {
      activePauses: activePauses.map((pause) => ({
        family: pause.family,
        reason: pause.reason,
        source: pause.source,
        mode: pause.mode,
        appliedAt: pause.appliedAt,
        expiresAt: pause.expiresAt,
        expiresAtMs: pause.expiresAtMs,
      })),
    },
  });

  const decision = await observeQueueSnapshot({
    mode: "dry-run",
    snapshot,
  });

  const observeWindow = await loadOtelWindow({
    component: "queue-observe",
    source: "worker",
    actions: QUEUE_OBSERVE_ACTIONS,
    hours: input.hours,
    limit: normalizedLimit,
    sinceTimestamp: input.sinceTimestamp,
    parser: parseQueueObserveHit,
  });

  return {
    snapshot,
    decision,
    observeHistory: summarizeQueueObserveHistory(
      observeWindow.events,
      windowFor(input.hours, observeWindow.found, observeWindow.events.length, observeWindow.filterBy, input.sinceTimestamp),
    ),
    control,
  };
}

export const __queueObserveCliTestUtils = {
  isTypesenseApiKeyError,
  summarizeQueueControlHistory,
  summarizeQueueObserveHistory,
};
