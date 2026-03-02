import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import type { NextAction } from "../response"
import { respond, respondError } from "../response"

const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"])
const CANCELLED_STATUSES = new Set(["CANCELLED", "CANCELED"])
const RUNNING_GHOST_DETAIL_LOOKUPS_MAX = 5
const HEALTH_CHECK_FUNCTIONS = new Set(["check/o11y-triage", "check/system-health"])
const RUNNING_GHOST_AGE_MINUTES = 30

type RunningGhostSignal = {
  likely: boolean
  confidence: "low" | "medium" | "high"
  reasons: string[]
  detailStatus: string | null
  ageMinutes: number | null
}

type RunningGhostDetailResult = {
  detail?: any
  error?: string
}

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

function filterRunsByStatus(rows: any[], status: string | undefined): any[] {
  if (!status) return rows
  const wanted = normalizeStatus(status)
  return rows.filter((row) => normalizeStatus(row?.status) === wanted)
}

function hasSdkReachabilityError(errors: Record<string, any> | undefined): boolean {
  if (!errors) return false
  return Object.values(errors).some((entry) => {
    const message = String(entry?.error?.message ?? "")
    const stack = String(entry?.error?.stack ?? "")
    const payload = `${message} ${stack}`
    return /Unable to reach SDK URL|EOF writing request to SDK/i.test(payload)
  })
}

function ageMinutesFromStartedAt(startedAt: unknown): number | null {
  if (typeof startedAt !== "string" || startedAt.trim().length === 0) return null
  const startedMs = Date.parse(startedAt)
  if (!Number.isFinite(startedMs)) return null
  const ageMs = Date.now() - startedMs
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0
  return Math.floor(ageMs / 60000)
}

function flattenTraceSpans(trace: any): any[] {
  const spans: any[] = []

  const visit = (span: any) => {
    if (!span || typeof span !== "object") return
    spans.push(span)
    const children = Array.isArray(span.childrenSpans) ? span.childrenSpans : []
    for (const child of children) {
      visit(child)
    }
  }

  visit(trace)
  return spans
}

function hasRunningExecutionSpan(trace: any): boolean {
  return flattenTraceSpans(trace).some((span) => (
    String(span?.name ?? "").toLowerCase() === "execution"
    && normalizeStatus(span?.status) === "RUNNING"
  ))
}

function hasFailedFinalizationSpan(trace: any): boolean {
  return flattenTraceSpans(trace).some((span) => (
    String(span?.name ?? "").toLowerCase() === "finalization"
    && normalizeStatus(span?.status) === "FAILED"
  ))
}

function needsRunningGhostDetailCheck(row: any): boolean {
  if (normalizeStatus(row?.status) !== "RUNNING") return false
  if (row?.endedAt) return true

  const fnName = String(row?.functionName ?? row?.functionID ?? "")
  const ageMinutes = ageMinutesFromStartedAt(row?.startedAt)
  if (!HEALTH_CHECK_FUNCTIONS.has(fnName)) return false

  return ageMinutes != null && ageMinutes >= RUNNING_GHOST_AGE_MINUTES
}

