import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"

export const watchCmd = Command.make(
  "watch",
  {
    loopId: Args.text({ name: "loop-id" }).pipe(
      Args.withDescription("Loop ID to watch (optional — auto-detects)"),
      Args.optional
    ),
    interval: Options.integer("interval").pipe(
      Options.withAlias("i"),
      Options.withDefault(15),
      Options.withDescription("Poll interval in seconds (default: 15)")
    ),
  },
  ({ loopId, interval }) =>
    Effect.gen(function* () {
      const igs = yield* Inngest

      const resolveLoop = async (): Promise<{ id: string; prd: any } | null> => {
        const Redis = (await import("ioredis")).default
        const redis = new Redis({ host: "localhost", port: 6379, lazyConnect: true, connectTimeout: 3000, commandTimeout: 5000 })
        await redis.connect()
        const keys = await redis.keys("agent-loop:prd:*")
        let target: { id: string; prd: any } | null = null
        const wantId = loopId._tag === "Some" ? loopId.value : undefined

        for (const key of keys) {
          const data = await redis.get(key)
          if (!data) continue
          const id = key.replace("agent-loop:prd:", "")
          const prd = JSON.parse(data)
          if (wantId && id === wantId) { target = { id, prd }; break }
          if (!wantId && prd.stories?.some((s: any) => !s.passes && !s.skipped)) {
            if (!target) target = { id, prd }
          }
        }
        await redis.quit()
        return target
      }

      const formatStatus = (loop: { id: string; prd: any }, events: any[]): string => {
        const stories = loop.prd.stories ?? []
        const passed = stories.filter((s: any) => s.passes).length
        const skipped = stories.filter((s: any) => s.skipped).length
        const total = stories.length

        // Find active story from events
        const myEvents = events.filter((e: any) => e.data?.loopId === loop.id)
        const latest = myEvents[0]

        const lines: string[] = []
        const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
        lines.push(`[${time}] ${loop.id} | ${passed}/${total}${skipped ? ` (${skipped} skip)` : ""}`)

        for (const s of stories) {
          let icon: string
          if (s.passes) icon = "✅"
          else if (s.skipped) icon = "⏭"
          else if (latest?.data?.storyId === s.id) {
            const role = latest.name.replace("agent/loop.", "")
            const elapsed = latest.occurredAt
              ? `${Math.round((Date.now() - new Date(latest.occurredAt).getTime()) / 1000)}s`
              : "?"
            icon = `▶ ${role} (${elapsed})`
          } else icon = "⏳"
          lines.push(`  ${icon}  ${s.id}: ${s.title}`)
        }
        return lines.join("\n")
      }

      // Initial resolve
      const loop = yield* Effect.tryPromise({
        try: resolveLoop,
        catch: (e) => new Error(`${e}`),
      })

      if (!loop) {
        yield* Console.log("No active loop found.")
        return
      }

      yield* Console.log(`Watching ${loop.id} | ${loop.prd.title ?? "?"} (every ${interval}s, ctrl-c to stop)\n`)

      // Poll loop
      let lastOutput = ""
      let done = false

      while (!done) {
        const freshLoop = yield* Effect.tryPromise({
          try: resolveLoop,
          catch: (e) => new Error(`${e}`),
        })

        if (!freshLoop) {
          yield* Console.log("Loop removed from Redis — completed or cancelled.")
          done = true
          break
        }

        const events = yield* igs.events({ prefix: "agent/loop", hours: 4, count: 50 })
        const output = formatStatus(freshLoop, events as any[])

        if (output !== lastOutput) {
          yield* Console.log(output)
          lastOutput = output
        }

        // Check if all done
        const allDone = freshLoop.prd.stories?.every((s: any) => s.passes || s.skipped)
        if (allDone) {
          yield* Console.log(`\n🏁 Loop complete: ${freshLoop.prd.stories.filter((s: any) => s.passes).length} passed, ${freshLoop.prd.stories.filter((s: any) => s.skipped).length} skipped`)
          done = true
          break
        }

        // Sleep
        yield* Effect.tryPromise({
          try: () => new Promise(resolve => setTimeout(resolve, interval * 1000)),
          catch: () => new Error("sleep interrupted"),
        })
      }
    })
)
