import {
  DEFAULT_QUEUE_CONTROL_CONFIG,
  getQueueStats,
  listActiveQueueFamilyPauses,
  listMessages,
  Priority,
  pauseQueueFamily,
  type QueueControlMode,
  type QueueFamilyPauseState,
  type QueueObservationMode,
  type QueueObserverAction,
  type QueuePriorityCounts,
  resumeQueueFamily,
  type StoredMessage,
} from "@joelclaw/queue";
import type Redis from "ioredis";
import { ensureQueueInitialized } from "../../lib/queue";
import {
  buildQueueObservationSnapshot,
  emitQueueControlApplied,
  emitQueueControlRejected,
  emitQueueObserveCompleted,
  emitQueueObserveFailed,
  emitQueueObserveFallback,
  emitQueueObserveStarted,
  observeQueueSnapshotDetailed,
  QUEUE_OBSERVE_MODEL,
} from "../../lib/queue-observe";
import { getRedisClient } from "../../lib/redis";
import { search } from "../../lib/typesense";
import { inngest } from "../client";

const OTEL_COLLECTION = "otel_events";
const OTEL_QUERY_BY = "action,error,component,source,metadata_json,search_text";
const DEFAULT_WINDOW_HOURS = 1;
const DEFAULT_LIMIT = 200;
const QUEUE_OBSERVER_INTERVAL_SECONDS_DEFAULT = 60;
const QUEUE_OBSERVER_INTERVAL_SECONDS_MIN = 60;
const QUEUE_OBSERVER_LAST_RUN_KEY = "joelclaw:queue:observer:last-run-ms";
const SYSTEM_SLEEP_KEY = "system:sleep";
const GATEWAY_HEALTH_MUTED_CHANNELS_KEY = "gateway:health:muted-channels";
const QUEUE_OBSERVER_CRON = "TZ=America/Los_Angeles */1 * * * *";

const DEFAULT_QUEUE_OBSERVER_FAMILIES = [
  "discovery/noted",
  "discovery/captured",
  "content/updated",
  "subscription/check-feeds.requested",
  "github/workflow_run.completed",
] as const;

const ENFORCE_ELIGIBLE_QUEUE_OBSERVER_AUTO_FAMILIES = [
  "content/updated",
] as const;

const QUEUE_OBSERVER_FAMILY_ALIASES = {
  discovery: ["discovery/noted", "discovery/captured"],
  content: ["content/updated"],
  subscriptions: ["subscription/check-feeds.requested"],
  github: ["github/workflow_run.completed"],
} as const satisfies Record<string, readonly string[]>;

const QUEUE_OBSERVER_AUTO_FAMILY_ALIASES = {
  content: ["content/updated"],
} as const satisfies Record<string, readonly string[]>;

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

type QueueDispatchAction = (typeof QUEUE_DISPATCH_ACTIONS)[number];
type QueueTriageAction = (typeof QUEUE_TRIAGE_ACTIONS)[number];

type QueueDispatchEvent = {
  timestamp: number;
  action: QueueDispatchAction;
  metadata: Record<string, unknown>;
};

type QueueTriageEvent = {
  timestamp: number;
  action: QueueTriageAction;
  metadata: Record<string, unknown>;
};

type RedisLike = Pick<
  Redis,
  "get" | "mget" | "hdel" | "hget" | "hgetall" | "hset" | "set" | "zadd" | "zrangebyscore" | "zrem"
>;

type QueueObserverConfig = {
  mode: QueueObservationMode;
  observeFamilies: Set<string>;
  autoApplyFamilies: Set<string>;
  intervalSeconds: number;
};

type QueueObserverCadenceGate = {
  shouldRun: boolean;
  intervalSeconds: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
};

type QueueDepthSnapshot = {
  total: number;
  byPriority: QueuePriorityCounts;
  oldestTimestamp: number | null;
  newestTimestamp: number | null;
};

type QueueObserverReport = {
  text: string;
  escalationCount: number;
};

type QueueObserverApplyResult = {
  appliedActions: QueueObserverAction[];
  rejectedActions: Array<{ action: QueueObserverAction; reason: string }>;
  report: QueueObserverReport | null;
};

