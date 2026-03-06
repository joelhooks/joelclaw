import { existsSync, readFileSync } from "node:fs"
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { type NextAction, respond, respondError } from "../response"
import { gatewayBehaviorCmd } from "./gateway-behavior"

const SESSIONS_SET = "joelclaw:gateway:sessions"
const GATEWAY_HEALTH_MUTED_CHANNELS_KEY = "gateway:health:muted-channels"
const GATEWAY_HEALTH_MUTE_REASONS_KEY = "gateway:health:mute-reasons"

type OptionalText = { _tag: "Some"; value: string } | { _tag: "None" }

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

function parseOptionalText(value: OptionalText): string | undefined {
  if (value._tag !== "Some") return undefined
  const normalized = value.value.trim()
  return normalized.length > 0 ? normalized : undefined
}

function normalizeChannelId(channel: string): string | null {
  const normalized = channel.trim().toLowerCase()
  return normalized.length > 0 ? normalized : null
}

function parseStringArrayJson(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const values: string[] = []
    for (const item of parsed) {
      if (typeof item !== "string") continue
      const normalized = normalizeChannelId(item)
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      values.push(normalized)
    }
    return values
  } catch {
    return []
  }
}

function parseStringMapJson(raw: string | null): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const map: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") continue
      const normalizedKey = normalizeChannelId(key)
      const reason = value.trim()
      if (!normalizedKey || reason.length === 0) continue
      map[normalizedKey] = reason
    }
    return map
  } catch {
    return {}
  }
}

function sortChannels(channels: string[]): string[] {
  return [...channels].sort((a, b) => a.localeCompare(b))
}

function buildKnownIssuesPayload(
  mutedChannels: string[],
  muteReasons: Record<string, string>,
) {
  const sortedChannels = sortChannels(mutedChannels)
  return {
    count: sortedChannels.length,
    mutedChannels: sortedChannels,
    issues: sortedChannels.map((channel) => ({
      channel,
      reason: muteReasons[channel] ?? null,
    })),
  }
}

async function loadMutedChannelState(redis: { mget: (...keys: string[]) => Promise<(string | null)[]> }) {
  const [mutedRaw, reasonsRaw] = await redis.mget(
    GATEWAY_HEALTH_MUTED_CHANNELS_KEY,
    GATEWAY_HEALTH_MUTE_REASONS_KEY,
  )
  return {
    mutedChannels: parseStringArrayJson(mutedRaw),
    muteReasons: parseStringMapJson(reasonsRaw),
  }
}

async function persistMutedChannelState(
  redis: { set: (key: string, value: string) => Promise<unknown> },
  mutedChannels: string[],
  muteReasons: Record<string, string>,
) {
  await redis.set(GATEWAY_HEALTH_MUTED_CHANNELS_KEY, JSON.stringify(sortChannels(mutedChannels)))
  await redis.set(GATEWAY_HEALTH_MUTE_REASONS_KEY, JSON.stringify(muteReasons))
}

// ── gateway status ──────────────────────────────────────────────────

/** Check if a PID is alive (POSIX kill -0) */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const GATEWAY_WS_PORT_FILE = "/tmp/joelclaw/gateway.ws.port"

type GatewayHealthCapability = {
  key?: string
  reason?: string
}

type GatewayHealthSnapshot = {
  ok?: boolean
  available?: boolean
  healthy?: boolean
  checkedAt?: string
  mode?: "normal" | "redis_degraded"
  degradedCapabilities?: GatewayHealthCapability[]
  reason?: string
  since?: string
  reconnectAttempts?: number
  components?: Record<string, unknown>
  status?: {
    sessionId?: string
    uptimeMs?: number
    pid?: number
    queueDepth?: number
    context?: Record<string, unknown>
    sessionPressure?: Record<string, unknown>
    supersession?: Record<string, unknown>
    guardrails?: Record<string, unknown>
  }
}

function readGatewayWsPort(): number | null {
  if (!existsSync(GATEWAY_WS_PORT_FILE)) return null
  try {
    const raw = readFileSync(GATEWAY_WS_PORT_FILE, "utf-8").trim()
    const port = Number.parseInt(raw, 10)
    return Number.isFinite(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

async function readGatewayHealthSnapshot(): Promise<(GatewayHealthSnapshot & { wsPort: number }) | null> {
  const wsPort = readGatewayWsPort()
  if (!wsPort) return null

  try {
    const response = await fetch(`http://127.0.0.1:${wsPort}/health`, {
      signal: AbortSignal.timeout(2500),
    })
    const raw = await response.text()
    if (!raw.trim()) return null
    const parsed = JSON.parse(raw) as GatewayHealthSnapshot
    return { ...parsed, wsPort }
  } catch {
    return null
  }
}

async function inspectGatewayRedisStatus(): Promise<{
  connected: boolean
  activeSessions: Array<{ id: string; pending: number; alive: boolean }>
  pruned: string[]
  legacyQueuePending: number | null
  error?: string
}> {
  let redis:
    | {
        connect: () => Promise<unknown>
        ping: () => Promise<string>
        smembers: (key: string) => Promise<string[]>
        srem: (key: string, member: string) => Promise<unknown>
        del: (key: string) => Promise<unknown>
        llen: (key: string) => Promise<number>
        quit: () => Promise<unknown>
      }
    | undefined

  try {
    const Redis = (await import("ioredis")).default
    redis = new Redis({
      host: process.env.REDIS_HOST ?? "localhost",
      port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
      lazyConnect: true,
      connectTimeout: 3000,
      commandTimeout: 5000,
    })
    await redis.connect()

    const pong = await redis.ping()
    const sessions = await redis.smembers(SESSIONS_SET)

    const deadSessions: string[] = []
    const aliveSessions: string[] = []
    for (const session of sessions) {
      const pidMatch = session.match(/^pid-(\d+)$/)
      if (!pidMatch) {
        aliveSessions.push(session)
        continue
      }

      const pid = parseInt(pidMatch[1], 10)
      if (isPidAlive(pid)) {
        aliveSessions.push(session)
      } else {
        deadSessions.push(session)
      }
    }

    if (deadSessions.length > 0) {
      for (const session of deadSessions) {
        await redis.srem(SESSIONS_SET, session)
        await redis.del(`joelclaw:events:${session}`)
      }
    }

    const activeSessions: Array<{ id: string; pending: number; alive: boolean }> = []
    for (const session of aliveSessions) {
      const pending = await redis.llen(`joelclaw:events:${session}`)
      activeSessions.push({ id: session, pending, alive: true })
    }

    const legacyQueuePending = await redis.llen("joelclaw:events:main")

    return {
      connected: pong === "PONG",
      activeSessions,
      pruned: deadSessions,
      legacyQueuePending,
    }
  } catch (error) {
    return {
      connected: false,
      activeSessions: [],
      pruned: [],
      legacyQueuePending: null,
      error: String(error),
    }
  } finally {
    try {
      await redis?.quit()
    } catch {
      // swallow
    }
  }
}

const gatewayStatus = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const daemonHealth = yield* Effect.promise(() => readGatewayHealthSnapshot())
    const redisStatus = yield* Effect.promise(() => inspectGatewayRedisStatus())

    const mode = daemonHealth?.mode ?? (redisStatus.connected ? "normal" : "redis_degraded")
    const degradedCapabilities = (daemonHealth?.degradedCapabilities ?? [])
      .filter((cap): cap is { key: string; reason?: string } => typeof cap?.key === "string")
      .map((cap) => ({ key: cap.key, reason: cap.reason ?? null }))

    const daemonSessionId = typeof daemonHealth?.status?.sessionId === "string"
      ? daemonHealth.status.sessionId
      : "gateway"
    const daemonQueueDepth = typeof daemonHealth?.status?.queueDepth === "number"
      ? daemonHealth.status.queueDepth
      : 0
    const sessionPressureHealth = typeof daemonHealth?.status?.sessionPressure?.health === "string"
      ? daemonHealth.status.sessionPressure.health
      : undefined

    const activeSessions = redisStatus.activeSessions.length > 0
      ? redisStatus.activeSessions
      : daemonHealth
        ? [{ id: daemonSessionId, pending: daemonQueueDepth, alive: daemonHealth.available !== false }]
        : []

    const totalPending = activeSessions.reduce((sum, session) => sum + (session.pending ?? 0), 0)
    const available = daemonHealth?.available ?? (redisStatus.connected || activeSessions.length > 0)
    const healthy = daemonHealth?.healthy ?? redisStatus.connected

    const nextActions: NextAction[] = [
      { command: "joelclaw gateway events", description: "Peek at pending events" },
      {
        command: "joelclaw gateway push --type <type>",
        description: "Push an event to all sessions",
        params: {
          type: { description: "Event type", default: "test", enum: ["test", "cron.heartbeat", "test.gateway-e2e"] },
        },
      },
      { command: "joelclaw gateway drain", description: "Clear all event queues" },
    ]

    if (mode === "redis_degraded") {
      nextActions.unshift(
        { command: "joelclaw gateway diagnose", description: "See which capabilities are degraded and why" },
        { command: "joelclaw gateway review", description: "Inspect recent gateway session behavior while Redis is degraded" },
      )
    }

    if (sessionPressureHealth && sessionPressureHealth !== "ok") {
      nextActions.unshift(
        { command: "joelclaw gateway diagnose", description: "Inspect session-pressure diagnostics and alert state" },
        { command: "joelclaw gateway review", description: "Review recent gateway turns if pressure stays elevated" },
      )
    }

    yield* Console.log(respond(
      "gateway status",
      {
        available,
        healthy,
        mode,
        redis: redisStatus.connected ? "connected" : "degraded",
        degradedCapabilities,
        reason: daemonHealth?.reason ?? (redisStatus.connected ? "redis_connected" : "redis_unreachable"),
        since: daemonHealth?.since ?? null,
        reconnectAttempts: daemonHealth?.reconnectAttempts ?? null,
        activeSessions,
        totalPending,
        ...(redisStatus.pruned.length > 0 ? { pruned: redisStatus.pruned } : {}),
        legacyQueuePending: redisStatus.legacyQueuePending,
        daemon: {
          reachable: Boolean(daemonHealth),
          wsPort: daemonHealth?.wsPort ?? readGatewayWsPort(),
          checkedAt: daemonHealth?.checkedAt ?? null,
          pid: daemonHealth?.status?.pid ?? null,
          sessionId: daemonHealth?.status?.sessionId ?? null,
          uptimeMs: daemonHealth?.status?.uptimeMs ?? null,
        },
        ...(daemonHealth?.components ? { components: daemonHealth.components } : {}),
        ...(daemonHealth?.status?.context ? { context: daemonHealth.status.context } : {}),
        ...(daemonHealth?.status?.sessionPressure ? { sessionPressure: daemonHealth.status.sessionPressure } : {}),
        ...(daemonHealth?.status?.supersession ? { supersession: daemonHealth.status.supersession } : {}),
        ...(daemonHealth?.status?.guardrails ? { guardrails: daemonHealth.status.guardrails } : {}),
        ...(redisStatus.error ? { redisError: redisStatus.error } : {}),
      },
      nextActions,
      available,
    ))
  })
).pipe(Command.withDescription("Daemon availability, runtime mode, session pressure, and Redis health"))

