import { createChannelDeliveryAudit, emitGatewayOtel } from "@joelclaw/telemetry"
import { Effect, ParseResult, Schema } from "effect"
import { type CapabilityPort, capabilityError } from "../contract"

const PRIORITIES = ["low", "normal", "high", "urgent"] as const
const MESSAGE_KINDS = ["memory", "alert", "digest", "ask", "receipt"] as const

const NotifySendArgsSchema = Schema.Struct({
  message: Schema.String,
  channel: Schema.optional(Schema.String),
  priority: Schema.optional(Schema.Literal(...PRIORITIES)),
  context: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  type: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.Literal(...MESSAGE_KINDS)),
  telegramOnly: Schema.optional(Schema.Boolean),
  eventId: Schema.optional(Schema.String),
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
  deduplicated: Schema.Boolean,
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
  eval: (script: string, keyCount: number, ...args: string[]) => Promise<number>
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
        ParseResult.TreeFormatter.formatErrorSync(error),
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

const NOTIFY_IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60
const NOTIFY_IDEMPOTENCY_SCRIPT = `
if redis.call("EXISTS", KEYS[1]) == 1 then
  return 0
end
redis.call("SET", KEYS[1], "1", "EX", ARGV[1])
for index = 2, #KEYS do
  redis.call("LPUSH", KEYS[index], ARGV[2])
  redis.call("PUBLISH", ARGV[index + 2], ARGV[3])
end
return 1
`

function validEventId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
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

          const requestedEventId = args.eventId?.trim()
          if (requestedEventId && !validEventId(requestedEventId)) {
            return yield* Effect.fail(
              capabilityError(
                "NOTIFY_EVENT_ID_INVALID",
                "--event-id must be a lowercase UUID v4",
                "Omit --event-id for a generated ID, or provide a stable UUID v4 for idempotent delivery."
              )
            )
          }
          const eventId = requestedEventId || crypto.randomUUID()
          const audit = createChannelDeliveryAudit(message, {
            flowId: `notify:${eventId}`,
            producer: source,
            eventId,
            route: `gateway:${normalizedChannel}`,
          })
          const payload: Record<string, unknown> = {
            prompt: message,
            message,
            priority,
            level: priorityToLevel(priority),
            context: args.context ?? {},
            audit,
            immediateTelegram: priority === "high" || priority === "urgent",
            ...(args.kind ? { kind: args.kind } : {}),
            ...(args.telegramOnly === true ? { telegramOnly: true } : {}),
          }

          const event = {
            id: eventId,
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

          const targetLists = targets.map(queueKey)
          const targetNotifyChannels = targets.map(notifyKey)
          const serializedEvent = JSON.stringify(event)
          const notification = JSON.stringify({
            eventId: event.id,
            type: event.type,
            priority,
          })
          let deduplicated = false

          yield* Effect.tryPromise({
            try: async () => {
              try {
                const inserted = await redis.eval(
                  NOTIFY_IDEMPOTENCY_SCRIPT,
                  1 + targetLists.length,
                  `joelclaw:notify:idempotency:${eventId}`,
                  ...targetLists,
                  String(NOTIFY_IDEMPOTENCY_TTL_SECONDS),
                  serializedEvent,
                  notification,
                  ...targetNotifyChannels,
                )
                deduplicated = inserted === 0
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

          const queuedLists = deduplicated ? [] : targetLists
          const notifyChannels = deduplicated ? [] : targetNotifyChannels
          void emitGatewayOtel({
            level: "info",
            source: "cli",
            systemId: audit.originSystemId,
            component: "notify",
            action: deduplicated ? "channel.delivery.deduplicated" : "channel.delivery.queued",
            success: true,
            critical: true,
            metadata: {
              ...audit,
              channel: normalizedChannel,
              priority,
              queuedLists,
              notifyChannels,
              deduplicated,
            },
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
            deduplicated,
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
