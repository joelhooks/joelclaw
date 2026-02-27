import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import { respond, respondError, type NextAction } from "../response"

const SUBSCRIPTIONS_KEY = "joelclaw:subscriptions"

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

function parseSubscription(raw: string): Subscription | null {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return null
    if (!parsed.id || !parsed.name || !parsed.feedUrl) return null
    return parsed as Subscription
  } catch {
    return null
  }
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

const COMMON_NEXT_ACTIONS: NextAction[] = [
  { command: "joelclaw subscribe list", description: "List all subscriptions" },
  {
    command: "joelclaw subscribe check [--id <id>]",
    description: "Force-check a subscription or all",
    params: { id: { description: "Subscription ID (omit for all)" } },
  },
]

// ── subscribe list ───────────────────────────────────────────────────

const subscribeList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const redis = yield* makeRedis()
    try {
      const map = yield* Effect.tryPromise({
        try: () => redis.hgetall(SUBSCRIPTIONS_KEY),
        catch: (e) => new Error(`${e}`),
      })

      const subs = Object.values(map)
        .map(parseSubscription)
        .filter((s): s is Subscription => s !== null)
        .sort((a, b) => a.name.localeCompare(b.name))

      const active = subs.filter((s) => s.active)
      const inactive = subs.filter((s) => !s.active)

      yield* Console.log(respond(
        "subscribe list",
        {
          total: subs.length,
          active: active.length,
          inactive: inactive.length,
          subscriptions: subs.map(compactSub),
        },
        [
          {
            command: "joelclaw subscribe add <url> [--name <name>] [--type <type>] [--interval <interval>]",
            description: "Add a new subscription",
            params: {
              url: { description: "Feed URL, GitHub repo URL, or page URL", required: true },
              name: { description: "Display name" },
              type: { enum: ["atom", "rss", "github", "page", "bluesky"] },
              interval: { enum: ["hourly", "daily", "weekly"], default: "daily" },
            },
          },
          {
            command: "joelclaw subscribe check [--id <id>]",
            description: "Force-check subscriptions",
            params: { id: { description: "Subscription ID (omit for all)" } },
          },
          {
            command: "joelclaw subscribe remove <id>",
            description: "Remove a subscription",
            params: { id: { description: "Subscription ID", required: true } },
          },
        ],
      ))
    } finally {
      redis.disconnect()
    }
  })
).pipe(
  Command.withDescription("List all monitored subscriptions"),
)

// ── subscribe add ────────────────────────────────────────────────────

const subscribeAdd = Command.make(
  "add",
  {
    url: Args.text({ name: "url" }).pipe(
      Args.withDescription("Feed URL, GitHub repo URL, or page URL to monitor"),
    ),
    name: Options.text("name").pipe(
      Options.withDescription("Display name for the subscription"),
      Options.optional,
    ),
    type: Options.text("type").pipe(
      Options.withDescription("Feed type: atom, rss, github, page, bluesky"),
      Options.optional,
    ),
    interval: Options.text("interval").pipe(
      Options.withDescription("Check interval: hourly, daily, weekly"),
      Options.withDefault("daily"),
    ),
    filter: Options.text("filter").pipe(
      Options.withAlias("f"),
      Options.withDescription("Comma-separated topic filters"),
      Options.optional,
    ),
  },
  ({ url, name, type, interval, filter }) =>
    Effect.gen(function* () {
      const redis = yield* makeRedis()
      try {
        const detectedType = type._tag === "Some"
          ? type.value as SubscriptionType
          : detectType(url)

        const displayName = name._tag === "Some"
          ? name.value
          : url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").slice(0, 50)

        const id = slugify(displayName)
        const checkInterval = (["hourly", "daily", "weekly"].includes(interval)
          ? interval
          : "daily") as SubscriptionInterval

        const filters = filter._tag === "Some"
          ? filter.value.split(",").map((f) => f.trim()).filter(Boolean)
          : undefined

        // Check for existing
        const existing = yield* Effect.tryPromise({
          try: () => redis.hget(SUBSCRIPTIONS_KEY, id),
          catch: (e) => new Error(`${e}`),
        })

        if (existing) {
          yield* Console.log(respondError(
            "subscribe add",
            `Subscription "${id}" already exists`,
            "SUBSCRIPTION_EXISTS",
            `Use a different --name or remove the existing one first: joelclaw subscribe remove ${id}`,
            [
              {
                command: "joelclaw subscribe remove <id>",
                description: "Remove existing subscription",
                params: { id: { value: id, required: true } },
              },
              { command: "joelclaw subscribe list", description: "List all subscriptions" },
            ],
          ))
          return
        }

        const subscription: Subscription = {
          id,
          name: displayName,
          feedUrl: url,
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
          catch: (e) => new Error(`${e}`),
        })

        yield* Console.log(respond(
          "subscribe add",
          {
            added: compactSub(subscription),
            feedUrl: url,
            detectedType,
          },
          [
            {
              command: "joelclaw subscribe check [--id <id>]",
              description: "Force-check this subscription now",
              params: { id: { value: id, description: "Subscription ID" } },
            },
            { command: "joelclaw subscribe list", description: "List all subscriptions" },
            {
              command: "joelclaw subscribe remove <id>",
              description: "Remove this subscription",
              params: { id: { value: id, required: true } },
            },
          ],
        ))
      } finally {
        redis.disconnect()
      }
    }),
).pipe(
  Command.withDescription("Add a URL to the monitoring list"),
)

