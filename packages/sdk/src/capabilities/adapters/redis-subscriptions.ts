import { randomUUID } from "node:crypto"
import {
  init,
  lookupQueueEvent,
  Priority,
  persist,
  type QueueConfig,
  type QueueEventEnvelope,
} from "@joelclaw/queue"
import { Effect, Schema } from "effect"
import type Redis from "ioredis"
import { sendInngestEvent } from "../../lib/inngest"
import { type CapabilityPort, capabilityError } from "../contract"

const SUBSCRIPTIONS_KEY = "joelclaw:subscriptions"

type SubscriptionType = "atom" | "rss" | "github" | "page" | "bluesky"
type SubscriptionInterval = "hourly" | "daily" | "weekly"

interface Subscription {
  id: string
  name: string
  feedUrl: string
  type: SubscriptionType
  checkInterval: SubscriptionInterval
  lastChecked: number
  lastContentHash: string
  lastEntryId: string
  filters?: string[]
  publishToCool: boolean
  notify: boolean
  summarize: boolean
  active: boolean
}

const LEGACY_SUBSCRIPTION_URLS: Record<string, string> = {
  "https://github.com/mariozechner/pi-coding-agent": "https://github.com/badlogic/pi-mono",
}

const LEGACY_SUBSCRIPTION_OVERRIDES: Record<string, Pick<Subscription, "feedUrl" | "checkInterval">> = {
  "pi-coding-agent": {
    feedUrl: "https://github.com/badlogic/pi-mono",
    checkInterval: "daily",
  },
}

const QUEUE_CONFIG: QueueConfig = {
  streamKey: "joelclaw:queue:events",
  priorityKey: "joelclaw:queue:priority",
  consumerGroup: "joelclaw:queue:cli",
  consumerName: "cli-subscribe",
}

const ListArgsSchema = Schema.Struct({})
const AddArgsSchema = Schema.Struct({
  url: Schema.String,
  name: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  interval: Schema.String,
  filter: Schema.optional(Schema.String),
})
const RemoveArgsSchema = Schema.Struct({
  id: Schema.String,
})
const CheckArgsSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
})
const SummaryArgsSchema = Schema.Struct({})

const commands = {
  list: {
    summary: "List all monitored subscriptions",
    argsSchema: ListArgsSchema,
    resultSchema: Schema.Unknown,
  },
  add: {
    summary: "Add a URL to the monitoring list",
    argsSchema: AddArgsSchema,
    resultSchema: Schema.Unknown,
  },
  remove: {
    summary: "Remove a subscription from the monitoring list",
    argsSchema: RemoveArgsSchema,
    resultSchema: Schema.Unknown,
  },
  check: {
    summary: "Force-check subscriptions for updates",
    argsSchema: CheckArgsSchema,
    resultSchema: Schema.Unknown,
  },
  summary: {
    summary: "Summary of subscription health and recent checks",
    argsSchema: SummaryArgsSchema,
    resultSchema: Schema.Unknown,
  },
} as const

type SubscribeCommandName = keyof typeof commands

function decodeArgs<K extends SubscribeCommandName>(
  subcommand: K,
  args: unknown
): Effect.Effect<Schema.Schema.Type<(typeof commands)[K]["argsSchema"]>, ReturnType<typeof capabilityError>> {
  return Schema.decodeUnknown(commands[subcommand].argsSchema)(args).pipe(
    Effect.mapError((error) =>
      capabilityError(
        "SUBSCRIBE_INVALID_ARGS",
        Schema.formatIssueSync(error),
        `Check \`joelclaw subscribe ${String(subcommand)} --help\` for valid arguments.`
      )
    )
  )
}

function makeRedis() {
  return Effect.tryPromise({
    try: async () => {
      const Redis = (await import("ioredis")).default
      const redis = new Redis({
        host: process.env.REDIS_HOST ?? "localhost",
        port: Number.parseInt(process.env.REDIS_PORT ?? "6379", 10),
        lazyConnect: true,
        connectTimeout: 3000,
        commandTimeout: 5000,
      })
      await redis.connect()
      return redis
    },
    catch: (e) => capabilityError("SUBSCRIBE_REDIS_UNAVAILABLE", `Redis connection failed: ${String(e)}`, "Check Redis host/port and worker health."),
  })
}

