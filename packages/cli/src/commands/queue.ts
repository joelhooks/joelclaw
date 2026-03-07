/**
 * joelclaw queue — Queue operator surface for @joelclaw/queue.
 * 
 * Commands:
 * - joelclaw queue emit <event> [-d <json>] — Emit an event to the queue
 * - joelclaw queue depth — Get queue depth and stats
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
        yield* Console.log(
          respondError("queue inspect", `Message not found: ${streamId}`)
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
  Command.withSubcommands([emitCmd, depthCmd, listCmd, inspectCmd])
);