// ── gateway events ──────────────────────────────────────────────────

const gatewayEvents = Command.make("events", {}, () =>
  Effect.gen(function* () {
    const redis = yield* makeRedis()
    const sessions = yield* Effect.tryPromise({
      try: () => redis.smembers(SESSIONS_SET),
      catch: (e) => new Error(`${e}`),
    })

    const allEvents = yield* Effect.tryPromise({
      try: async () => {
        const result: Array<{ session: string; events: any[] }> = []
        for (const s of sessions) {
          const raw = await redis.lrange(`joelclaw:events:${s}`, 0, -1)
          const events = raw.reverse().map((r: string) => {
            try { return JSON.parse(r) } catch { return { raw: r } }
          })
          if (events.length > 0) result.push({ session: s, events })
        }
        const legacyRaw = await redis.lrange("joelclaw:events:main", 0, -1)
        if (legacyRaw.length > 0) {
          const events = legacyRaw.reverse().map((r: string) => {
            try { return JSON.parse(r) } catch { return { raw: r } }
          })
          result.push({ session: "main (legacy)", events })
        }
        return result
      },
      catch: (e) => new Error(`${e}`),
    })
    yield* Effect.tryPromise({ try: () => redis.quit(), catch: () => {} })

    const totalCount = allEvents.reduce((sum, s) => sum + s.events.length, 0)

    yield* Console.log(respond(
      "gateway events",
      {
        totalCount,
        sessions: allEvents.map(s => ({
          session: s.session,
          count: s.events.length,
          events: s.events.map((e: any) => ({
            id: e.id, type: e.type, source: e.source,
            ts: e.ts ? new Date(e.ts).toISOString() : undefined,
            payload: e.payload,
          })),
        })),
      },
      [
        { command: "joelclaw gateway drain", description: "Clear all events" },
        {
          command: "joelclaw gateway push --type <type>",
          description: "Push a test event",
          params: {
            type: { description: "Event type", value: "test", enum: ["test", "cron.heartbeat", "test.gateway-e2e"] },
          },
        },
      ],
      true
    ))
  })
).pipe(Command.withDescription("Peek at all pending events per session"))

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
      yield* Console.log(respondError(
        "gateway push",
        "Invalid JSON payload",
        "INVALID_JSON",
        "Check your --payload value is valid JSON",
        [{ command: "joelclaw gateway push --type <type> --payload <payload>", description: "Retry with valid JSON payload" }],
      ))
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

    const json = JSON.stringify(event)
    const notification = JSON.stringify({ eventId: event.id, type: event.type })

    // Fan out to all active sessions (same logic as pushGatewayEvent)
    const sessions = yield* Effect.tryPromise({
      try: () => redis.smembers(SESSIONS_SET),
      catch: (e) => new Error(`${e}`),
    })

    yield* Effect.tryPromise({
      try: async () => {
        if (sessions.length === 0) {
          await redis.lpush("joelclaw:events:main", json)
          await redis.publish("joelclaw:notify:main", notification)
        } else {
          for (const s of sessions) {
            await redis.lpush(`joelclaw:events:${s}`, json)
            await redis.publish(`joelclaw:notify:${s}`, notification)
          }
        }
      },
      catch: (e) => new Error(`${e}`),
    })

    yield* Effect.tryPromise({ try: () => redis.quit(), catch: () => {} })

    yield* Console.log(respond(
      "gateway push",
      {
        pushed: event,
        deliveredTo: sessions.length > 0 ? sessions : ["main (legacy)"],
      },
      [
        { command: "joelclaw gateway events", description: "See all pending events" },
        { command: "joelclaw gateway status", description: "Check gateway status" },
      ],
      true
    ))
  })
).pipe(Command.withDescription("Push event to all gateway sessions"))

// ── gateway drain ───────────────────────────────────────────────────

const gatewayDrain = Command.make("drain", {}, () =>
  Effect.gen(function* () {
    const redis = yield* makeRedis()
    const sessions = yield* Effect.tryPromise({
      try: () => redis.smembers(SESSIONS_SET),
      catch: (e) => new Error(`${e}`),
    })
    const { total, legacyDrained } = yield* Effect.tryPromise({
      try: async () => {
        let t = 0
        for (const s of sessions) {
          const len = await redis.llen(`joelclaw:events:${s}`)
          if (len > 0) { await redis.del(`joelclaw:events:${s}`); t += len }
        }
        const lLen = await redis.llen("joelclaw:events:main")
        if (lLen > 0) { await redis.del("joelclaw:events:main"); t += lLen }
        return { total: t, legacyDrained: lLen }
      },
      catch: (e) => new Error(`${e}`),
    })
    yield* Effect.tryPromise({ try: () => redis.quit(), catch: () => {} })

    yield* Console.log(respond(
      "gateway drain",
      { drained: total, sessions: sessions.length, legacyDrained },
      [
        { command: "joelclaw gateway status", description: "Verify queues are empty" },
      ],
      true
    ))
  })
).pipe(Command.withDescription("Clear all event queues"))

// ── gateway test ────────────────────────────────────────────────────

const gatewayTest = Command.make("test", {}, () =>
  Effect.gen(function* () {
    const redis = yield* makeRedis()
    const sessions = yield* Effect.tryPromise({
      try: () => redis.smembers(SESSIONS_SET),
      catch: (e) => new Error(`${e}`),
    })

    const event = {
      id: crypto.randomUUID(),
      type: "test.gateway-e2e",
      source: "cli",
      payload: { test: true, ts: new Date().toISOString() },
      ts: Date.now(),
    }

    const json = JSON.stringify(event)
    const notification = JSON.stringify({ eventId: event.id, type: event.type })

    yield* Effect.tryPromise({
      try: async () => {
        if (sessions.length === 0) {
          await redis.lpush("joelclaw:events:main", json)
          await redis.publish("joelclaw:notify:main", notification)
        } else {
          for (const s of sessions) {
            await redis.lpush(`joelclaw:events:${s}`, json)
            await redis.publish(`joelclaw:notify:${s}`, notification)
          }
        }
      },
      catch: (e) => new Error(`${e}`),
    })

    yield* Effect.tryPromise({ try: () => redis.quit(), catch: () => {} })

    yield* Console.log(respond(
      "gateway test",
      {
        pushed: event,
        deliveredTo: sessions.length > 0 ? sessions : ["main (legacy)"],
        note: "If the pi gateway extension is running, it should drain this event and inject it into the session.",
      },
      [
        { command: "joelclaw gateway events", description: "Check if event was drained" },
        { command: "joelclaw gateway status", description: "Full gateway status" },
      ],
      true
    ))
  })
).pipe(Command.withDescription("Push test event and verify delivery"))

// ── gateway known-issues / mute / unmute ───────────────────────────

