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

const NotifyWaitArgsSchema = Schema.Struct({
  eventId: Schema.String,
  source: Schema.String,
  timeoutSeconds: Schema.optional(Schema.Number),
})

const NotifyCallbackActionSchema = Schema.Struct({
  kind: Schema.Literal("callback"),
  id: Schema.Literal(
    "learner-flow.ack",
    "learner-flow.run",
    "learner-flow.investigate",
  ),
  label: Schema.String,
})

const NotifyWaitResultSchema = Schema.Struct({
  flowId: Schema.String,
  correlationId: Schema.String,
  platform: Schema.String,
  platformMessageId: Schema.NullOr(Schema.String),
  deliveryState: Schema.Literal("confirmed", "failed", "suppressed", "digested"),
  declaredActions: Schema.Array(NotifyCallbackActionSchema),
  confirmedAt: Schema.NullOr(Schema.String),
})

const commands = {
  send: {
    summary: "Send canonical operator notification through gateway Redis bridge",
    argsSchema: NotifySendArgsSchema,
    resultSchema: NotifySendResultSchema,
  },
  wait: {
    summary: "Wait for a terminal contract-v2 notification receipt",
    argsSchema: NotifyWaitArgsSchema,
    resultSchema: NotifyWaitResultSchema,
  },
} as const

type RedisClient = {
  connect: () => Promise<void>
  quit: () => Promise<void>
  smembers: (key: string) => Promise<string[]>
  get: (key: string) => Promise<string | null>
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

export interface NotifyTerminalReceipt {
  readonly flowId: string
  readonly correlationId: string
  readonly platform: string
  readonly platformMessageId: string | null
  readonly deliveryState: "confirmed" | "failed" | "suppressed" | "digested"
  readonly declaredActions: ReadonlyArray<{
    readonly kind: "callback"
    readonly id: "learner-flow.ack" | "learner-flow.run" | "learner-flow.investigate"
    readonly label: string
  }>
  readonly confirmedAt: string | null
}

export function notifyTerminalFailureCode(
  state: Exclude<NotifyTerminalReceipt["deliveryState"], "confirmed">,
): "NOTIFY_DELIVERY_FAILED" | "NOTIFY_SUPPRESSED" | "NOTIFY_DIGESTED" {
  if (state === "failed") return "NOTIFY_DELIVERY_FAILED"
  if (state === "suppressed") return "NOTIFY_SUPPRESSED"
  return "NOTIFY_DIGESTED"
}

export async function waitForNotifyTerminalReceipt(
  input: {
    readonly correlationId: string
    readonly timeoutMs: number
  },
  dependencies: {
    readonly get: (key: string) => Promise<string | null>
    readonly now?: () => number
    readonly sleep?: (milliseconds: number) => Promise<void>
    readonly pollIntervalMs?: number
  },
): Promise<NotifyTerminalReceipt | null> {
  const now = dependencies.now ?? Date.now
  const sleep = dependencies.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const deadline = now() + Math.max(0, input.timeoutMs)
  const key = `joelclaw:message-contract:correlation:${input.correlationId}`
  while (now() <= deadline) {
    const raw = await dependencies.get(key)
    if (raw) {
      const parsed = JSON.parse(raw)
      return Schema.decodeUnknownSync(NotifyWaitResultSchema)(parsed)
    }
    if (now() >= deadline) return null
    await sleep(dependencies.pollIntervalMs ?? 250)
  }
  return null
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
        case "wait": {
          const args = yield* decodeArgs("wait", rawArgs)
          const eventId = args.eventId.trim()
          const source = args.source.trim()
          if (!validEventId(eventId) || source.length === 0) {
            return yield* Effect.fail(
              capabilityError(
                "NOTIFY_WAIT_INVALID_ARGS",
                "notify wait requires a lowercase UUID v4 event ID and non-empty source",
                "Use the eventId returned by notify send and the exact producer passed to --source."
              )
            )
          }
          const timeoutSeconds = args.timeoutSeconds ?? 15
          if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 300) {
            return yield* Effect.fail(
              capabilityError(
                "NOTIFY_WAIT_INVALID_TIMEOUT",
                "--timeout must be between 0 and 300 seconds",
                "Use --timeout 15s for the normal terminal receipt window."
              )
            )
          }
          const redis = yield* Effect.tryPromise({
            try: () => connectRedis(),
            catch: (error) =>
              capabilityError(
                "NOTIFY_BACKEND_UNAVAILABLE",
                `Redis connection failed: ${String(error)}`,
                "Verify Redis is running (`joelclaw status`) and retry the same event ID."
              ),
          })
          const correlationId = `${source}:${eventId}`
          const receipt = yield* Effect.tryPromise({
            try: async () => {
              try {
                return await waitForNotifyTerminalReceipt(
                  { correlationId, timeoutMs: timeoutSeconds * 1_000 },
                  { get: (key) => redis.get(key) },
                )
              } finally {
                await redis.quit().catch(() => {})
              }
            },
            catch: (error) =>
              capabilityError(
                "NOTIFY_TERMINAL_RECEIPT_INVALID",
                `Terminal receipt could not be decoded: ${String(error)}`,
                "Audit the same correlation ID in the private message journal; do not resend."
              ),
          })
          if (!receipt) {
            return yield* Effect.fail(
              capabilityError(
                "NOTIFY_TERMINAL_RECEIPT_TIMEOUT",
                `No terminal receipt appeared for ${correlationId} before the deadline`,
                "Repeat notify wait or audit this same event ID; do not send a new notification.",
                true,
              )
            )
          }
          if (receipt.deliveryState !== "confirmed") {
            const code = notifyTerminalFailureCode(receipt.deliveryState)
            return yield* Effect.fail(
              capabilityError(
                code,
                `Notification ended in terminal state ${receipt.deliveryState}`,
                "Inspect the terminal receipt and stop for an explicit operator decision; do not resend automatically."
              )
            )
          }
          return receipt
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