const queueObserverDeps = {
  ensureQueueInitialized,
  getQueueStats,
  listMessages,
  listActiveQueueFamilyPauses,
  pauseQueueFamily,
  resumeQueueFamily,
  search,
  getRedisClient,
};

function parseCsvSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function parseQueueObservationMode(raw: string | undefined): QueueObservationMode {
  const normalized = (raw ?? "off").trim().toLowerCase();
  if (normalized === "dry-run") return "dry-run";
  if (normalized === "enforce") return "enforce";
  return "off";
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }

  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  return fallback;
}

function parseStringArrayJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))]
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function expandConfiguredFamilies(
  configured: Set<string>,
  aliases: Record<string, readonly string[]>,
  fallbackFamilies: readonly string[],
): Set<string> {
  if (configured.size === 0) {
    return new Set(fallbackFamilies);
  }

  const expanded = new Set<string>();
  for (const value of configured) {
    const aliasTargets = aliases[value as keyof typeof aliases];
    if (aliasTargets) {
      for (const target of aliasTargets) expanded.add(target);
      continue;
    }

    expanded.add(value);
  }

  return expanded;
}

function expandQueueObserverFamilies(raw: string | undefined): Set<string> {
  return expandConfiguredFamilies(
    parseCsvSet(raw),
    QUEUE_OBSERVER_FAMILY_ALIASES,
    DEFAULT_QUEUE_OBSERVER_FAMILIES,
  );
}

function expandQueueObserverAutoFamilies(raw: string | undefined): Set<string> {
  const expanded = expandConfiguredFamilies(
    parseCsvSet(raw),
    QUEUE_OBSERVER_AUTO_FAMILY_ALIASES,
    [],
  );

  return new Set(
    [...expanded].filter((family) => ENFORCE_ELIGIBLE_QUEUE_OBSERVER_AUTO_FAMILIES.includes(
      family as (typeof ENFORCE_ELIGIBLE_QUEUE_OBSERVER_AUTO_FAMILIES)[number],
    )),
  );
}

function resolveQueueObserverConfig(env: NodeJS.ProcessEnv = process.env): QueueObserverConfig {
  const mode = parseQueueObservationMode(env.QUEUE_OBSERVER_MODE);
  const observeFamilies = expandQueueObserverFamilies(env.QUEUE_OBSERVER_FAMILIES);
  const autoApplyFamilies = new Set(
    [...expandQueueObserverAutoFamilies(env.QUEUE_OBSERVER_AUTO_FAMILIES)].filter((family) => observeFamilies.has(family)),
  );

  return {
    mode,
    observeFamilies,
    autoApplyFamilies,
    intervalSeconds: Math.max(
      QUEUE_OBSERVER_INTERVAL_SECONDS_MIN,
      parsePositiveInt(env.QUEUE_OBSERVER_INTERVAL_SECONDS, QUEUE_OBSERVER_INTERVAL_SECONDS_DEFAULT),
    ),
  };
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseMetadataJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed metadata JSON
  }
  return {};
}

function isQueueDispatchAction(value: unknown): value is QueueDispatchAction {
  return typeof value === "string" && (QUEUE_DISPATCH_ACTIONS as readonly string[]).includes(value);
}

function isQueueTriageAction(value: unknown): value is QueueTriageAction {
  return typeof value === "string" && (QUEUE_TRIAGE_ACTIONS as readonly string[]).includes(value);
}

function parseQueueDispatchHit(hit: unknown): QueueDispatchEvent | null {
  const doc = (hit as { document?: Record<string, unknown> })?.document;
  if (!doc) return null;

  const action = doc.action;
  const timestamp = asFiniteNumber(doc.timestamp);
  if (!isQueueDispatchAction(action) || timestamp == null) return null;

  return {
    timestamp,
    action,
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
    timestamp,
    action,
    metadata: parseMetadataJson(doc.metadata_json),
  };
}