const muteReason = Options.text("reason").pipe(
  Options.withDescription("Optional reason for muting this channel"),
  Options.optional,
)

const gatewayKnownIssues = Command.make("known-issues", {}, () =>
  Effect.gen(function* () {
    const redis = yield* makeRedis()
    const { mutedChannels, muteReasons } = yield* Effect.tryPromise({
      try: () => loadMutedChannelState(redis),
      catch: (e) => new Error(`${e}`),
    })
    yield* Effect.tryPromise({ try: () => redis.quit(), catch: () => {} })

    yield* Console.log(respond(
      "gateway known-issues",
      {
        ...buildKnownIssuesPayload(mutedChannels, muteReasons),
        keys: {
          mutedChannels: GATEWAY_HEALTH_MUTED_CHANNELS_KEY,
          muteReasons: GATEWAY_HEALTH_MUTE_REASONS_KEY,
        },
      },
      [
        {
          command: "joelclaw gateway mute <channel> [--reason <reason>]",
          description: "Mute a noisy/degraded channel",
          params: {
            channel: { description: "Channel ID (e.g. imessage)", required: true },
            reason: { description: "Optional known-issue context" },
          },
        },
        {
          command: "joelclaw gateway unmute <channel>",
          description: "Remove a channel from known issues",
          params: {
            channel: { description: "Channel ID (e.g. imessage)", required: true },
          },
        },
      ],
      true,
    ))
  })
).pipe(Command.withDescription("List muted channel health alerts (known issues)"))

const gatewayMute = Command.make(
  "mute",
  {
    channel: Args.text({ name: "channel" }).pipe(
      Args.withDescription("Channel ID to mute (e.g. imessage)"),
    ),
    reason: muteReason,
  },
  ({ channel, reason }) =>
    Effect.gen(function* () {
      const normalizedChannel = normalizeChannelId(channel)
      if (!normalizedChannel) {
        yield* Console.log(respondError(
          "gateway mute",
          "Channel must be a non-empty string",
          "INVALID_CHANNEL",
          "Provide a channel ID like `imessage` or `telegram`.",
          [
            {
              command: "joelclaw gateway mute <channel> [--reason <reason>]",
              description: "Retry with a valid channel ID",
              params: {
                channel: { description: "Channel ID", required: true },
                reason: { description: "Optional reason" },
              },
            },
            { command: "joelclaw gateway known-issues", description: "Inspect current muted channels" },
          ],
        ))
        return
      }

      const redis = yield* makeRedis()
      const { mutedChannels, muteReasons } = yield* Effect.tryPromise({
        try: () => loadMutedChannelState(redis),
        catch: (e) => new Error(`${e}`),
      })

      const reasonText = parseOptionalText(reason)
      const nextMutedChannels = sortChannels([...new Set([...mutedChannels, normalizedChannel])])
      const nextMuteReasons = { ...muteReasons }
      if (reasonText) {
        nextMuteReasons[normalizedChannel] = reasonText
      }

      yield* Effect.tryPromise({
        try: () => persistMutedChannelState(redis, nextMutedChannels, nextMuteReasons),
        catch: (e) => new Error(`${e}`),
      })
      yield* Effect.tryPromise({ try: () => redis.quit(), catch: () => {} })

      yield* Console.log(respond(
        "gateway mute",
        {
          channel: normalizedChannel,
          muted: true,
          reason: nextMuteReasons[normalizedChannel] ?? null,
          ...buildKnownIssuesPayload(nextMutedChannels, nextMuteReasons),
        },
        [
          { command: "joelclaw gateway known-issues", description: "List all muted channels with reasons" },
          {
            command: "joelclaw gateway unmute <channel>",
            description: "Unmute this channel when issue is resolved",
            params: { channel: { value: normalizedChannel, required: true } },
          },
        ],
        true,
      ))
    }),
).pipe(Command.withDescription("Mute a channel from triggering gateway health alerts"))

const gatewayUnmute = Command.make(
  "unmute",
  {
    channel: Args.text({ name: "channel" }).pipe(
      Args.withDescription("Channel ID to unmute"),
    ),
  },
  ({ channel }) =>
    Effect.gen(function* () {
      const normalizedChannel = normalizeChannelId(channel)
      if (!normalizedChannel) {
        yield* Console.log(respondError(
          "gateway unmute",
          "Channel must be a non-empty string",
          "INVALID_CHANNEL",
          "Provide a channel ID like `imessage` or `telegram`.",
          [
            {
              command: "joelclaw gateway unmute <channel>",
              description: "Retry with a valid channel ID",
              params: { channel: { description: "Channel ID", required: true } },
            },
            { command: "joelclaw gateway known-issues", description: "Inspect current muted channels" },
          ],
        ))
        return
      }

      const redis = yield* makeRedis()
      const { mutedChannels, muteReasons } = yield* Effect.tryPromise({
        try: () => loadMutedChannelState(redis),
        catch: (e) => new Error(`${e}`),
      })

      const wasMuted = mutedChannels.includes(normalizedChannel)
      const nextMutedChannels = mutedChannels.filter((value) => value !== normalizedChannel)
      const nextMuteReasons = { ...muteReasons }
      delete nextMuteReasons[normalizedChannel]

      yield* Effect.tryPromise({
        try: () => persistMutedChannelState(redis, nextMutedChannels, nextMuteReasons),
        catch: (e) => new Error(`${e}`),
      })
      yield* Effect.tryPromise({ try: () => redis.quit(), catch: () => {} })

      yield* Console.log(respond(
        "gateway unmute",
        {
          channel: normalizedChannel,
          unmuted: wasMuted,
          ...buildKnownIssuesPayload(nextMutedChannels, nextMuteReasons),
        },
        [
          { command: "joelclaw gateway known-issues", description: "List muted channels" },
          {
            command: "joelclaw gateway mute <channel> [--reason <reason>]",
            description: "Mute a channel again if needed",
            params: {
              channel: { value: normalizedChannel, required: true },
              reason: { description: "Optional reason" },
            },
          },
        ],
        true,
      ))
    }),
).pipe(Command.withDescription("Remove a channel from muted health alerts"))

// ── gateway restart ─────────────────────────────────────────────────

import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"

const gatewayRestart = Command.make("restart", {}, () =>
  Effect.gen(function* () {
    const LAUNCHD_LABEL = "com.joel.gateway"
    const DAEMON_MATCH = "/Users/joel/Code/joelhooks/joelclaw/packages/gateway/src/daemon.ts"
    const LAUNCHD_UID = process.getuid?.() ?? 0
    const LAUNCHD_DOMAIN = `gui/${LAUNCHD_UID}`
    const LAUNCHD_SERVICE = `${LAUNCHD_DOMAIN}/${LAUNCHD_LABEL}`
    const PID_FILE = "/tmp/joelclaw/gateway.pid"
    const LOG_FILE = "/tmp/joelclaw/gateway.log"
    const MAX_RESTART_WAIT_SECONDS = 30

    const readGatewayPidFile = (): string | null => {
      try {
        if (!existsSync(PID_FILE)) return null
        const pid = readFileSync(PID_FILE, "utf-8").trim()
        return /^\d+$/.test(pid) ? pid : null
      } catch {
        return null
      }
    }

    const isPidAlive = (pid: string): boolean => {
      try {
        execSync(`kill -0 ${pid} 2>/dev/null`, { stdio: "pipe" })
        return true
      } catch {
        return false
      }
    }

    const findDaemonPid = (): string | null => {
      try {
        const pid = execSync(`pgrep -f '${DAEMON_MATCH}' | head -n 1`, {
          encoding: "utf-8",
          timeout: 2_000,
          stdio: "pipe",
        }).trim()
        return /^\d+$/.test(pid) ? pid : null
      } catch {
        return null
      }
    }

    const oldPid = readGatewayPidFile() ?? findDaemonPid()

    // Clean stale Redis state (in case shutdown doesn't complete cleanly)
    const redis = yield* makeRedis()
    yield* Effect.tryPromise({
      try: async () => {
        await redis.srem("joelclaw:gateway:sessions", "gateway")
        await redis.del("joelclaw:events:gateway")
      },
      catch: () => {},
    })
    yield* Effect.tryPromise({ try: () => redis.quit(), catch: () => {} })

    // Stop via launchctl (SIGTERM → graceful shutdown)
    try {
      execSync(`launchctl bootout ${LAUNCHD_DOMAIN} system/${LAUNCHD_LABEL} 2>/dev/null || launchctl stop ${LAUNCHD_LABEL}`, {
        timeout: 10_000,
        stdio: "pipe",
      })
    } catch {}

    // Wait for old process to exit
    let waited = 0
    while (waited < 5000 && oldPid) {
      if (!isPidAlive(oldPid)) {
        break
      }
      yield* Effect.promise(() => new Promise(r => setTimeout(r, 500)))
      waited += 500
    }

    // Re-enable + bootstrap + kickstart (KeepAlive ensures it comes back)
    try {
      execSync(`launchctl enable ${LAUNCHD_SERVICE}`, {
        timeout: 5_000,
        stdio: "pipe",
      })
    } catch {}

    try {
      execSync(`launchctl bootstrap ${LAUNCHD_DOMAIN} ~/Library/LaunchAgents/com.joel.gateway.plist 2>/dev/null || true`, {
        timeout: 5_000,
        stdio: "pipe",
      })
    } catch {}

    try {
      execSync(`launchctl kickstart -k ${LAUNCHD_SERVICE}`, {
        timeout: 5_000,
        stdio: "pipe",
      })
    } catch {}

    // Wait for new PID (PID file can lag startup; fall back to pgrep)
    let newPid: string | null = null
    let attempts = 0
    while (attempts < MAX_RESTART_WAIT_SECONDS) {
      yield* Effect.promise(() => new Promise(r => setTimeout(r, 1000)))
      attempts++
      const pidCandidate = readGatewayPidFile() ?? findDaemonPid()
      if (!pidCandidate) continue
      if (oldPid && pidCandidate === oldPid && isPidAlive(pidCandidate)) continue
      if (!isPidAlive(pidCandidate)) continue
      newPid = pidCandidate
      break
    }

    let logTail = ""
    try {
      logTail = execSync(`tail -5 ${LOG_FILE}`, { encoding: "utf-8", timeout: 3000 }).trim()
    } catch {}

    const ok = !!newPid && newPid !== oldPid

    yield* Console.log(respond(
      "gateway restart",
      {
        previousPid: oldPid,
        newPid: newPid ?? "unknown",
        restarted: ok,
        waitedMs: attempts * 1000,
        log: logTail.split("\n").slice(-3),
      },
      [
        { command: "joelclaw gateway status", description: "Verify sessions registered" },
        { command: "joelclaw gateway test", description: "Push test event to verify" },
      ],
      ok
    ))
  })
).pipe(Command.withDescription("Restart daemon (kill, clean Redis, respawn)"))

