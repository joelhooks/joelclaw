import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import type { NextAction } from "../response"
import { respond, respondError } from "../response"

const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"])
const CANCELLED_STATUSES = new Set(["CANCELLED", "CANCELED"])

const sleepMs = (ms: number) =>
  Effect.tryPromise({
    try: () => new Promise((resolve) => setTimeout(resolve, ms)),
    catch: () => new Error("sleep interrupted"),
  })

function isTerminalRunStatus(status: string | null | undefined): boolean {
  return TERMINAL_STATUSES.has((status ?? "").toUpperCase())
}

function normalizeStatus(status: string | null | undefined): string {
  return (status ?? "UNKNOWN").toUpperCase()
}

function buildRunNextActions(result: any, runId: string): NextAction[] {
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

  if (result.run.status === "RUNNING" || result.run.status === "QUEUED") {
    next.push(
      {
        command: "joelclaw run <run-id>",
        description: "Re-check run status",
        params: {
          "run-id": { description: "Run ID", value: runId, required: true },
        },
      },
      {
        command: "joelclaw run <run-id> --cancel",
        description: "Request cancellation",
        params: {
          "run-id": { description: "Run ID", value: runId, required: true },
        },
      },
    )
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

  return next
}

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
        .filter((r: any) => r.status === "FAILED" || r.status === "RUNNING" || r.status === "QUEUED")
        .slice(0, 3)
        .map((r: any) => ({
          command: "joelclaw run <run-id>",
          description: `Inspect ${String(r.status).toLowerCase()} ${r.functionName}`,
          params: {
            "run-id": { description: "Run ID", value: r.id, required: true },
          },
        }))

      const firstActiveRun = (result as any[]).find((r) => r.status === "RUNNING" || r.status === "QUEUED")
      if (firstActiveRun) {
        next.unshift({
          command: "joelclaw run <run-id> --cancel",
          description: `Cancel active run ${firstActiveRun.functionName}`,
          params: {
            "run-id": { description: "Run ID", value: firstActiveRun.id, required: true },
          },
        })
      }

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
    cancel: Options.boolean("cancel").pipe(
      Options.withDefault(false),
      Options.withDescription("Request cancellation before returning run details")
    ),
    waitMs: Options.integer("wait-ms").pipe(
      Options.withDefault(3000),
      Options.withDescription("Max wait for cancellation status change in milliseconds (default: 3000)")
    ),
  },
  ({ runId, cancel, waitMs }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      const initialResult = yield* inngestClient.run(runId)

      if (!cancel) {
        const next = buildRunNextActions(initialResult, runId)
        yield* Console.log(respond("run", initialResult, next, initialResult.run.status !== "FAILED"))
        return
      }

      const initialStatus = normalizeStatus(initialResult.run.status)
      if (isTerminalRunStatus(initialStatus)) {
        const terminalResult = {
          ...initialResult,
          cancellation: {
            requested: false,
            skipped: "already_terminal",
            status: initialStatus,
          },
        }
        const next = buildRunNextActions(terminalResult, runId)
        yield* Console.log(respond("run", terminalResult, next, initialStatus !== "FAILED"))
        return
      }

      const cancelAttempt = yield* inngestClient.cancelRun(runId).pipe(Effect.either)
      if (cancelAttempt._tag === "Left") {
        yield* Console.log(respondError(
          "run",
          `Failed to request cancellation for ${runId}`,
          "RUN_CANCEL_FAILED",
          "Retry with joelclaw run <run-id> --cancel or inspect Inngest server logs",
          [
            {
              command: "joelclaw run <run-id> --cancel",
              description: "Retry cancellation",
              params: {
                "run-id": { description: "Run ID", value: runId, required: true },
              },
            },
            {
              command: "joelclaw logs server [--lines <lines>] [--grep <text>]",
              description: "Inspect cancellation failure in server logs",
              params: {
                lines: { description: "Number of lines", value: 120, default: 80 },
                text: { description: "Grep filter", value: runId },
              },
            },
          ],
        ))
        return
      }

      const safeWaitMs = Math.max(0, waitMs)
      const pollIntervalMs = 500
      const pollAttempts = safeWaitMs === 0 ? 1 : Math.max(1, Math.ceil(safeWaitMs / pollIntervalMs))

      let observedResult = initialResult
      for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
        if (attempt > 0) {
          yield* sleepMs(pollIntervalMs)
        }

        observedResult = yield* inngestClient.run(runId)
        const observedStatus = normalizeStatus(observedResult.run.status)
        if (observedStatus === "CANCELLED" || isTerminalRunStatus(observedStatus)) {
          break
        }
      }

      const mutationStatus = normalizeStatus(cancelAttempt.right?.status)
      const observedStatus = normalizeStatus(observedResult.run.status)
      const cancellationResult = {
        requested: true,
        waitMs: safeWaitMs,
        mutation: cancelAttempt.right,
        mutationStatus,
        observedStatus,
        cancelled: observedStatus === "CANCELLED" || CANCELLED_STATUSES.has(mutationStatus),
      }

      const result = {
        ...observedResult,
        cancellation: cancellationResult,
      }

      const stillActive = observedStatus === "RUNNING" || observedStatus === "QUEUED"
      if (stillActive && !cancellationResult.cancelled) {
        yield* Console.log(respondError(
          "run",
          `Cancellation request for ${runId} did not reach a terminal state within ${safeWaitMs}ms`,
          "RUN_CANCEL_TIMEOUT",
          "Retry cancellation or inspect logs to confirm server-side cancelRun behavior",
          buildRunNextActions(result, runId),
        ))
        return
      }

      const ok = observedStatus !== "FAILED"
      yield* Console.log(respond("run", result, buildRunNextActions(result, runId), ok))
    })
)

export const __runsTestUtils = {
  isTerminalRunStatus,
  normalizeStatus,
  buildRunNextActions,
  cancelledStatuses: [...CANCELLED_STATUSES],
}