function detectLikelyStaleRunningGhost(listRun: any, detailResult?: RunningGhostDetailResult): RunningGhostSignal | null {
  if (normalizeStatus(listRun?.status) !== "RUNNING") return null

  const reasons: string[] = []
  const ageMinutes = ageMinutesFromStartedAt(listRun?.startedAt)

  if (listRun?.endedAt) {
    reasons.push("list_ended_at_present_while_running")
  }

  const fnName = String(listRun?.functionName ?? listRun?.functionID ?? "")
  if (HEALTH_CHECK_FUNCTIONS.has(fnName) && ageMinutes != null && ageMinutes >= RUNNING_GHOST_AGE_MINUTES) {
    reasons.push("health_check_running_older_than_30m")
  }

  let detailStatus: string | null = null
  let sdkReachabilityError = false

  if (detailResult?.detail) {
    detailStatus = normalizeStatus(detailResult.detail?.run?.status)
    sdkReachabilityError = hasSdkReachabilityError(detailResult.detail?.errors)

    if (detailStatus !== "RUNNING" && detailStatus !== "QUEUED") {
      reasons.push(`list_detail_status_mismatch:${detailStatus}`)
    }

    if (sdkReachabilityError) {
      reasons.push("sdk_unreachable_error")
    }

    const finalizationFailed = hasFailedFinalizationSpan(detailResult.detail?.trace)
    const executionRunning = hasRunningExecutionSpan(detailResult.detail?.trace)
    if (finalizationFailed && !executionRunning && sdkReachabilityError) {
      reasons.push("finalization_failed_without_execution")
    }
  }

  if (detailResult?.error) {
    reasons.push("detail_lookup_failed")
  }

  if (reasons.length === 0) return null

  const likely = reasons.some((reason) => reason.startsWith("list_detail_status_mismatch:"))
    || reasons.includes("finalization_failed_without_execution")
    || (reasons.includes("list_ended_at_present_while_running") && reasons.includes("sdk_unreachable_error"))

  const confidence: RunningGhostSignal["confidence"] = likely
    ? (reasons.some((reason) => reason.startsWith("list_detail_status_mismatch:")) ? "high" : "medium")
    : "low"

  return {
    likely,
    confidence,
    reasons,
    detailStatus,
    ageMinutes,
  }
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
      const filteredResult = filterRunsByStatus(result as any[], statusVal)

      const ghostDetailCandidates = (filteredResult as any[])
        .filter((row) => needsRunningGhostDetailCheck(row))
        .slice(0, RUNNING_GHOST_DETAIL_LOOKUPS_MAX)

      const ghostDetailPairs = yield* Effect.forEach(
        ghostDetailCandidates,
        (row: any) =>
          inngestClient.run(String(row.id)).pipe(
            Effect.map((detail) => [String(row.id), { detail }] as const),
            Effect.catchAll((error) => Effect.succeed([
              String(row.id),
              { error: error instanceof Error ? error.message : String(error) },
            ] as const)),
          ),
        { concurrency: 3 },
      )

      const ghostDetailMap = new Map<string, RunningGhostDetailResult>(ghostDetailPairs)

      const enrichedRuns = (filteredResult as any[]).map((row) => {
        const runId = String(row?.id ?? "")
        const staleSignal = detectLikelyStaleRunningGhost(row, ghostDetailMap.get(runId))
        if (!staleSignal) return row
        return {
          ...row,
          staleSignal,
        }
      })

      const staleSignals = enrichedRuns
        .map((row: any) => row.staleSignal)
        .filter((signal: RunningGhostSignal | undefined): signal is RunningGhostSignal => !!signal)
      const likelyStaleRuns = enrichedRuns.filter((row: any) => row.staleSignal?.likely)

      if (compact) {
        const firstRunId = (enrichedRuns as any[])[0]?.id ?? "RUN_ID"
        const rows = (enrichedRuns as any[]).map((r) => {
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

        yield* Console.log(respond("runs", {
          count: rows.length,
          compact: true,
          staleSignals: {
            detected: staleSignals.length,
            likely: likelyStaleRuns.length,
            detailChecked: ghostDetailMap.size,
          },
          rows,
        }, [
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

      const next: NextAction[] = enrichedRuns
        .filter((r: any) => r.status === "FAILED" || r.status === "RUNNING" || r.status === "QUEUED")
        .slice(0, 3)
        .map((r: any) => ({
          command: "joelclaw run <run-id>",
          description: `Inspect ${String(r.status).toLowerCase()} ${r.functionName}`,
          params: {
            "run-id": { description: "Run ID", value: r.id, required: true },
          },
        }))

      const firstActiveRun = (enrichedRuns as any[]).find((r) => r.status === "RUNNING" || r.status === "QUEUED")
      if (firstActiveRun) {
        next.unshift({
          command: "joelclaw run <run-id> --cancel",
          description: `Cancel active run ${firstActiveRun.functionName}`,
          params: {
            "run-id": { description: "Run ID", value: firstActiveRun.id, required: true },
          },
        })
      }

      if (likelyStaleRuns.length > 0) {
        next.unshift(
          {
            command: "joelclaw inngest sweep-stale-runs",
            description: `Preview stale RUNNING ghost candidates (${likelyStaleRuns.length} likely in current list)`,
          },
          {
            command: "joelclaw run <run-id>",
            description: "Inspect likely stale RUNNING ghost",
            params: {
              "run-id": {
                description: "Run ID",
                value: likelyStaleRuns[0].id,
                required: true,
              },
            },
          },
        )
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

      yield* Console.log(respond("runs", {
        count: enrichedRuns.length,
        staleSignals: {
          detected: staleSignals.length,
          likely: likelyStaleRuns.length,
          detailChecked: ghostDetailMap.size,
        },
        runs: enrichedRuns,
      }, next))
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
        const sdkReachabilityIssue = hasSdkReachabilityError(initialResult.errors)

        if (sdkReachabilityIssue && initialStatus === "RUNNING") {
          const next = [
            {
              command: "joelclaw inngest status",
              description: "Confirm SDK endpoint and worker registration are healthy",
            },
            {
              command: "joelclaw run <run-id>",
              description: "Re-check stale run status",
              params: {
                "run-id": { description: "Run ID", value: runId, required: true },
              },
            },
            {
              command: "joelclaw logs server --grep \"Unable to reach SDK URL\"",
              description: "Inspect server-side SDK reachability failures",
            },
          ]

          yield* Console.log(respondError(
            "run",
            `Run ${runId} is stuck in RUNNING after SDK reachability failure; cancellation endpoint cannot find a cancellable execution`,
            "RUN_STALE_SDK_UNREACHABLE",
            "Treat as stale run metadata. Validate current worker health; new runs should complete normally.",
            next,
          ))
          return
        }

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
  filterRunsByStatus,
  hasSdkReachabilityError,
  ageMinutesFromStartedAt,
  hasRunningExecutionSpan,
  hasFailedFinalizationSpan,
  needsRunningGhostDetailCheck,
  detectLikelyStaleRunningGhost,
  buildRunNextActions,
  cancelledStatuses: [...CANCELLED_STATUSES],
}
