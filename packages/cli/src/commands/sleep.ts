import { randomUUID } from "node:crypto"
import { Args, Command, Options } from "@effect/cli"
import {
  PANE_SCHEDULE_REGISTRY_KEY,
  PANE_SCHEDULE_VERSION,
  type PaneScheduleEntry,
  type PaneScheduleVerb,
  validatePaneSchedule,
} from "@joelclaw/system-bus/src/lib/pane-schedule.ts"
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

const scheduleVerb = Options.choice("verb", ["wake", "spawn", "revive"] as const).pipe(
  Options.withDefault("wake"),
  Options.withDescription("Action to execute when the schedule becomes due"),
)
const scheduleTarget = Options.text("target").pipe(Options.optional, Options.withDescription("Existing pane or agent for wake"))
const scheduleBrief = Options.text("brief").pipe(Options.optional, Options.withDescription("Task brief path for spawn"))
const scheduleLoop = Options.text("loop").pipe(Options.optional, Options.withDescription("Loop id for revive"))
const schedulePrompt = Options.text("prompt").pipe(Options.optional, Options.withDescription("Optional extra context"))
const scheduleFormat = Options.choice("format", ["json", "text"] as const).pipe(
  Options.withDefault("json"),
  Options.withDescription("Output format"),
)

function optionalCliText(value: { _tag: "Some"; value: string } | { _tag: "None" }): string | undefined {
  return value._tag === "Some" && value.value.trim().length > 0 ? value.value.trim() : undefined
}

export function parseScheduleDuration(input: string): number | null {
  const compact = input.trim().toLowerCase().replace(/\s+/g, "")
  const parts = [...compact.matchAll(/(\d+)(s|m|h|d|w)/g)]
  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== compact) return null
  const units: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
  return parts.reduce((total, part) => total + Number.parseInt(part[1]!, 10) * units[part[2]!]!, 0)
}

export function resolveScheduleAt(mode: "at" | "in", input: string, nowMs = Date.now()): string {
  if (mode === "in") {
    const durationMs = parseScheduleDuration(input)
    if (durationMs === null || durationMs <= 0) throw new Error(`Invalid duration: "${input}". Use values like 5m, 2h, or 1d12h.`)
    return new Date(nowMs + durationMs).toISOString()
  }
  const parsed = Date.parse(input)
  if (!Number.isFinite(parsed)) throw new Error(`Invalid date: "${input}". Use ISO-8601 or a date string your system understands.`)
  if (parsed <= nowMs) throw new Error(`Scheduled time must be in the future: ${new Date(parsed).toISOString()}`)
  return new Date(parsed).toISOString()
}

function requestedBy(): string {
  return process.env.JOELCLAW_REQUESTED_BY?.trim() || process.env.USER?.trim() || "joelclaw-cli"
}

