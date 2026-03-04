/**
 * `joelclaw memory` — human-friendly memory interface.
 *
 * Subcommands:
 *   write <text>  — submit an observation to the memory pipeline
 *   search <query> — semantic search across observations (alias for recall)
 *   recent         — list recently written observations
 *
 * The write subcommand fires `memory/observation.submitted` to Inngest,
 * which runs the write-gate pipeline (observe → proposal-triage → promote).
 *
 * Categories use short names that map to `jc:` prefixed SKOS concepts:
 *   ops, rules, arch, projects, prefs, people, memory
 */

import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import type { CapabilityError } from "../capabilities/contract"
import { executeCapabilityCommand } from "../capabilities/runtime"
import { Inngest } from "../inngest"
import { respond, respondError } from "../response"
import { resolveTypesenseApiKey as resolveApiKey } from "../typesense-auth"

// ── Category mapping ────────────────────────────────────────────
const CATEGORY_MAP: Record<string, string> = {
  operations: "jc:operations",
  ops: "jc:operations",
  rules: "jc:rules-conventions",
  conventions: "jc:rules-conventions",
  architecture: "jc:system-architecture",
  arch: "jc:system-architecture",
  projects: "jc:projects",
  preferences: "jc:preferences",
  prefs: "jc:preferences",
  people: "jc:people-relationships",
  relationships: "jc:people-relationships",
  memory: "jc:memory-system",
}

const VALID_CATEGORIES = ["ops", "rules", "arch", "projects", "prefs", "people", "memory"]

function resolveCategory(input: string): string {
  const lower = input.toLowerCase().trim()
  if (lower.startsWith("jc:")) return lower
  return CATEGORY_MAP[lower] ?? `jc:${lower}`
}

type RecallCapabilityResult = {
  raw: boolean
  text?: string
  payload?: Record<string, unknown>
}

function codeOrFallback(error: CapabilityError, fallback: string): string {
  return error.code || fallback
}

function fixOrFallback(error: CapabilityError, fallback: string): string {
  return error.fix ?? fallback
}

// ── Write subcommand ────────────────────────────────────────────
const writeCmd = Command.make(
  "write",
  {
    observation: Args.text({ name: "observation" }).pipe(
      Args.withDescription("The observation to remember (concrete, reusable, future-tense useful)")
    ),
    category: Options.text("category").pipe(
      Options.withAlias("c"),
      Options.withDefault("ops"),
      Options.withDescription(`Category: ${VALID_CATEGORIES.join(", ")}`)
    ),
    tags: Options.text("tags").pipe(
      Options.withAlias("t"),
      Options.withDefault(""),
      Options.withDescription("Comma-separated tags")
    ),
    source: Options.text("source").pipe(
      Options.withAlias("s"),
      Options.withDefault("cli"),
      Options.withDescription("Source identifier (default: cli)")
    ),
  },
  ({ observation, category, tags, source }) =>
    Effect.gen(function* () {
      const trimmed = observation.trim()
      if (trimmed.length === 0) {
        yield* Console.log(
          respondError(
            "memory write",
            "Observation text cannot be empty",
            "EMPTY_TEXT",
            'Provide observation text: joelclaw memory write "your observation"',
            [{ command: 'joelclaw memory write "your observation" --category ops', description: "Write an observation" }]
          )
        )
        return
      }

      const inngestClient = yield* Inngest
      const resolvedCategory = resolveCategory(category)
      const tagList = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)

      const payload = {
        observation: trimmed,
        category: resolvedCategory,
        source,
        tags: tagList,
      }

      const result = yield* inngestClient
        .send("memory/observation.submitted", payload)
        .pipe(Effect.either)

      if (result._tag === "Left") {
        yield* Console.log(
          respondError(
            "memory write",
            `Failed to send: ${String(result.left)}`,
            "SEND_FAILED",
            "Check Inngest: joelclaw inngest status",
            [
              { command: "joelclaw inngest status", description: "Check Inngest health" },
              { command: "joelclaw status", description: "Full system health" },
            ]
          )
        )
        return
      }

      const runIds = (result.right as any)?.ids ?? []

      yield* Console.log(
        respond(
          "memory write",
          {
            observation: trimmed,
            category: resolvedCategory,
            source,
            tags: tagList,
            run_id: runIds[0] ?? null,
          },
          [
            {
              command: `joelclaw run ${runIds[0] ?? "<run-id>"}`,
              description: "Track the write-gate pipeline",
            },
            {
              command: `joelclaw memory search "${trimmed.slice(0, 40)}"`,
              description: "Verify it landed (after pipeline completes)",
            },
            {
              command: "joelclaw memory recent",
              description: "See recent observations",
            },
          ]
        )
      )
    })
).pipe(Command.withDescription("Write an observation to agent memory"))

