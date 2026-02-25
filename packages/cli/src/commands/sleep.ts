import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import { respond, respondError } from "../response"

const SYSTEM_SLEEP_KEY = "system:sleep"
const SLEEP_QUEUE_KEY = "sleep:queue"

type SleepState = {
  since?: string
  reason?: string
  duration?: string
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
    catch: (e) => new Error(`Redis connection failed: ${e}`),
  })
}

function optionValue(value: { _tag: "Some"; value: string } | { _tag: "None" }): string | undefined {
  if (value._tag !== "Some") return undefined
  const trimmed = value.value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function isValidDurationInput(input: string): boolean {
  const compact = input.trim().toLowerCase().replace(/\s+/g, "")
  if (compact.length === 0) return false
  const matches = Array.from(compact.matchAll(/(\d+)([smhdw])/g))
  if (matches.length === 0) return false
  return matches.map((match) => match[0]).join("").length === compact.length
}

function parseSleepState(raw: string | null): SleepState | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const state: SleepState = {}
    if (typeof parsed.since === "string") state.since = parsed.since
    if (typeof parsed.reason === "string") state.reason = parsed.reason
    if (typeof parsed.duration === "string") state.duration = parsed.duration
    return state
  } catch {
    return null
  }
}

const sleepFor = Options.text("for").pipe(
  Options.optional,
  Options.withDescription("Sleep duration (examples: 30m, 2h, 1h30m)")
)

const sleepReason = Options.text("reason").pipe(
  Options.optional,
  Options.withDescription("Why sleep mode is being enabled")
)

const sleepStatusCmd = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const redis = yield* makeRedis()

    const { rawSleepState, queueDepth, ttlSeconds } = yield* Effect.tryPromise({
      try: async () => {
        const raw = await redis.get(SYSTEM_SLEEP_KEY)
        const queueLen = await redis.llen(SLEEP_QUEUE_KEY)
        const ttl = raw ? await redis.ttl(SYSTEM_SLEEP_KEY) : null
        return {
          rawSleepState: raw,
          queueDepth: queueLen,
          ttlSeconds: ttl,
        }
      },
      catch: (e) => new Error(`${e}`),
    })

    yield* Effect.tryPromise({ try: () => redis.quit(), catch: () => {} })

    const state = parseSleepState(rawSleepState)
    const sleeping = Boolean(rawSleepState)

    yield* Console.log(respond(
      "sleep status",
      {
        sleeping,
        queueDepth,
        ...(state ? { sleepState: state } : {}),
        ...(ttlSeconds !== null ? { ttlSeconds } : {}),
      },
      sleeping
        ? [
            { command: "joelclaw wake", description: "Exit sleep mode and flush queued digest" },
            { command: "joelclaw sleep status", description: "Refresh sleep status" },
          ]
        : [
            {
              command: "joelclaw sleep [--for <duration>] [--reason <reason>]",
              description: "Enable sleep mode",
              params: {
                duration: { description: "Sleep duration", value: "2h", default: "2h" },
                reason: { description: "Sleep reason", value: "focused work" },
              },
            },
            { command: "joelclaw wake", description: "Force wake (safe no-op if not sleeping)" },
          ],
      true
    ))
  })
).pipe(
  Command.withDescription("Show current sleep mode state and queued event count")
)

export const sleepCmd = Command.make(
  "sleep",
  {
    for: sleepFor,
    reason: sleepReason,
  },
  ({ for: durationOpt, reason: reasonOpt }) =>
    Effect.gen(function* () {
      const duration = optionValue(durationOpt)
      const reason = optionValue(reasonOpt)

      if (duration && !isValidDurationInput(duration)) {
        yield* Console.log(respondError(
          "sleep",
          `Invalid duration: "${duration}"`,
          "INVALID_DURATION",
          "Use values like 30m, 2h, 1d, or 1h30m",
          [
            {
              command: "joelclaw sleep [--for <duration>] [--reason <reason>]",
              description: "Retry with a valid duration",
              params: {
                duration: { description: "Sleep duration", value: "2h", default: "2h" },
                reason: { description: "Sleep reason", value: reason ?? "focused work" },
              },
            },
          ],
        ))
        return
      }

      const inngestClient = yield* Inngest
      const payload: Record<string, unknown> = {}
      if (duration) payload.duration = duration
      if (reason) payload.reason = reason

      const result = yield* inngestClient.send("system/sleep.requested", payload)

      yield* Console.log(respond(
        "sleep",
        {
          event: "system/sleep.requested",
          requested: payload,
          response: result,
        },
        [
          { command: "joelclaw sleep status", description: "Check sleep state and queue depth" },
          { command: "joelclaw wake", description: "Exit sleep mode and receive queued digest" },
        ],
        true
      ))
    })
).pipe(
  Command.withDescription("Enable system sleep mode (queue non-critical gateway events)"),
  Command.withSubcommands([sleepStatusCmd]),
)

export const wakeCmd = Command.make("wake", {}, () =>
  Effect.gen(function* () {
    const inngestClient = yield* Inngest
    const result = yield* inngestClient.send("system/wake.requested", {})

    yield* Console.log(respond(
      "wake",
      {
        event: "system/wake.requested",
        response: result,
      },
      [
        { command: "joelclaw sleep status", description: "Verify sleep mode is cleared" },
        { command: "joelclaw runs --count 5", description: "Check the wake function run" },
      ],
      true
    ))
  })
).pipe(
  Command.withDescription("Wake the system and flush queued sleep-mode digest")
)