async function loadOtelWindow<T>(input: {
  component: string;
  source?: string;
  actions: readonly string[];
  hours: number;
  limit: number;
  parser: (hit: unknown) => T | null;
}): Promise<T[]> {
  const lowerBound = Math.floor(Date.now() - input.hours * 60 * 60 * 1000);
  const filterBy = [
    `timestamp:>=${lowerBound}`,
    ...(input.source ? [`source:=${input.source}`] : []),
    `component:=${input.component}`,
    `action:=[${input.actions.join(",")}]`,
  ].join(" && ");

  const result = await queueObserverDeps.search({
    collection: OTEL_COLLECTION,
    q: "*",
    query_by: OTEL_QUERY_BY,
    filter_by: filterBy,
    per_page: Math.min(Math.max(1, input.limit), DEFAULT_LIMIT),
    page: 1,
    sort_by: "timestamp:desc",
    include_fields: "timestamp,action,metadata_json",
  });

  return result.hits
    .map(input.parser)
    .filter((event): event is T => event !== null);
}

function familyFromDispatchEvent(event: QueueDispatchEvent): string | undefined {
  return asNonEmptyString(event.metadata.eventName) ?? asNonEmptyString(event.metadata.family);
}

function familyFromTriageEvent(event: QueueTriageEvent): string {
  return asNonEmptyString(event.metadata.family)
    ?? asNonEmptyString(event.metadata.queueEventName)
    ?? "unknown";
}

function filterDispatchEvents(events: readonly QueueDispatchEvent[], families: Set<string>): QueueDispatchEvent[] {
  if (families.size === 0) return [...events];
  return events.filter((event) => {
    const family = familyFromDispatchEvent(event);
    return !family || families.has(family);
  });
}

function filterTriageEvents(events: readonly QueueTriageEvent[], families: Set<string>): QueueTriageEvent[] {
  if (families.size === 0) return [...events];
  return events.filter((event) => families.has(familyFromTriageEvent(event)));
}

function percentile(values: readonly number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? null;
}

function deriveDepthSnapshot(messages: readonly StoredMessage[]): QueueDepthSnapshot {
  const byPriority: QueuePriorityCounts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  let oldestTimestamp: number | null = null;
  let newestTimestamp: number | null = null;

  for (const message of messages) {
    const label = message.priority === Priority.P0
      ? "P0"
      : message.priority === Priority.P1
        ? "P1"
        : message.priority === Priority.P2
          ? "P2"
          : "P3";
    byPriority[label] += 1;
    oldestTimestamp = oldestTimestamp == null ? message.timestamp : Math.min(oldestTimestamp, message.timestamp);
    newestTimestamp = newestTimestamp == null ? message.timestamp : Math.max(newestTimestamp, message.timestamp);
  }

  return {
    total: messages.length,
    byPriority,
    oldestTimestamp,
    newestTimestamp,
  };
}

function summarizeDispatchWindow(
  events: readonly QueueDispatchEvent[],
  depth: QueueDepthSnapshot,
  hours: number,
) {
  const started = events.filter((event) => event.action === "queue.dispatch.started");
  const failed = events.filter((event) => event.action === "queue.dispatch.failed");
  const waitTimes = started
    .map((event) => asFiniteNumber(event.metadata.waitTimeMs))
    .filter((value): value is number => value != null && value >= 0);

  return {
    started: started.length,
    failed: failed.length,
    queueLatencyP95Ms: percentile(waitTimes, 0.95),
    drainerState: depth.total > 0 && started.length === 0
      ? "down"
      : failed.length > 0 || ((percentile(waitTimes, 0.95) ?? 0) > 5_000)
        ? "degraded"
        : "healthy",
    throughputPerMinute: Number((started.length / Math.max(1, hours * 60)).toFixed(2)),
  } as const;
}

