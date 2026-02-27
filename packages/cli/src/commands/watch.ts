/**
 * ADR-0058: Loop watcher using streamed NDJSON.
 *
 * Subscribes to Redis pub/sub for loop state changes and emits
 * typed NDJSON lines. Replaces the previous polling+plaintext approach.
 *
 * Usage:
 *   joelclaw watch [loop-id]              # auto-detect active loop
 *   joelclaw watch [loop-id] --timeout 600  # stop after 10 min
 *
 * Output: NDJSON stream, one JSON line per event. Terminal line is
 * type "result" with the final loop state.
 */

import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import {
  emit,
  emitError,
  emitLog,
  emitProgress,
  emitResult,
  emitStart,
  emitStep,
  type StreamEvent,
} from "../stream"

export const watchCmd = Command.make(
  "watch",
  {
    loopId: Args.text({ name: "loop-id" }).pipe(
      Args.withDescription("Loop ID to watch (optional — auto-detects)"),
      Args.optional,
    ),
    timeout: Options.integer("timeout").pipe(
      Options.withAlias("t"),
      Options.withDefault(0),
      Options.withDescription("Stop after N seconds (0 = until complete)"),
    ),
    interval: Options.integer("interval").pipe(
      Options.withAlias("i"),
      Options.withDefault(10),
      Options.withDescription("Poll interval in seconds for state sync (default: 10)"),
    ),
  },
  ({ loopId, timeout, interval }) =>
    Effect.gen(function* () {
      const Redis = (yield* Effect.tryPromise({
        try: () => import("ioredis"),
        catch: (e) => new Error(`ioredis: ${e}`),
      })).default

      // ── Resolve target loop ────────────────────────────────────
      const resolveLoop = async (): Promise<{ id: string; prd: any } | null> => {
        const redis = new Redis({
          host: "localhost",
          port: 6379,
          lazyConnect: true,
          connectTimeout: 3000,
          commandTimeout: 5000,
        })
        await redis.connect()
        const keys = await redis.keys("agent-loop:prd:*")
        let target: { id: string; prd: any } | null = null
        const wantId = loopId._tag === "Some" ? loopId.value : undefined

        for (const key of keys) {
          const data = await redis.get(key)
          if (!data) continue
          const id = key.replace("agent-loop:prd:", "")
          const prd = JSON.parse(data)
          if (wantId && id === wantId) {
            target = { id, prd }
            break
          }
          if (!wantId && prd.stories?.some((s: any) => !s.passes && !s.skipped)) {
            if (!target) target = { id, prd }
          }
        }
        await redis.quit()
        return target
      }

      const loop = yield* Effect.tryPromise({
        try: resolveLoop,
        catch: (e) => new Error(`${e}`),
      })

      if (!loop) {
        emitError("watch", "No active loop found", "NO_ACTIVE_LOOP",
          "Start a loop first: joelclaw loop start", [
            { command: "joelclaw loop start", description: "Start a new loop" },
            { command: "joelclaw runs --count 5", description: "Check recent runs" },
          ])
        return
      }

      const cmd = `joelclaw watch ${loop.id}`

      // ── Subscribe to gateway events ────────────────────────────
      const sub = new Redis({
        host: "localhost",
        port: 6379,
        lazyConnect: true,
        connectTimeout: 3000,
        retryStrategy: (times: number) => (times > 3 ? null : Math.min(times * 500, 5000)),
      })

      try {
        yield* Effect.tryPromise({
          try: () => sub.connect(),
          catch: (e) => new Error(`Redis subscribe: ${e}`),
        })
      } catch {
        emitError(cmd, "Redis connection failed", "REDIS_CONNECT_FAILED",
          "Check Redis: kubectl get pods -n joelclaw | grep redis", [
            { command: "joelclaw status", description: "Check system health" },
          ])
        return
      }

      emitStart(cmd)

      // Emit initial state
      const stories = loop.prd.stories ?? []
      const passed = stories.filter((s: any) => s.passes).length
      const skipped = stories.filter((s: any) => s.skipped).length
      const total = stories.length

      emitLog("info", `Watching ${loop.id} | ${loop.prd.title ?? "?"} | ${passed}/${total} passed, ${skipped} skipped`)

      for (const s of stories) {
        if (s.passes) {
          emitStep(s.id, "completed", { duration_ms: 0 })
        } else if (s.skipped) {
          emitLog("info", `${s.id}: skipped — ${s.title}`)
        }
      }

      // ── Event-driven + polling hybrid ──────────────────────────
      // Subscribe to gateway channel for real-time events,
      // poll Redis for state sync (catches events we might miss)
      let ended = false
      let lastState = JSON.stringify(stories.map((s: any) => ({ p: s.passes, k: s.skipped })))

      const onSignal = () => {
        ended = true
        sub.disconnect().catch(() => {})
        emitResult(cmd, { reason: "interrupted", loop_id: loop.id }, [])
        process.exit(0)
      }
      process.on("SIGINT", onSignal)
      process.on("SIGTERM", onSignal)

      // Listen for gateway events about this loop
      sub.on("message", (_ch: string, message: string) => {
        if (ended) return
        try {
          const event = JSON.parse(message)
          if (!event.type?.includes("loop") && !event.data?.loopId) return
          if (event.data?.loopId && event.data.loopId !== loop.id) return

          // Map gateway events to stream events
          if (event.type === "loop.story.started" || event.type?.includes("implement")) {
            emitStep(event.data?.storyId ?? "unknown", "started")
          } else if (event.type === "loop.story.passed" || event.type?.includes("passed")) {
            emitStep(event.data?.storyId ?? "unknown", "completed", {
              duration_ms: event.data?.duration,
            })
          } else if (event.type === "loop.story.failed" || event.type?.includes("failed")) {
            emitStep(event.data?.storyId ?? "unknown", "failed", {
              error: event.data?.error ?? event.data?.reason,
            })
          } else if (event.type === "loop.complete" || event.type?.includes("complete")) {
            // Will be caught by the polling check
            emitLog("info", "Loop complete signal received")
          } else {
            // Generic loop event
            emit({
              type: "event",
              name: event.type ?? "unknown",
              data: event.data,
              ts: new Date().toISOString(),
            })
          }
        } catch {
          // Skip unparseable messages
        }
      })

      yield* Effect.tryPromise({
        try: () => sub.subscribe("joelclaw:notify:gateway"),
        catch: (e) => new Error(`Subscribe: ${e}`),
      })

      // Timeout
      const startTime = Date.now()

      // Poll for state changes (catches anything pub/sub misses)
      while (!ended) {
        yield* Effect.tryPromise({
          try: () => new Promise((resolve) => setTimeout(resolve, interval * 1000)),
          catch: () => new Error("sleep"),
        })

        if (ended) break

        // Check timeout
        if (timeout > 0 && Date.now() - startTime > timeout * 1000) {
          emitLog("info", `Timeout reached (${timeout}s)`)
          break
        }

        // Re-fetch state
        const freshLoop = yield* Effect.tryPromise({
          try: resolveLoop,
          catch: (e) => new Error(`${e}`),
        })

        if (!freshLoop) {
          emitLog("warn", "Loop removed from Redis — may have completed or been cancelled")
          break
        }

        // Diff state and emit changes
        const freshStories = freshLoop.prd.stories ?? []
        const freshState = JSON.stringify(freshStories.map((s: any) => ({ p: s.passes, k: s.skipped })))

        if (freshState !== lastState) {
          // Find what changed
          for (let i = 0; i < freshStories.length; i++) {
            const old = stories[i]
            const fresh = freshStories[i]
            if (!old) continue
            if (!old.passes && fresh.passes) {
              emitStep(fresh.id, "completed")
            }
            if (!old.skipped && fresh.skipped) {
              emitLog("info", `${fresh.id}: skipped`)
            }
          }

          // Update state
          Object.assign(stories, freshStories)
          lastState = freshState

          const newPassed = freshStories.filter((s: any) => s.passes).length
          const newSkipped = freshStories.filter((s: any) => s.skipped).length
          emitProgress(loop.id, {
            percent: Math.round(((newPassed + newSkipped) / total) * 100),
            message: `${newPassed}/${total} passed, ${newSkipped} skipped`,
          })
        }

        // Check if all done
        const allDone = freshStories.every((s: any) => s.passes || s.skipped)
        if (allDone) {
          emitLog("info", "All stories resolved")
          break
        }
      }

      // ── Terminal ───────────────────────────────────────────────
      ended = true
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
      sub.disconnect().catch(() => {})

      const finalPassed = stories.filter((s: any) => s.passes).length
      const finalSkipped = stories.filter((s: any) => s.skipped).length

      emitResult(cmd, {
        loop_id: loop.id,
        title: loop.prd.title,
        passed: finalPassed,
        skipped: finalSkipped,
        total,
        stories: stories.map((s: any) => ({
          id: s.id,
          title: s.title,
          passed: !!s.passes,
          skipped: !!s.skipped,
        })),
      }, [
        { command: `joelclaw loop status ${loop.id}`, description: "Final loop status" },
        { command: `joelclaw runs --count 10`, description: "Recent runs" },
        { command: `joelclaw loop diagnose ${loop.id}`, description: "Diagnose if incomplete" },
      ])
    }),
)
