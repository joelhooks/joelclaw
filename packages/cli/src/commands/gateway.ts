import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { respond } from "../response"

const EVENT_LIST = "joelclaw:events:main"
const NOTIFY_CHANNEL = "joelclaw:notify:main"

// ── Helpers ──────────────────────────────────────────────────────────

function makeRedis() {
  return Effect.tryPromise({
    try: async () => {
      const Redis = (await import("ioredis")).default
      const redis = new Redis({
        host: process.env.REDIS_HOST ?? "localhost",
        port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
        lazyConnect: true,
        connectTimeout: 3000,
        commandTimeout: 5000,
      })
      await redis.connect()
      return redis
    },
    catch: (e) => new Error(`Redis connection failed: ${e}`),
  })
}

// ── gateway status ──────────────────────────────────────────────────

const gatewayStatus = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const redis = yield* makeRedis()
    const queueLen = yield* Effect.tryPromise({
      try: () => redis.llen(EVENT_LIST),
      catch: (e) => new Error(`${e}`),
    })
    const pong = yield* Effect.tryPromise({
      try: () => redis.ping(),
      catch: (e) => new Error(`${e}`),
    })
    yield* Effect.tryPromise({ try: () => redis.quit(), catch: () => {} })

    yield* Console.log(respond(
      "gateway status",
      {
        redis: pong === "PONG" ? "connected" : "error",
        eventList: EVENT_LIST,
        notifyChannel: NOTIFY_CHANNEL,
        pendingEvents: queueLen,
      },
      [
        { command: "joelclaw gateway events", description: "Peek at pending events" },
        { command: "joelclaw gateway push --type test", description: "Push a test event" },
        { command: "joelclaw gateway drain", description: "Clear the event queue" },
      ],
      pong === "PONG"
    ))
  })
)

// ── gateway events ──────────────────────────────────────────────────

const gatewayEvents = Command.make("events", {}, () =>
  Effect.gen(function* () {
    const redis = yield* makeRedis()
    const raw = yield* Effect.tryPromise({
      try: () => redis.lrange(EVENT_LIST, 0, -1),
      catch: (e) => new Error(`${e}`),
    })
    yield* Effect.tryPromise({ try: () => redis.quit(), catch: () => {} })

    const events = raw.reverse().map((r: string) => {
      try {
        return JSON.parse(r)
      } catch {
        return { raw: r }
      }
    })

    yield* Console.log(respond(
      "gateway events",
      {
        count: events.length,
        events: events.map((e: any) => ({
          id: e.id,
          type: e.type,
          source: e.source,
          ts: e.ts ? new Date(e.ts).toISOString() : undefined,
          payload: e.payload,
        })),
      },
      [
        { command: "joelclaw gateway drain", description: "Clear all events" },
        { command: "joelclaw gateway push --type test", description: "Push a test event" },
      ],
      true
    ))
  })
)

// ── gateway push ────────────────────────────────────────────────────

const pushType = Options.text("type").pipe(
  Options.withDescription("Event type (e.g. 'test', 'cron.heartbeat')"),
  Options.withDefault("test.manual"),
)

const pushPayload = Options.text("payload").pipe(
  Options.withDescription("JSON payload"),
  Options.withDefault("{}"),
)

