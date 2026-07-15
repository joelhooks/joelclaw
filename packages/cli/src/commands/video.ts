import { Args, Command, Options } from "@effect/cli"
import { resolveUsageQueryConfig } from "@joelclaw/system-bus/src/lib/clickhouse-usage-query.ts"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import { respond, respondError } from "../response"

type VideoTraceEvent = {
  timestamp: string
  level: string
  component: string
  action: string
  success: boolean
  error?: string
  durationMs?: number
  metadata: Record<string, unknown>
  runId?: string
}

type RunTrace = {
  runId: string
  graphqlStatus?: string
  coarseRestStatus?: string
  statusDisagreement: boolean
  authorityNote?: string
  detail?: unknown
  error?: string
}

type TraceMismatch = {
  kind: "no_events" | "events_missing_run_id" | "partial_run_correlation" | "run_trace_lookup_failed" | "none"
  message: string | null
  eventsWithoutRunId: number
  runIdsFound: number
  tracesResolved: number
}

const QUERY_TIMEOUT_MS = 15_000
const INNGEST_TIMEOUT_MS = 15_000
const INNGEST_RUN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/u
const SHARE_SLUG = /^[0-9A-Za-z_-]{8,128}$/u

function sqlString(value: string): string {
  return `'${value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'")}'`
}

function sqlIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new Error(`Invalid ClickHouse identifier: ${value}`)
  }
  return value
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return asRecord(value)
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return { raw: value }
  }
}

function parseJsonEachRow(body: string): Record<string, unknown>[] {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return asRecord(JSON.parse(line))
      } catch (error) {
        throw new Error(`Malformed ClickHouse JSONEachRow line ${index + 1}: ${String(error)}`)
      }
    })
}

function coerceBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
}

function normalizeStatus(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : undefined
}