function makeScheduleEntry(input: {
  mode: "at" | "in"
  when: string
  verb: PaneScheduleVerb
  target?: string
  briefPath?: string
  loopId?: string
  prompt?: string
  nowMs?: number
}): PaneScheduleEntry {
  const nowMs = input.nowMs ?? Date.now()
  return validatePaneSchedule({
    version: PANE_SCHEDULE_VERSION,
    scheduleId: randomUUID(),
    verb: input.verb,
    at: resolveScheduleAt(input.mode, input.when, nowMs),
    ...(input.target ? { target: input.target } : {}),
    ...(input.briefPath ? { briefPath: input.briefPath } : {}),
    ...(input.loopId ? { loopId: input.loopId } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    requestedBy: requestedBy(),
    createdAt: new Date(nowMs).toISOString(),
  })
}

function renderScheduleResult(format: "json" | "text", command: string, entry: PaneScheduleEntry, response: unknown): string {
  if (format === "text") return `${entry.scheduleId}\t${entry.verb}\t${entry.at}`
  return respond(command, { event: "pane/schedule.requested", schedule: entry, response }, [
    { command: "wake list", description: "List pending pane schedules" },
    {
      command: "wake cancel <schedule-id>",
      description: "Cancel this schedule",
      params: { "schedule-id": { value: entry.scheduleId, required: true } },
    },
  ])
}

function scheduleCommand(mode: "at" | "in") {
  return Command.make(mode, {
    when: Args.text({ name: mode === "at" ? "date" : "duration" }),
    verb: scheduleVerb,
    target: scheduleTarget,
    brief: scheduleBrief,
    loop: scheduleLoop,
    prompt: schedulePrompt,
    format: scheduleFormat,
  }, ({ when, verb, target, brief, loop, prompt, format }) => Effect.gen(function* () {
    let entry: PaneScheduleEntry
    try {
      entry = makeScheduleEntry({
        mode,
        when,
        verb,
        target: optionalCliText(target),
        briefPath: optionalCliText(brief),
        loopId: optionalCliText(loop),
        prompt: optionalCliText(prompt),
      })
    } catch (error) {
      yield* Console.log(respondError(`wake ${mode}`, error instanceof Error ? error.message : String(error), "INVALID_SCHEDULE", "Match the verb to its required flag: wake --target, spawn --brief, revive --loop."))
      return
    }

    const inngestClient = yield* Inngest
    const response = yield* inngestClient.send("pane/schedule.requested", entry)
    const redis = yield* makeRedis()
    yield* Effect.tryPromise({
      try: () => redis.hset(PANE_SCHEDULE_REGISTRY_KEY, entry.scheduleId, JSON.stringify(entry)),
      catch: (error) => new Error(`Schedule accepted but registry write failed: ${error}`),
    })
    yield* Effect.tryPromise({ try: () => redis.quit(), catch: () => {} })
    yield* Console.log(renderScheduleResult(format, `wake ${mode}`, entry, response))
  })).pipe(Command.withDescription(mode === "at" ? "Schedule a pane action at a date-time" : "Schedule a pane action after a duration"))
}

const wakeListCmd = Command.make("list", { format: scheduleFormat }, ({ format }) => Effect.gen(function* () {
  const redis = yield* makeRedis()
  const raw = yield* Effect.tryPromise({ try: () => redis.hgetall(PANE_SCHEDULE_REGISTRY_KEY), catch: (error) => new Error(String(error)) })
  yield* Effect.tryPromise({ try: () => redis.quit(), catch: () => {} })
  const schedules = Object.values(raw)
    .flatMap((value) => { try { return [validatePaneSchedule(JSON.parse(value))] } catch { return [] } })
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
  if (format === "text") {
    yield* Console.log(schedules.length === 0 ? "No pending schedules." : schedules.map((entry) => `${entry.scheduleId}\t${entry.verb}\t${entry.at}`).join("\n"))
    return
  }
  yield* Console.log(respond("wake list", { count: schedules.length, schedules }, [
    { command: "wake in <duration> --verb <verb>", description: "Create another schedule" },
  ]))
})).pipe(Command.withDescription("List pending pane schedules"))

const wakeCancelCmd = Command.make("cancel", {
  scheduleId: Args.text({ name: "schedule-id" }),
  format: scheduleFormat,
}, ({ scheduleId, format }) => Effect.gen(function* () {
  const redis = yield* makeRedis()
  const existing = yield* Effect.tryPromise({ try: () => redis.hget(PANE_SCHEDULE_REGISTRY_KEY, scheduleId), catch: (error) => new Error(String(error)) })
  if (!existing) {
    yield* Effect.tryPromise({ try: () => redis.quit(), catch: () => {} })
    yield* Console.log(respondError("wake cancel", `No pending schedule found: ${scheduleId}`, "SCHEDULE_NOT_FOUND", "Run joelclaw wake list and use a pending scheduleId."))
    return
  }
  const inngestClient = yield* Inngest
  const cancelledAt = new Date().toISOString()
  const response = yield* inngestClient.send("pane/schedule.cancelled", { scheduleId, cancelledBy: requestedBy(), cancelledAt })
  yield* Effect.tryPromise({ try: () => redis.hdel(PANE_SCHEDULE_REGISTRY_KEY, scheduleId), catch: (error) => new Error(String(error)) })
  yield* Effect.tryPromise({ try: () => redis.quit(), catch: () => {} })
  if (format === "text") {
    yield* Console.log(`${scheduleId}\tcancelled\t${cancelledAt}`)
    return
  }
  yield* Console.log(respond("wake cancel", { scheduleId, cancelledAt, response }, [
    { command: "wake list", description: "List remaining pending schedules" },
  ]))
})).pipe(Command.withDescription("Cancel a pending pane schedule"))

export const wakeCmd = Command.make("wake", {}, () =>
  Effect.gen(function* () {
    const inngestClient = yield* Inngest
    const result = yield* inngestClient.send("system/wake.requested", {})
    yield* Console.log(respond("wake", { event: "system/wake.requested", response: result }, [
      { command: "sleep status", description: "Verify sleep mode is cleared" },
      { command: "wake list", description: "List pending pane schedules" },
    ], true))
  })
).pipe(
  Command.withDescription("Wake the system now or schedule a pane action"),
  Command.withSubcommands([scheduleCommand("at"), scheduleCommand("in"), wakeListCmd, wakeCancelCmd]),
)

export const __wakeTestUtils = { parseScheduleDuration, resolveScheduleAt, makeScheduleEntry }
