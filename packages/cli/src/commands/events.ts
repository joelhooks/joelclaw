import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import type { NextAction } from "../response"
import { respond } from "../response"

export const eventsCmd = Command.make(
  "events",
  {
    prefix: Options.text("prefix").pipe(
      Options.withAlias("p"),
      Options.optional,
      Options.withDescription("Filter by event name prefix (e.g., memory/, agent/)")
    ),
    hours: Options.integer("hours").pipe(
      Options.withDefault(4),
      Options.withDescription("Look back N hours (default: 4)")
    ),
    count: Options.integer("count").pipe(
      Options.withAlias("n"),
      Options.withDefault(20),
      Options.withDescription("Max events (default: 20)")
    ),
  },
  ({ prefix, hours, count }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      const prefixVal = prefix._tag === "Some" ? prefix.value : undefined
      const result = yield* inngestClient.events({ prefix: prefixVal, hours, count })

      // Terse: just name + time + truncated data
      const events = result.map((e: any) => ({
        id: e.id,
        name: e.name,
        at: e.occurredAt,
        data: truncateData(e.data),
      }))

      // Group by name prefix for summary
      const byPrefix: Record<string, number> = {}
      for (const e of result) {
        const p = (e as any).name.split("/")[0] ?? "other"
        byPrefix[p] = (byPrefix[p] ?? 0) + 1
      }

      const next: NextAction[] = [
        {
          command: "joelclaw events [--prefix <prefix>] [--hours <hours>]",
          description: "Memory pipeline events",
          params: {
            prefix: { description: "Event prefix", value: "memory/" },
            hours: { description: "Lookback window in hours", value: 24, default: 4 },
          },
        },
        {
          command: "joelclaw events [--prefix <prefix>] [--hours <hours>]",
          description: "Agent loop events",
          params: {
            prefix: { description: "Event prefix", value: "agent/" },
            hours: { description: "Lookback window in hours", value: 24, default: 4 },
          },
        },
        {
          command: "joelclaw events [--prefix <prefix>]",
          description: "Pipeline events",
          params: {
            prefix: { description: "Event prefix", value: "pipeline/" },
          },
        },
        {
          command: "joelclaw runs [--count <count>]",
          description: "Runs triggered by events",
          params: {
            count: { description: "Number of runs", value: 5, default: 10 },
          },
        },
      ]

      yield* Console.log(respond("events", {
        count: events.length,
        hours,
        prefix: prefixVal ?? "(all)",
        summary: byPrefix,
        events,
      }, next))
    })
)

/** Truncate data objects to avoid blowing context. Keep keys, trim values. */
function truncateData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "string" && v.length > 100) {
      result[k] = v.slice(0, 100) + `... (${v.length} chars)`
    } else {
      result[k] = v
    }
  }
  return result
}
