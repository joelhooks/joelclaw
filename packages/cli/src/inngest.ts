import {
  buildServiceHealthCandidates,
  resolveEndpoint,
  summarizeSkippedCandidates,
} from "@joelclaw/endpoint-resolver"
import { Effect, Schema } from "effect"
import { loadConfig } from "./config"
import {
  EventsV2Response,
  InngestFunction,
  LoopEventData,
  RunsResponse,
  RunTrigger,
  SpanOutput,
} from "./schema"

const cfg = loadConfig()
const GQL = `${cfg.inngestUrl}/v0/gql`
const EVENT_API = `${cfg.inngestUrl}/e/${cfg.eventKey}`
const GQL_TIMEOUT_MS = Math.max(
  5000,
  Number.parseInt(process.env.JOELCLAW_INNGEST_GQL_TIMEOUT_MS ?? "20000", 10),
)
const RUNS_GQL_TIMEOUT_MS = Math.max(
  GQL_TIMEOUT_MS,
  Number.parseInt(process.env.JOELCLAW_INNGEST_RUNS_GQL_TIMEOUT_MS ?? "60000", 10),
)
const RUNS_GQL_TIMEOUT_STEP_MS = Math.max(
  5000,
  Number.parseInt(process.env.JOELCLAW_INNGEST_RUNS_GQL_TIMEOUT_STEP_MS ?? "30000", 10),
)
const RUNS_GQL_MAX_TIMEOUT_MS = Math.max(
  RUNS_GQL_TIMEOUT_MS,
  Number.parseInt(process.env.JOELCLAW_INNGEST_RUNS_GQL_MAX_TIMEOUT_MS ?? "180000", 10),
)
const DETAIL_GQL_TIMEOUT_MS = Math.max(
  GQL_TIMEOUT_MS,
  Number.parseInt(process.env.JOELCLAW_INNGEST_DETAIL_GQL_TIMEOUT_MS ?? "75000", 10),
)
const DETAIL_GQL_TIMEOUT_STEP_MS = Math.max(
  5000,
  Number.parseInt(process.env.JOELCLAW_INNGEST_DETAIL_GQL_TIMEOUT_STEP_MS ?? "30000", 10),
)
const DETAIL_GQL_MAX_TIMEOUT_MS = Math.max(
  DETAIL_GQL_TIMEOUT_MS,
  Number.parseInt(process.env.JOELCLAW_INNGEST_DETAIL_GQL_MAX_TIMEOUT_MS ?? "150000", 10),
)
const HEALTH_PROBE_TIMEOUT_MS = Math.max(
  600,
  Number.parseInt(process.env.JOELCLAW_HEALTH_PROBE_TIMEOUT_MS ?? "1500", 10),
)

type GqlOptions = {
  timeoutMs?: number
  retryTimeoutMs?: number
}

// ── Errors ───────────────────────────────────────────────────────────

class InngestError {
  readonly _tag = "InngestError"
  constructor(readonly message: string, readonly cause?: unknown) {}
}

// ── GQL helper ───────────────────────────────────────────────────────

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const name = "name" in error ? String((error as { name?: unknown }).name ?? "") : ""
  const message = "message" in error ? String((error as { message?: unknown }).message ?? "") : ""
  return name === "AbortError" || /aborted|timed out/i.test(message)
}

function resolveRunsGqlTimeoutMs(count: number): number {
  const safeCount = Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 10

  if (safeCount <= 10) return RUNS_GQL_TIMEOUT_MS
  if (safeCount <= 50) return Math.min(RUNS_GQL_MAX_TIMEOUT_MS, RUNS_GQL_TIMEOUT_MS + RUNS_GQL_TIMEOUT_STEP_MS)
  if (safeCount <= 150) return Math.min(RUNS_GQL_MAX_TIMEOUT_MS, RUNS_GQL_TIMEOUT_MS + RUNS_GQL_TIMEOUT_STEP_MS * 2)

  return RUNS_GQL_MAX_TIMEOUT_MS
}

function resolveDetailGqlTimeoutMs(): number {
  return DETAIL_GQL_TIMEOUT_MS
}

function resolveDetailGqlOptions(): GqlOptions {
  const timeoutMs = resolveDetailGqlTimeoutMs()
  return {
    timeoutMs,
    retryTimeoutMs: Math.min(DETAIL_GQL_MAX_TIMEOUT_MS, timeoutMs + DETAIL_GQL_TIMEOUT_STEP_MS),
  }
}

