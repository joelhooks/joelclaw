import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { respond, respondError } from "../response"

const SESSIONS_SET = "joelclaw:gateway:sessions"

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

/** Check if a PID is alive (POSIX kill -0) */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const gatewayStatus = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const redis = yield* makeRedis()
    const pong = yield* Effect.tryPromise({
      try: () => redis.ping(),
      catch: (e) => new Error(`${e}`),
    })
    const sessions = yield* Effect.tryPromise({
      try: () => redis.smembers(SESSIONS_SET),
      catch: (e) => new Error(`${e}`),
    })

    // Check PIDs and auto-prune dead ones
    const deadSessions: string[] = []
    const aliveSessions: string[] = []
    for (const s of sessions) {
      const pidMatch = s.match(/^pid-(\d+)$/)
      if (pidMatch) {
        const pid = parseInt(pidMatch[1], 10)
        if (isPidAlive(pid)) {
          aliveSessions.push(s)
        } else {
          deadSessions.push(s)
        }
      } else {
        // Non-PID sessions (e.g. "gateway") — keep
        aliveSessions.push(s)
      }
    }

    // Auto-prune dead PIDs from Redis
    if (deadSessions.length > 0) {
      yield* Effect.tryPromise({
        try: async () => {
          for (const s of deadSessions) {
            await redis.srem(SESSIONS_SET, s)
            await redis.del(`joelclaw:events:${s}`)
          }
        },
        catch: () => {},
      })
    }

    const { sessionInfo, legacyLen } = yield* Effect.tryPromise({
      try: async () => {
        const info: Array<{ id: string; pending: number; alive: boolean }> = []
        for (const s of aliveSessions) {
          const len = await redis.llen(`joelclaw:events:${s}`)
          info.push({ id: s, pending: len, alive: true })
        }
        const legacy = await redis.llen("joelclaw:events:main")
        return { sessionInfo: info, legacyLen: legacy }
      },
      catch: (e) => new Error(`${e}`),
    })
    yield* Effect.tryPromise({ try: () => redis.quit(), catch: () => {} })

    yield* Console.log(respond(
      "gateway status",
      {
        redis: pong === "PONG" ? "connected" : "error",
        activeSessions: sessionInfo,
        ...(deadSessions.length > 0 ? { pruned: deadSessions } : {}),
        legacyQueuePending: legacyLen,
      },
      [
        { command: "joelclaw gateway events", description: "Peek at pending events" },
        {
          command: "joelclaw gateway push --type <type>",
          description: "Push an event to all sessions",
          params: {
            type: { description: "Event type", default: "test", enum: ["test", "cron.heartbeat", "test.gateway-e2e"] },
          },
        },
        { command: "joelclaw gateway drain", description: "Clear all event queues" },
      ],
      pong === "PONG"
    ))
  })
)

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
)

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
)

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
)

// ── gateway restart ─────────────────────────────────────────────────

import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"

const gatewayRestart = Command.make("restart", {}, () =>
  Effect.gen(function* () {
    const LAUNCHD_LABEL = "com.joel.gateway"
    const DAEMON_MATCH = "/Users/joel/Code/joelhooks/joelclaw/packages/gateway/src/daemon.ts"
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
      execSync(`launchctl bootout gui/$(id -u) system/${LAUNCHD_LABEL} 2>/dev/null || launchctl stop ${LAUNCHD_LABEL}`, {
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

    // Re-bootstrap + kickstart (KeepAlive ensures it comes back)
    try {
      execSync(`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.joel.gateway.plist 2>/dev/null || true`, {
        timeout: 5_000, stdio: "pipe",
      })
    } catch {}
    try {
      execSync(`launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}`, {
        timeout: 5_000, stdio: "pipe",
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
)

// ── gateway stream (ADR-0058) ───────────────────────────────────────

import {
  emitStart,
  emitLog,
  emitEvent,
  emitResult,
  emitError,
  emit,
} from "../stream"

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
        sub.disconnect().catch(() => {})
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
      sub.disconnect().catch(() => {})

      emitResult(cmd, {
        reason: timeout > 0 ? "timeout" : "ended",
        events_received: eventCount,
        duration_ms: Date.now() - startTime,
      }, [
        { command: "joelclaw gateway status", description: "Check gateway health" },
        { command: `joelclaw gateway stream`, description: "Resume streaming" },
      ])
    }),
)

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
        stream: "joelclaw gateway stream — NDJSON stream of all gateway events (ADR-0058)",
      },
    },
    [
      { command: "joelclaw gateway status", description: "Check gateway health" },
      { command: "joelclaw gateway stream", description: "Stream all gateway events (NDJSON)" },
      { command: "joelclaw gateway test", description: "Push test event + verify" },
      { command: "joelclaw gateway restart", description: "Restart the gateway daemon" },
    ],
    true
  ))
).pipe(
  Command.withSubcommands([gatewayStatus, gatewayEvents, gatewayPush, gatewayDrain, gatewayTest, gatewayRestart, gatewayStream])
)