function parseSubscription(raw: string): { subscription: Subscription; changed: boolean } | null {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return null
    if (!parsed.id || !parsed.name || !parsed.feedUrl) return null
    const subscription = parsed as Subscription
    return applyLegacySubscriptionMigrations(subscription)
  } catch {
    return null
  }
}

function applyLegacySubscriptionMigrations(subscription: Subscription): {
  subscription: Subscription
  changed: boolean
} {
  let next = subscription
  let changed = false

  const trimmedFeedUrl = next.feedUrl.trim()
  const normalizedFeedUrl = LEGACY_SUBSCRIPTION_URLS[trimmedFeedUrl] ?? trimmedFeedUrl
  if (normalizedFeedUrl !== next.feedUrl) {
    next = { ...next, feedUrl: normalizedFeedUrl }
    changed = true
  }

  const legacyOverride = LEGACY_SUBSCRIPTION_OVERRIDES[next.id]
  if (legacyOverride) {
    if (next.feedUrl !== legacyOverride.feedUrl || next.checkInterval !== legacyOverride.checkInterval) {
      next = {
        ...next,
        feedUrl: legacyOverride.feedUrl,
        checkInterval: legacyOverride.checkInterval,
      }
      changed = true
    }
  }

  return { subscription: next, changed }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
}

function detectType(url: string): SubscriptionType {
  if (/github\.com\/[^/]+\/[^/]+/i.test(url)) return "github"
  if (/bsky\.app/i.test(url)) return "bluesky"
  if (/\/atom\b|\/feed\b|\.atom$/i.test(url)) return "atom"
  if (/\/rss\b|\.rss$|\.xml$/i.test(url)) return "rss"
  return "page"
}

function compactSub(sub: Subscription) {
  const ago = sub.lastChecked > 0
    ? `${Math.round((Date.now() - sub.lastChecked) / 60_000)}min ago`
    : "never"
  return {
    id: sub.id,
    name: sub.name,
    type: sub.type,
    interval: sub.checkInterval,
    lastChecked: ago,
    active: sub.active,
    feedUrl: sub.feedUrl,
    ...(sub.filters?.length ? { filters: sub.filters } : {}),
  }
}

function asSubscriptionType(input: string | undefined, url: string): SubscriptionType {
  if (!input) return detectType(url)
  if (["atom", "rss", "github", "page", "bluesky"].includes(input)) {
    return input as SubscriptionType
  }
  return detectType(url)
}

function asSubscriptionInterval(input: string): SubscriptionInterval {
  return (["hourly", "daily", "weekly"].includes(input) ? input : "daily") as SubscriptionInterval
}

function fail(code: string, message: string, fix: string) {
  return capabilityError(code, message, fix)
}

