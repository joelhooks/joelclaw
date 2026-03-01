import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { type NextAction, respond, respondError } from "../response"
import {
  emitError,
  emitEvent,
  emitLog,
  emitResult,
  emitStart,
} from "../stream"

const WEBHOOK_SUBSCRIPTIONS_KEY = "joelclaw:webhook:subscriptions"
const WEBHOOK_INDEX_PREFIX = "joelclaw:webhook:index"
const WEBHOOK_EVENTS_PREFIX = "joelclaw:webhook:events"
const WEBHOOK_NOTIFY_PREFIX = "joelclaw:webhook:notify"

type WebhookSubscriptionFilters = {
  repo?: string
  workflow?: string
  branch?: string
  conclusion?: string
}

type WebhookSubscription = {
  id: string
  provider: string
  event: string
  filters: WebhookSubscriptionFilters
  sessionId?: string
  createdAt: string
  expiresAt?: string
  active: boolean
}

function webhookSubscriptionIndexKey(provider: string, event: string): string {
  return `${WEBHOOK_INDEX_PREFIX}:${provider}:${event}`
}

function webhookSubscriptionEventsKey(subscriptionId: string): string {
  return `${WEBHOOK_EVENTS_PREFIX}:${subscriptionId}`
}

function webhookSubscriptionNotifyKey(subscriptionId: string): string {
  return `${WEBHOOK_NOTIFY_PREFIX}:${subscriptionId}`
}

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

function parseWebhookSubscription(raw: string | null): WebhookSubscription | null {
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>

    const id = typeof parsed.id === "string" ? parsed.id.trim() : ""
    const provider = typeof parsed.provider === "string" ? parsed.provider.trim() : ""
    const event = typeof parsed.event === "string" ? parsed.event.trim() : ""
    const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt.trim() : ""

    if (!id || !provider || !event || !createdAt) return null

    const filtersRaw = parsed.filters && typeof parsed.filters === "object" ? parsed.filters as Record<string, unknown> : {}

    const filters: WebhookSubscriptionFilters = {}
    for (const key of ["repo", "workflow", "branch", "conclusion"] as const) {
      const value = filtersRaw[key]
      if (typeof value === "string" && value.trim().length > 0) {
        filters[key] = value.trim()
      }
    }

    const sessionId = typeof parsed.sessionId === "string" && parsed.sessionId.trim().length > 0
      ? parsed.sessionId.trim()
      : undefined

    const expiresAt = typeof parsed.expiresAt === "string" && parsed.expiresAt.trim().length > 0
      ? parsed.expiresAt.trim()
      : undefined

    return {
      id,
      provider,
      event,
      filters,
      ...(sessionId ? { sessionId } : {}),
      createdAt,
      ...(expiresAt ? { expiresAt } : {}),
      active: parsed.active !== false,
    }
  } catch {
    return null
  }
}

function safeDisconnect(client: { disconnect: () => void } | undefined): void {
  if (!client) return
  try {
    client.disconnect()
  } catch {
    // best effort
  }
}

function safeQuit(redis: { quit: () => Promise<unknown>; disconnect: () => void }): Effect.Effect<void, never> {
  return Effect.tryPromise({
    try: async () => {
      try {
        await redis.quit()
      } catch {
        safeDisconnect(redis)
      }
    },
    catch: () => undefined,
  }).pipe(Effect.asVoid)
}

function parseDurationToSeconds(input: string): number | null {
  const trimmed = input.trim().toLowerCase()
  if (!trimmed) return null

  const direct = Number.parseInt(trimmed, 10)
  if (Number.isFinite(direct) && direct > 0 && /^[0-9]+$/u.test(trimmed)) {
    return direct
  }

  const match = /^([0-9]+)(s|m|h|d)$/u.exec(trimmed)
  if (!match) return null

  const value = Number.parseInt(match[1] ?? "", 10)
  if (!Number.isFinite(value) || value <= 0) return null

  const unit = match[2]
  if (unit === "s") return value
  if (unit === "m") return value * 60
  if (unit === "h") return value * 60 * 60
  if (unit === "d") return value * 24 * 60 * 60
  return null
}

function isExpired(subscription: WebhookSubscription, now = Date.now()): boolean {
  if (!subscription.expiresAt) return false
  const parsed = Date.parse(subscription.expiresAt)
  if (!Number.isFinite(parsed)) return true
  return parsed <= now
}

function defaultSessionId(): string {
  return process.env.GATEWAY_ROLE === "central"
    ? "gateway"
    : `pid-${process.ppid}`
}