// ── Search subcommand ───────────────────────────────────────────
const searchCmd = Command.make(
  "search",
  {
    query: Args.text({ name: "query" }),
    limit: Options.integer("limit").pipe(Options.withDefault(5)),
    category: Options.text("category").pipe(
      Options.withAlias("c"),
      Options.withDefault(""),
      Options.withDescription("Filter by category")
    ),
    raw: Options.boolean("raw").pipe(Options.withDefault(false)),
  },
  ({ query, limit, category, raw }) =>
    Effect.gen(function* () {
      const resolvedCategory = category ? resolveCategory(category) : ""

      const result = yield* executeCapabilityCommand<RecallCapabilityResult>({
        capability: "recall",
        subcommand: "query",
        args: {
          query,
          limit,
          minScore: 0,
          raw,
          includeHold: false,
          includeDiscard: false,
          budget: "auto",
          category: resolvedCategory,
        },
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        const code = codeOrFallback(error, "UNKNOWN")

        yield* Console.log(
          respondError(
            "memory search",
            error.message,
            code,
            fixOrFallback(error, "Check Typesense: joelclaw status"),
            [{ command: "joelclaw status", description: "Check system health" }]
          )
        )
        return
      }

      if (result.right.raw) {
        yield* Console.log(result.right.text ?? "")
        return
      }

      yield* Console.log(
        respond("memory search", result.right.payload ?? {}, [
          {
            command: `joelclaw memory search "${query}" --limit 10`,
            description: "More results",
          },
          {
            command: `joelclaw memory write "<observation>" --category ops`,
            description: "Write a new observation",
          },
        ])
      )
    })
).pipe(Command.withDescription("Search agent memory (semantic recall)"))

// ── Recent subcommand ───────────────────────────────────────────
const recentCmd = Command.make(
  "recent",
  {
    count: Options.integer("count").pipe(
      Options.withAlias("n"),
      Options.withDefault(10)
    ),
    hours: Options.integer("hours").pipe(Options.withDefault(24)),
  },
  ({ count, hours }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      const result = yield* inngestClient.events({
        prefix: "memory/observation",
        hours,
        count,
      })

      const observations = (result as any[]).map((e: any) => ({
        id: e.id,
        at: e.occurredAt,
        observation: e.data?.observation?.slice(0, 120) ?? "(no text)",
        category: e.data?.category ?? "unknown",
        source: e.data?.source ?? "unknown",
      }))

      yield* Console.log(
        respond("memory recent", { count: observations.length, hours, observations }, [
          {
            command: "joelclaw memory recent --hours 48 --count 20",
            description: "Look further back",
          },
          {
            command: 'joelclaw memory write "<observation>"',
            description: "Write a new observation",
          },
        ])
      )
    })
).pipe(Command.withDescription("List recently submitted observations"))

// ── Scorecard subcommand (ADR-0190) ─────────────────────────────
// Computes memory yield metrics from OTEL data over a time window.
// Queries Typesense otel_events collection directly for aggregation.

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108"

type OtelSearchResult = {
  found: number
  hits: Array<{ document: Record<string, unknown> }>
  facet_counts?: Array<{
    field_name: string
    counts: Array<{ value: string; count: number }>
  }>
}

async function queryOtelEvents(params: {
  query: string
  filterBy: string
  perPage?: number
  facetBy?: string
}): Promise<OtelSearchResult> {
  const apiKey = resolveApiKey()
  const searchParams = new URLSearchParams({
    q: params.query,
    query_by: "search_text,action,component,error",
    filter_by: params.filterBy,
    per_page: String(params.perPage ?? 0),
    ...(params.facetBy ? { facet_by: params.facetBy, max_facet_values: "50" } : {}),
  })

  const resp = await fetch(
    `${TYPESENSE_URL}/collections/otel_events/documents/search?${searchParams}`,
    { headers: { "X-TYPESENSE-API-KEY": apiKey } }
  )

  if (!resp.ok) {
    throw new Error(`Typesense query failed (${resp.status}): ${await resp.text()}`)
  }

  return resp.json() as Promise<OtelSearchResult>
}

function facetCount(result: OtelSearchResult, field: string, value: string): number {
  const facet = result.facet_counts?.find((f) => f.field_name === field)
  return facet?.counts.find((c) => c.value === value)?.count ?? 0
}

function facetTotal(result: OtelSearchResult, field: string): number {
  const facet = result.facet_counts?.find((f) => f.field_name === field)
  return facet?.counts.reduce((sum, c) => sum + c.count, 0) ?? 0
}

type ScorecardMetric = {
  name: string
  value: number
  description: string
  status: "green" | "yellow" | "red"
  detail: string
}