function summarizeTriageWindow(events: readonly QueueTriageEvent[]) {
  const completed = events.filter((event) => event.action === "queue.triage.completed");
  const failed = events.filter((event) => event.action === "queue.triage.failed");
  const fallbacks = events.filter((event) => event.action === "queue.triage.fallback");
  const latencySamples = [...completed, ...fallbacks]
    .map((event) => asFiniteNumber(event.metadata.latencyMs))
    .filter((value): value is number => value != null && value >= 0);
  const fallbackByReason = new Map<string, number>();

  for (const event of fallbacks) {
    const reason = asNonEmptyString(event.metadata.fallbackReason) ?? "unknown";
    fallbackByReason.set(reason, (fallbackByReason.get(reason) ?? 0) + 1);
  }

  return {
    attempts: events.filter((event) => event.action === "queue.triage.started").length,
    completed: completed.length,
    failed: failed.length,
    fallbacks: fallbacks.length,
    fallbackByReason: Object.fromEntries([...fallbackByReason.entries()]),
    routeMismatches: completed.filter((event) => asNonEmptyString(event.metadata.routeCheck) === "mismatch").length,
    latencyMs: {
      p50: percentile(latencySamples, 0.5),
      p95: percentile(latencySamples, 0.95),
    },
  };
}

function isQuietHours(): boolean {
  const pstString = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
  const pstHour = new Date(pstString).getHours();
  return pstHour >= 23 || pstHour < 7;
}

async function loadGatewaySummary(redis: Pick<Redis, "mget">) {
  const [sleepRaw, mutedRaw] = await redis.mget(SYSTEM_SLEEP_KEY, GATEWAY_HEALTH_MUTED_CHANNELS_KEY);
  return {
    sleepMode: typeof sleepRaw === "string" && sleepRaw.trim().length > 0,
    quietHours: isQuietHours(),
    mutedChannels: parseStringArrayJson(mutedRaw),
  };
}

async function gateQueueObserverCadence(
  redis: Pick<Redis, "get" | "set">,
  intervalSeconds: number,
  now = Date.now(),
): Promise<QueueObserverCadenceGate> {
  const minimumIntervalMs = Math.max(QUEUE_OBSERVER_INTERVAL_SECONDS_MIN, intervalSeconds) * 1000;
  const raw = await redis.get(QUEUE_OBSERVER_LAST_RUN_KEY);
  const lastRunMs = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const hasLastRun = Number.isFinite(lastRunMs);

  if (hasLastRun && now - lastRunMs < minimumIntervalMs) {
    return {
      shouldRun: false,
      intervalSeconds,
      lastRunAt: new Date(lastRunMs).toISOString(),
      nextRunAt: new Date(lastRunMs + minimumIntervalMs).toISOString(),
    };
  }

  await redis.set(QUEUE_OBSERVER_LAST_RUN_KEY, String(now));
  return {
    shouldRun: true,
    intervalSeconds,
    lastRunAt: hasLastRun ? new Date(lastRunMs).toISOString() : null,
    nextRunAt: hasLastRun ? new Date(now + minimumIntervalMs).toISOString() : null,
  };
}

function filterObservedMessages(messages: readonly StoredMessage[], families: Set<string>): StoredMessage[] {
  if (families.size === 0) return [...messages];
  return messages.filter((message) => {
    const family = asNonEmptyString(message.payload?.name);
    return family != null && families.has(family);
  });
}

function compactPause(pause: QueueFamilyPauseState) {
  return {
    family: pause.family,
    reason: pause.reason,
    source: pause.source,
    mode: pause.mode,
    appliedAt: pause.appliedAt,
    expiresAt: pause.expiresAt,
    expiresAtMs: pause.expiresAtMs,
  };
}