function createWebhookSubscriptionId(): string {
  return `whs_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function compactWebhookSubscription(subscription: WebhookSubscription) {
  const expiresInSeconds = subscription.expiresAt
    ? Math.max(0, Math.floor((Date.parse(subscription.expiresAt) - Date.now()) / 1000))
    : null

  return {
    id: subscription.id,
    provider: subscription.provider,
    event: subscription.event,
    filters: subscription.filters,
    sessionId: subscription.sessionId,
    createdAt: subscription.createdAt,
    expiresAt: subscription.expiresAt,
    ...(expiresInSeconds !== null ? { expiresInSeconds } : {}),
    active: subscription.active,
  }
}

const streamTimeout = Options.integer("timeout").pipe(
  Options.withDefault(0),
  Options.withDescription("Stop stream after N seconds (0 = indefinite)"),
)

const streamReplay = Options.integer("replay").pipe(
  Options.withDefault(20),
  Options.withDescription("Replay last N events before live stream"),
)

function streamNextActions(subscriptionId: string): NextAction[] {
  return [
    {
      command: "joelclaw webhook stream <subscription-id> [--timeout <timeout>] [--replay <replay>]",
      description: "Resume live stream for this subscription",
      params: {
        "subscription-id": { value: subscriptionId, required: true },
        timeout: { value: 30, default: 0 },
        replay: { value: 20, default: 20 },
      },
    },
    {
      command: "joelclaw webhook unsubscribe <subscription-id>",
      description: "Remove this subscription",
      params: {
        "subscription-id": { value: subscriptionId, required: true },
      },
    },
    { command: "joelclaw webhook list", description: "List webhook subscriptions" },
  ]
}

function streamWebhookSubscription(subscriptionId: string, timeout: number, replay: number, command: string) {
  return Effect.gen(function* () {
    const Redis = (yield* Effect.tryPromise({
      try: () => import("ioredis"),
      catch: (e) => new Error(`ioredis: ${e}`),
    })).default

    const sub = new Redis({
      host: process.env.REDIS_HOST ?? "localhost",
      port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
      lazyConnect: true,
      connectTimeout: 3000,
      retryStrategy: (times: number) => (times > 3 ? null : Math.min(times * 500, 5000)),
    })

    const cmd = new Redis({
      host: process.env.REDIS_HOST ?? "localhost",
      port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
      lazyConnect: true,
      connectTimeout: 3000,
      commandTimeout: 5000,
    })

    try {
      yield* Effect.tryPromise({
        try: async () => {
          await Promise.all([sub.connect(), cmd.connect()])
        },
        catch: (e) => new Error(`Redis: ${e}`),
      })
    } catch {
      emitError(
        command,
        "Redis connection failed",
        "REDIS_CONNECT_FAILED",
        "Check Redis health: joelclaw status",
        [{ command: "joelclaw status", description: "Check system health" }],
      )
      return
    }

    const notifyChannel = webhookSubscriptionNotifyKey(subscriptionId)
    const eventListKey = webhookSubscriptionEventsKey(subscriptionId)

    emitStart(command)
    emitLog("info", `Streaming ${notifyChannel} (subscription=${subscriptionId})`)

    let ended = false
    let eventCount = 0
    const startMs = Date.now()

    const cleanup = (reason: "interrupted" | "timeout" | "ended") => {
      if (ended) return
      ended = true
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
      safeDisconnect(sub)
      safeDisconnect(cmd)

      emitResult(
        command,
        {
          subscriptionId,
          reason,
          eventsReceived: eventCount,
          durationMs: Date.now() - startMs,
        },
        streamNextActions(subscriptionId),
      )
    }

    const onSignal = () => {
      cleanup("interrupted")
      process.exit(0)
    }

    process.on("SIGINT", onSignal)
    process.on("SIGTERM", onSignal)

    if (replay > 0) {
      const replayed = yield* Effect.tryPromise({
        try: () => cmd.lrange(eventListKey, 0, Math.max(0, replay - 1)),
        catch: () => [] as string[],
      })

      if (replayed.length > 0) {
        emitLog("info", `Replaying ${replayed.length} events`)

        for (const item of replayed.reverse()) {
          try {
            const parsed = JSON.parse(item) as Record<string, unknown>
            emitEvent(String(parsed.type ?? "webhook.subscription.matched"), parsed)
            eventCount += 1
          } catch {
            emitLog("warn", `Unparseable replay event: ${item.slice(0, 200)}`)
          }
        }
      }
    }

    sub.on("message", (_channel: string, message: string) => {
      if (ended) return
      try {
        const parsed = JSON.parse(message) as Record<string, unknown>
        emitEvent(String(parsed.type ?? "webhook.subscription.matched"), parsed)
        eventCount += 1
      } catch {
        emitLog("warn", `Unparseable live event: ${message.slice(0, 200)}`)
      }
    })

    const subscribed = yield* Effect.tryPromise({
      try: async () => {
        await sub.subscribe(notifyChannel)
        return true
      },
      catch: () => false,
    })

    if (!subscribed) {
      emitError(
        command,
        `Failed to subscribe to ${notifyChannel}`,
        "REDIS_SUBSCRIBE_FAILED",
        "Check Redis and subscription ID",
        streamNextActions(subscriptionId),
      )
      safeDisconnect(sub)
      safeDisconnect(cmd)
      return
    }

    if (timeout > 0) {
      yield* Effect.tryPromise({
        try: () => new Promise((resolve) => setTimeout(resolve, timeout * 1000)),
        catch: () => new Error("sleep"),
      })
      cleanup("timeout")
      return
    }

    while (!ended) {
      yield* Effect.tryPromise({
        try: () => new Promise((resolve) => setTimeout(resolve, 60_000)),
        catch: () => new Error("sleep"),
      })
    }

    cleanup("ended")
  })
}

const webhookList = Command.make(
  "list",
  {
    provider: Options.text("provider").pipe(
      Options.optional,
      Options.withDescription("Filter by provider (e.g. github)"),
    ),
    event: Options.text("event").pipe(
      Options.optional,
      Options.withDescription("Filter by event (e.g. workflow_run.completed)"),
    ),
    session: Options.text("session").pipe(
      Options.optional,
      Options.withDescription("Filter by session ID"),
    ),
  },
  ({ provider, event, session }) =>
    Effect.gen(function* () {
      const redis = yield* makeRedis().pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* Console.log(respondError(
              "webhook list",
              error.message,
              "WEBHOOK_REDIS_UNAVAILABLE",
              "Check Redis and retry.",
              [{ command: "joelclaw status", description: "Check system health" }],
            ))
            return null as any
          }),
        ),
      )

      if (!redis) return

      try {
        const records = yield* Effect.tryPromise({
          try: () => redis.hgetall(WEBHOOK_SUBSCRIPTIONS_KEY),
          catch: (e) => new Error(`${e}`),
        })

        const now = Date.now()
        const all = Object.values(records)
          .map((raw) => parseWebhookSubscription(raw))
          .filter((item): item is WebhookSubscription => item !== null)

        const expired = all.filter((subscription) => isExpired(subscription, now))
        for (const stale of expired) {
          yield* Effect.tryPromise({
            try: async () => {
              await redis.hdel(WEBHOOK_SUBSCRIPTIONS_KEY, stale.id)
              await redis.srem(webhookSubscriptionIndexKey(stale.provider, stale.event), stale.id)
              await redis.del(webhookSubscriptionEventsKey(stale.id))
            },
            catch: () => undefined,
          })
        }

        const active = all.filter((subscription) => !isExpired(subscription, now) && subscription.active)

        const filtered = active.filter((subscription) => {
          if (provider._tag === "Some" && subscription.provider !== provider.value.trim()) return false
          if (event._tag === "Some" && subscription.event !== event.value.trim()) return false
          if (session._tag === "Some" && subscription.sessionId !== session.value.trim()) return false
          return true
        })

        filtered.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))

        yield* Console.log(respond(
          "webhook list",
          {
            total: filtered.length,
            activeCount: active.length,
            prunedExpired: expired.length,
            subscriptions: filtered.map(compactWebhookSubscription),
          },
          [
            {
              command: "joelclaw webhook subscribe <provider> <event> [--stream]",
              description: "Create a new webhook subscription",
              params: {
                provider: { value: "github", required: true },
                event: { value: "workflow_run.completed", required: true },
              },
            },
            { command: "joelclaw webhook list", description: "Refresh subscription list" },
          ],
        ))
      } catch (error) {
        yield* Console.log(respondError(
          "webhook list",
          String(error),
          "WEBHOOK_LIST_FAILED",
          "Retry once Redis is healthy.",
          [{ command: "joelclaw webhook list", description: "Retry" }],
        ))
      } finally {
        yield* safeQuit(redis)
      }
    }),
).pipe(Command.withDescription("List webhook subscriptions"))

const webhookUnsubscribe = Command.make(
  "unsubscribe",
  {
    subscriptionId: Args.text({ name: "subscription-id" }).pipe(
      Args.withDescription("Webhook subscription ID"),
    ),
  },
  ({ subscriptionId }) =>
    Effect.gen(function* () {
      const redis = yield* makeRedis().pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* Console.log(respondError(
              "webhook unsubscribe",
              error.message,
              "WEBHOOK_REDIS_UNAVAILABLE",
              "Check Redis and retry.",
              [{ command: "joelclaw status", description: "Check system health" }],
            ))
            return null as any
          }),
        ),
      )

      if (!redis) return

      try {
        const raw = yield* Effect.tryPromise({
          try: () => redis.hget(WEBHOOK_SUBSCRIPTIONS_KEY, subscriptionId),
          catch: (e) => new Error(`${e}`),
        })

        const existing = parseWebhookSubscription(raw)
        if (!existing) {
          yield* Console.log(respondError(
            "webhook unsubscribe",
            `Subscription not found: ${subscriptionId}`,
            "WEBHOOK_SUBSCRIPTION_NOT_FOUND",
            "List subscriptions to find valid IDs.",
            [{ command: "joelclaw webhook list", description: "List subscriptions" }],
          ))
          return
        }

        yield* Effect.tryPromise({
          try: async () => {
            await redis.hdel(WEBHOOK_SUBSCRIPTIONS_KEY, subscriptionId)
            await redis.srem(webhookSubscriptionIndexKey(existing.provider, existing.event), subscriptionId)
            await redis.del(webhookSubscriptionEventsKey(subscriptionId))
          },
          catch: (e) => new Error(`${e}`),
        })

        yield* Console.log(respond(
          "webhook unsubscribe",
          {
            removed: subscriptionId,
            provider: existing.provider,
            event: existing.event,
          },
          [
            { command: "joelclaw webhook list", description: "List subscriptions" },
            {
              command: "joelclaw webhook subscribe <provider> <event>",
              description: "Create a new webhook subscription",
              params: {
                provider: { value: existing.provider, required: true },
                event: { value: existing.event, required: true },
              },
            },
          ],
        ))
      } catch (error) {
        yield* Console.log(respondError(
          "webhook unsubscribe",
          String(error),
          "WEBHOOK_UNSUBSCRIBE_FAILED",
          "Retry once Redis is healthy.",
          [{ command: "joelclaw webhook list", description: "List subscriptions" }],
        ))
      } finally {
        yield* safeQuit(redis)
      }
    }),
).pipe(Command.withDescription("Remove a webhook subscription"))

const webhookSubscribe = Command.make(
  "subscribe",
  {
    provider: Args.text({ name: "provider" }).pipe(
      Args.withDescription("Webhook provider (e.g. github)"),
    ),
    event: Args.text({ name: "event" }).pipe(
      Args.withDescription("Provider event (e.g. workflow_run.completed)"),
    ),
    repo: Options.text("repo").pipe(
      Options.optional,
      Options.withDescription("Filter by repository full name (owner/repo)"),
    ),
    workflow: Options.text("workflow").pipe(
      Options.optional,
      Options.withDescription("Filter by workflow name"),
    ),
    branch: Options.text("branch").pipe(
      Options.optional,
      Options.withDescription("Filter by branch"),
    ),
    conclusion: Options.text("conclusion").pipe(
      Options.optional,
      Options.withDescription("Filter by conclusion (success|failure|cancelled)")
    ),
    session: Options.text("session").pipe(
      Options.optional,
      Options.withDescription("Target session ID for immediate follow-up (default: current pid session)"),
    ),
    ttl: Options.text("ttl").pipe(
      Options.withDefault("24h"),
      Options.withDescription("Subscription TTL (e.g. 15m, 1h, 24h)"),
    ),
    stream: Options.boolean("stream").pipe(
      Options.withDefault(false),
      Options.withDescription("Start NDJSON stream immediately after subscribe"),
    ),
    timeout: streamTimeout,
    replay: streamReplay,
  },
  ({ provider, event, repo, workflow, branch, conclusion, session, ttl, stream, timeout, replay }) =>
    Effect.gen(function* () {
      const ttlSeconds = parseDurationToSeconds(ttl)
      if (!ttlSeconds) {
        yield* Console.log(respondError(
          "webhook subscribe",
          `Invalid TTL: ${ttl}`,
          "WEBHOOK_INVALID_TTL",
          "Use duration like 15m, 1h, or 24h.",
          [{
            command: "joelclaw webhook subscribe <provider> <event> [--ttl <ttl>]",
            description: "Retry with valid TTL",
            params: {
              provider: { value: provider, required: true },
              event: { value: event, required: true },
              ttl: { value: "24h", default: "24h" },
            },
          }],
        ))
        return
      }

      const redis = yield* makeRedis().pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* Console.log(respondError(
              "webhook subscribe",
              error.message,
              "WEBHOOK_REDIS_UNAVAILABLE",
              "Check Redis and retry.",
              [{ command: "joelclaw status", description: "Check system health" }],
            ))
            return null as any
          }),
        ),
      )

      if (!redis) return

      const now = new Date()
      const subscription: WebhookSubscription = {
        id: createWebhookSubscriptionId(),
        provider: provider.trim(),
        event: event.trim(),
        filters: {
          ...(repo._tag === "Some" && repo.value.trim().length > 0 ? { repo: repo.value.trim() } : {}),
          ...(workflow._tag === "Some" && workflow.value.trim().length > 0 ? { workflow: workflow.value.trim() } : {}),
          ...(branch._tag === "Some" && branch.value.trim().length > 0 ? { branch: branch.value.trim() } : {}),
          ...(conclusion._tag === "Some" && conclusion.value.trim().length > 0 ? { conclusion: conclusion.value.trim() } : {}),
        },
        sessionId: session._tag === "Some" && session.value.trim().length > 0
          ? session.value.trim()
          : defaultSessionId(),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
        active: true,
      }

      try {
        yield* Effect.tryPromise({
          try: async () => {
            await redis.hset(WEBHOOK_SUBSCRIPTIONS_KEY, subscription.id, JSON.stringify(subscription))
            await redis.sadd(webhookSubscriptionIndexKey(subscription.provider, subscription.event), subscription.id)
          },
          catch: (e) => new Error(`${e}`),
        })
      } catch (error) {
        yield* Console.log(respondError(
          "webhook subscribe",
          String(error),
          "WEBHOOK_SUBSCRIBE_FAILED",
          "Retry once Redis is healthy.",
          [{ command: "joelclaw webhook list", description: "List subscriptions" }],
        ))
        yield* safeQuit(redis)
        return
      }

      yield* safeQuit(redis)

      if (stream) {
        const cmd = `joelclaw webhook subscribe ${subscription.provider} ${subscription.event} --stream`
        yield* streamWebhookSubscription(subscription.id, timeout, replay, cmd)
        return
      }

      yield* Console.log(respond(
        "webhook subscribe",
        {
          subscription: compactWebhookSubscription(subscription),
          ttl,
        },
        [
          {
            command: "joelclaw webhook stream <subscription-id> [--timeout <timeout>] [--replay <replay>]",
            description: "Stream matched events for this subscription",
            params: {
              "subscription-id": { value: subscription.id, required: true },
              timeout: { value: 0, default: 0 },
              replay: { value: 20, default: 20 },
            },
          },
          {
            command: "joelclaw webhook unsubscribe <subscription-id>",
            description: "Remove this subscription",
            params: {
              "subscription-id": { value: subscription.id, required: true },
            },
          },
          { command: "joelclaw webhook list", description: "List subscriptions" },
        ],
      ))
    }),
).pipe(Command.withDescription("Subscribe to webhook events for a session"))

const webhookStream = Command.make(
  "stream",
  {
    subscriptionId: Args.text({ name: "subscription-id" }).pipe(
      Args.withDescription("Webhook subscription ID"),
    ),
    timeout: streamTimeout,
    replay: streamReplay,
  },
  ({ subscriptionId, timeout, replay }) =>
    streamWebhookSubscription(
      subscriptionId,
      timeout,
      replay,
      `joelclaw webhook stream ${subscriptionId}`,
    ),
).pipe(Command.withDescription("NDJSON stream for a webhook subscription"))

export const webhookCmd = Command.make("webhook", {}, () =>
  Console.log(respond(
    "webhook",
    {
      description: "Session-scoped webhook subscriptions with NDJSON streaming (ADR-0185)",
      subcommands: {
        subscribe: "joelclaw webhook subscribe <provider> <event> [filters] [--stream]",
        unsubscribe: "joelclaw webhook unsubscribe <subscription-id>",
        list: "joelclaw webhook list [--provider <provider>] [--event <event>] [--session <session>]",
        stream: "joelclaw webhook stream <subscription-id> [--timeout <timeout>] [--replay <replay>]",
      },
    },
    [
      {
        command: "joelclaw webhook subscribe <provider> <event> [--stream]",
        description: "Create a webhook subscription",
        params: {
          provider: { value: "github", required: true },
          event: { value: "workflow_run.completed", required: true },
        },
      },
      { command: "joelclaw webhook list", description: "List webhook subscriptions" },
    ],
  )),
).pipe(
  Command.withDescription("Webhook subscription and streaming commands"),
  Command.withSubcommands([webhookSubscribe, webhookUnsubscribe, webhookList, webhookStream]),
)

export const __webhookTestUtils = {
  parseDurationToSeconds,
  defaultSessionId,
}
