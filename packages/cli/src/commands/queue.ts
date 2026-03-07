import { Args, Command, Options } from "@effect/cli"
import {
  getDepth,
  getEventRegistration,
  init,
  inspectById,
  listRegisteredEvents,
  Priority,
  persistEnvelope,
  QUEUE_DISPATCH_FAILED_CONTRACT,
  type QueueEventEnvelope,
  type TelemetryEmitter,
} from "@joelclaw/queue"
import { Console, Effect } from "effect"
import Redis from "ioredis"
import { ulid } from "ulidx"
import { executeCapabilityCommand } from "../capabilities/runtime"
import type { NextAction } from "../response"
import { respond, respondError } from "../response"

const DEFAULT_REDIS_URL = "redis://localhost:6379"
const QUEUE_STREAM_KEY = "joelclaw:queue:messages"
const QUEUE_PRIORITY_KEY = "joelclaw:queue:priority"
const QUEUE_CONSUMER_GROUP = "joelclaw-cli"
const QUEUE_CONSUMER_NAME = "cli-operator"

export const queueCommandNames = ["emit", "depth", "list", "inspect"] as const

type QueueTelemetryBuffer = {
  pending: Promise<unknown>[]
  emitter: TelemetryEmitter
}

function parseJsonObject(input?: string): Record<string, unknown> | undefined {
  if (!input) return {}
  const parsed = JSON.parse(input) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("queue payload must be a JSON object")
  }
  return parsed as Record<string, unknown>
}

function resolvePriority(priority: string | undefined, fallback: Priority): Priority {
  if (!priority) return fallback

  switch (priority.trim().toUpperCase()) {
    case "P0":
      return Priority.P0
    case "P1":
      return Priority.P1
    case "P2":
      return Priority.P2
    case "P3":
      return Priority.P3
    default:
      throw new Error(`Unknown priority ${priority}. Expected one of P0, P1, P2, P3.`)
  }
}

function priorityLabel(priority: Priority): "P0" | "P1" | "P2" | "P3" {
  if (priority === Priority.P0) return "P0"
  if (priority === Priority.P1) return "P1"
  if (priority === Priority.P2) return "P2"
  return "P3"
}

function getRedisClient(): Redis {
  const url = process.env.REDIS_URL ?? DEFAULT_REDIS_URL
  return new Redis(url)
}

function buildQueueEnvelope<TData extends Record<string, unknown>>(input: {
  event: string
  data: TData
  priority: Priority
  dedupKey?: string
}): QueueEventEnvelope<TData> {
  return {
    id: ulid(),
    event: input.event,
    source: "cli",
    ts: Date.now(),
    data: input.data,
    priority: input.priority,
    ...(input.dedupKey ? { dedupKey: input.dedupKey } : {}),
    trace: {
      correlationId: ulid(),
    },
  }
}

function createQueueTelemetryBuffer(): QueueTelemetryBuffer {
  const pending: Promise<unknown>[] = []

  return {
    pending,
    emitter: {
      emit(action, detail, extra) {
        pending.push(
          Effect.runPromise(
            executeCapabilityCommand<Record<string, unknown>>({
              capability: "otel",
              subcommand: "emit",
              args: {
                action,
                source: "cli",
                component: "queue-cli",
                level: detail === "info" ? "info" : "debug",
                success: true,
                metadata: {
                  detail,
                  ...(extra ?? {}),
                },
              },
            }).pipe(Effect.either),
          ).catch(() => undefined),
        )
      },
    },
  }
}

async function flushQueueTelemetry(buffer: QueueTelemetryBuffer): Promise<void> {
  if (buffer.pending.length === 0) return
  const work = buffer.pending.splice(0, buffer.pending.length)
  await Promise.allSettled(work)
}

async function ensureQueueInit(redis: Redis, telemetry: TelemetryEmitter): Promise<void> {
  await init(redis, {
    streamKey: QUEUE_STREAM_KEY,
    priorityKey: QUEUE_PRIORITY_KEY,
    consumerGroup: QUEUE_CONSUMER_GROUP,
    consumerName: QUEUE_CONSUMER_NAME,
  }, {
    telemetry,
  })
}

async function closeRedis(redis: Redis): Promise<void> {
  try {
    await redis.quit()
  } catch {
    redis.disconnect()
  }
}