const gatewayPush = Command.make("push", { type: pushType, payload: pushPayload }, ({ type, payload }) =>
  Effect.gen(function* () {
    const redis = yield* makeRedis()

    let parsedPayload: Record<string, unknown> = {}
    try {
      parsedPayload = JSON.parse(payload)
    } catch {
      yield* Console.log(respond("gateway push", { error: "Invalid JSON payload" }, [], false))
      yield* Effect.tryPromise({ try: () => redis.quit(), catch: () => {} })
      return
    }

    const event = {
      id: crypto.randomUUID(),
      type,
      source: "cli",
      payload: parsedPayload,
      ts: Date.now(),
    }

    yield* Effect.tryPromise({
      try: async () => {
        await redis.lpush(EVENT_LIST, JSON.stringify(event))
        await redis.publish(NOTIFY_CHANNEL, JSON.stringify({ eventId: event.id, type: event.type }))
      },
      catch: (e) => new Error(`${e}`),
    })

    yield* Effect.tryPromise({ try: () => redis.quit(), catch: () => {} })

    yield* Console.log(respond(
      "gateway push",
      {
        pushed: event,
        notified: NOTIFY_CHANNEL,
      },
      [
        { command: "joelclaw gateway events", description: "See all pending events" },
        { command: "joelclaw gateway status", description: "Check gateway status" },
      ],
      true
    ))
  })
)

// ── gateway drain ───────────────────────────────────────────────────

const gatewayDrain = Command.make("drain", {}, () =>
  Effect.gen(function* () {
    const redis = yield* makeRedis()
    const count = yield* Effect.tryPromise({
      try: () => redis.llen(EVENT_LIST),
      catch: (e) => new Error(`${e}`),
    })
    yield* Effect.tryPromise({
      try: () => redis.del(EVENT_LIST),
      catch: (e) => new Error(`${e}`),
    })
    yield* Effect.tryPromise({ try: () => redis.quit(), catch: () => {} })

    yield* Console.log(respond(
      "gateway drain",
      { drained: count, list: EVENT_LIST },
      [
        { command: "joelclaw gateway status", description: "Verify queue is empty" },
      ],
      true
    ))
  })
)

// ── gateway test ────────────────────────────────────────────────────

const gatewayTest = Command.make("test", {}, () =>
  Effect.gen(function* () {
    const redis = yield* makeRedis()

    // Push + publish + read back
    const event = {
      id: crypto.randomUUID(),
      type: "test.gateway-e2e",
      source: "cli",
      payload: { test: true, ts: new Date().toISOString() },
      ts: Date.now(),
    }

    yield* Effect.tryPromise({
      try: async () => {
        await redis.lpush(EVENT_LIST, JSON.stringify(event))
        await redis.publish(NOTIFY_CHANNEL, JSON.stringify({ eventId: event.id, type: event.type }))
      },
      catch: (e) => new Error(`${e}`),
    })

    const pending = yield* Effect.tryPromise({
      try: () => redis.llen(EVENT_LIST),
      catch: (e) => new Error(`${e}`),
    })

    yield* Effect.tryPromise({ try: () => redis.quit(), catch: () => {} })

    yield* Console.log(respond(
      "gateway test",
      {
        pushed: event,
        notified: NOTIFY_CHANNEL,
        pendingAfterPush: pending,
        note: "If the pi gateway extension is running, it should drain this event and inject it into the session.",
      },
      [
        { command: "joelclaw gateway events", description: "Check if event was drained" },
        { command: "joelclaw gateway status", description: "Full gateway status" },
      ],
      true
    ))
  })
)

// ── Root gateway command ────────────────────────────────────────────

export const gatewayCmd = Command.make("gateway", {}, () =>
  Console.log(respond(
    "gateway",
    {
      description: "Redis event bridge between Inngest functions and pi sessions (ADR-0018)",
      subcommands: {
        status: "joelclaw gateway status — Redis connection + queue depth",
        events: "joelclaw gateway events — Peek at pending events",
        push: "joelclaw gateway push --type <type> [--payload JSON] — Push an event",
        drain: "joelclaw gateway drain — Clear the event queue",
        test: "joelclaw gateway test — Push a test event and check round-trip",
      },
    },
    [
      { command: "joelclaw gateway status", description: "Check gateway health" },
      { command: "joelclaw gateway test", description: "Push test event + verify" },
    ],
    true
  ))
).pipe(
  Command.withSubcommands([gatewayStatus, gatewayEvents, gatewayPush, gatewayDrain, gatewayTest])
)
