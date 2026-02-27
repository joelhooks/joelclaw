import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import type { NextAction } from "../response"
import { respond } from "../response"

export const runsCmd = Command.make(
  "runs",
  {
    count: Options.integer("count").pipe(
      Options.withAlias("n"),
      Options.withAlias("limit"),
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
      Options.withDescription("Terse JSON row output")
    ),
  },
  ({ count, status, hours, compact }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      const statusVal = status._tag === "Some" ? status.value : undefined
      const result = yield* inngestClient.runs({ count, status: statusVal, hours })

      if (compact) {
        const firstRunId = (result as any[])[0]?.id ?? "RUN_ID"
        const rows = (result as any[]).map((r) => {
          const statusBadge = r.status === "COMPLETED"
            ? "✅"
            : r.status === "FAILED"
              ? "❌"
              : r.status === "RUNNING"
                ? "▶"
                : "⏳"
          const functionName = (r.functionName ?? r.functionID ?? "?").slice(0, 35)
          const started = r.startedAt
            ? new Date(r.startedAt).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })
            : "?"
          return {
            statusBadge,
            functionName,
            started,
            runIdShort: String(r.id).slice(0, 12),
            status: r.status,
          }
        })

        yield* Console.log(respond("runs", { count: rows.length, compact: true, rows }, [
          {
            command: "joelclaw runs [--status <status>] [--hours <hours>]",
            description: "Refine compact list with filters",
            params: {
              status: {
                description: "Run status filter",
                value: statusVal ?? "FAILED",
                enum: ["COMPLETED", "FAILED", "RUNNING", "QUEUED", "CANCELLED"],
              },
              hours: { description: "Lookback window in hours", value: hours, default: 24 },
            },
          },
          {
            command: "joelclaw run <run-id>",
            description: "Inspect one run in detail",
            params: {
              "run-id": { description: "Run ID", value: firstRunId, required: true },
            },
          },
        ]))
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
          command: "joelclaw logs errors [--lines <lines>]",
          description: "Check worker stderr for full stack trace",
          params: {
            lines: { description: "Number of lines", value: 120, default: 120 },
          },
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
          command: "joelclaw logs server [--lines <lines>] [--grep <text>]",
          description: "Server-side logs for this run",
          params: {
            lines: { description: "Number of lines", value: 80, default: 80 },
            text: { description: "Grep filter", value: runId },
          },
        },
      )

      yield* Console.log(respond("run", result, next, result.run.status !== "FAILED"))
    })
)
