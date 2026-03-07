/**
 * joelclaw queue — Queue operator surface for @joelclaw/queue.
 * 
 * Commands:
 * - joelclaw queue emit <event> [-d <json>] — Emit an event to the queue
 * - joelclaw queue depth — Get queue depth and stats
 * - joelclaw queue stats [--hours <n>] [--limit <n>] — Summarize recent drainer success/failure + latency
 * - joelclaw queue list [--limit <n>] — List recent messages
 * - joelclaw queue inspect <stream-id> — Inspect a message by ID
 */

import { Args, Command, Options } from "@effect/cli";
import {
  getQueueStats,
  init,
  inspectById,
  listMessages,
  lookupQueueEvent,
  Priority,
  persist,
  type QueueConfig,
  type QueueEventEnvelope,
  type TelemetryEmitter,
} from "@joelclaw/queue";
import { Console, Effect } from "effect";
import Redis from "ioredis";
import { loadConfig } from "../config";
import { createOtelEventPayload, ingestOtelPayload } from "../lib/otel-ingest";
import { type NextAction, respond, respondError } from "../response";
import { isTypesenseApiKeyError, resolveTypesenseApiKey } from "../typesense-auth";

const cfg = loadConfig();
const REDIS_URL = process.env.REDIS_URL ?? cfg.redisUrl ?? "redis://localhost:6379";

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
const QUEUE_LATENCY_TARGET_P95_MS = 5_000;
const DEFAULT_QUEUE_STATS_LIMIT = 200;

type QueueDispatchAction = (typeof QUEUE_DISPATCH_ACTIONS)[number];

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
    withRedisCleanup(Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => ensureQueueInitialized(),
        catch: (error) => new Error(`Failed to initialize queue: ${error}`),
      });

      const dataText = parseOptionalText(data);
      const priorityText = parseOptionalText(priority);

      // Parse data JSON
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

      // Determine priority
      let eventPriority = Priority.P2;
      if (priorityText) {
        const priorityUpper = priorityText.toUpperCase();
        if (priorityUpper === "P0") eventPriority = Priority.P0;
        else if (priorityUpper === "P1") eventPriority = Priority.P1;
        else if (priorityUpper === "P2") eventPriority = Priority.P2;
        else if (priorityUpper === "P3") eventPriority = Priority.P3;
        else {
          yield* Effect.fail(new Error(`Invalid priority: ${priorityText}. Must be P0, P1, P2, or P3`));
        }
      } else {
        // Look up default priority from registry
        const registryEntry = lookupQueueEvent(event);
        if (registryEntry) {
          eventPriority = registryEntry.priority;
        }
      }

      // Generate envelope
      const envelope: QueueEventEnvelope = {
        id: crypto.randomUUID(),
        name: event,
        source: "cli",
        ts: Date.now(),
        data: eventData,
        priority: eventPriority,
      };

      // Persist to queue
      const result = yield* Effect.tryPromise({
        try: () => persist({
          payload: envelope as Record<string, unknown>,
          priority: eventPriority,
          metadata: {
            envelope_version: "1",
          },
        }),
        catch: (error) => new Error(`Failed to persist event: ${error}`),
      });

      if (!result) {
        yield* Effect.fail(new Error("Event was rejected by queue filter"));
      }

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
          event: envelope.name,
          eventId: envelope.id,
        }, next)
      );
    }))
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

          return summarizeQueueStats(
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
          command: `joelclaw otel search "queue.dispatch.failed" --hours ${hours}`,
          description: "Inspect failed drainer dispatch telemetry",
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
  Command.withSubcommands([emitCmd, depthCmd, statsCmd, listCmd, inspectCmd])
);

export const __queueTestUtils = {
  parseSinceTimestamp,
  percentile,
  summarizeQueueStats,
};
