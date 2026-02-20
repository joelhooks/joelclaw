import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import { respond } from "../response"
import type { NextAction } from "../response"

export const runsCmd = Command.make(
  "runs",
  {
    count: Options.integer("count").pipe(
      Options.withAlias("n"),
      Options.withDefault(10),
      Options.withDescription("Number of runs to show")
    ),
    status: Options.text("status").pipe(
      Options.withAlias("s"),
      Options.optional,
      Options.withDescription("Filter: COMPLETED, FAILED, RUNNING, QUEUED, CANCELLED")
    ),
    hours: Options.integer("hours").pipe(
      Options.withDefault(24),
      Options.withDescription("Look back N hours (default: 24)")
    ),
    compact: Options.boolean("compact").pipe(
      Options.withAlias("c"),
      Options.withDefault(false),
      Options.withDescription("Terse plain-text output")
    ),
  },
  ({ count, status, hours, compact }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      const statusVal = status._tag === "Some" ? status.value : undefined
      const result = yield* inngestClient.runs({ count, status: statusVal, hours })

      if (compact) {
        for (const r of result as any[]) {
          const st = r.status === "COMPLETED" ? "✅" : r.status === "FAILED" ? "❌" : r.status === "RUNNING" ? "▶" : "⏳"
          const name = (r.functionName ?? r.functionID ?? "?").slice(0, 35).padEnd(35)
          const time = r.startedAt ? new Date(r.startedAt).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" }) : "?"
          yield* Console.log(`${st} ${name} ${time}  ${r.id.slice(0, 12)}`)
        }
        return
      }

      const next: NextAction[] = result
        .filter((r: any) => r.status === "FAILED" || r.status === "RUNNING")
        .slice(0, 3)
        .map((r: any) => ({
          command: "joelclaw run <run-id>",
          description: `Inspect ${r.status.toLowerCase()} ${r.functionName}`,
          params: {
            "run-id": { description: "Run ID", value: r.id, required: true },
          },
        }))

      next.push(
        {
          command: "joelclaw runs [--status <status>]",
          description: "Show only failures",
          params: {
            status: {
              description: "Run status filter",
              value: "FAILED",
              enum: ["COMPLETED", "FAILED", "RUNNING", "QUEUED", "CANCELLED"],
            },
          },
        },
        {
          command: "joelclaw runs [--hours <hours>] [--count <count>]",
          description: "Wider time range",
          params: {
            hours: { description: "Lookback window in hours", value: 48, default: 24 },
            count: { description: "Number of runs", value: 20, default: 10 },
          },
        },
      )

      yield* Console.log(respond("runs", { count: result.length, runs: result }, next))
    })
)

export const runCmd = Command.make(
  "run",
  {
    runId: Args.text({ name: "run-id" }).pipe(
      Args.withDescription("Run ID (ULID)")
    ),
  },
  ({ runId }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      const result = yield* inngestClient.run(runId)

      const next: NextAction[] = []

      if (result.run.status === "FAILED" && result.errors) {
        next.push({
          command: `tail -30 ~/.local/log/system-bus-worker.err`,
          description: "Check worker stderr for full stack trace",
        })
      }
      if (result.run.status === "RUNNING") {
        next.push({
          command: "joelclaw run <run-id>",
          description: "Re-check (still running)",
          params: {
            "run-id": { description: "Run ID", value: runId, required: true },
          },
        })
      }
      if (result.trigger?.IDs?.[0]) {
        next.push({
          command: "joelclaw event <event-id>",
          description: "View the trigger event payload",
          params: {
            "event-id": { description: "Event ID", value: result.trigger.IDs[0], required: true },
          },
        })
      }
      next.push(
        {
          command: "joelclaw runs [--count <count>]",
          description: "See surrounding runs",
          params: {
            count: { description: "Number of runs", value: 5, default: 10 },
          },
        },
        {
          command: 'docker logs system-bus-inngest-1 2>&1 | grep "<run-id>" | tail -5',
          description: "Server-side logs for this run",
          params: {
            "run-id": { description: "Run ID", value: runId, required: true },
          },
        },
      )

      yield* Console.log(respond("run", result, next, result.run.status !== "FAILED"))
    })
)