const gatewayEnable = Command.make("enable", {}, () =>
  Effect.gen(function* () {
    const LAUNCHD_LABEL = "com.joel.gateway"
    const LAUNCHD_UID = process.getuid?.() ?? 0
    const LAUNCHD_DOMAIN = `gui/${LAUNCHD_UID}`
    const LAUNCHD_SERVICE = `${LAUNCHD_DOMAIN}/${LAUNCHD_LABEL}`
    const PLIST_PATH = `${process.env.HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`

    const runLaunchctl = (command: string, timeout = 5000): { ok: boolean; error?: string } => {
      try {
        execSync(command, { timeout, stdio: "pipe" })
        return { ok: true }
      } catch (error) {
        return { ok: false, error: `${error}` }
      }
    }

    const enableResult = runLaunchctl(`launchctl enable ${LAUNCHD_SERVICE}`)

    const bootstrapResult = runLaunchctl(`launchctl bootstrap ${LAUNCHD_DOMAIN} ${PLIST_PATH}`)
    const bootstrapAlreadyLoaded =
      !bootstrapResult.ok
      && /already loaded|in progress|service is disabled/iu.test(bootstrapResult.error ?? "")

    const kickstartResult = runLaunchctl(`launchctl kickstart -k ${LAUNCHD_SERVICE}`)

    let pid: string | null = null
    let attempts = 0
    while (attempts < 20) {
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 500)))
      attempts++
      const launchd = inspectGatewayLaunchd()
      const pidCandidate = launchd.pid ?? findGatewayDaemonPid()
      if (!pidCandidate) continue
      const parsedPid = Number.parseInt(pidCandidate, 10)
      if (!Number.isInteger(parsedPid) || !isPidAlive(parsedPid)) continue
      pid = pidCandidate
      break
    }

    const launchdAfter = inspectGatewayLaunchd()

    const warnings: string[] = []
    if (!enableResult.ok) warnings.push(`launchctl enable failed: ${enableResult.error}`)
    if (!bootstrapResult.ok && !bootstrapAlreadyLoaded) {
      warnings.push(`launchctl bootstrap failed: ${bootstrapResult.error}`)
    }
    if (!kickstartResult.ok) warnings.push(`launchctl kickstart failed: ${kickstartResult.error}`)
    if (launchdAfter.disabled === true) warnings.push("launchd service still disabled after enable")

    const ok = launchdAfter.disabled !== true && !!pid

    yield* Console.log(respond(
      "gateway enable",
      {
        service: LAUNCHD_SERVICE,
        enabled: launchdAfter.disabled === false,
        registered: launchdAfter.registered,
        state: launchdAfter.state,
        pid,
        actions: {
          enable: enableResult.ok,
          bootstrap: bootstrapResult.ok || bootstrapAlreadyLoaded,
          kickstart: kickstartResult.ok,
        },
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      [
        { command: "joelclaw gateway status", description: "Verify gateway session registration" },
        { command: "joelclaw gateway test", description: "Verify e2e event delivery" },
        { command: "joelclaw gateway diagnose", description: "Run full diagnostic if still unhealthy" },
      ],
      ok,
    ))
  }),
).pipe(Command.withDescription("Enable com.joel.gateway launch agent and start daemon"))

// ── gateway stream (ADR-0058) ───────────────────────────────────────

import {
  emit,
  emitError,
  emitEvent,
  emitLog,
  emitResult,
  emitStart,
} from "../stream"

function safeDisconnect(client: { disconnect: () => void } | undefined): void {
  if (!client) return
  try {
    client.disconnect()
  } catch {
    // best effort
  }
}

const gatewayStream = Command.make(
  "stream",
  {
    timeout: Options.integer("timeout").pipe(
      Options.withDefault(0),
      Options.withDescription("Stop after N seconds (0 = indefinite)"),
    ),
    channel: Options.text("channel").pipe(
      Options.withDefault("gateway"),
      Options.withDescription("Session channel to subscribe to (default: gateway)"),
    ),
  },
  ({ timeout, channel }) =>
    Effect.gen(function* () {
      const cmd = `joelclaw gateway stream`
      const channelName = `joelclaw:notify:${channel}`

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

      try {
        yield* Effect.tryPromise({
          try: () => sub.connect(),
          catch: (e) => new Error(`Redis: ${e}`),
        })
      } catch {
        emitError(cmd, "Redis connection failed", "REDIS_CONNECT_FAILED",
          "Check Redis: kubectl get pods -n joelclaw | grep redis", [
            { command: "joelclaw gateway status", description: "Check gateway health" },
          ])
        return
      }

      emitStart(cmd)
      emitLog("info", `Subscribed to ${channelName} — streaming events (ctrl-c to stop)`)

      let ended = false
      let eventCount = 0
      const startTime = Date.now()

      const onSignal = () => {
        ended = true
        safeDisconnect(sub)
        emitResult(cmd, {
          reason: "interrupted",
          events_received: eventCount,
          duration_ms: Date.now() - startTime,
        }, [
          { command: "joelclaw gateway status", description: "Check gateway health" },
          { command: "joelclaw gateway events", description: "Peek at pending events" },
        ])
        process.exit(0)
      }
      process.on("SIGINT", onSignal)
      process.on("SIGTERM", onSignal)

      // Also subscribe to the event list channel for LPUSH notifications
      sub.on("message", (_ch: string, message: string) => {
        if (ended) return
        eventCount++
        try {
          const parsed = JSON.parse(message)
          emitEvent(parsed.type ?? parsed.eventId ?? "unknown", parsed)
        } catch {
          emitLog("warn", `Unparseable: ${message.slice(0, 200)}`)
        }
      })

      yield* Effect.tryPromise({
        try: () => sub.subscribe(channelName),
        catch: (e) => new Error(`Subscribe: ${e}`),
      })

      // Wait until timeout or signal
      if (timeout > 0) {
        yield* Effect.tryPromise({
          try: () => new Promise((resolve) => setTimeout(resolve, timeout * 1000)),
          catch: () => new Error("sleep"),
        })
        emitLog("info", `Timeout reached (${timeout}s)`)
      } else {
        // Block indefinitely — signals handle exit
        while (!ended) {
          yield* Effect.tryPromise({
            try: () => new Promise((resolve) => setTimeout(resolve, 60_000)),
            catch: () => new Error("sleep"),
          })
        }
      }

      ended = true
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
      safeDisconnect(sub)

      emitResult(cmd, {
        reason: timeout > 0 ? "timeout" : "ended",
        events_received: eventCount,
        duration_ms: Date.now() - startTime,
      }, [
        { command: "joelclaw gateway status", description: "Check gateway health" },
        { command: `joelclaw gateway stream`, description: "Resume streaming" },
      ])
    }),
).pipe(Command.withDescription("NDJSON stream of gateway events (ADR-0058)"))

// ── gateway diagnose ────────────────────────────────────────────────

const diagnoseHours = Options.integer("hours").pipe(
  Options.withDefault(1),
  Options.withDescription("How far back to scan logs (hours, default: 1)"),
)

const diagnoseLines = Options.integer("lines").pipe(
  Options.withDefault(100),
  Options.withDescription("Max log lines to scan per source (default: 100)"),
)

