import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { respond } from "../response"

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
    const { sessionInfo, legacyLen } = yield* Effect.tryPromise({
      try: async () => {
        const info: Array<{ id: string; pending: number }> = []
        for (const s of sessions) {
          const len = await redis.llen(`joelclaw:events:${s}`)
          info.push({ id: s, pending: len })
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
        legacyQueuePending: legacyLen,
      },
      [
        { command: "joelclaw gateway events", description: "Peek at pending events" },
        { command: "joelclaw gateway push --type test", description: "Push a test event" },
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
        { command: "joelclaw gateway push --type test", description: "Push a test event" },
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
      yield* Console.log(respond("gateway push", { error: "Invalid JSON payload" }, [], false))
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
    const PID_FILE = "/tmp/joelclaw/gateway.pid"
    const LOG_FILE = "/tmp/joelclaw/gateway.log"

    let oldPid: string | null = null
    try {
      if (existsSync(PID_FILE)) {
        oldPid = readFileSync(PID_FILE, "utf-8").trim()
      }
    } catch {}

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
      try {
        execSync(`kill -0 ${oldPid} 2>/dev/null`, { stdio: "pipe" })
      } catch {
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

    // Wait for new PID
    let newPid: string | null = null
    let attempts = 0
    while (attempts < 10) {
      yield* Effect.promise(() => new Promise(r => setTimeout(r, 1000)))
      attempts++
      try {
        if (existsSync(PID_FILE)) {
          newPid = readFileSync(PID_FILE, "utf-8").trim()
          if (newPid && newPid !== oldPid) break
        }
      } catch {}
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
      },
    },
    [
      { command: "joelclaw gateway status", description: "Check gateway health" },
      { command: "joelclaw gateway test", description: "Push test event + verify" },
      { command: "joelclaw gateway restart", description: "Restart the gateway daemon" },
    ],
    true
  ))
).pipe(
  Command.withSubcommands([gatewayStatus, gatewayEvents, gatewayPush, gatewayDrain, gatewayTest, gatewayRestart])
)
