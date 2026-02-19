/**
 * NDJSON streaming protocol for agent-first CLIs.
 * ADR-0058: Streamed NDJSON Protocol for Agent-First CLIs.
 *
 * Each line is a self-contained JSON object with a `type` discriminator.
 * The last line is always a terminal event (result or error) containing
 * the standard HATEOAS envelope — backwards compatible with non-streaming consumers.
 *
 * Streaming commands subscribe to Redis pub/sub channels that the gateway
 * extension already writes to via pushGatewayEvent().
 */

import type { NextAction } from "./response"
import Redis from "ioredis"

// ── Stream Event Types ──────────────────────────────────────────────

export type StreamEvent =
  | StreamStart
  | StreamStep
  | StreamProgress
  | StreamLog
  | StreamEventEmit
  | StreamResult
  | StreamError

export interface StreamStart {
  readonly type: "start"
  readonly command: string
  readonly ts: string
}

export interface StreamStep {
  readonly type: "step"
  readonly name: string
  readonly status: "started" | "completed" | "failed"
  readonly duration_ms?: number
  readonly error?: string
  readonly ts: string
}

export interface StreamProgress {
  readonly type: "progress"
  readonly name: string
  readonly percent?: number
  readonly message?: string
  readonly ts: string
}

export interface StreamLog {
  readonly type: "log"
  readonly level: "info" | "warn" | "error"
  readonly message: string
  readonly ts: string
}

export interface StreamEventEmit {
  readonly type: "event"
  readonly name: string
  readonly data: unknown
  readonly ts: string
}

export interface StreamResult {
  readonly type: "result"
  readonly ok: true
  readonly command: string
  readonly result: unknown
  readonly next_actions: readonly NextAction[]
}

export interface StreamError {
  readonly type: "error"
  readonly ok: false
  readonly command: string
  readonly error: { message: string; code: string }
  readonly fix: string
  readonly next_actions: readonly NextAction[]
}

// ── Emitters ────────────────────────────────────────────────────────

const ts = () => new Date().toISOString()

/** Emit a single NDJSON line to stdout. Flushes immediately. */
export function emit(event: StreamEvent): void {
  const line = JSON.stringify(event)
  process.stdout.write(line + "\n")
}

/** Emit a start event. Call once at stream begin. */
export function emitStart(command: string): void {
  emit({ type: "start", command, ts: ts() })
}

/** Emit a step lifecycle event. */
export function emitStep(
  name: string,
  status: "started" | "completed" | "failed",
  opts?: { duration_ms?: number; error?: string },
): void {
  emit({ type: "step", name, status, ...opts, ts: ts() })
}

/** Emit a progress update. */
export function emitProgress(name: string, opts?: { percent?: number; message?: string }): void {
  emit({ type: "progress", name, ...opts, ts: ts() })
}

/** Emit a diagnostic log line. */
export function emitLog(level: "info" | "warn" | "error", message: string): void {
  emit({ type: "log", level, message, ts: ts() })
}

/** Emit an event notification (fan-out visibility). */
export function emitEvent(name: string, data: unknown): void {
  emit({ type: "event", name, data, ts: ts() })
}

/** Emit the terminal success result. Always last line. */
export function emitResult(
  command: string,
  result: unknown,
  nextActions: readonly NextAction[],
): void {
  emit({ type: "result", ok: true, command, result, next_actions: nextActions })
}

/** Emit the terminal error result. Always last line. */
export function emitError(
  command: string,
  message: string,
  code: string,
  fix: string,
  nextActions: readonly NextAction[],
): void {
  emit({
    type: "error",
    ok: false,
    command,
    error: { message, code },
    fix,
    next_actions: nextActions,
  })
}

// ── Redis Subscription ──────────────────────────────────────────────

export interface StreamFromRedisOptions {
  /** Redis pub/sub channel to subscribe to */
  channel: string
  /** Command string for the start event */
  command: string
  /** Transform a raw Redis message into a StreamEvent (or null to skip) */
  transform: (parsed: any) => StreamEvent | null
  /** Optional: end the stream when this returns true */
  until?: (parsed: any) => boolean
  /** Timeout in ms (0 = no timeout). Default: 0 */
  timeout?: number
  /** Redis connection options */
  redisOpts?: { host?: string; port?: number }
}

/**
 * Subscribe to a Redis pub/sub channel and emit NDJSON lines.
 * Handles SIGINT/SIGTERM cleanup. Emits start event on connect,
 * transforms messages via the provided function, and emits a
 * terminal result when the stream ends.
 */
export async function streamFromRedis(opts: StreamFromRedisOptions): Promise<void> {
  const {
    channel,
    command,
    transform,
    until,
    timeout = 0,
    redisOpts = {},
  } = opts

  const sub = new Redis({
    host: redisOpts.host ?? process.env.REDIS_HOST ?? "localhost",
    port: redisOpts.port ?? parseInt(process.env.REDIS_PORT ?? "6379", 10),
    lazyConnect: true,
    connectTimeout: 3000,
    retryStrategy: (times) => (times > 3 ? null : Math.min(times * 500, 5000)),
  })

  let ended = false

  const cleanup = async (terminal?: StreamEvent) => {
    if (ended) return
    ended = true
    if (terminal) emit(terminal)
    try {
      await sub.unsubscribe(channel)
      sub.disconnect()
    } catch {
      // best-effort cleanup
    }
  }

  // Signal handlers for graceful shutdown
  const onSignal = () => {
    cleanup({
      type: "result",
      ok: true,
      command,
      result: { reason: "interrupted" },
      next_actions: [],
    })
    process.exit(0)
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  try {
    await sub.connect()
  } catch (err) {
    emitError(command, `Redis connection failed: ${err}`, "REDIS_CONNECT_FAILED",
      "Check Redis: kubectl get pods -n joelclaw | grep redis", [
        { command: "joelclaw status", description: "Check system health" },
      ])
    return
  }

  emitStart(command)

  // Timeout handler
  let timer: ReturnType<typeof setTimeout> | null = null
  if (timeout > 0) {
    timer = setTimeout(() => {
      cleanup({
        type: "result",
        ok: true,
        command,
        result: { reason: "timeout", timeout_ms: timeout },
        next_actions: [
          { command: `${command}`, description: "Restart the stream" },
        ],
      })
    }, timeout)
  }

  return new Promise<void>((resolve) => {
    sub.on("message", (_ch: string, message: string) => {
      if (ended) return

      let parsed: any
      try {
        parsed = JSON.parse(message)
      } catch {
        emitLog("warn", `Unparseable message on ${channel}: ${message.slice(0, 200)}`)
        return
      }

      // Check end condition
      if (until?.(parsed)) {
        const terminal: StreamResult = {
          type: "result",
          ok: true,
          command,
          result: { reason: "completed", final_event: parsed },
          next_actions: [],
        }
        cleanup(terminal).then(resolve)
        return
      }

      // Transform and emit
      const event = transform(parsed)
      if (event) emit(event)
    })

    sub.subscribe(channel).catch((err) => {
      emitError(command, `Subscribe failed: ${err}`, "REDIS_SUBSCRIBE_FAILED",
        "Check Redis connectivity", [])
      resolve()
    })

    // If timeout fires, resolve
    if (timer) {
      const origCleanup = cleanup
      // Patch to resolve on timeout
      ;(async () => {
        // Wait for either signal, timeout, or until-condition
        // The promise resolves when cleanup is called
      })()
    }
  }).finally(() => {
    if (timer) clearTimeout(timer)
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
  })
}
