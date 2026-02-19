/**
 * ADR-0058: Send events with optional --follow for NDJSON streaming.
 *
 * Without --follow: fire-and-forget, returns standard HATEOAS envelope.
 * With --follow: sends event, subscribes to gateway Redis pub/sub,
 * streams step completions as NDJSON until the run completes.
 */

import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import { respond } from "../response"
import {
  emitStart,
  emitStep,
  emitLog,
  emitEvent,
  emitResult,
  emitError,
  emit,
} from "../stream"

export const sendCmd = Command.make(
  "send",
  {
    event: Args.text({ name: "event" }).pipe(
      Args.withDescription("Event name (e.g. pipeline/video.download, system/log)")
    ),
    data: Options.text("data").pipe(
      Options.withAlias("d"),
      Options.withDescription("JSON data payload"),
      Options.withDefault("{}")
    ),
    url: Options.text("url").pipe(
      Options.withDescription("Shorthand: sets data.url for video.download events"),
      Options.optional
    ),
    follow: Options.boolean("follow").pipe(
      Options.withAlias("f"),
      Options.withDefault(false),
      Options.withDescription("Stream run progress as NDJSON (ADR-0058)")
    ),
    timeout: Options.integer("timeout").pipe(
      Options.withDefault(300),
      Options.withDescription("Follow timeout in seconds (default: 300)")
    ),
  },
  ({ event, data, url, follow, timeout }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      let payload: Record<string, unknown>

      try {
        payload = JSON.parse(data)
      } catch {
        if (follow) {
          emitError("send", "Invalid JSON in --data", "INVALID_JSON",
            "Check your -d payload is valid JSON", [])
        } else {
          yield* Console.log(respond("send", { error: "Invalid JSON in --data" }, [], false))
        }
        return
      }

      if (url._tag === "Some") {
        payload.url = url.value
      }

      const result = yield* inngestClient.send(event, payload)
      const runIds = (result as any)?.ids ?? []

      // ── Standard mode: fire and forget ─────────────────────────
      if (!follow) {
        yield* Console.log(respond("send", { event, data: payload, response: result }, [
          { command: `joelclaw runs --count 3`, description: "Check if the function picked it up" },
          { command: `joelclaw run ${runIds[0] ?? "RUN_ID"}`, description: "Inspect the run once it starts" },
          { command: `joelclaw send ${event} -d '${JSON.stringify(payload)}' --follow`, description: "Re-send with streaming" },
          { command: `joelclaw functions`, description: "See which function handles this event" },
        ]))
        return
      }

      // ── Follow mode: stream via Redis pub/sub ──────────────────
      const cmd = `joelclaw send ${event} --follow`
      emitStart(cmd)
      emitLog("info", `Event sent: ${event} → ${runIds.length} run(s)`)

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
        // Fallback: emit what we have and exit
        emitResult(cmd, {
          event,
          data: payload,
          response: result,
          follow_failed: "Redis connection failed — event sent but cannot stream progress",
        }, [
          { command: `joelclaw run ${runIds[0] ?? "RUN_ID"}`, description: "Poll run status instead" },
        ])
        return
      }

      let ended = false
      const startTime = Date.now()

      const cleanup = () => {
        if (ended) return
        ended = true
        sub.disconnect().catch(() => {})
      }

      const onSignal = () => {
        cleanup()
        emitResult(cmd, { reason: "interrupted", event, run_ids: runIds }, [])
        process.exit(0)
      }
      process.on("SIGINT", onSignal)
      process.on("SIGTERM", onSignal)

      // Subscribe to gateway channel — captures all events from pushGatewayEvent
      sub.on("message", (_ch: string, message: string) => {
        if (ended) return
        try {
          const gwEvent = JSON.parse(message)

          // Filter to events related to our run
          // Gateway events have varying shapes; match on event name patterns
          const eventName: string = gwEvent.type ?? gwEvent.name ?? ""
          const eventData = gwEvent.data ?? gwEvent

          // Map to stream events
          if (eventName.includes("step") || eventName.includes("started")) {
            emitStep(eventData.stepName ?? eventName, "started")
          } else if (eventName.includes("complete") || eventName.includes("passed")) {
            emitStep(eventData.stepName ?? eventName, "completed", {
              duration_ms: eventData.duration,
            })
          } else if (eventName.includes("fail") || eventName.includes("error")) {
            emitStep(eventData.stepName ?? eventName, "failed", {
              error: eventData.error ?? eventData.message,
            })
          } else {
            emitEvent(eventName, eventData)
          }
        } catch {
          // Skip unparseable
        }
      })

      yield* Effect.tryPromise({
        try: () => sub.subscribe("joelclaw:notify:gateway"),
        catch: (e) => new Error(`Subscribe: ${e}`),
      })

      // Poll for run completion (gateway events are best-effort)
      while (!ended) {
        yield* Effect.tryPromise({
          try: () => new Promise((resolve) => setTimeout(resolve, 5000)),
          catch: () => new Error("sleep"),
        })

        if (ended) break

        // Check timeout
        if (Date.now() - startTime > timeout * 1000) {
          emitLog("warn", `Timeout reached (${timeout}s)`)
          break
        }

        // Check if run is done
        if (runIds[0]) {
          try {
            const runResult = yield* inngestClient.run(runIds[0])
            const status = runResult?.run?.status
            if (status === "COMPLETED") {
              emitLog("info", "Run completed")
              break
            } else if (status === "FAILED") {
              emitLog("error", `Run failed: ${runResult?.errors?.[0]?.message ?? "unknown"}`)
              break
            } else if (status === "CANCELLED") {
              emitLog("warn", "Run was cancelled")
              break
            }
            // RUNNING or QUEUED — keep waiting
          } catch {
            // API error — keep waiting
          }
        }
      }

      // ── Terminal ──────────────────────────────────────────────
      cleanup()
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)

      // Fetch final run state
      let finalState: any = null
      if (runIds[0]) {
        try {
          finalState = yield* inngestClient.run(runIds[0])
        } catch {}
      }

      const ok = finalState?.run?.status !== "FAILED"
      if (ok) {
        emitResult(cmd, {
          event,
          run_id: runIds[0],
          status: finalState?.run?.status ?? "unknown",
          data: payload,
        }, [
          { command: `joelclaw run ${runIds[0]}`, description: "Inspect final run state" },
          { command: `joelclaw runs --count 5`, description: "Recent runs" },
        ])
      } else {
        emitError(cmd, `Run failed: ${finalState?.errors?.[0]?.message ?? "unknown"}`,
          "RUN_FAILED",
          `Check: joelclaw run ${runIds[0]}`, [
            { command: `joelclaw run ${runIds[0]}`, description: "Inspect failed run" },
            { command: `joelclaw logs errors`, description: "Worker error logs" },
          ])
      }
    })
)