// ── subscribe remove ─────────────────────────────────────────────────

const subscribeRemove = Command.make(
  "remove",
  {
    id: Args.text({ name: "id" }).pipe(
      Args.withDescription("Subscription ID to remove"),
    ),
  },
  ({ id }) =>
    Effect.gen(function* () {
      const redis = yield* makeRedis()
      try {
        const removed = yield* Effect.tryPromise({
          try: () => redis.hdel(SUBSCRIPTIONS_KEY, id),
          catch: (e) => new Error(`${e}`),
        })

        if (removed === 0) {
          yield* Console.log(respondError(
            "subscribe remove",
            `Subscription "${id}" not found`,
            "SUBSCRIPTION_NOT_FOUND",
            "Check available IDs with: joelclaw subscribe list",
            [{ command: "joelclaw subscribe list", description: "List all subscriptions" }],
          ))
          return
        }

        yield* Console.log(respond(
          "subscribe remove",
          { removed: id },
          COMMON_NEXT_ACTIONS,
        ))
      } finally {
        redis.disconnect()
      }
    }),
).pipe(
  Command.withDescription("Remove a subscription from the monitoring list"),
)

// ── subscribe check ──────────────────────────────────────────────────

const subscribeCheck = Command.make(
  "check",
  {
    id: Options.text("id").pipe(
      Options.withDescription("Subscription ID to check (omit for all)"),
      Options.optional,
    ),
  },
  ({ id }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest

      if (id._tag === "Some") {
        // Check single subscription
        const result = yield* inngestClient.send("subscription/check.requested", {
          subscriptionId: id.value,
          forced: true,
          source: "cli",
        })

        const ids = (result as any)?.ids ?? []

        yield* Console.log(respond(
          "subscribe check",
          {
            subscriptionId: id.value,
            event: "subscription/check.requested",
            response: result,
          },
          [
            {
              command: "joelclaw run <run-id>",
              description: "Check the run progress",
              params: { "run-id": { value: ids[0], required: true } },
            },
            ...COMMON_NEXT_ACTIONS,
          ],
        ))
      } else {
        // Check all subscriptions
        const result = yield* inngestClient.send("subscription/check-feeds.requested", {
          forceAll: true,
          source: "cli",
        })

        const ids = (result as any)?.ids ?? []

        yield* Console.log(respond(
          "subscribe check",
          {
            scope: "all",
            event: "subscription/check-feeds.requested",
            response: result,
          },
          [
            {
              command: "joelclaw runs [--count <count>]",
              description: "Check feed-check run progress",
              params: { count: { default: 5, description: "Number of runs" } },
            },
            ...COMMON_NEXT_ACTIONS,
          ],
        ))
      }
    }),
).pipe(
  Command.withDescription("Force-check subscriptions for updates"),
)

// ── subscribe summary ────────────────────────────────────────────────

const subscribeSummary = Command.make("summary", {}, () =>
  Effect.gen(function* () {
    const redis = yield* makeRedis()
    try {
      const map = yield* Effect.tryPromise({
        try: () => redis.hgetall(SUBSCRIPTIONS_KEY),
        catch: (e) => new Error(`${e}`),
      })

      const subs = Object.values(map)
        .map(parseSubscription)
        .filter((s): s is Subscription => s !== null && s.active)
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

      yield* Console.log(respond(
        "subscribe summary",
        {
          active: subs.length,
          byType,
          stale: stale.length,
          staleIds: stale.map((s) => s.id),
          recentlyChecked,
        },
        [
          ...(stale.length > 0 ? [{
            command: "joelclaw subscribe check",
            description: `Force-check all (${stale.length} stale)`,
          }] : []),
          { command: "joelclaw subscribe list", description: "Full subscription list" },
          {
            command: "joelclaw subscribe add <url> [--name <name>]",
            description: "Add a new subscription",
            params: {
              url: { description: "Feed URL or page URL", required: true },
              name: { description: "Display name" },
            },
          },
        ],
      ))
    } finally {
      redis.disconnect()
    }
  })
).pipe(
  Command.withDescription("Summary of subscription health and recent checks"),
)

// ── Root subscribe command ───────────────────────────────────────────

export const subscribeCmd = Command.make("subscribe", {}, () =>
  Console.log(respond(
    "subscribe",
    {
      description: "Monitor blogs, repos, and pages for changes (ADR-0127)",
      subcommands: {
        list: "joelclaw subscribe list",
        add: "joelclaw subscribe add <url> [--name <name>] [--type <type>] [--interval <interval>]",
        remove: "joelclaw subscribe remove <id>",
        check: "joelclaw subscribe check [--id <id>]",
        summary: "joelclaw subscribe summary",
      },
    },
    [
      { command: "joelclaw subscribe list", description: "List all subscriptions" },
      {
        command: "joelclaw subscribe add <url> [--name <name>]",
        description: "Add a new subscription",
        params: {
          url: { description: "Feed URL, GitHub repo, or page URL", required: true },
          name: { description: "Display name" },
        },
      },
      { command: "joelclaw subscribe summary", description: "Health summary" },
    ],
  ))
).pipe(
  Command.withDescription("Monitor blogs, repos, and pages for changes (ADR-0127)"),
  Command.withSubcommands([subscribeList, subscribeAdd, subscribeRemove, subscribeCheck, subscribeSummary]),
)