const LOG_FILE = "/tmp/joelclaw/gateway.log"
const ERR_FILE = "/tmp/joelclaw/gateway.err"
const PID_FILE = "/tmp/joelclaw/gateway.pid"
const SESSION_DIR = `${process.env.HOME}/.joelclaw/sessions/gateway`
const GATEWAY_LAUNCHD_LABEL = "com.joel.gateway"
const GATEWAY_DAEMON_MATCH = "/Users/joel/Code/joelhooks/joelclaw/packages/gateway/src/daemon.ts"

type GatewayLaunchdSnapshot = {
  disabled: boolean | null
  registered: boolean
  pid: string | null
  state: string | null
  lastExitCode: string | null
}

type DiagLayer = {
  layer: string
  status: "ok" | "degraded" | "failed" | "skipped"
  detail: string
  findings?: string[]
}

const KNOWN_ERR_PATTERNS: Array<{ pattern: RegExp; label: string; severity: "error" | "warn" }> = [
  { pattern: /Agent is already processing/i, label: "session-busy", severity: "error" },
  { pattern: /fallback activated/i, label: "model-fallback", severity: "error" },
  { pattern: /no streaming tokens after/i, label: "model-timeout", severity: "error" },
  { pattern: /session still streaming, retrying/i, label: "streaming-retry", severity: "warn" },
  { pattern: /session appears stuck/i, label: "watchdog-stuck", severity: "error" },
  { pattern: /stuck recovery timed out/i, label: "watchdog-stuck-timeout", severity: "error" },
  { pattern: /session appears dead/i, label: "watchdog-dead", severity: "error" },
  { pattern: /prompt failed.*consecutiveFailures/i, label: "prompt-failure", severity: "error" },
  { pattern: /OTEL emit request failed/i, label: "otel-timeout", severity: "warn" },
  { pattern: /Redis connection failed|ECONNREFUSED/i, label: "redis-down", severity: "error" },
  { pattern: /gracefulShutdown/i, label: "self-restart", severity: "warn" },
]