function isQueuePilotEnabled(name: string): boolean {
  return new Set(
    (process.env.QUEUE_PILOTS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  ).has(name.trim().toLowerCase())
}

async function enqueueSubscriptionCheckFeedsRequested(
  redis: Redis,
  data: Record<string, unknown>
): Promise<{ streamId: string; eventId: string; priority: number }> {
  await init(redis, QUEUE_CONFIG)

  const priority = lookupQueueEvent("subscription/check-feeds.requested")?.priority ?? Priority.P2
  const eventId = randomUUID()
  const envelope: QueueEventEnvelope = {
    id: eventId,
    name: "subscription/check-feeds.requested",
    source: "cli/subscribe",
    ts: Date.now(),
    data,
    priority,
  }

  const result = await persist({
    payload: envelope as Record<string, unknown>,
    priority,
    metadata: {
      envelope_version: "1",
      source: "cli/subscribe",
    },
  })

  if (!result) {
    throw new Error("subscription/check-feeds.requested event was rejected by queue filter")
  }

  return {
    streamId: result.streamId,
    eventId,
    priority: result.priority,
  }
}

function sendSubscriptionEvent(name: string, data: Record<string, unknown>) {
  return Effect.tryPromise({
    try: () => sendInngestEvent(name, data),
    catch: (error) =>
      fail(
        "SUBSCRIBE_CHECK_FAILED",
        `Failed to emit ${name}: ${String(error)}`,
        "Check INNGEST_URL/INNGEST_EVENT_KEY and retry."
      ),
  })
}

export const redisSubscriptionsAdapter: CapabilityPort<typeof commands> = {
  capability: "subscribe",
  adapter: "redis-subscriptions",
  commands,
  execute(subcommand, rawArgs) {
    return Effect.gen(function* () {
      switch (subcommand) {
        case "list": {
          yield* decodeArgs("list", rawArgs)
          const redis = yield* makeRedis()
          try {
            const map = yield* Effect.tryPromise({
              try: () => redis.hgetall(SUBSCRIPTIONS_KEY),
              catch: (e) => fail("SUBSCRIBE_LIST_FAILED", String(e), "Retry after Redis connectivity is restored."),
            })

            const parsedSubs = Object.entries(map)
              .map(([id, raw]) => ({ id, parsed: parseSubscription(raw) }))
              .filter(
                (entry): entry is { id: string; parsed: { subscription: Subscription; changed: boolean } } =>
                  entry.parsed !== null
              )

            const migrated = parsedSubs.filter((entry) => entry.parsed.changed)
            if (migrated.length > 0) {
              yield* Effect.tryPromise({
                try: () =>
                  Promise.all(
                    migrated.map((entry) =>
                      redis.hset(
                        SUBSCRIPTIONS_KEY,
                        entry.id,
                        JSON.stringify(entry.parsed.subscription),
                      )
                    )
                  ),
                catch: (e) => fail("SUBSCRIBE_LIST_FAILED", String(e), "Retry after Redis connectivity is restored."),
              })
            }

            const subs = parsedSubs
              .map((entry) => entry.parsed.subscription)
              .sort((a, b) => a.name.localeCompare(b.name))

            const active = subs.filter((s) => s.active)
            const inactive = subs.filter((s) => !s.active)

            return {
              total: subs.length,
              active: active.length,
              inactive: inactive.length,
              subscriptions: subs.map(compactSub),
            }
          } finally {
            redis.disconnect()
          }
        }
        case "add": {
          const args = yield* decodeArgs("add", rawArgs)
          const redis = yield* makeRedis()
          try {
            const detectedType = asSubscriptionType(args.type, args.url)
            const displayName = args.name?.trim().length
              ? args.name
              : args.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").slice(0, 50)
            const id = slugify(displayName)
            const checkInterval = asSubscriptionInterval(args.interval)
            const filters = args.filter?.trim().length
              ? args.filter.split(",").map((f) => f.trim()).filter(Boolean)
              : undefined

            const existing = yield* Effect.tryPromise({
              try: () => redis.hget(SUBSCRIPTIONS_KEY, id),
              catch: (e) => fail("SUBSCRIBE_ADD_FAILED", String(e), "Retry after Redis connectivity is restored."),
            })

            if (existing) {
              return yield* Effect.fail(
                fail(
                  "SUBSCRIPTION_EXISTS",
                  `Subscription "${id}" already exists`,
                  `Use a different --name or remove the existing one first: joelclaw subscribe remove ${id}`
                )
              )
            }

            const subscription: Subscription = {
              id,
              name: displayName,
              feedUrl: args.url,
              type: detectedType,
              checkInterval,
              lastChecked: 0,
              lastContentHash: "",
              lastEntryId: "",
              filters,
              publishToCool: false,
              notify: true,
              summarize: true,
              active: true,
            }

            yield* Effect.tryPromise({
              try: () => redis.hset(SUBSCRIPTIONS_KEY, id, JSON.stringify(subscription)),
              catch: (e) => fail("SUBSCRIBE_ADD_FAILED", String(e), "Retry after Redis connectivity is restored."),
            })

            return {
              added: compactSub(subscription),
              feedUrl: args.url,
              detectedType,
            }
          } finally {
            redis.disconnect()
          }
        }
        case "remove": {
          const args = yield* decodeArgs("remove", rawArgs)
          const redis = yield* makeRedis()
          try {
            const removed = yield* Effect.tryPromise({
              try: () => redis.hdel(SUBSCRIPTIONS_KEY, args.id),
              catch: (e) => fail("SUBSCRIBE_REMOVE_FAILED", String(e), "Retry after Redis connectivity is restored."),
            })

            if (removed === 0) {
              return yield* Effect.fail(
                fail(
                  "SUBSCRIPTION_NOT_FOUND",
                  `Subscription "${args.id}" not found`,
                  "Check available IDs with: joelclaw subscribe list"
                )
              )
            }

            return { removed: args.id }
          } finally {
            redis.disconnect()
          }
        }
        case "check": {
          const args = yield* decodeArgs("check", rawArgs)

          if (args.id?.trim()) {
            const response = yield* sendSubscriptionEvent("subscription/check.requested", {
              subscriptionId: args.id,
              forced: true,
              source: "cli",
            })

            return {
              subscriptionId: args.id,
              event: "subscription/check.requested",
              response,
            }
          }

          if (isQueuePilotEnabled("subscriptions")) {
            const redis = yield* makeRedis()
            try {
              const queued = yield* Effect.tryPromise({
                try: () => enqueueSubscriptionCheckFeedsRequested(redis, {
                  forceAll: true,
                  source: "cli",
                }),
                catch: (error) =>
                  fail(
                    "SUBSCRIBE_CHECK_FAILED",
                    `Failed to enqueue subscription/check-feeds.requested: ${String(error)}`,
                    "Check Redis connectivity and retry."
                  ),
              })

              return {
                scope: "all",
                event: "subscription/check-feeds.requested",
                mode: "queue",
                streamId: queued.streamId,
                eventId: queued.eventId,
                priority: queued.priority,
              }
            } finally {
              redis.disconnect()
            }
          }

          const response = yield* sendSubscriptionEvent("subscription/check-feeds.requested", {
            forceAll: true,
            source: "cli",
          })

          return {
            scope: "all",
            event: "subscription/check-feeds.requested",
            mode: "inngest",
            response,
          }
        }
        case "summary": {
          yield* decodeArgs("summary", rawArgs)
          const redis = yield* makeRedis()
          try {
            const map = yield* Effect.tryPromise({
              try: () => redis.hgetall(SUBSCRIPTIONS_KEY),
              catch: (e) => fail("SUBSCRIBE_SUMMARY_FAILED", String(e), "Retry after Redis connectivity is restored."),
            })

            const parsedSubs = Object.entries(map)
              .map(([id, raw]) => ({ id, parsed: parseSubscription(raw) }))
              .filter(
                (entry): entry is { id: string; parsed: { subscription: Subscription; changed: boolean } } =>
                  entry.parsed !== null
              )

            const migrated = parsedSubs.filter((entry) => entry.parsed.changed)
            if (migrated.length > 0) {
              yield* Effect.tryPromise({
                try: () =>
                  Promise.all(
                    migrated.map((entry) =>
                      redis.hset(
                        SUBSCRIPTIONS_KEY,
                        entry.id,
                        JSON.stringify(entry.parsed.subscription),
                      )
                    )
                  ),
                catch: (e) => fail("SUBSCRIBE_SUMMARY_FAILED", String(e), "Retry after Redis connectivity is restored."),
              })
            }

            const subs = parsedSubs
              .map((entry) => entry.parsed.subscription)
              .filter((s): s is Subscription => s.active)
              .sort((a, b) => b.lastChecked - a.lastChecked)

            const now = Date.now()
            const stale = subs.filter((s) => {
              if (s.lastChecked <= 0) return true
              const intervals: Record<string, number> = {
                hourly: 2 * 60 * 60 * 1000,
                daily: 2 * 24 * 60 * 60 * 1000,
                weekly: 2 * 7 * 24 * 60 * 60 * 1000,
              }
              return now - s.lastChecked > (intervals[s.checkInterval] ?? intervals.daily)
            })

            const byType: Record<string, number> = {}
            for (const sub of subs) {
              byType[sub.type] = (byType[sub.type] ?? 0) + 1
            }

            const recentlyChecked = subs
              .filter((s) => s.lastChecked > 0)
              .slice(0, 10)
              .map((s) => ({
                id: s.id,
                name: s.name,
                type: s.type,
                lastChecked: `${Math.round((now - s.lastChecked) / 60_000)}min ago`,
              }))

            return {
              active: subs.length,
              byType,
              stale: stale.length,
              staleIds: stale.map((s) => s.id),
              recentlyChecked,
            }
          } finally {
            redis.disconnect()
          }
        }
        default:
          return yield* Effect.fail(
            capabilityError(
              "SUBSCRIBE_SUBCOMMAND_UNSUPPORTED",
              `Unsupported subscribe subcommand: ${String(subcommand)}`
            )
          )
      }
    })
  },
}

export const __subscribeAdapterTestUtils = {
  slugify,
  detectType,
  asSubscriptionInterval,
}