const emitCmd = Command.make(
  "emit",
  {
    event: Args.text({ name: "event" }).pipe(
      Args.withDescription("Event name (e.g. discovery/noted)"),
    ),
    data: Options.text("data").pipe(
      Options.withAlias("d"),
      Options.withDescription("JSON object payload for the event envelope"),
      Options.optional,
    ),
    priority: Options.text("priority").pipe(
      Options.withDescription("Priority override: P0, P1, P2, or P3"),
      Options.optional,
    ),
    dedupKey: Options.text("dedup-key").pipe(
      Options.withDescription("Optional deduplication key override"),
      Options.optional,
    ),
  },
  ({ event, data, priority, dedupKey }) =>
    Effect.gen(function* () {
      const redis = getRedisClient()
      const telemetry = createQueueTelemetryBuffer()

      try {
        yield* Effect.promise(() => ensureQueueInit(redis, telemetry.emitter))

        const registration = getEventRegistration(event)
        const payload = parseJsonObject(data)
        const resolvedPriority = resolvePriority(priority, registration?.priority ?? Priority.P3)
        const envelope = buildQueueEnvelope({
          event,
          data: payload ?? {},
          priority: resolvedPriority,
          dedupKey,
        })

        const result = yield* Effect.promise(() => persistEnvelope(envelope))
        yield* Effect.promise(() => flushQueueTelemetry(telemetry))

        const nextActions: NextAction[] = [
          {
            command: "queue inspect <stream-id>",
            description: "Inspect the queued envelope by Redis stream ID",
            params: {
              "stream-id": {
                value: result.streamId,
                required: true,
                description: "Redis stream ID returned from queue emit",
              },
            },
          },
          {
            command: "queue depth",
            description: "Check ready vs leased queue depth",
          },
          {
            command: "queue list",
            description: "Inspect the static pilot registry contract",
          },
          {
            command: "otel search \"queue.\" --hours 1",
            description: "Verify queue lifecycle telemetry",
          },
        ]

        yield* Console.log(respond("queue emit", {
          streamId: result.streamId,
          envelope,
          priority: priorityLabel(resolvedPriority),
          registration: registration
            ? {
                event: registration.event,
                priority: priorityLabel(registration.priority),
                dedupWindowMs: registration.dedupWindowMs,
                handler: registration.handler,
              }
            : null,
        }, nextActions))
      } catch (error) {
        yield* Console.log(respondError(
          "queue emit",
          error instanceof Error ? error.message : String(error),
          "QUEUE_EMIT_FAILED",
          "Validate the payload JSON, priority override, and Redis availability before retrying.",
          [
            { command: "queue list", description: "Inspect the registered queue events" },
            { command: "queue depth", description: "Check whether the queue backend is reachable" },
          ],
        ))
      } finally {
        yield* Effect.promise(() => flushQueueTelemetry(telemetry))
        yield* Effect.promise(() => closeRedis(redis))
      }
    }),
).pipe(Command.withDescription("Emit a canonical queue event envelope into Redis"))

const depthCmd = Command.make(
  "depth",
  {},
  () =>
    Effect.gen(function* () {
      const redis = getRedisClient()
      const telemetry = createQueueTelemetryBuffer()

      try {
        yield* Effect.promise(() => ensureQueueInit(redis, telemetry.emitter))
        const depth = yield* Effect.promise(() => getDepth())
        yield* Effect.promise(() => flushQueueTelemetry(telemetry))

        const nextActions: NextAction[] = [
          {
            command: "queue list",
            description: "Inspect the queue registry contract",
          },
          {
            command: "otel search \"queue.depth\" --hours 1",
            description: "Verify queue depth telemetry",
          },
        ]

        if (depth.oldest) {
          nextActions.unshift({
            command: "queue inspect <stream-id>",
            description: "Inspect the oldest queued envelope",
            params: {
              "stream-id": {
                value: depth.oldest.id,
                required: true,
                description: "Oldest known queued stream ID",
              },
            },
          })
        }

        yield* Console.log(respond("queue depth", depth, nextActions))
      } catch (error) {
        yield* Console.log(respondError(
          "queue depth",
          error instanceof Error ? error.message : String(error),
          "QUEUE_DEPTH_FAILED",
          "Ensure Redis is reachable and the queue stream can be initialized.",
          [],
        ))
      } finally {
        yield* Effect.promise(() => flushQueueTelemetry(telemetry))
        yield* Effect.promise(() => closeRedis(redis))
      }
    }),
).pipe(Command.withDescription("Report queue ready/leased depth and oldest-item hints"))