const gql = (
  query: string,
  variables?: Record<string, unknown>,
  options?: GqlOptions,
) =>
  Effect.tryPromise({
    try: async () => {
      const execute = async (timeoutMs: number) => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const res = await fetch(GQL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              query,
              ...(variables ? { variables } : {}),
            }),
            signal: controller.signal,
          })
          const json = await res.json() as { errors?: Array<{ message: string }>; data: any }
          if (json.errors?.length) throw new Error(json.errors[0].message)
          return json.data
        } finally {
          clearTimeout(timer)
        }
      }

      const timeoutMs = options?.timeoutMs ?? GQL_TIMEOUT_MS

      try {
        return await execute(timeoutMs)
      } catch (error) {
        const retryTimeoutMs = options?.retryTimeoutMs
        if (
          retryTimeoutMs != null
          && retryTimeoutMs > timeoutMs
          && isAbortLikeError(error)
        ) {
          return await execute(retryTimeoutMs)
        }
        throw error
      }
    },
    catch: (e) => new InngestError("GQL request failed", e),
  })

// ── Service ──────────────────────────────────────────────────────────

export class Inngest extends Effect.Service<Inngest>()("joelclaw/Inngest", {
  sync: () => {
    // ── send event ─────────────────────────────────────────────────

    const send = Effect.fn("Inngest.send")(function* (
      name: string,
      data: Record<string, unknown>
    ) {
      return yield* Effect.tryPromise({
        try: async () => {
          const res = await fetch(EVENT_API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, data }),
          })
          return await res.json()
        },
        catch: (e) => new InngestError("Failed to send event", e),
      })
    })

    // ── list functions ─────────────────────────────────────────────

    const loadFunctions = (options?: GqlOptions) => Effect.gen(function* () {
      const data = yield* gql(`{
        functions {
          id slug name
          triggers { type value }
        }
      }`, undefined, options)
      return data.functions as Array<{
        id: string; slug: string; name: string
        triggers: Array<{ type: string; value: string }>
      }>
    })

    const functions = Effect.fn("Inngest.functions")(function* () {
      return yield* loadFunctions()
    })

    // ── list runs ──────────────────────────────────────────────────

    const runs = Effect.fn("Inngest.runs")(function* (opts: {
      count?: number
      status?: string
      hours?: number
    }) {
      const count = opts.count ?? 10
      const hours = opts.hours ?? 24
      const from = new Date(Date.now() - hours * 3600_000).toISOString()
      const statusFilter = opts.status ? `, status: [${opts.status}]` : ""
      const timeoutMs = resolveRunsGqlTimeoutMs(count)
      const retryTimeoutMs = Math.min(RUNS_GQL_MAX_TIMEOUT_MS, timeoutMs + RUNS_GQL_TIMEOUT_STEP_MS)

      const data = yield* gql(`{
        runs(
          filter: { from: "${from}"${statusFilter} }
          orderBy: [{ field: STARTED_AT, direction: DESC }]
          first: ${count}
        ) {
          edges { node { id status functionID startedAt endedAt output } }
        }
      }`, undefined, { timeoutMs, retryTimeoutMs })

      // resolve function names
      const fns = yield* functions()
      const fnMap = new Map(fns.map((f) => [f.id, f.name]))

      return (data.runs.edges as Array<{ node: any }>).map((e) => ({
        ...e.node,
        functionName: fnMap.get(e.node.functionID) ?? e.node.functionID,
      }))
    })

    // ── single run detail ──────────────────────────────────────────

    const run = Effect.fn("Inngest.run")(function* (runID: string) {
      const detailGqlOptions = resolveDetailGqlOptions()
      const [runData, triggerData, traceData] = yield* Effect.all([
        gql(`{ run(runID: "${runID}") { id status functionID startedAt endedAt output traceID } }`, undefined, detailGqlOptions),
        gql(`{ runTrigger(runID: "${runID}") { eventName IDs timestamp } }`, undefined, detailGqlOptions),
        gql(`{
          runTrace(runID: "${runID}") {
            name status attempts duration isRoot startedAt endedAt
            stepOp stepID outputID
            childrenSpans {
              name status attempts duration startedAt endedAt
              stepOp stepID outputID
              childrenSpans {
                name status attempts duration startedAt endedAt
                stepOp stepID outputID
              }
            }
          }
        }`, undefined, detailGqlOptions),
      ])

      // resolve function name
      const fns = yield* loadFunctions(detailGqlOptions)
      const fnMap = new Map(fns.map((f) => [f.id, f.name]))

      // fetch errors for failed steps
      const steps = flattenSpans(traceData.runTrace)
      const failedSteps = steps.filter((step) => step.status === "FAILED" && step.outputID)
      const errorEntries = yield* Effect.forEach(
        failedSteps,
        (step) => Effect.gen(function* () {
          try {
            const output = yield* gql(`{
              runTraceSpanOutputByID(outputID: "${step.outputID}") {
                data error { message name stack }
              }
            }`, undefined, detailGqlOptions)
            return [step.name, output.runTraceSpanOutputByID] as const
          } catch {
            return undefined
          }
        }),
        { concurrency: 4 },
      )
      const errors: Record<string, any> = {}
      for (const entry of errorEntries) {
        if (!entry) continue
        errors[entry[0]] = entry[1]
      }

      return {
        run: {
          ...runData.run,
          functionName: fnMap.get(runData.run.functionID) ?? runData.run.functionID,
        },
        trigger: triggerData.runTrigger,
        trace: traceData.runTrace,
        errors: Object.keys(errors).length > 0 ? errors : undefined,
      }
    })

    // ── cancel run ────────────────────────────────────────────────

    const cancelRun = Effect.fn("Inngest.cancelRun")(function* (runID: string) {
      const data = (yield* gql(`
        mutation CancelRun($runID: ULID!) {
          cancelRun(runID: $runID) {
            id
            status
          }
        }
      `, { runID })) as {
        cancelRun?: {
          id?: string | null
          status?: string | null
        } | null
      }

      return data.cancelRun ?? null
    })

    // ── events ─────────────────────────────────────────────────────

    const events = Effect.fn("Inngest.events")(function* (opts: {
      prefix?: string
      hours?: number
      count?: number
    }) {
      const hours = opts.hours ?? 4
      const count = opts.count ?? 100
      const from = new Date(Date.now() - hours * 3600_000).toISOString()

      const data = yield* gql(`{
        eventsV2(first: ${count}, filter: {
          from: "${from}",
          includeInternalEvents: false
        }) {
          edges { node { id name occurredAt raw } }
        }
      }`)

      const decoded = Schema.decodeUnknownSync(EventsV2Response)(data)

      const results = decoded.eventsV2.edges
        .map((e) => {
          const raw = JSON.parse(e.node.raw ?? "{}")
          return {
            id: e.node.id,
            name: e.node.name,
            occurredAt: e.node.occurredAt,
            data: raw.data ?? {},
          }
        })
        .filter((e) => !opts.prefix || e.name.startsWith(opts.prefix))

      return results
    })

    // ── single event + its runs ──────────────────────────────────

    const event = Effect.fn("Inngest.event")(function* (eventID: string) {
      const detailGqlOptions = resolveDetailGqlOptions()
      const data = yield* gql(`{
        event(query: { eventId: "${eventID}" }) {
          id name createdAt raw pendingRuns totalRuns
          functionRuns { id status functionID startedAt finishedAt output }
        }
      }`, undefined, detailGqlOptions)

      const ev = data.event
      if (!ev) return { event: null, runs: [] }

      // resolve function names
      const fns = yield* loadFunctions(detailGqlOptions)
      const fnMap = new Map(fns.map((f) => [f.id, f.name]))

      let payload: Record<string, unknown> = {}
      try { payload = JSON.parse(ev.raw ?? "{}").data ?? {} } catch {}

      return {
        event: {
          id: ev.id,
          name: ev.name,
          createdAt: ev.createdAt,
          pendingRuns: ev.pendingRuns,
          totalRuns: ev.totalRuns,
          data: payload,
        },
        runs: (ev.functionRuns ?? []).map((r: any) => ({
          id: r.id,
          status: r.status,
          functionID: r.functionID,
          functionName: fnMap.get(r.functionID) ?? r.functionID,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          output: r.output,
        })),
      }
    })

    // ── health ─────────────────────────────────────────────────────

    const health = Effect.fn("Inngest.health")(function* () {
      const checks: Record<string, { ok: boolean; detail?: string }> = {}

      checks.server = yield* Effect.tryPromise({
        try: () => probeServerHealth(),
        catch: () => ({ ok: false, detail: "unreachable" }),
      })

      checks.worker = yield* Effect.tryPromise({
        try: () => probeWorkerHealth(),
        catch: () => ({ ok: false, detail: "unreachable" }),
      })

      // k8s pods
      try {
        const proc = Bun.spawnSync(["kubectl", "get", "pods", "-n", "joelclaw", "--no-headers", "-o", "custom-columns=NAME:.metadata.name,STATUS:.status.phase,READY:.status.containerStatuses[0].ready"])
        const output = proc.stdout.toString().trim()
        const pods = output.split("\n").filter(Boolean)
        const activePods = pods.filter((line) => {
          const [, status] = line.trim().split(/\s+/, 3)
          return status !== "Succeeded" && status !== "Completed"
        })
        const allRunning = activePods.length > 0 && activePods.every(p => p.includes("Running") && p.includes("true"))
        checks.k8s = { ok: allRunning, detail: pods.join(" | ") }
      } catch {
        checks.k8s = { ok: false, detail: "kubectl not available or k3d cluster not running" }
      }

      // agent-mail server
      checks.agent_mail = yield* Effect.tryPromise({
        try: async () => {
          const mailUrl = process.env.AGENT_MAIL_URL?.trim() || "http://127.0.0.1:8765"
          const resp = await fetch(`${mailUrl}/health/liveness`, { signal: AbortSignal.timeout(3000) })
          if (resp.ok) {
            const body = await resp.json() as { status?: string }
            return { ok: body.status === "alive", detail: body.status ?? "unknown" }
          }
          return { ok: false, detail: `HTTP ${resp.status}` }
        },
        catch: () => ({ ok: false, detail: "unreachable — check launchd: launchctl list | grep agent-mail" }),
      })

      return checks
    })

    return { send, functions, runs, run, cancelRun, event, events, health } as const
  },
}) {}