function tailFile(path: string, maxLines: number): string[] {
  try {
    const out = execSync(`tail -${maxLines} "${path}" 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 3000,
    })
    return out.split("\n").filter(Boolean)
  } catch {
    return []
  }
}

function scanForPatterns(lines: string[]): Array<{ label: string; severity: string; count: number; lastLine: string }> {
  const hits = new Map<string, { severity: string; count: number; lastLine: string }>()
  for (const line of lines) {
    for (const { pattern, label, severity } of KNOWN_ERR_PATTERNS) {
      if (pattern.test(line)) {
        const existing = hits.get(label)
        if (existing) {
          existing.count++
          existing.lastLine = line.slice(0, 200)
        } else {
          hits.set(label, { severity, count: 1, lastLine: line.slice(0, 200) })
        }
      }
    }
  }
  return Array.from(hits.entries()).map(([label, info]) => ({
    label,
    severity: info.severity,
    count: info.count,
    lastLine: info.lastLine,
  }))
}

function parseLaunchctlField(raw: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = raw.match(new RegExp(`^\\s*${escaped}\\s*=\\s*(.+)$`, "mi"))
  return match?.[1]?.trim() ?? null
}

function parseLaunchctlDisabled(raw: string, label: string): boolean | null {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = raw.match(new RegExp(`"${escapedLabel}"\\s*=>\\s*(disabled|enabled)`, "i"))
  if (!match) return null
  return match[1]?.toLowerCase() === "disabled"
}

function inspectGatewayLaunchd(): GatewayLaunchdSnapshot {
  const uid = process.getuid?.() ?? 0
  const domain = `gui/${uid}`
  const service = `${domain}/${GATEWAY_LAUNCHD_LABEL}`

  let disabled: boolean | null = null
  try {
    const output = execSync(`launchctl print-disabled ${domain} 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 3000,
    })
    disabled = parseLaunchctlDisabled(output, GATEWAY_LAUNCHD_LABEL)
  } catch {
    // ignore
  }

  try {
    const output = execSync(`launchctl print ${service} 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 3000,
    })
    const pidRaw = parseLaunchctlField(output, "pid")

    return {
      disabled,
      registered: true,
      pid: pidRaw && /^\d+$/.test(pidRaw) ? pidRaw : null,
      state: parseLaunchctlField(output, "state"),
      lastExitCode: parseLaunchctlField(output, "last exit code"),
    }
  } catch {
    return {
      disabled,
      registered: false,
      pid: null,
      state: null,
      lastExitCode: null,
    }
  }
}

function findGatewayDaemonPid(): string | null {
  try {
    const pid = execSync(`pgrep -f '${GATEWAY_DAEMON_MATCH}' | head -n 1`, {
      encoding: "utf-8",
      timeout: 2000,
      stdio: "pipe",
    }).trim()
    return /^\d+$/.test(pid) ? pid : null
  } catch {
    return null
  }
}

const gatewayDiagnose = Command.make("diagnose", { hours: diagnoseHours, lines: diagnoseLines }, ({ hours, lines: maxLines }) =>
  Effect.gen(function* () {
    const layers: DiagLayer[] = []
    const ts = new Date().toISOString()

    // ── Layer 0: Process Health ──
    const launchd = inspectGatewayLaunchd()

    let pidFileValue: string | null = null
    try {
      pidFileValue = readFileSync(PID_FILE, "utf-8").trim()
    } catch { /* missing */ }

    const daemonPid = launchd.pid ?? findGatewayDaemonPid() ?? pidFileValue
    const daemonPidLabel = daemonPid ?? "unknown"
    const processAlive = daemonPid ? isPidAlive(parseInt(daemonPid, 10)) : false
    const pidFileMatches = daemonPid !== null && pidFileValue !== null && daemonPid === pidFileValue
    const launchdState = launchd.state ?? (launchd.registered ? "unknown" : "not registered")
    const disabledState =
      launchd.disabled === null
        ? "unknown"
        : launchd.disabled
          ? "disabled"
          : "enabled"

    if (launchd.disabled === true && processAlive) {
      layers.push({
        layer: "process",
        status: "degraded",
        detail: `PID ${daemonPidLabel} alive but launchd service ${GATEWAY_LAUNCHD_LABEL} is disabled`,
      })
    } else if (launchd.disabled === true) {
      layers.push({
        layer: "process",
        status: "failed",
        detail: `Launchd service ${GATEWAY_LAUNCHD_LABEL} is disabled`,
      })
    } else if (processAlive && launchd.registered) {
      if (pidFileValue && !pidFileMatches) {
        layers.push({
          layer: "process",
          status: "degraded",
          detail: `PID ${daemonPidLabel} alive, launchd state ${launchdState}, PID file stale (file: ${pidFileValue})`,
        })
      } else {
        layers.push({
          layer: "process",
          status: "ok",
          detail: `PID ${daemonPidLabel} alive, launchd state ${launchdState}, PID file ${pidFileValue ? "matches" : "missing"}`,
        })
      }
    } else if (processAlive) {
      layers.push({
        layer: "process",
        status: "degraded",
        detail: `PID ${daemonPidLabel} alive but launchd service is not registered`,
      })
    } else {
      const lastExitDetail = launchd.lastExitCode ? `, lastExit: ${launchd.lastExitCode}` : ""
      layers.push({
        layer: "process",
        status: "failed",
        detail: `Daemon not running (launchd: ${launchdState}, disabled: ${disabledState}${lastExitDetail}, pidFile: ${pidFileValue})`,
      })
    }

    // ── Layer 1: CLI Status ──
    let redisOk = false
    let gatewayMode: "normal" | "redis_degraded" = "normal"
    let sessionCount = 0
    let totalPending = 0
    let degradedCapabilityCount = 0
    let sessionPressureHealth: string | undefined
    let sessionPressureUsagePercent: number | undefined
    let sessionPressureNextAction: string | undefined
    let sessionPressureNextThresholdSummary: string | undefined
    let sessionPressureLastCompactionAgeMs: number | undefined
    let sessionPressureSessionAgeMs: number | undefined
    let sessionPressureActiveThreads: number | undefined
    let sessionPressureWarmThreads: number | undefined
    let sessionPressureTotalThreads: number | undefined
    let sessionPressureFallbackActive: boolean | undefined
    let sessionPressureFallbackActivationCount: number | undefined
    let sessionPressureConsecutiveFailures: number | undefined
    let sessionPressureReasons: string[] = []
    let sessionPressureLastNotifiedHealth: string | undefined
    let sessionPressureLastNotifiedAt: string | undefined
    let supersessionActive = false
    let supersessionActiveSource: string | undefined
    let supersessionLastSource: string | undefined
    let supersessionLastAt: string | undefined
    let supersessionLastDroppedQueued: number | undefined
    let supersessionLastAbortRequested: boolean | undefined
    let checkpointSentThisTurn = false
    let pendingDeployVerificationCount = 0
    try {
      const raw = execSync("joelclaw gateway status 2>/dev/null", { encoding: "utf-8", timeout: 10000 })
      const parsed = JSON.parse(raw)
      const pressure = parsed.result?.sessionPressure ?? {}
      const supersession = parsed.result?.supersession ?? {}
      redisOk = parsed.result?.redis === "connected"
      gatewayMode = parsed.result?.mode === "redis_degraded" ? "redis_degraded" : "normal"
      const sessions = parsed.result?.activeSessions ?? []
      sessionCount = sessions.length
      totalPending = sessions.reduce((s: number, sess: any) => s + (sess.pending ?? 0), 0)
      degradedCapabilityCount = Array.isArray(parsed.result?.degradedCapabilities)
        ? parsed.result.degradedCapabilities.length
        : 0
      sessionPressureHealth = typeof pressure.health === "string"
        ? pressure.health
        : undefined
      sessionPressureUsagePercent = typeof pressure.usagePercent === "number" ? pressure.usagePercent : undefined
      sessionPressureNextAction = typeof pressure.nextAction === "string" ? pressure.nextAction : undefined
      sessionPressureNextThresholdSummary = typeof pressure.nextThresholdSummary === "string"
        ? pressure.nextThresholdSummary
        : undefined
      sessionPressureLastCompactionAgeMs = typeof pressure.lastCompactionAgeMs === "number" ? pressure.lastCompactionAgeMs : undefined
      sessionPressureSessionAgeMs = typeof pressure.sessionAgeMs === "number" ? pressure.sessionAgeMs : undefined
      sessionPressureActiveThreads = typeof pressure.activeThreads === "number" ? pressure.activeThreads : undefined
      sessionPressureWarmThreads = typeof pressure.warmThreads === "number" ? pressure.warmThreads : undefined
      sessionPressureTotalThreads = typeof pressure.totalThreads === "number" ? pressure.totalThreads : undefined
      sessionPressureFallbackActive = typeof pressure.fallbackActive === "boolean" ? pressure.fallbackActive : undefined
      sessionPressureFallbackActivationCount = typeof pressure.fallbackActivationCount === "number"
        ? pressure.fallbackActivationCount
        : undefined
      sessionPressureConsecutiveFailures = typeof pressure.consecutivePromptFailures === "number"
        ? pressure.consecutivePromptFailures
        : undefined
      sessionPressureReasons = Array.isArray(pressure.reasons)
        ? pressure.reasons.filter((reason: unknown): reason is string => typeof reason === "string")
        : []
      sessionPressureLastNotifiedHealth = typeof pressure.alerting?.lastNotifiedHealth === "string"
        ? pressure.alerting.lastNotifiedHealth
        : undefined
      sessionPressureLastNotifiedAt = typeof pressure.alerting?.lastNotifiedAt === "string"
        ? pressure.alerting.lastNotifiedAt
        : undefined
      supersessionActive = supersession.activeRequest?.superseded === true
      supersessionActiveSource = typeof supersession.activeRequest?.source === "string"
        ? supersession.activeRequest.source
        : undefined
      supersessionLastSource = typeof supersession.lastEvent?.source === "string"
        ? supersession.lastEvent.source
        : undefined
      supersessionLastAt = typeof supersession.lastEvent?.enqueuedAt === "string"
        ? supersession.lastEvent.enqueuedAt
        : undefined
      supersessionLastDroppedQueued = typeof supersession.lastEvent?.droppedQueued === "number"
        ? supersession.lastEvent.droppedQueued
        : undefined
      supersessionLastAbortRequested = typeof supersession.lastEvent?.abortRequested === "boolean"
        ? supersession.lastEvent.abortRequested
        : undefined
      checkpointSentThisTurn = parsed.result?.guardrails?.checkpointSentThisTurn === true
      pendingDeployVerificationCount = Array.isArray(parsed.result?.guardrails?.pendingDeployVerifications)
        ? parsed.result.guardrails.pendingDeployVerifications.length
        : 0

      if (gatewayMode === "redis_degraded" && parsed.result?.available !== false) {
        const findings = [
          `${degradedCapabilityCount} degraded capability${degradedCapabilityCount === 1 ? "" : "ies"}`,
          ...(sessionPressureHealth ? [`session pressure: ${sessionPressureHealth}`] : []),
          ...(checkpointSentThisTurn ? ["runtime checkpoint already sent this turn"] : []),
          ...(pendingDeployVerificationCount > 0 ? [`${pendingDeployVerificationCount} deploy verification pending`] : []),
        ]
        layers.push({
          layer: "cli-status",
          status: "degraded",
          detail: `Gateway available in redis_degraded mode, ${sessionCount} session(s), ${totalPending} pending`,
          findings,
        })
      } else if (redisOk && sessionCount > 0 && totalPending === 0) {
        layers.push({ layer: "cli-status", status: "ok", detail: `Redis connected, ${sessionCount} session(s), 0 pending` })
      } else if (redisOk) {
        const findings = [
          ...(sessionPressureHealth ? [`session pressure: ${sessionPressureHealth}`] : []),
          ...(checkpointSentThisTurn ? ["runtime checkpoint already sent this turn"] : []),
          ...(pendingDeployVerificationCount > 0 ? [`${pendingDeployVerificationCount} deploy verification pending`] : []),
        ]
        layers.push({
          layer: "cli-status",
          status: totalPending > 3 || checkpointSentThisTurn || pendingDeployVerificationCount > 0 ? "degraded" : "ok",
          detail: `Redis connected, ${sessionCount} session(s), ${totalPending} pending`,
          ...(findings.length > 0 ? { findings } : {}),
        })
      } else {
        layers.push({ layer: "cli-status", status: "failed", detail: "Redis not connected or no sessions" })
      }
    } catch (e) {
      layers.push({ layer: "cli-status", status: "failed", detail: `CLI status failed: ${e}` })
    }

    const sessionPressureFindings: string[] = []
    if (typeof sessionPressureUsagePercent === "number") {
      sessionPressureFindings.push(`context: ${sessionPressureUsagePercent}% used`)
    }
    if (typeof sessionPressureLastCompactionAgeMs === "number") {
      sessionPressureFindings.push(`last compaction: ${Math.round(sessionPressureLastCompactionAgeMs / 60_000)}m ago`)
    }
    if (typeof sessionPressureSessionAgeMs === "number") {
      sessionPressureFindings.push(`session age: ${Math.round((sessionPressureSessionAgeMs / 3_600_000) * 10) / 10}h`)
    }
    if (sessionPressureNextAction) {
      sessionPressureFindings.push(`next action: ${sessionPressureNextAction}`)
    }
    if (sessionPressureNextThresholdSummary) {
      sessionPressureFindings.push(`next threshold: ${sessionPressureNextThresholdSummary}`)
    }
    if (typeof sessionPressureTotalThreads === "number") {
      sessionPressureFindings.push(
        `threads: ${sessionPressureActiveThreads ?? 0} active / ${sessionPressureWarmThreads ?? 0} warm / ${sessionPressureTotalThreads} total`,
      )
    }
    if (
      typeof sessionPressureFallbackActivationCount === "number"
      || typeof sessionPressureConsecutiveFailures === "number"
      || typeof sessionPressureFallbackActive === "boolean"
    ) {
      sessionPressureFindings.push(
        `fallback: ${sessionPressureFallbackActive === true ? "active" : "inactive"}; activations: ${sessionPressureFallbackActivationCount ?? 0}; consecutive failures: ${sessionPressureConsecutiveFailures ?? 0}`,
      )
    }
    if (sessionPressureReasons.length > 0) {
      sessionPressureFindings.push(`signals: ${sessionPressureReasons.join(", ")}`)
    }
    if (sessionPressureLastNotifiedHealth && sessionPressureLastNotifiedAt) {
      sessionPressureFindings.push(`last alert: ${sessionPressureLastNotifiedHealth} at ${sessionPressureLastNotifiedAt}`)
    }

    if (sessionPressureHealth) {
      layers.push({
        layer: "session-pressure",
        status: sessionPressureHealth === "ok" ? "ok" : "degraded",
        detail: sessionPressureHealth === "ok"
          ? "Session pressure within guardrails"
          : `Session pressure ${sessionPressureHealth} — gateway should ${sessionPressureNextAction ?? "observe"}${sessionPressureNextThresholdSummary ? `; next threshold ${sessionPressureNextThresholdSummary}` : ""}`,
        ...(sessionPressureFindings.length > 0 ? { findings: sessionPressureFindings } : {}),
      })
    }

    const supersessionFindings: string[] = []
    if (supersessionActiveSource) {
      supersessionFindings.push(`active superseded source: ${supersessionActiveSource}`)
    }
    if (supersessionLastSource) {
      supersessionFindings.push(`last supersession source: ${supersessionLastSource}`)
    }
    if (supersessionLastAt) {
      supersessionFindings.push(`last supersession at: ${supersessionLastAt}`)
    }
    if (typeof supersessionLastDroppedQueued === "number") {
      supersessionFindings.push(`queued entries dropped: ${supersessionLastDroppedQueued}`)
    }
    if (typeof supersessionLastAbortRequested === "boolean") {
      supersessionFindings.push(`abort requested: ${supersessionLastAbortRequested ? "yes" : "no"}`)
    }

    layers.push({
      layer: "interruptibility",
      status: supersessionActive ? "degraded" : "ok",
      detail: supersessionActive
        ? "Newer human turn superseded the active request"
        : "Latest human turn wins; no supersession active",
      ...(supersessionFindings.length > 0 ? { findings: supersessionFindings } : {}),
    })

    // ── Layer 2: Error Log ──
    const errLines = tailFile(ERR_FILE, maxLines)
    const errPatterns = scanForPatterns(errLines)
    const hasErrors = errPatterns.some((p) => p.severity === "error")

    if (errLines.length === 0) {
      layers.push({ layer: "error-log", status: "ok", detail: "No error log or empty" })
    } else if (errPatterns.length === 0) {
      layers.push({ layer: "error-log", status: "ok", detail: `${errLines.length} lines scanned, no known failure patterns` })
    } else {
      layers.push({
        layer: "error-log",
        status: hasErrors ? "failed" : "degraded",
        detail: `${errPatterns.length} pattern(s) found in last ${maxLines} lines`,
        findings: errPatterns.map((p) => `[${p.severity}] ${p.label} ×${p.count}`),
      })
    }

    // ── Layer 3: Stdout Log ──
    const outLines = tailFile(LOG_FILE, maxLines)
    const lastStartup = outLines.findLast((l) => l.includes("[gateway] daemon started"))
    const fallbackActive = outLines.findLast((l) => l.includes("[gateway:fallback] activated"))
    const fallbackRecovered = outLines.findLast((l) => l.includes("recovered to primary"))
    const onFallback = fallbackActive && (!fallbackRecovered || outLines.indexOf(fallbackActive) > outLines.indexOf(fallbackRecovered))
    const replayLine = outLines.findLast((l) => l.includes("replayed unacked messages"))

    const stdoutFindings: string[] = []
    if (lastStartup) stdoutFindings.push(`last startup: ${lastStartup.slice(0, 120)}`)
    if (onFallback) stdoutFindings.push("⚠️ currently on fallback model")
    if (replayLine) stdoutFindings.push(`replay: ${replayLine.slice(0, 120)}`)

    layers.push({
      layer: "stdout-log",
      status: onFallback ? "degraded" : "ok",
      detail: `${outLines.length} lines scanned`,
      ...(stdoutFindings.length > 0 ? { findings: stdoutFindings } : {}),
    })

    // ── Layer 4: E2E Test ──
    let e2eOk = false
    if (gatewayMode === "redis_degraded") {
      layers.push({
        layer: "e2e-test",
        status: "skipped",
        detail: "Skipped: Redis event bridge is intentionally degraded in redis_degraded mode",
      })
    } else {
      try {
        execSync("joelclaw gateway test 2>/dev/null", { encoding: "utf-8", timeout: 10000 })
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 8000)))
        const eventsRaw = execSync("joelclaw gateway events 2>/dev/null", { encoding: "utf-8", timeout: 10000 })
        const events = JSON.parse(eventsRaw)
        // If test event was drained, totalCount should be 0 (or only non-test events)
        const testStuck = (events.result?.sessions ?? []).some((s: any) =>
          s.events?.some((e: any) => e.type === "test.gateway-e2e")
        )
        e2eOk = !testStuck
        layers.push({
          layer: "e2e-test",
          status: e2eOk ? "ok" : "failed",
          detail: e2eOk ? "Test event pushed and drained within 8s" : "Test event stuck in queue — session not draining",
        })
      } catch (e) {
        layers.push({ layer: "e2e-test", status: "failed", detail: `E2E test failed: ${e}` })
      }
    }

    // ── Layer 5: Model API ──
    let apiReachable = false
    try {
      const out = execSync(
        'curl -s -m 10 https://api.anthropic.com/v1/messages -H "x-api-key: test" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" -d "{}" 2>/dev/null',
        { encoding: "utf-8", timeout: 15000 }
      )
      apiReachable = out.includes("authentication_error")
      layers.push({
        layer: "model-api",
        status: apiReachable ? "ok" : "degraded",
        detail: apiReachable ? "Anthropic API reachable" : `Unexpected response: ${out.slice(0, 100)}`,
      })
    } catch (e) {
      layers.push({ layer: "model-api", status: "failed", detail: `API unreachable: ${e}` })
    }

    // ── Layer 6: Redis Direct ──
    try {
      const redis = yield* makeRedis()
      const queueLen = yield* Effect.tryPromise({
        try: () => redis.llen("joelclaw:events:gateway"),
        catch: (e) => new Error(`${e}`),
      })
      const streamLen = yield* Effect.tryPromise({
        try: () => redis.xlen("gateway:messages"),
        catch: () => new Error("xlen failed"),
      })
      yield* Effect.tryPromise({ try: () => redis.quit(), catch: () => {} })

      layers.push({
        layer: "redis-state",
        status: gatewayMode === "redis_degraded" ? "degraded" : "ok",
        detail: `event queue: ${queueLen}, message stream: ${streamLen}`,
      })
    } catch (e) {
      layers.push({
        layer: "redis-state",
        status: gatewayMode === "redis_degraded" ? "degraded" : "failed",
        detail: gatewayMode === "redis_degraded"
          ? `Redis query failed while daemon remained available in redis_degraded mode: ${e}`
          : `Redis query failed: ${e}`,
      })
    }

    // ── Reconciliation: stale watchdog entries vs current e2e health ──
    const e2eLayer = layers.find((layer) => layer.layer === "e2e-test")
    const errorLogLayer = layers.find((layer) => layer.layer === "error-log")
    const watchdogLabels = new Set(["watchdog-stuck", "watchdog-stuck-timeout", "watchdog-dead"])
    const errorLogHasOnlyWatchdogFindings =
      errPatterns.length > 0 &&
      errPatterns.every((pattern) => watchdogLabels.has(pattern.label))

    if (
      e2eLayer?.status === "ok" &&
      errorLogLayer?.status === "failed" &&
      errorLogHasOnlyWatchdogFindings
    ) {
      const note = "stale watchdog entries — e2e passing"
      errorLogLayer.status = "degraded"
      errorLogLayer.detail = `${errorLogLayer.detail}; ${note}`
      errorLogLayer.findings = [...(errorLogLayer.findings ?? []), note]
    }

    // ── Reconciliation: recovered errors — e2e passing means gateway recovered ──
    if (
      e2eLayer?.status === "ok" &&
      errorLogLayer?.status === "failed" &&
      !errorLogHasOnlyWatchdogFindings
    ) {
      const processOk = layers.find((l) => l.layer === "process")?.status === "ok"
      const redisOk = layers.find((l) => l.layer === "redis-state")?.status === "ok"
      if (processOk && redisOk) {
        const note = "error patterns found but gateway recovered — e2e/process/redis all passing"
        errorLogLayer.status = "degraded"
        errorLogLayer.detail = `${errorLogLayer.detail}; ${note}`
        errorLogLayer.findings = [...(errorLogLayer.findings ?? []), note]
      }
    }

    // ── Summary ──
    const failed = layers.filter((l) => l.status === "failed")
    const degraded = layers.filter((l) => l.status === "degraded")
    const allOk = failed.length === 0 && degraded.length === 0
    const healthy = failed.length === 0

    const nextActions: NextAction[] = []
    if (!allOk) {
      nextActions.push({ command: "joelclaw gateway restart", description: "Restart the gateway daemon" })
    }
    if (errPatterns.length > 0) {
      nextActions.push({
        command: "joelclaw gateway diagnose [--hours <hours>] [--lines <lines>]",
        description: "Re-run with wider window",
        params: {
          hours: { value: hours * 2, default: 1, description: "Hours to scan" },
          lines: { value: maxLines * 2, default: 100, description: "Max lines per source" },
        },
      })
    }
    nextActions.push(
      { command: "joelclaw gateway status", description: "Quick status check" },
      { command: "joelclaw gateway test", description: "E2E delivery test" },
    )
    if (hasErrors) {
      nextActions.push({
        command: "joelclaw otel search <query> [--hours <hours>]",
        description: "Search OTEL telemetry",
        params: {
          query: { value: "gateway", description: "Search query" },
          hours: { value: hours, default: 1 },
        },
      })
    }

    yield* Console.log(respond(
      "gateway diagnose",
      {
        timestamp: ts,
        window: `${hours}h`,
        healthy,
        summary: allOk
          ? "All layers healthy"
          : `${failed.length} failed, ${degraded.length} degraded`,
        layers,
        ...(errPatterns.length > 0 ? { errorPatterns: errPatterns } : {}),
      },
      nextActions,
      healthy,
    ))
  })
).pipe(Command.withDescription("Layer-by-layer health check (process → model → Redis)"))

// ── gateway review ──────────────────────────────────────────────────

const reviewHours = Options.integer("hours").pipe(
  Options.withDefault(1),
  Options.withDescription("How far back to review (hours, default: 1)"),
)

const reviewMaxExchanges = Options.integer("max").pipe(
  Options.withDefault(20),
  Options.withDescription("Max exchanges to return (default: 20)"),
)

function findLatestSessionFile(): string | null {
  try {
    const files = execSync(`ls -t "${SESSION_DIR}"/*.jsonl 2>/dev/null | head -1`, {
      encoding: "utf-8",
      timeout: 3000,
    }).trim()
    return files || null
  } catch {
    return null
  }
}

type SessionExchange = {
  ts: string
  role: "user" | "assistant"
  preview: string
  tools?: string[]
}

type SessionReview = {
  sessionFile: string
  sessionId: string
  windowHours: number
  totalEntries: number
  exchanges: SessionExchange[]
  compactions: number
  toolCallSummary: Record<string, number>
  errorLogHighlights: string[]
  stdoutHighlights: string[]
}

const gatewayReview = Command.make("review", { hours: reviewHours, max: reviewMaxExchanges }, ({ hours, max }) =>
  Effect.gen(function* () {
    const sessionFile = findLatestSessionFile()
    if (!sessionFile) {
      yield* Console.log(respondError(
        "gateway review",
        "No gateway session files found",
        "NO_SESSION",
        `Check ${SESSION_DIR} for .jsonl files. Gateway may not have run yet.`,
        [{ command: "joelclaw gateway restart", description: "Start the gateway" }],
      ))
      return
    }

    const sessionIdMatch = sessionFile.match(/([a-f0-9-]{36})\.jsonl$/)
    const sessionId = sessionIdMatch?.[1] ?? "unknown"

    // Parse the session JSONL for the time window
    const cutoffIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()

    // Write python script to temp file to avoid shell escaping issues on large JSONL
    let reviewData: SessionReview | null = null
    try {
      const tmpScript = `/tmp/joelclaw/gateway-review.py`
      const scriptContent = [
        `import json, sys`,
        `from collections import Counter`,
        ``,
        `cutoff = "${cutoffIso}"`,
        `exchanges = []`,
        `compactions = 0`,
        `tool_counts = Counter()`,
        `total = 0`,
        ``,
        `with open("${sessionFile}") as f:`,
        `    for line in f:`,
        `        total += 1`,
        `        try:`,
        `            obj = json.loads(line.strip())`,
        `            ts = obj.get("timestamp", "")`,
        `            if ts < cutoff:`,
        `                continue`,
        `            if obj.get("type") == "compaction":`,
        `                compactions += 1`,
        `                continue`,
        `            if obj.get("type") != "message":`,
        `                continue`,
        `            msg = obj.get("message", {})`,
        `            role = msg.get("role", "")`,
        `            if role not in ("user", "assistant"):`,
        `                continue`,
        `            content = msg.get("content", "")`,
        `            tools = []`,
        `            if isinstance(content, list):`,
        `                texts = []`,
        `                for c in content:`,
        `                    if isinstance(c, dict):`,
        `                        if c.get("type") == "text" and c.get("text"):`,
        `                            texts.append(c["text"])`,
        `                        elif c.get("type") == "toolCall":`,
        `                            name = c.get("name", "?")`,
        `                            tools.append(name)`,
        `                            tool_counts[name] += 1`,
        `                content = " ".join(texts)`,
        `            if not content and not tools:`,
        `                continue`,
        `            exchanges.append({`,
        `                "ts": ts[:19],`,
        `                "role": role,`,
        `                "preview": (content or "(tool calls only)")[:200],`,
        `                **({"tools": tools} if tools else {}),`,
        `            })`,
        `        except:`,
        `            pass`,
        ``,
        `exchanges = exchanges[-${max}:]`,
        ``,
        `json.dump({`,
        `    "totalEntries": total,`,
        `    "exchanges": exchanges,`,
        `    "compactions": compactions,`,
        `    "toolCallSummary": dict(tool_counts.most_common(10)),`,
        `}, sys.stdout)`,
      ].join("\n")

      const { writeFileSync, mkdirSync } = require("node:fs")
      mkdirSync("/tmp/joelclaw", { recursive: true })
      writeFileSync(tmpScript, scriptContent)

      const raw = execSync(`python3 "${tmpScript}"`, {
        encoding: "utf-8",
        timeout: 15000,
      })
      const parsed = JSON.parse(raw)

      // Get log highlights
      const errLines = tailFile(ERR_FILE, 50)
      const outLines = tailFile(LOG_FILE, 50)

      const errHighlights = errLines
        .filter((l) => KNOWN_ERR_PATTERNS.some((p) => p.pattern.test(l)))
        .slice(-5)
        .map((l) => l.slice(0, 200))

      const outHighlights = outLines
        .filter((l) =>
          l.includes("daemon started") ||
          l.includes("fallback") ||
          l.includes("replayed unacked") ||
          l.includes("response ready") ||
          l.includes("telegram] message received")
        )
        .slice(-10)
        .map((l) => l.slice(0, 200))

      reviewData = {
        sessionFile: sessionFile.replace(process.env.HOME ?? "", "~"),
        sessionId,
        windowHours: hours,
        totalEntries: parsed.totalEntries,
        exchanges: parsed.exchanges,
        compactions: parsed.compactions,
        toolCallSummary: parsed.toolCallSummary,
        errorLogHighlights: errHighlights,
        stdoutHighlights: outHighlights,
      }
    } catch (e) {
      yield* Console.log(respondError(
        "gateway review",
        `Failed to parse session: ${e}`,
        "PARSE_FAILED",
        "Session file may be corrupted or too large for the timeout.",
        [
          { command: "joelclaw gateway diagnose", description: "Run automated diagnostics instead" },
        ],
      ))
      return
    }

    if (!reviewData) return

    yield* Console.log(respond(
      "gateway review",
      reviewData,
      [
        {
          command: "joelclaw gateway review [--hours <hours>] [--max <max>]",
          description: "Adjust time window or exchange count",
          params: {
            hours: { value: hours * 2, default: 1, description: "Hours to review" },
            max: { value: max, default: 20, description: "Max exchanges" },
          },
        },
        { command: "joelclaw gateway diagnose", description: "Automated health check" },
        { command: "joelclaw gateway status", description: "Quick status" },
      ],
      true,
    ))
  })
).pipe(Command.withDescription("Recent session context (exchanges, tools, errors)"))

// ── Root gateway command ────────────────────────────────────────────

export const gatewayCmd = Command.make("gateway", {}, () =>
  Console.log(respond(
    "gateway",
    {
      description: "Redis event bridge between Inngest functions and pi sessions (ADR-0018). Per-session fan-out.",
      subcommands: {
        status: "joelclaw gateway status — Active sessions + queue depths",
        events: "joelclaw gateway events — Peek at all pending events",
        push: "joelclaw gateway push --type <type> [--payload JSON] — Push to all sessions",
        drain: "joelclaw gateway drain — Clear all event queues",
        test: "joelclaw gateway test — Push test event to all sessions",
        restart: "joelclaw gateway restart — Roll the pi session, clean Redis, restart daemon",
        enable: "joelclaw gateway enable — Re-enable launch agent and start daemon",
        stream: "joelclaw gateway stream — NDJSON stream of all gateway events (ADR-0058)",
        diagnose: "joelclaw gateway diagnose [--hours N] — Full diagnostic across all layers",
        review: "joelclaw gateway review [--hours N] — Recent session context (exchanges, tools, errors)",
        behavior: "joelclaw gateway behavior {add|list|promote|remove|apply|stats} — Control runtime behavior contract (ADR-0211)",
        "known-issues": "joelclaw gateway known-issues — List muted channels + reasons for health alert suppression",
        mute: "joelclaw gateway mute <channel> [--reason \"...\"] — Suppress alerting for a known channel issue",
        unmute: "joelclaw gateway unmute <channel> — Re-enable alerting for a muted channel",
      },
    },
    [
      { command: "joelclaw gateway status", description: "Check gateway health" },
      { command: "joelclaw gateway diagnose", description: "Full diagnostic (process → redis → model → delivery)" },
      { command: "joelclaw gateway review", description: "Recent session context (what happened?)" },
      { command: "joelclaw gateway behavior list", description: "Inspect active behavior contract + pending candidates" },
      { command: "joelclaw gateway known-issues", description: "List muted channels that won't trigger alerts" },
      { command: "joelclaw gateway stream", description: "Stream all gateway events (NDJSON)" },
      { command: "joelclaw gateway test", description: "Push test event + verify" },
      { command: "joelclaw gateway restart", description: "Restart the gateway daemon" },
      { command: "joelclaw gateway enable", description: "Re-enable launch agent + start daemon" },
    ],
    true
  ))
).pipe(
  Command.withSubcommands([
    gatewayStatus,
    gatewayEvents,
    gatewayPush,
    gatewayDrain,
    gatewayTest,
    gatewayKnownIssues,
    gatewayMute,
    gatewayUnmute,
    gatewayRestart,
    gatewayEnable,
    gatewayStream,
    gatewayDiagnose,
    gatewayReview,
    gatewayBehaviorCmd,
  ])
)
