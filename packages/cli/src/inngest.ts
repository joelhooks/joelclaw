import { Effect, Schema } from "effect"
import { loadConfig } from "./config"
import {
  InngestFunction, EventsV2Response, RunsResponse, RunTrigger,
  SpanOutput, LoopEventData,
} from "./schema"

const cfg = loadConfig()
const GQL = `${cfg.inngestUrl}/v0/gql`
const EVENT_API = `${cfg.inngestUrl}/e/${cfg.eventKey}`
const WORKER = cfg.workerUrl

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
      const timer = setTimeout(() => controller.abort(), 5000)
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

      // inngest server
      try {
        const res = yield* Effect.tryPromise({
          try: () => fetch("http://localhost:8288/health").then((r) => r.text()),
          catch: () => new InngestError("server unreachable"),
        })
        checks.server = { ok: true, detail: res }
      } catch {
        checks.server = { ok: false, detail: "unreachable" }
      }

      // worker
      try {
        const res = yield* Effect.tryPromise({
          try: () => fetch(WORKER).then((r) => r.json()),
          catch: () => new InngestError("worker unreachable"),
        })
        checks.worker = { ok: true, detail: (res as any).functions?.join(", ") }
      } catch {
        checks.worker = { ok: false, detail: "unreachable" }
      }

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
