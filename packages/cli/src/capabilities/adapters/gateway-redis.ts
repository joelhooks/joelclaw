import { Effect, Schema } from "effect"
import { type CapabilityPort, capabilityError } from "../contract"

const PRIORITIES = ["low", "normal", "high", "urgent"] as const

const NotifySendArgsSchema = Schema.Struct({
  message: Schema.String,
  channel: Schema.optional(Schema.String),
  priority: Schema.optional(Schema.Literal(...PRIORITIES)),
  context: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  type: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  telegramOnly: Schema.optional(Schema.Boolean),
})

const NotifySendResultSchema = Schema.Struct({
  backend: Schema.String,
  eventId: Schema.String,
  eventType: Schema.String,
  channel: Schema.String,
  deliveredTo: Schema.Array(Schema.String),
  priority: Schema.Literal(...PRIORITIES),
  queuedLists: Schema.Array(Schema.String),
  notifyChannels: Schema.Array(Schema.String),
  payload: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
})

const commands = {
  send: {
    summary: "Send canonical operator notification through gateway Redis bridge",
    argsSchema: NotifySendArgsSchema,
    resultSchema: NotifySendResultSchema,
  },
} as const

type RedisClient = {
  connect: () => Promise<void>
  quit: () => Promise<void>
  smembers: (key: string) => Promise<string[]>
  lpush: (key: string, value: string) => Promise<number>
  publish: (channel: string, message: string) => Promise<number>
}

type NotifyPriority = (typeof PRIORITIES)[number]

function decodeArgs<K extends keyof typeof commands>(
  subcommand: K,
  args: unknown,
): Effect.Effect<Schema.Schema.Type<(typeof commands)[K]["argsSchema"]>, ReturnType<typeof capabilityError>> {
  return Schema.decodeUnknown(commands[subcommand].argsSchema)(args).pipe(
    Effect.mapError((error) =>
      capabilityError(
        "NOTIFY_INVALID_ARGS",
        Schema.formatIssueSync(error),
        `Check \`joelclaw notify ${String(subcommand)} --help\` for valid arguments.`
      )
    )
  )
}

function priorityToLevel(priority: NotifyPriority): "info" | "warn" | "fatal" {
  if (priority === "high") return "warn"
  if (priority === "urgent") return "fatal"
  return "info"
}

function normalizeChannel(channel: string | undefined): string {
  const normalized = channel?.trim().toLowerCase()
  if (!normalized) return "gateway"
  if (normalized === "all") return "all"
  return normalized
}

async function connectRedis(): Promise<RedisClient> {
  const Redis = (await import("ioredis")).default
  const configuredHost = (process.env.REDIS_HOST ?? "127.0.0.1").trim()
  const host = configuredHost === "localhost" ? "127.0.0.1" : configuredHost
  const redis = new Redis({
    host,
    port: Number.parseInt(process.env.REDIS_PORT ?? "6379", 10),
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 3_000,
    commandTimeout: 5_000,
    retryStrategy: (attempt: number) => (attempt > 3 ? null : Math.min(attempt * 500, 2_000)),
  })
  redis.on("error", () => {})

  try {
    await redis.connect()
  } catch (error) {
    redis.disconnect(false)
    throw error
  }

  return redis as unknown as RedisClient
}

async function resolveTargets(redis: RedisClient, requestedChannel: string): Promise<string[]> {
  if (requestedChannel !== "all") return [requestedChannel]

  const sessions = await redis.smembers("joelclaw:gateway:sessions")
  if (sessions.length === 0) return ["gateway", "main"]
  return sessions
}

function queueKey(channel: string): string {
  return `joelclaw:events:${channel}`
}

function notifyKey(channel: string): string {
  return `joelclaw:notify:${channel}`
}

export const gatewayRedisNotifyAdapter: CapabilityPort<typeof commands> = {
  capability: "notify",
  adapter: "gateway-redis",
  commands,
  execute(subcommand, rawArgs) {
    return Effect.gen(function* () {
      switch (subcommand) {
        case "send": {
          const args = yield* decodeArgs("send", rawArgs)
          const priority = args.priority ?? "normal"
          const normalizedChannel = normalizeChannel(args.channel)
          const type = args.type?.trim() || "notify.message"
          const source = args.source?.trim() || "cli/notify"
          const message = args.message.trim()

          if (message.length === 0) {
            return yield* Effect.fail(
              capabilityError(
                "NOTIFY_MESSAGE_REQUIRED",
                "Message cannot be empty",
                "Provide a non-empty message argument: joelclaw notify send \"message\""
              )
            )
          }

          const payload: Record<string, unknown> = {
            prompt: message,
            message,
            priority,
            level: priorityToLevel(priority),
            context: args.context ?? {},
            immediateTelegram: priority === "high" || priority === "urgent",
            ...(args.telegramOnly === true ? { telegramOnly: true } : {}),
          }

          const event = {
            id: crypto.randomUUID(),
            type,
            source,
            payload,
            ts: Date.now(),
          }

          const redis = yield* Effect.tryPromise({
            try: () => connectRedis(),
            catch: (error) =>
              capabilityError(
                "NOTIFY_BACKEND_UNAVAILABLE",
                `Redis connection failed: ${String(error)}`,
                "Verify Redis is running (`joelclaw status`) and retry."
              ),
          })

          const targets = yield* Effect.tryPromise({
            try: () => resolveTargets(redis, normalizedChannel),
            catch: (error) =>
              capabilityError(
                "NOTIFY_TARGET_RESOLUTION_FAILED",
                `Failed to resolve notify targets: ${String(error)}`,
                "Check Redis gateway session state with `joelclaw gateway status`."
              ),
          })

          const queuedLists: string[] = []
          const notifyChannels: string[] = []
          const serializedEvent = JSON.stringify(event)
          const notification = JSON.stringify({
            eventId: event.id,
            type: event.type,
            priority,
          })

          yield* Effect.tryPromise({
            try: async () => {
              try {
                for (const channel of targets) {
                  const list = queueKey(channel)
                  const notify = notifyKey(channel)
                  await redis.lpush(list, serializedEvent)
                  await redis.publish(notify, notification)
                  queuedLists.push(list)
                  notifyChannels.push(notify)
                }
              } finally {
                await redis.quit().catch(() => {})
              }
            },
            catch: (error) =>
              capabilityError(
                "NOTIFY_SEND_FAILED",
                `Failed to publish gateway notification: ${String(error)}`,
                "Check `joelclaw gateway status` and retry."
              ),
          })

          return {
            backend: "gateway-redis",
            eventId: event.id,
            eventType: event.type,
            channel: normalizedChannel,
            deliveredTo: targets,
            priority,
            queuedLists,
            notifyChannels,
            payload,
          }
        }
        default:
          return yield* Effect.fail(
            capabilityError(
              "NOTIFY_SUBCOMMAND_UNSUPPORTED",
              `Unsupported notify subcommand: ${String(subcommand)}`
            )
          )
      }
    })
  },
}