type ScorecardResult = {
  hours: number
  computedAt: string
  metrics: ScorecardMetric[]
  overallStatus: "green" | "yellow" | "red"
  gatesBreached: string[]
}

function metricStatus(value: number, greenBelow: number, yellowBelow: number): "green" | "yellow" | "red" {
  if (value <= greenBelow) return "green"
  if (value <= yellowBelow) return "yellow"
  return "red"
}

function yieldStatus(value: number, greenAbove: number, yellowAbove: number): "green" | "yellow" | "red" {
  if (value >= greenAbove) return "green"
  if (value >= yellowAbove) return "yellow"
  return "red"
}

const scorecardCmd = Command.make(
  "scorecard",
  {
    hours: Options.integer("hours").pipe(Options.withDefault(24)),
  },
  ({ hours }) =>
    Effect.gen(function* () {
      const startTs = Date.now() - hours * 60 * 60 * 1000
      const filterBase = `timestamp:>=${startTs}`

      try {
        // 1. Recall rewrite fallback rate
        const recallCompleted = yield* Effect.tryPromise({
          try: () => queryOtelEvents({
            query: "memory.recall.completed",
            filterBy: `${filterBase} && action:=memory.recall.completed`,
          }),
          catch: (e) => new Error(`recall query: ${e}`),
        })
        const totalRecalls = recallCompleted.found

        // Search for fallback strategy in metadata (full-text search on search_text)
        const recallFallbacks = yield* Effect.tryPromise({
          try: () => queryOtelEvents({
            query: "fallback",
            filterBy: `${filterBase} && action:=memory.recall.completed`,
          }),
          catch: (e) => new Error(`recall fallback query: ${e}`),
        })
        const fallbackCount = recallFallbacks.found
        const rewriteFallbackRate = totalRecalls > 0 ? fallbackCount / totalRecalls : 0

        // 2. Reflect null output rate
        const reflectCompletedResult = yield* Effect.tryPromise({
          try: () => queryOtelEvents({
            query: "reflect.completed",
            filterBy: `${filterBase} && action:=reflect.completed`,
          }),
          catch: (e) => new Error(`reflect completed query: ${e}`),
        })
        const reflectCompleted = reflectCompletedResult.found

        const reflectFailedResult = yield* Effect.tryPromise({
          try: () => queryOtelEvents({
            query: "reflect.failed",
            filterBy: `${filterBase} && action:=reflect.failed`,
          }),
          catch: (e) => new Error(`reflect failed query: ${e}`),
        })
        const reflectFailed = reflectFailedResult.found

        const reflectSkippedResult = yield* Effect.tryPromise({
          try: () => queryOtelEvents({
            query: "reflect.skipped",
            filterBy: `${filterBase} && action:=reflect.skipped`,
          }),
          catch: (e) => new Error(`reflect skipped query: ${e}`),
        })
        const reflectSkipped = reflectSkippedResult.found
        const reflectTotal = reflectCompleted + reflectFailed
        const nullOutputRate = reflectTotal > 0 ? reflectFailed / reflectTotal : 0

        // 3. Memory yield rate (recalls that returned results vs total)
        const recallYieldResult = yield* Effect.tryPromise({
          try: () => queryOtelEvents({
            query: "memory.recall.completed",
            filterBy: `${filterBase} && action:=memory.recall.completed`,
            perPage: 250,
          }),
          catch: (e) => new Error(`recall yield query: ${e}`),
        })
        // Parse metadata_json to count returned > 0
        let recallsWithResults = 0
        let recallsEmpty = 0
        for (const hit of recallYieldResult.hits) {
          const meta = hit.document.metadata_json
          if (typeof meta === "string") {
            try {
              const parsed = JSON.parse(meta)
              const returned = typeof parsed.returned === "number" ? parsed.returned : 0
              if (returned > 0) recallsWithResults++
              else recallsEmpty++
            } catch { recallsEmpty++ }
          }
        }
        const yieldSampleSize = recallsWithResults + recallsEmpty
        const memoryYieldRate = yieldSampleSize > 0 ? recallsWithResults / yieldSampleSize : 0

        // 4. Usage coverage rate (calls with success metadata vs total)
        const allMemoryEvents = yield* Effect.tryPromise({
          try: () => queryOtelEvents({
            query: "memory",
            filterBy: filterBase,
            facetBy: "success",
          }),
          catch: (e) => new Error(`coverage query: ${e}`),
        })
        const successCount = facetCount(allMemoryEvents, "success", "true")
        const failCount = facetCount(allMemoryEvents, "success", "false")
        const coverageTotal = successCount + failCount
        const usageCoverageRate = coverageTotal > 0 ? successCount / coverageTotal : 0

        // 5. Observe volume
        const observeAll = yield* Effect.tryPromise({
          try: () => queryOtelEvents({
            query: "observations.stored",
            filterBy: `${filterBase} && component:=observe-session-noted`,
          }),
          catch: (e) => new Error(`observe query: ${e}`),
        })
        const observeTotal = observeAll.found

        // Build metrics
        const metrics: ScorecardMetric[] = [
          {
            name: "rewrite_fallback_rate",
            value: Math.round(rewriteFallbackRate * 1000) / 1000,
            description: "Recall rewrites falling back to original query",
            status: metricStatus(rewriteFallbackRate, 0.1, 0.3),
            detail: `${fallbackCount}/${totalRecalls} recalls used fallback strategy`,
          },
          {
            name: "null_output_rate",
            value: Math.round(nullOutputRate * 1000) / 1000,
            description: "Reflect LLM calls producing failed/null output",
            status: metricStatus(nullOutputRate, 0.05, 0.15),
            detail: `${reflectFailed} failed, ${reflectCompleted} completed, ${reflectSkipped} skipped`,
          },
          {
            name: "memory_yield_rate",
            value: Math.round(memoryYieldRate * 1000) / 1000,
            description: "Recall queries returning at least one result",
            status: yieldStatus(memoryYieldRate, 0.7, 0.5),
            detail: `${recallsWithResults}/${yieldSampleSize} recalls returned results (sample of ${yieldSampleSize})`,
          },
          {
            name: "usage_coverage_rate",
            value: Math.round(usageCoverageRate * 1000) / 1000,
            description: "Memory events with success metadata",
            status: yieldStatus(usageCoverageRate, 0.95, 0.85),
            detail: `${successCount} success, ${failCount} failed out of ${coverageTotal} total`,
          },
          {
            name: "observe_volume",
            value: observeTotal,
            description: "Observation store events in window",
            status: observeTotal > 0 ? "green" : "yellow",
            detail: `${observeTotal} observation batches stored in ${hours}h`,
          },
          {
            name: "reflect_volume",
            value: reflectCompleted + reflectFailed + reflectSkipped,
            description: "Reflect runs in window",
            status: reflectCompleted > 0 ? "green" : "yellow",
            detail: `${reflectCompleted} completed, ${reflectFailed} failed, ${reflectSkipped} skipped in ${hours}h`,
          },
        ]

        const gatesBreached = metrics
          .filter((m) => m.status === "red")
          .map((m) => m.name)

        const overallStatus: "green" | "yellow" | "red" =
          gatesBreached.length > 0 ? "red" :
          metrics.some((m) => m.status === "yellow") ? "yellow" :
          "green"

        const result: ScorecardResult = {
          hours,
          computedAt: new Date().toISOString(),
          metrics,
          overallStatus,
          gatesBreached,
        }

        yield* Console.log(
          respond("memory scorecard", result, [
            {
              command: "joelclaw otel search \"reflect.failed\" --hours 24",
              description: "Investigate reflect failures",
            },
            {
              command: "joelclaw otel search \"memory.recall.completed\" --hours 24",
              description: "Inspect recall performance",
            },
            {
              command: "joelclaw memory scorecard --hours 48",
              description: "Compare with longer window",
            },
          ])
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        yield* Console.log(
          respondError(
            "memory scorecard",
            message,
            "SCORECARD_FAILED",
            "Check Typesense: kubectl port-forward -n joelclaw svc/typesense 8108:8108",
            [{ command: "joelclaw status", description: "Check system health" }]
          )
        )
      }
    })
).pipe(Command.withDescription("Compute memory yield scorecard metrics (ADR-0190)"))

// ── Root memory command ─────────────────────────────────────────
export const memoryCmd = Command.make("memory", {}, () =>
  Console.log(
    respond(
      "memory",
      {
        description: "Agent memory — write, search, inspect, and measure observations",
        categories: VALID_CATEGORIES,
        usage: [
          'joelclaw memory write "Stripe requires idempotency keys" --category ops --tags stripe,api',
          'joelclaw memory search "stripe patterns"',
          "joelclaw memory recent --hours 24",
          "joelclaw memory scorecard --hours 24",
        ],
      },
      [
        {
          command: 'joelclaw memory write "<text>" [--category ops] [--tags a,b]',
          description: "Write an observation",
        },
        {
          command: 'joelclaw memory search "<query>" [--limit 5]',
          description: "Semantic search",
        },
        {
          command: "joelclaw memory recent [--hours 24]",
          description: "Recent observations",
        },
        {
          command: "joelclaw memory scorecard [--hours 24]",
          description: "Memory yield scorecard (ADR-0190)",
        },
      ]
    )
  )
).pipe(
  Command.withDescription("Agent memory — write, search, inspect, and measure observations"),
  Command.withSubcommands([writeCmd, searchCmd, recentCmd, scorecardCmd])
)