// ── helpers ──────────────────────────────────────────────────────────

type HealthCheck = { ok: boolean; detail: string }

function formatSkippedEndpointSummary(detailPrefix: string, skippedCount: number): string {
  return skippedCount > 0 ? `${detailPrefix}; skipped=${skippedCount}` : detailPrefix
}

async function probeServerHealth(): Promise<HealthCheck> {
  const resolution = await resolveEndpoint(
    buildServiceHealthCandidates("inngest"),
    { timeoutMs: HEALTH_PROBE_TIMEOUT_MS },
  )

  if (!resolution.ok) {
    return {
      ok: false,
      detail: `unreachable (${resolution.reason})`,
    }
  }

  const bodyDetail = resolution.body.trim().length > 0 ? resolution.body.trim() : `HTTP ${resolution.status}`
  const detail = `${bodyDetail} [${resolution.endpointClass}] (${resolution.probeUrl})`

  return {
    ok: true,
    detail: formatSkippedEndpointSummary(detail, resolution.skippedCandidates.length),
  }
}

function parseWorkerDetail(rawBody: string, endpoint: string, status: number): string {
  if (!rawBody) return `ok (${endpoint})`

  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>
    const functions = Array.isArray(parsed.functions)
      ? parsed.functions.filter((value): value is string => typeof value === "string")
      : []

    if (functions.length > 0) return functions.join(", ")

    const workerStatus = typeof parsed.status === "string" ? parsed.status : undefined
    if (workerStatus && workerStatus.length > 0) return `${workerStatus} (${endpoint})`

    const service = typeof parsed.service === "string" ? parsed.service : undefined
    if (service && service.length > 0) return `${service} (${endpoint})`
  } catch {
    // plain-text endpoint; fall through
  }

  const compact = rawBody.replace(/\s+/gu, " ").trim()
  return compact.length > 0 ? compact.slice(0, 400) : `HTTP ${status} (${endpoint})`
}