async function buildLiveQueueObservation(input: {
  redis: RedisLike;
  observeFamilies: Set<string>;
  hours: number;
  limit: number;
}) {
  await queueObserverDeps.ensureQueueInitialized();
  const stats = await queueObserverDeps.getQueueStats();
  const messages = stats.total > 0
    ? await queueObserverDeps.listMessages(stats.total)
    : [];
  const observedMessages = filterObservedMessages(messages, input.observeFamilies);
  const depth = deriveDepthSnapshot(observedMessages);
  const activePauses = (await queueObserverDeps.listActiveQueueFamilyPauses(input.redis, {
    config: DEFAULT_QUEUE_CONTROL_CONFIG,
  })).filter((pause) => input.observeFamilies.size === 0 || input.observeFamilies.has(pause.family));

  const [dispatchEvents, triageEvents, gateway] = await Promise.all([
    loadOtelWindow({
      component: "queue-drainer",
      source: "restate",
      actions: QUEUE_DISPATCH_ACTIONS,
      hours: input.hours,
      limit: input.limit,
      parser: parseQueueDispatchHit,
    }),
    loadOtelWindow({
      component: "queue-triage",
      source: "worker",
      actions: QUEUE_TRIAGE_ACTIONS,
      hours: input.hours,
      limit: input.limit,
      parser: parseQueueTriageHit,
    }),
    loadGatewaySummary(input.redis),
  ]);

  const filteredDispatchEvents = filterDispatchEvents(dispatchEvents, input.observeFamilies);
  const filteredTriageEvents = filterTriageEvents(triageEvents, input.observeFamilies);
  const dispatchSummary = summarizeDispatchWindow(filteredDispatchEvents, depth, input.hours);
  const triageSummary = summarizeTriageWindow(filteredTriageEvents);

  return {
    snapshot: buildQueueObservationSnapshot({
      stats: depth,
      messages: observedMessages,
      triage: triageSummary,
      drainer: {
        state: dispatchSummary.drainerState,
        recentDispatches: dispatchSummary.started,
        recentFailures: dispatchSummary.failed,
        throughputPerMinute: dispatchSummary.throughputPerMinute,
      },
      gateway,
      control: {
        activePauses: activePauses.map(compactPause),
      },
    }),
    observedMessages,
    activePauses,
  };
}

function buildQueueObserverReport(input: {
  decision: Awaited<ReturnType<typeof observeQueueSnapshotDetailed>>["decision"];
  config: QueueObserverConfig;
  appliedActions: readonly QueueObserverAction[];
  rejectedActions: readonly { action: QueueObserverAction; reason: string }[];
  escalationActions: readonly Extract<QueueObserverAction, { kind: "escalate" }>[];
}): QueueObserverReport | null {
  if (
    input.appliedActions.length === 0
    && input.rejectedActions.length === 0
    && input.escalationActions.length === 0
  ) {
    return null;
  }

  const lines = [
    `Queue observer ${input.config.mode} · ${input.decision.findings.queuePressure}/${input.decision.findings.downstreamState}`,
    input.decision.findings.summary,
    `Snapshot: ${input.decision.snapshotId}`,
  ];

  if (input.appliedActions.length > 0) {
    lines.push("", "Applied actions:");
    for (const action of input.appliedActions) {
      switch (action.kind) {
        case "pause_family":
          lines.push(`- pause ${action.family} for ${Math.round(action.ttlMs / 60_000)}m — ${action.reason}`);
          break;
        case "resume_family":
          lines.push(`- resume ${action.family} — ${action.reason}`);
          break;
        default:
          break;
      }
    }
  }

  if (input.rejectedActions.length > 0) {
    lines.push("", "Rejected actions:");
    for (const rejected of input.rejectedActions) {
      lines.push(`- ${rejected.action.kind}: ${rejected.reason}`);
    }
  }

  if (input.escalationActions.length > 0) {
    lines.push("", "Escalation:");
    for (const action of input.escalationActions) {
      lines.push(`- [${action.severity}] ${action.message}`);
    }
  }

  return {
    text: lines.join("\n"),
    escalationCount: input.escalationActions.length,
  };
}