function normalizeLookup(target: string) {
  const input = target.trim()
  const shareSlug = input.startsWith("video:") ? input.slice("video:".length) : input
  if (!SHARE_SLUG.test(shareSlug)) {
    throw new Error("Video target must be an 8-128 character wzrrd share slug or video:<slug> resource ID")
  }
  return { input, resourceId: `video:${shareSlug}`, shareSlug }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

function classifyMismatch(events: readonly VideoTraceEvent[], traces: readonly RunTrace[]): TraceMismatch {
  const eventsWithoutRunId = events.filter((event) => !event.runId).length
  const runIdsFound = new Set(events.flatMap((event) => event.runId ? [event.runId] : [])).size
  const tracesResolved = traces.filter((trace) => !trace.error).length
  if (events.length === 0) {
    return {
      kind: "no_events",
      message: "No video-pipeline/joelclaw-api ClickHouse events matched this target. Historical phase-1 runs predate forensic emission.",
      eventsWithoutRunId: 0,
      runIdsFound: 0,
      tracesResolved: 0,
    }
  }
  if (runIdsFound === 0) {
    return {
      kind: "events_missing_run_id",
      message: "Forensic events exist, but none include metadata.runId, so Inngest runTrace correlation is unavailable.",
      eventsWithoutRunId,
      runIdsFound,
      tracesResolved,
    }
  }
  if (traces.some((trace) => trace.error)) {
    return {
      kind: "run_trace_lookup_failed",
      message: "ClickHouse evidence was found, but at least one Inngest runTrace lookup failed.",
      eventsWithoutRunId,
      runIdsFound,
      tracesResolved,
    }
  }
  if (eventsWithoutRunId > 0) {
    return {
      kind: "partial_run_correlation",
      message: "Some forensic events omit metadata.runId; runTrace coverage is partial.",
      eventsWithoutRunId,
      runIdsFound,
      tracesResolved,
    }
  }
  return {
    kind: "none",
    message: null,
    eventsWithoutRunId,
    runIdsFound,
    tracesResolved,
  }
}

function rowsToEvents(rows: readonly Record<string, unknown>[]): VideoTraceEvent[] {
  return rows.map((row) => {
    const metadata = parseMetadata(row.metadataJson)
    const sessionId = typeof row.sessionId === "string" ? row.sessionId : undefined
    const metadataRunId = typeof metadata.runId === "string" ? metadata.runId : undefined
    const candidateRunId = metadataRunId
      ?? (sessionId && sessionId !== "video-pipeline" && sessionId !== "joelclaw-api" ? sessionId : undefined)
    const durationMs = typeof row.durationMs === "number" ? row.durationMs : Number(row.durationMs)
    return {
      timestamp: String(row.timestampText ?? ""),
      level: String(row.level ?? ""),
      component: String(row.component ?? ""),
      action: String(row.action ?? ""),
      success: coerceBoolean(row.success),
      ...(typeof row.error === "string" && row.error ? { error: row.error } : {}),
      ...(Number.isFinite(durationMs) ? { durationMs } : {}),
      metadata,
      ...(candidateRunId && INNGEST_RUN_ID.test(candidateRunId) ? { runId: candidateRunId } : {}),
    }
  })
}

async function runClickHouseQuery(sql: string): Promise<Record<string, unknown>[]> {
  const config = resolveUsageQueryConfig()
  const headers: Record<string, string> = {}
  if (config.username) headers["X-ClickHouse-User"] = config.username
  if (config.password) headers["X-ClickHouse-Key"] = config.password
  const response = await fetch(config.url, {
    method: "POST",
    headers,
    body: sql,
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`ClickHouse video trace failed (${response.status}): ${await response.text()}`)
  }
  return parseJsonEachRow(await response.text())
}

async function queryVideoEvents(target: string, hours: number, limit: number): Promise<VideoTraceEvent[]> {
  const config = resolveUsageQueryConfig()
  const { resourceId, shareSlug } = normalizeLookup(target)
  const table = `${sqlIdent(config.database)}.${sqlIdent(config.table)}`
  const boundedHours = Math.max(1, Math.min(24 * 365, Math.floor(hours)))
  const boundedLimit = Math.max(1, Math.min(5_000, Math.floor(limit)))
  const select = `SELECT
  toString(timestamp) AS timestampText,
  level,
  component,
  action,
  success,
  error,
  duration_ms AS durationMs,
  metadata_json AS metadataJson,
  coalesce(sessionId, '') AS sessionId
FROM ${table}`
  const targetSql = `${select}
WHERE timestamp > now() - INTERVAL ${boundedHours} HOUR
  AND component IN ('video-pipeline', 'joelclaw-api')
  AND (
    JSONExtractString(metadata_json, 'resourceId') = ${sqlString(resourceId)}
    OR JSONExtractString(metadata_json, 'shareSlug') = ${sqlString(shareSlug)}
  )
ORDER BY timestamp DESC
LIMIT ${boundedLimit}
FORMAT JSONEachRow`
  const targetRows = await runClickHouseQuery(targetSql)
  const targetEvents = rowsToEvents(targetRows)
  const runIds = [...new Set(targetEvents.flatMap((event) => event.runId ? [event.runId] : []))]
  if (runIds.length === 0) return targetEvents.toSorted((a, b) => a.timestamp.localeCompare(b.timestamp))

  const runIdsSql = runIds.map(sqlString).join(", ")
  const runSql = `${select}
WHERE timestamp > now() - INTERVAL ${boundedHours} HOUR
  AND component IN ('video-pipeline', 'joelclaw-api')
  AND (
    JSONExtractString(metadata_json, 'runId') IN (${runIdsSql})
    OR coalesce(sessionId, '') IN (${runIdsSql})
  )
ORDER BY timestamp DESC
LIMIT ${boundedLimit}
FORMAT JSONEachRow`
  const runEvents = rowsToEvents(await runClickHouseQuery(runSql))
  const merged = new Map<string, VideoTraceEvent>()
  for (const event of [...targetEvents, ...runEvents]) {
    merged.set(`${event.timestamp}\u0000${event.component}\u0000${event.action}\u0000${JSON.stringify(event.metadata)}`, event)
  }
  return [...merged.values()].toSorted((a, b) => a.timestamp.localeCompare(b.timestamp))
}

async function queryCoarseRestStatus(runId: string): Promise<{ status?: string; note?: string }> {
  const baseUrl = (process.env.INNGEST_URL ?? "http://127.0.0.1:8288").replace(/\/+$/u, "")
  try {
    const response = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}`, {
      signal: AbortSignal.timeout(INNGEST_TIMEOUT_MS),
    })
    if (!response.ok) return { note: `REST status unavailable (${response.status})` }
    const body = asRecord(await response.json())
    return {
      status: normalizeStatus(body.status)
        ?? normalizeStatus(asRecord(body.data).status)
        ?? normalizeStatus(asRecord(asRecord(body.data).run).status),
    }
  } catch (error) {
    return { note: `REST status unavailable: ${String(error)}` }
  }
}

const targetArg = Args.text({ name: "resourceId|slug" }).pipe(
  Args.withDescription("Video resourceId (video:<slug>) or share slug"),
)
const hoursOpt = Options.integer("hours").pipe(
  Options.withDefault(72),
  Options.withDescription("Lookback window in hours"),
)
const limitOpt = Options.integer("limit").pipe(
  Options.withDefault(500),
  Options.withDescription("Maximum ClickHouse events per query"),
)

const traceCmd = Command.make(
  "trace",
  { target: targetArg, hours: hoursOpt, limit: limitOpt },
  ({ target, hours, limit }) =>
  Effect.gen(function* () {
    const eventsResult = yield* Effect.tryPromise({
      try: () => queryVideoEvents(target, hours, limit),
      catch: (error) => error instanceof Error ? error : new Error(String(error)),
    }).pipe(Effect.either)

    if (eventsResult._tag === "Left") {
      yield* Console.log(respondError(
        "video trace",
        eventsResult.left.message,
        "VIDEO_TRACE_QUERY_FAILED",
        "Check ClickHouse reachability and CLICKHOUSE_QUERY_URL",
        [
          { command: "joelclaw status", description: "Check system health" },
          { command: `joelclaw otel search ${shellQuote(target)} --hours ${hours}`, description: "Search raw OTEL fallback" },
        ],
      ))
      return
    }

    const events = eventsResult.right
    const runIds = [...new Set(events.flatMap((event) => event.runId ? [event.runId] : []))]
    const inngest = yield* Inngest
    const traces = yield* Effect.forEach(
      runIds,
      (runId) => Effect.gen(function* () {
        const [detailResult, coarse] = yield* Effect.all([
          inngest.run(runId).pipe(Effect.either),
          Effect.tryPromise({
            try: () => queryCoarseRestStatus(runId),
            catch: (error) => ({ note: String(error) }),
          }).pipe(Effect.orElseSucceed(() => ({ note: "REST status unavailable" }))),
        ])
        if (detailResult._tag === "Left") {
          return {
            runId,
            statusDisagreement: false,
            coarseRestStatus: coarse.status,
            error: String(detailResult.left),
          } satisfies RunTrace
        }
        const detail = detailResult.right as any
        const graphqlStatus = normalizeStatus(detail?.trace?.status) ?? normalizeStatus(detail?.run?.status)
        const coarseRestStatus = coarse.status
        const statusDisagreement = Boolean(
          graphqlStatus && coarseRestStatus && graphqlStatus !== coarseRestStatus
        )
        return {
          runId,
          graphqlStatus,
          coarseRestStatus,
          statusDisagreement,
          ...(statusDisagreement
            ? { authorityNote: "Statuses disagree. The coarse /v1 REST status can report Scheduled during retry backoff; runTrace GraphQL is authoritative." }
            : coarse.note
              ? { authorityNote: coarse.note }
              : {}),
          detail,
        } satisfies RunTrace
      }),
      { concurrency: 4 },
    )

    const lookup = normalizeLookup(target)
    const rejectedRunIds = [...new Set(events.flatMap((event) => {
      const value = event.metadata.runId
      return typeof value === "string" && !INNGEST_RUN_ID.test(value) ? [value] : []
    }))]
    const mismatch = classifyMismatch(events, traces)
    yield* Console.log(respond(
      "video trace",
      {
        lookup,
        eventCount: events.length,
        events,
        inngest: {
          requestedRunIds: runIds,
          traces,
          lookupErrors: [
            ...traces.filter((trace) => trace.error).map(({ runId, error }) => ({ runId, error })),
            ...rejectedRunIds.map((runId) => ({ runId, error: "Rejected invalid Inngest run ID from telemetry" })),
          ],
        },
        mismatch,
        notes: [
          "This trace covers the local request→upload→handoff. Cloud encode/transcribe history lives in wzrrd.",
          ...(traces.some((trace) => trace.statusDisagreement)
            ? ["runTrace GraphQL wins over coarse /v1 REST status during retry backoff."]
            : []),
        ],
      },
      [
        { command: `joelclaw video trace ${shellQuote(lookup.shareSlug)} --hours ${hours} --limit ${limit}`, description: "Repeat this forensic trace" },
        { command: `joelclaw otel search ${shellQuote(lookup.resourceId)} --hours ${hours}`, description: "Inspect raw OTEL events" },
        { command: `wzrrd video trace ${shellQuote(lookup.shareSlug)}`, description: "Inspect the cloud Workflow trace" },
        ...(runIds[0] ? [{ command: `joelclaw run ${shellQuote(runIds[0])}`, description: "Inspect the first Inngest run" }] : []),
      ],
    ))
  }),
).pipe(Command.withDescription("Reconstruct one video publish from ClickHouse events and Inngest runTrace"))

export const videoCmd = Command.make("video").pipe(
  Command.withDescription("Video pipeline operations"),
  Command.withSubcommands([traceCmd]),
)

export const __videoTestUtils = {
  classifyMismatch,
  normalizeLookup,
  parseJsonEachRow,
  queryVideoEvents,
  shellQuote,
  sqlString,
}