async function probeWorkerHealth(): Promise<HealthCheck> {
  const resolution = await resolveEndpoint(
    buildServiceHealthCandidates("worker"),
    { timeoutMs: HEALTH_PROBE_TIMEOUT_MS },
  )

  if (!resolution.ok) {
    return {
      ok: false,
      detail: `unreachable (${summarizeSkippedCandidates(resolution.skippedCandidates)})`,
    }
  }

  const workerDetail = parseWorkerDetail(resolution.body, resolution.probeUrl, resolution.status)
  const detailWithClass = `${workerDetail} [${resolution.endpointClass}]`

  return {
    ok: true,
    detail: formatSkippedEndpointSummary(detailWithClass, resolution.skippedCandidates.length),
  }
}

export const __inngestHealthTestUtils = {
  probeServerHealth,
  probeWorkerHealth,
  resolveRunsGqlTimeoutMs,
  resolveDetailGqlTimeoutMs,
  resolveDetailGqlOptions,
}

function flattenSpans(span: any): Array<{ name: string; status: string; outputID?: string }> {
  const result: Array<{ name: string; status: string; outputID?: string }> = []
  if (span.name && !span.isRoot) {
    result.push({ name: span.name, status: span.status, outputID: span.outputID })
  }
  for (const child of span.childrenSpans ?? []) {
    result.push(...flattenSpans(child))
  }
  return result
}
