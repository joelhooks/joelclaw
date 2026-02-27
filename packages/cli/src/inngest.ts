import { Effect, Schema } from "effect"
import { loadConfig } from "./config"
import {EventsV2Response, 
  InngestFunction, LoopEventData,RunsResponse, RunTrigger,
  SpanOutput, 
} from "./schema"

const cfg = loadConfig()
const GQL = `${cfg.inngestUrl}/v0/gql`
const EVENT_API = `${cfg.inngestUrl}/e/${cfg.eventKey}`
const WORKER = cfg.workerUrl
const INNGEST_HEALTH = `${cfg.inngestUrl}/health`
const GQL_TIMEOUT_MS = Math.max(
  5000,
  Number.parseInt(process.env.JOELCLAW_INNGEST_GQL_TIMEOUT_MS ?? "20000", 10)
)

// ── Errors ───────────────────────────────────────────────────────────

class InngestError {
  readonly _tag = "InngestError"
  constructor(readonly message: string, readonly cause?: unknown) {}
}

// ── GQL helper ───────────────────────────────────────────────────────

const gql = (query: string) =>
  Effect.tryPromise({
    try: async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), GQL_TIMEOUT_MS)
      try {
        const res = await fetch(GQL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
          signal: controller.signal,
        })
        const json = await res.json() as { errors?: Array<{ message: string }>; data: any }
        if (json.errors?.length) throw new Error(json.errors[0].message)
        return json.data
      } finally {
        clearTimeout(timer)
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

    const functions = Effect.fn("Inngest.functions")(function* () {
      const data = yield* gql(`{
        functions {
          id slug name
          triggers { type value }
        }
      }`)
      return data.functions as Array<{
        id: string; slug: string; name: string
        triggers: Array<{ type: string; value: string }>
      }>
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

      const data = yield* gql(`{
        runs(
          filter: { from: "${from}"${statusFilter} }
          orderBy: [{ field: STARTED_AT, direction: DESC }]
          first: ${count}
        ) {
          edges { node { id status functionID startedAt endedAt output } }
        }
      }`)

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
      const [runData, triggerData, traceData] = yield* Effect.all([
        gql(`{ run(runID: "${runID}") { id status functionID startedAt endedAt output traceID } }`),
        gql(`{ runTrigger(runID: "${runID}") { eventName IDs timestamp } }`),
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
        }`),
      ])

      // resolve function name
      const fns = yield* functions()
      const fnMap = new Map(fns.map((f) => [f.id, f.name]))

      // fetch errors for failed steps
      const steps = flattenSpans(traceData.runTrace)
      const errors: Record<string, any> = {}
      for (const step of steps) {
        if (step.status === "FAILED" && step.outputID) {
          try {
            const output = yield* gql(`{
              runTraceSpanOutputByID(outputID: "${step.outputID}") {
                data error { message name stack }
              }
            }`)
            errors[step.name] = output.runTraceSpanOutputByID
          } catch { /* ignore */ }
        }
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
      const data = yield* gql(`{
        event(query: { eventId: "${eventID}" }) {
          id name createdAt raw pendingRuns totalRuns
          functionRuns { id status functionID startedAt finishedAt output }
        }
      }`)

      const ev = data.event
      if (!ev) return { event: null, runs: [] }

      // resolve function names
      const fns = yield* functions()
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
        const allRunning = pods.every(p => p.includes("Running") && p.includes("true"))
        checks.k8s = { ok: allRunning, detail: pods.join(" | ") }
      } catch {
        checks.k8s = { ok: false, detail: "kubectl not available or k3d cluster not running" }
      }

      return checks
    })

    return { send, functions, runs, run, event, events, health } as const
  },
}) {}

// ── helpers ──────────────────────────────────────────────────────────

type HealthCheck = { ok: boolean; detail: string }

async function fetchTextWithTimeout(url: string, timeoutMs = 4000): Promise<{ ok: boolean; status: number; body: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, { signal: controller.signal })
    const body = await res.text().catch(() => "")
    return {
      ok: res.ok,
      status: res.status,
      body,
    }
  } catch {
    return {
      ok: false,
      status: 0,
      body: "",
    }
  } finally {
    clearTimeout(timer)
  }
}

async function probeServerHealth(): Promise<HealthCheck> {
  const res = await fetchTextWithTimeout(INNGEST_HEALTH)
  if (!res.ok) return { ok: false, detail: `unreachable (${INNGEST_HEALTH})` }
  return { ok: true, detail: res.body || `HTTP ${res.status}` }
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
  const base = WORKER.replace(/\/$/u, "")
  const candidates = [...new Set([base, `${base}/health`, `${base}/api/inngest`])]
  let lastDetail = `unreachable (${base})`

  for (const endpoint of candidates) {
    const res = await fetchTextWithTimeout(endpoint)
    if (!res.ok) {
      lastDetail = res.status > 0
        ? `HTTP ${res.status} (${endpoint})`
        : `unreachable (${endpoint})`
      continue
    }

    return {
      ok: true,
      detail: parseWorkerDetail(res.body, endpoint, res.status),
    }
  }

  return { ok: false, detail: lastDetail }
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