async function applyQueueObserverActions(input: {
  redis: RedisLike;
  decision: Awaited<ReturnType<typeof observeQueueSnapshotDetailed>>["decision"];
  actor: string;
  config: QueueObserverConfig;
}): Promise<QueueObserverApplyResult> {
  const appliedActions: QueueObserverAction[] = [];
  const rejectedActions: Array<{ action: QueueObserverAction; reason: string }> = [];
  const escalationActions: Extract<QueueObserverAction, { kind: "escalate" }>[] = [];

  for (const action of input.decision.finalActions) {
    try {
      switch (action.kind) {
        case "pause_family": {
          const pause = await queueObserverDeps.pauseQueueFamily(input.redis, {
            family: action.family,
            ttlMs: action.ttlMs,
            reason: action.reason,
            source: "observer",
            mode: input.decision.mode as QueueControlMode,
            snapshotId: input.decision.snapshotId,
            model: input.decision.model,
            actor: input.actor,
            config: DEFAULT_QUEUE_CONTROL_CONFIG,
          });
          await emitQueueControlApplied({
            snapshotId: input.decision.snapshotId,
            mode: input.decision.mode as QueueControlMode,
            model: input.decision.model,
            expiresAt: pause.expiresAt,
            action,
          });
          appliedActions.push(action);
          break;
        }
        case "resume_family": {
          const resumed = await queueObserverDeps.resumeQueueFamily(input.redis, {
            family: action.family,
            config: DEFAULT_QUEUE_CONTROL_CONFIG,
          });
          if (!resumed.removed) {
            const reason = `No active pause existed for ${action.family}`;
            await emitQueueControlRejected({
              snapshotId: input.decision.snapshotId,
              mode: input.decision.mode as QueueControlMode,
              model: input.decision.model,
              action,
              reason,
            });
            rejectedActions.push({ action, reason });
            break;
          }

          await emitQueueControlApplied({
            snapshotId: input.decision.snapshotId,
            mode: input.decision.mode as QueueControlMode,
            model: input.decision.model,
            action,
          });
          appliedActions.push(action);
          break;
        }
        case "escalate":
          escalationActions.push(action);
          break;
        default: {
          const reason = `Auto-apply does not support ${action.kind}`;
          await emitQueueControlRejected({
            snapshotId: input.decision.snapshotId,
            mode: input.decision.mode as QueueControlMode,
            model: input.decision.model,
            action,
            reason,
          });
          rejectedActions.push({ action, reason });
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await emitQueueControlRejected({
        snapshotId: input.decision.snapshotId,
        mode: input.decision.mode as QueueControlMode,
        model: input.decision.model,
        action,
        reason,
      });
      rejectedActions.push({ action, reason });
    }
  }

  return {
    appliedActions,
    rejectedActions,
    report: buildQueueObserverReport({
      decision: input.decision,
      config: input.config,
      appliedActions,
      rejectedActions,
      escalationActions,
    }),
  };
}

type QueueObserverStep = {
  run(id: string, fn: () => unknown): Promise<any>;
  sendEvent(
    id: string,
    payload: { name: string; data: Record<string, unknown> },
  ): Promise<unknown>;
};

async function runQueueObserverPass(input: {
  step: QueueObserverStep;
  eventName: string;
  eventData?: { hours?: unknown; limit?: unknown } | null;
  allowAutoApply: boolean;
}) {
  const config = resolveQueueObserverConfig();
  const redis = queueObserverDeps.getRedisClient();
  const eventData = (input.eventData ?? {}) as { hours?: unknown; limit?: unknown };
  const hours = Math.max(1, parsePositiveInt(eventData.hours, DEFAULT_WINDOW_HOURS));
  const limit = Math.min(DEFAULT_LIMIT, Math.max(1, parsePositiveInt(eventData.limit, DEFAULT_LIMIT)));
  const manualRequest = input.eventName === "queue/observer.requested";
  const trigger = manualRequest ? "manual" : "cron";
  const autoApplyEnabled = input.allowAutoApply && config.mode === "enforce";

  if (config.mode === "off") {
    return {
      status: "disabled",
      trigger,
      mode: config.mode,
      autoApplyEnabled,
      observeFamilies: [...config.observeFamilies].sort(),
      autoApplyFamilies: [...config.autoApplyFamilies].sort(),
    };
  }

  if (!manualRequest) {
    const cadence = await input.step.run("gate-cadence", async () =>
      gateQueueObserverCadence(redis, config.intervalSeconds)
    );
    if (!cadence.shouldRun) {
      return {
        status: "skipped",
        reason: "cadence",
        trigger,
        mode: config.mode,
        autoApplyEnabled,
        intervalSeconds: config.intervalSeconds,
        lastRunAt: cadence.lastRunAt,
        nextRunAt: cadence.nextRunAt,
      };
    }
  }

  const live = await input.step.run("build-live-snapshot", async () =>
    buildLiveQueueObservation({
      redis,
      observeFamilies: config.observeFamilies,
      hours,
      limit,
    })
  );

  await emitQueueObserveStarted({
    snapshot: live.snapshot,
    mode: config.mode,
    model: QUEUE_OBSERVE_MODEL,
    autoApplyFamilies: config.autoApplyFamilies,
  });

  const observed = await observeQueueSnapshotDetailed({
    mode: config.mode,
    snapshot: live.snapshot,
    autoApplyFamilies: config.autoApplyFamilies,
  });

  let decision = observed.decision;
  let applyResult: QueueObserverApplyResult = {
    appliedActions: [],
    rejectedActions: [],
    report: null,
  };

  if (autoApplyEnabled && !decision.fallbackReason && decision.finalActions.length > 0) {
    applyResult = await input.step.run("apply-final-actions", async () =>
      applyQueueObserverActions({
        redis,
        decision,
        actor: "queue-observer",
        config,
      })
    );
    decision = {
      ...decision,
      appliedCount: applyResult.appliedActions.length,
    };
  }

  if (applyResult.report) {
    await input.step.sendEvent("send-queue-observer-report", {
      name: "gateway/send.message",
      data: {
        channel: "telegram",
        text: applyResult.report.text,
      },
    });
    if (applyResult.report.escalationCount > 0) {
      decision = {
        ...decision,
        appliedCount: decision.appliedCount + applyResult.report.escalationCount,
      };
    }
  }

  if (observed.failedError) {
    await emitQueueObserveFailed({
      snapshot: live.snapshot,
      mode: config.mode,
      model: decision.model ?? QUEUE_OBSERVE_MODEL,
      error: observed.failedError,
      latencyMs: decision.latencyMs,
    });
  }

  if (decision.fallbackReason) {
    await emitQueueObserveFallback({ decision });
  } else {
    await emitQueueObserveCompleted({
      decision,
      autoApplyFamilies: observed.autoApplyFamilies,
    });
  }

  return {
    status: decision.fallbackReason ? "fallback" : config.mode,
    trigger,
    mode: config.mode,
    autoApplyEnabled,
    intervalSeconds: config.intervalSeconds,
    observeFamilies: [...config.observeFamilies].sort(),
    autoApplyFamilies: [...config.autoApplyFamilies].sort(),
    snapshotId: live.snapshot.snapshotId,
    findings: decision.findings,
    suggestedActions: decision.suggestedActions,
    finalActions: decision.finalActions,
    appliedCount: decision.appliedCount,
    fallbackReason: decision.fallbackReason ?? null,
    reportQueued: applyResult.report != null,
    queuedDepth: live.snapshot.totals.depth,
    activePauses: live.snapshot.control.activePauses,
  };
}

export const queueObserver = inngest.createFunction(
  {
    id: "queue/observer",
    retries: 1,
    concurrency: { limit: 1 },
  },
  { cron: QUEUE_OBSERVER_CRON },
  async ({ event, step }) =>
    runQueueObserverPass({
      step,
      eventName: event.name,
      eventData: (event.data ?? {}) as { hours?: unknown; limit?: unknown },
      allowAutoApply: true,
    }),
);

export const queueObserverRequested = inngest.createFunction(
  {
    id: "queue/observer-requested",
    retries: 1,
    concurrency: { limit: 1 },
    singleton: { key: '"manual"', mode: "skip" },
  },
  { event: "queue/observer.requested" },
  async ({ event, step }) =>
    runQueueObserverPass({
      step,
      eventName: event.name,
      eventData: (event.data ?? {}) as { hours?: unknown; limit?: unknown },
      allowAutoApply: false,
    }),
);

export const __queueObserverTestUtils = {
  applyQueueObserverActions,
  buildLiveQueueObservation,
  deriveDepthSnapshot,
  expandQueueObserverAutoFamilies,
  expandQueueObserverFamilies,
  gateQueueObserverCadence,
  resolveQueueObserverConfig,
  runQueueObserverPass,
  deps: queueObserverDeps,
};