const listCmd = Command.make(
  "list",
  {},
  () =>
    Effect.gen(function* () {
      const registrations = listRegisteredEvents()
      const nextActions: NextAction[] = [
        {
          command: "queue emit <event> -d <data>",
          description: "Queue one of the pilot events",
          params: {
            event: {
              value: registrations[0]?.event ?? "discovery/noted",
              required: true,
              description: "Registered queue event name",
            },
            data: {
              value: '{"url":"https://example.com"}',
              required: true,
              description: "JSON object payload for the envelope data",
            },
          },
        },
        {
          command: "queue depth",
          description: "Inspect live queue depth",
        },
      ]

      yield* Console.log(respond("queue list", {
        count: registrations.length,
        events: registrations.map((registration) => ({
          event: registration.event,
          priority: priorityLabel(registration.priority),
          dedupWindowMs: registration.dedupWindowMs,
          handler: registration.handler,
          meta: registration.meta,
        })),
        dispatchFailureContract: QUEUE_DISPATCH_FAILED_CONTRACT,
      }, nextActions))
    }),
).pipe(Command.withDescription("List the static ADR-0217 pilot registry and dispatch contract"))

const inspectCmd = Command.make(
  "inspect",
  {
    streamId: Args.text({ name: "stream-id" }).pipe(
      Args.withDescription("Redis stream ID returned from queue emit"),
    ),
  },
  ({ streamId }) =>
    Effect.gen(function* () {
      const redis = getRedisClient()
      const telemetry = createQueueTelemetryBuffer()

      try {
        yield* Effect.promise(() => ensureQueueInit(redis, telemetry.emitter))
        const record = yield* Effect.promise(() => inspectById(streamId))
        yield* Effect.promise(() => flushQueueTelemetry(telemetry))

        if (!record) {
          yield* Console.log(respondError(
            "queue inspect",
            `Queue stream ID ${streamId} was not found.`,
            "QUEUE_MESSAGE_NOT_FOUND",
            "Use `joelclaw queue emit ...` to create a record or inspect the returned stream ID again.",
            [
              { command: "queue list", description: "Inspect registered queue event families" },
              { command: "queue depth", description: "Confirm the queue backend is reachable" },
            ],
          ))
          return
        }

        const nextActions: NextAction[] = [
          {
            command: "queue depth",
            description: "Inspect current queue depth",
          },
          {
            command: "otel search \"queue.inspect\" --hours 1",
            description: "Verify inspect telemetry",
          },
        ]

        yield* Console.log(respond("queue inspect", {
          streamId: record.streamId,
          state: record.state,
          stored: {
            id: record.stored.id,
            timestamp: record.stored.timestamp,
            age_ms: Date.now() - record.stored.timestamp,
            priority: priorityLabel(record.stored.priority),
            metadata: record.stored.metadata,
          },
          envelope: record.envelope ?? null,
        }, nextActions))
      } catch (error) {
        yield* Console.log(respondError(
          "queue inspect",
          error instanceof Error ? error.message : String(error),
          "QUEUE_INSPECT_FAILED",
          "Ensure Redis is reachable and use a valid Redis stream ID from `joelclaw queue emit`.",
          [],
        ))
      } finally {
        yield* Effect.promise(() => flushQueueTelemetry(telemetry))
        yield* Effect.promise(() => closeRedis(redis))
      }
    }),
).pipe(Command.withDescription("Inspect a queued record and decoded envelope by stream ID"))

export const __queueCommandTestUtils = {
  buildQueueEnvelope,
  parseJsonObject,
  resolvePriority,
  queueCommandNames,
}

export const queueCmd = Command.make("queue", {}).pipe(
  Command.withDescription("Queue operator commands for ADR-0217 Story 2"),
  Command.withSubcommands([emitCmd, depthCmd, listCmd, inspectCmd]),
)
