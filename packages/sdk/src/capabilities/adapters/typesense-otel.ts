import { randomUUID } from "node:crypto"
import { Effect, ParseResult, Schema } from "effect"
import { ingestOtelPayload, OTEL_INGEST_URL } from "../../lib/otel-ingest"
import { isTypesenseApiKeyError, resolveTypesenseApiKey } from "../../lib/typesense-auth"
import { type CapabilityPort, capabilityError } from "../contract"

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108"
const COLLECTION = "otel_events"
const SYSTEM_LOG_COLLECTION = "system_log"
const QUERY_BY = "action,error,component,source,metadata_json,search_text"
const SYSTEM_LOG_QUERY_BY = "detail,tool,action"
const OTEL_LEVELS = new Set(["debug", "info", "warn", "error", "fatal"])

type OtelQueryResult = { ok: true; data: unknown } | {
  ok: false
  error: string
  code?: string
  fix?: string
}

const ListArgsSchema = Schema.Struct({
  level: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  component: Schema.optional(Schema.String),
  session: Schema.optional(Schema.String),
  system: Schema.optional(Schema.String),
  success: Schema.optional(Schema.String),
  hours: Schema.Number,
  limit: Schema.Number,
  page: Schema.Number,
})

const SearchArgsSchema = Schema.Struct({
  query: Schema.String,
  level: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  component: Schema.optional(Schema.String),
  session: Schema.optional(Schema.String),
  system: Schema.optional(Schema.String),
  success: Schema.optional(Schema.String),
  hours: Schema.Number,
  limit: Schema.Number,
  page: Schema.Number,
})

const CorrelateArgsSchema = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  systemId: Schema.optional(Schema.String),
  hours: Schema.Number,
  limit: Schema.Number,
})

const StatsArgsSchema = Schema.Struct({
  source: Schema.optional(Schema.String),
  component: Schema.optional(Schema.String),
  hours: Schema.Number,
})

const EmitArgsSchema = Schema.Struct({
  event: Schema.optional(Schema.Unknown),
  action: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  component: Schema.optional(Schema.String),
  level: Schema.optional(Schema.String),
  success: Schema.optional(Schema.Boolean),
  metadata: Schema.optional(Schema.Unknown),
  id: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
})

const commands = {
  list: {
    summary: "List OTEL events",
    argsSchema: ListArgsSchema,
    resultSchema: Schema.Unknown,
  },
  search: {
    summary: "Search OTEL events",
    argsSchema: SearchArgsSchema,
    resultSchema: Schema.Unknown,
  },
  correlate: {
    summary: "Correlate observability records across OTEL + system log",
    argsSchema: CorrelateArgsSchema,
    resultSchema: Schema.Unknown,
  },
  stats: {
    summary: "Compute OTEL aggregate stats",
    argsSchema: StatsArgsSchema,
    resultSchema: Schema.Unknown,
  },
  emit: {
    summary: "Emit OTEL event to worker ingest endpoint",
    argsSchema: EmitArgsSchema,
    resultSchema: Schema.Unknown,
  },
} as const

type OtelCommandName = keyof typeof commands

function helpCommandForSubcommand(subcommand: OtelCommandName): string {
  switch (subcommand) {
    case "correlate":
      return "joelclaw o11y --help"
    default:
      return `joelclaw otel ${String(subcommand)} --help`
  }
}

function decodeArgs<K extends OtelCommandName>(
  subcommand: K,
  args: unknown
): Effect.Effect<Schema.Schema.Type<(typeof commands)[K]["argsSchema"]>, ReturnType<typeof capabilityError>> {
  return Schema.decodeUnknown(commands[subcommand].argsSchema)(args).pipe(
    Effect.mapError((error) =>
      capabilityError(
        "OTEL_INVALID_ARGS",
        ParseResult.TreeFormatter.formatErrorSync(error),
        `Check \`${helpCommandForSubcommand(subcommand)}\` for valid arguments.`
      )
    )
  )
}

function parsePositiveInt(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), max)
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function quoteFilterValue(value: string): string {
  return `\`${value.replace(/[`\\]/gu, "\\$&")}\``
}

function buildFilter(input: {
  level?: string
  source?: string
  component?: string
  session?: string
  system?: string
  success?: string
  hours?: number
}, options: { timestampUnit?: "milliseconds" | "seconds" } = {}): string | undefined {
  const filters: string[] = []

  if (typeof input.hours === "number" && Number.isFinite(input.hours) && input.hours > 0) {
    const cutoffMs = Date.now() - input.hours * 60 * 60 * 1000
    const cutoff = options.timestampUnit === "seconds" ? Math.floor(cutoffMs / 1000) : Math.floor(cutoffMs)
    filters.push(`timestamp:>=${Math.floor(cutoff)}`)
  }

  const levels = splitCsv(input.level)
  if (levels.length > 0) filters.push(`level:=[${levels.join(",")}]`)

  const sources = splitCsv(input.source)
  if (sources.length > 0) filters.push(`source:=[${sources.join(",")}]`)

  const components = splitCsv(input.component)
  if (components.length > 0) filters.push(`component:=[${components.join(",")}]`)

  const session = input.session?.trim()
  if (session) filters.push(`sessionId:=${quoteFilterValue(session)}`)

  const system = input.system?.trim()
  if (system) filters.push(`systemId:=${quoteFilterValue(system)}`)

  if (input.success === "true" || input.success === "false") {
    filters.push(`success:=${input.success}`)
  }

  return filters.length > 0 ? filters.join(" && ") : undefined
}

async function queryOtel(options: {
  q: string
  page: number
  limit: number
  queryBy?: string
  filterBy?: string
  facetBy?: string
}): Promise<OtelQueryResult> {
  try {
    const apiKey = resolveTypesenseApiKey()
    const searchParams = new URLSearchParams({
      q: options.q,
      query_by: options.queryBy ?? QUERY_BY,
      per_page: String(options.limit),
      page: String(options.page),
      sort_by: "timestamp:desc",
      exclude_fields: "embedding",
    })
    if (options.filterBy) searchParams.set("filter_by", options.filterBy)
    if (options.facetBy) searchParams.set("facet_by", options.facetBy)

    const resp = await fetch(
      `${TYPESENSE_URL}/collections/${COLLECTION}/documents/search?${searchParams}`,
      {
        headers: { "X-TYPESENSE-API-KEY": apiKey },
      }
    )

    if (!resp.ok) {
      const text = await resp.text()
      return { ok: false, error: `Typesense query failed (${resp.status}): ${text}` }
    }

    return { ok: true, data: await resp.json() }
  } catch (error) {
    if (isTypesenseApiKeyError(error)) {
      return {
        ok: false,
        error: error.message,
        code: error.code,
        fix: error.fix,
      }
    }
    return { ok: false, error: String(error) }
  }
}

async function queryOtelMultiSearch(searches: ReadonlyArray<Record<string, unknown>>): Promise<OtelQueryResult> {
  try {
    const apiKey = resolveTypesenseApiKey()
    const resp = await fetch(`${TYPESENSE_URL}/multi_search`, {
      method: "POST",
      headers: {
        "X-TYPESENSE-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ searches }),
    })

    if (!resp.ok) {
      const text = await resp.text()
      return { ok: false, error: `Typesense multi_search failed (${resp.status}): ${text}` }
    }

    return { ok: true, data: await resp.json() }
  } catch (error) {
    if (isTypesenseApiKeyError(error)) {
      return {
        ok: false,
        error: error.message,
        code: error.code,
        fix: error.fix,
      }
    }
    return { ok: false, error: String(error) }
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return value
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value !== "boolean") return undefined
  return value
}

function normalizeLevel(value: unknown): string | undefined {
  const text = asNonEmptyString(value)?.toLowerCase()
  if (!text) return undefined
  return OTEL_LEVELS.has(text) ? text : undefined
}

type EmitPayloadBuildResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string; fix: string }

function buildEmitPayload(args: Schema.Schema.Type<typeof EmitArgsSchema>): EmitPayloadBuildResult {
  const baseEvent = asObject(args.event) ?? {}
  const action = asNonEmptyString(args.action) ?? asNonEmptyString(baseEvent.action)

  if (!action) {
    return {
      ok: false,
      error: "OTEL emit requires an action (stdin JSON action, positional action, or --action).",
      fix: "Provide action via stdin payload `{\"action\":\"...\"}`, positional arg, or --action.",
    }
  }

  const metadataCandidate = args.metadata !== undefined ? args.metadata : baseEvent.metadata
  const metadata = metadataCandidate === undefined ? {} : asObject(metadataCandidate)
  if (!metadata) {
    return {
      ok: false,
      error: "OTEL emit metadata must be a JSON object.",
      fix: "Pass --metadata as JSON object (for example: --metadata '{\"k\":\"v\"}')",
    }
  }

  const level = normalizeLevel(args.level) ?? normalizeLevel(baseEvent.level) ?? "info"
  const payload: Record<string, unknown> = {
    ...baseEvent,
    id: asNonEmptyString(args.id) ?? asNonEmptyString(baseEvent.id) ?? randomUUID(),
    timestamp: asFiniteNumber(args.timestamp) ?? asFiniteNumber(baseEvent.timestamp) ?? Date.now(),
    sessionId: asNonEmptyString(baseEvent.sessionId) ?? process.env.SLOG_SESSION_ID ?? "unknown",
    systemId: asNonEmptyString(baseEvent.systemId) ?? process.env.SLOG_SYSTEM_ID ?? "unknown",
    level,
    source: asNonEmptyString(args.source) ?? asNonEmptyString(baseEvent.source) ?? "cli",
    component: asNonEmptyString(args.component) ?? asNonEmptyString(baseEvent.component) ?? "otel-cli",
    action,
    success: args.success ?? asBoolean(baseEvent.success) ?? true,
    metadata,
  }

  const error = asNonEmptyString(args.error) ?? asNonEmptyString(baseEvent.error)
  if (error) payload.error = error

  return { ok: true, payload }
}

async function emitOtel(payload: Record<string, unknown>): Promise<OtelQueryResult> {
  const result = await ingestOtelPayload(payload)

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      code: "OTEL_EMIT_FAILED",
      fix: `Ensure worker endpoint ${OTEL_INGEST_URL} is reachable and accepts the payload.`,
    }
  }

  return {
    ok: true,
    data: {
      endpoint: result.endpoint,
      status: result.status,
      response: result.response,
      event: payload,
    },
  }
}

function simplifyHit(hit: unknown): Record<string, unknown> {
  const doc = (hit as { document?: Record<string, unknown> })?.document ?? {}
  const timestamp = doc.timestamp
  return {
    id: doc.id,
    ts: typeof timestamp === "number" ? new Date(timestamp).toISOString() : timestamp,
    sessionId: doc.sessionId,
    systemId: doc.systemId,
    level: doc.level,
    source: doc.source,
    component: doc.component,
    action: doc.action,
    success: doc.success,
    duration_ms: doc.duration_ms,
    error: doc.error,
    metadata_keys: doc.metadata_keys,
  }
}

function timestampFromDocument(document: Record<string, unknown>): number {
  if (typeof document.timestamp === "number" && Number.isFinite(document.timestamp)) {
    return document.timestamp < 1_000_000_000_000 ? document.timestamp * 1000 : document.timestamp
  }
  if (typeof document.timestamp === "string") {
    const parsed = Number(document.timestamp)
    if (Number.isFinite(parsed)) return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed
  }
  return 0
}

function simplifyCorrelatedHit(collection: string, hit: unknown): Record<string, unknown> {
  const doc = (hit as { document?: Record<string, unknown> })?.document ?? {}
  const timestamp = timestampFromDocument(doc)
  const common = {
    collection,
    timestamp,
    ts: timestamp > 0 ? new Date(timestamp).toISOString() : doc.timestamp,
    sessionId: doc.sessionId,
    systemId: doc.systemId,
    action: doc.action,
  }

  if (collection === COLLECTION) {
    return {
      ...common,
      id: doc.id,
      level: doc.level,
      source: doc.source,
      component: doc.component,
      success: doc.success,
      duration_ms: doc.duration_ms,
      error: doc.error,
      metadata_keys: doc.metadata_keys,
    }
  }

  return {
    ...common,
    tool: doc.tool,
    detail: doc.detail,
    reason: doc.reason,
  }
}

function readFacet(data: any, field: string, value: string): number {
  const facets = Array.isArray(data?.facet_counts) ? data.facet_counts : []
  const facet = facets.find((item: any) => item?.field_name === field)
  const count = Array.isArray(facet?.counts)
    ? facet.counts.find((item: any) => item?.value === value)?.count
    : 0
  return typeof count === "number" ? count : 0
}

function failFromResult(result: Extract<OtelQueryResult, { ok: false }>, fallbackCode: string, fallbackFix: string) {
  return capabilityError(
    result.code ?? fallbackCode,
    result.error,
    result.fix ?? fallbackFix
  )
}

export const typesenseOtelAdapter: CapabilityPort<typeof commands> = {
  capability: "otel",
  adapter: "typesense-otel",
  commands,
  execute(subcommand, rawArgs) {
    return Effect.gen(function* () {
      switch (subcommand) {
        case "list": {
          const args = yield* decodeArgs("list", rawArgs)
          const filterBy = buildFilter({
            level: args.level,
            source: args.source,
            component: args.component,
            session: args.session,
            system: args.system,
            success: args.success,
            hours: args.hours,
          })

          const result = yield* Effect.promise(() =>
            queryOtel({
              q: "*",
              page: parsePositiveInt(args.page, 1, 10_000),
              limit: parsePositiveInt(args.limit, 30, 200),
              filterBy,
              facetBy: "level,source,component,success",
            })
          )

          if (!result.ok) {
            return yield* Effect.fail(
              failFromResult(result, "OTEL_QUERY_FAILED", "Check Typesense health and API key")
            )
          }

          const payload = result.data as any
          const hits = Array.isArray(payload?.hits) ? payload.hits.map(simplifyHit) : []
          return {
            found: payload?.found ?? 0,
            page: args.page,
            limit: args.limit,
            filterBy,
            events: hits,
            facets: payload?.facet_counts ?? [],
          }
        }
        case "search": {
          const args = yield* decodeArgs("search", rawArgs)
          const filterBy = buildFilter({
            level: args.level,
            source: args.source,
            component: args.component,
            session: args.session,
            system: args.system,
            success: args.success,
            hours: args.hours,
          })

          const result = yield* Effect.promise(() =>
            queryOtel({
              q: args.query.trim() || "*",
              page: parsePositiveInt(args.page, 1, 10_000),
              limit: parsePositiveInt(args.limit, 30, 200),
              filterBy,
              facetBy: "level,source,component,success",
            })
          )

          if (!result.ok) {
            return yield* Effect.fail(
              failFromResult(result, "OTEL_QUERY_FAILED", "Check Typesense health and API key")
            )
          }

          const payload = result.data as any
          const hits = Array.isArray(payload?.hits) ? payload.hits.map(simplifyHit) : []
          return {
            query: args.query,
            found: payload?.found ?? 0,
            page: args.page,
            limit: args.limit,
            filterBy,
            events: hits,
            facets: payload?.facet_counts ?? [],
          }
        }
        case "correlate": {
          const args = yield* decodeArgs("correlate", rawArgs)
          const sessionId = args.sessionId?.trim()
          const systemId = args.systemId?.trim()

          if (!sessionId && !systemId) {
            return yield* Effect.fail(
              capabilityError(
                "OTEL_INVALID_ARGS",
                "OTEL correlate requires `sessionId` or `systemId`.",
                "Provide `sessionId` or `systemId` to correlate across otel_events and system_log."
              )
            )
          }

          const otelFilterBy = buildFilter({
            session: sessionId,
            system: systemId,
            hours: args.hours,
          })
          const systemLogFilterBy = buildFilter({
            session: sessionId,
            system: systemId,
            hours: args.hours,
          }, { timestampUnit: "seconds" })

          const perPage = parsePositiveInt(args.limit, 50, 200)
          const result = yield* Effect.promise(() =>
            queryOtelMultiSearch([
              {
                collection: COLLECTION,
                q: "*",
                query_by: QUERY_BY,
                per_page: perPage,
                sort_by: "timestamp:desc",
                include_fields: "id,timestamp,level,source,component,action,success,duration_ms,error,metadata_keys,sessionId,systemId",
                ...(otelFilterBy ? { filter_by: otelFilterBy } : {}),
              },
              {
                collection: SYSTEM_LOG_COLLECTION,
                q: "*",
                query_by: SYSTEM_LOG_QUERY_BY,
                per_page: perPage,
                sort_by: "timestamp:desc",
                include_fields: "action,tool,detail,reason,timestamp,sessionId,systemId",
                ...(systemLogFilterBy ? { filter_by: systemLogFilterBy } : {}),
              },
            ])
          )

          if (!result.ok) {
            return yield* Effect.fail(
              failFromResult(result, "OTEL_QUERY_FAILED", "Check Typesense health and API key")
            )
          }

          const payload = result.data as { results?: Array<Record<string, unknown>> }
          const collectionResults = Array.isArray(payload?.results) ? payload.results : []
          const mergedHits = collectionResults
            .flatMap((entry, index) => {
              const collection =
                typeof entry?.request_params === "object" &&
                entry?.request_params &&
                typeof (entry.request_params as { collection_name?: unknown }).collection_name === "string"
                  ? (entry.request_params as { collection_name: string }).collection_name
                  : index === 0
                    ? COLLECTION
                    : SYSTEM_LOG_COLLECTION
              const hits = Array.isArray(entry?.hits) ? entry.hits : []
              return hits.map((hit) => simplifyCorrelatedHit(collection, hit))
            })
            .sort((a, b) => Number((b as { timestamp?: unknown }).timestamp ?? 0) - Number((a as { timestamp?: unknown }).timestamp ?? 0))
            .slice(0, perPage)

          return {
            windowHours: args.hours,
            limit: perPage,
            returned: mergedHits.length,
            found: collectionResults.reduce((total, entry) => total + Number(entry?.found ?? 0), 0),
            filterBy: {
              otel_events: otelFilterBy,
              system_log: systemLogFilterBy,
            },
            scope: sessionId ? "session" : "system",
            sessionId,
            systemId,
            collections: collectionResults.map((entry, index) => ({
              collection:
                typeof entry?.request_params === "object" &&
                entry?.request_params &&
                typeof (entry.request_params as { collection_name?: unknown }).collection_name === "string"
                  ? (entry.request_params as { collection_name: string }).collection_name
                  : index === 0
                    ? COLLECTION
                    : SYSTEM_LOG_COLLECTION,
              found: Number(entry?.found ?? 0),
            })),
            hits: mergedHits,
          }
        }
        case "stats": {
          const args = yield* decodeArgs("stats", rawArgs)
          const baseFilter = buildFilter({
            source: args.source,
            component: args.component,
            hours: args.hours,
          })

          const [windowData, recentData] = yield* Effect.promise(() =>
            Promise.all([
              queryOtel({
                q: "*",
                page: 1,
                limit: 1,
                filterBy: baseFilter,
                facetBy: "level,source,component,success",
              }),
              queryOtel({
                q: "*",
                page: 1,
                limit: 1,
                filterBy: buildFilter({
                  source: args.source,
                  component: args.component,
                  hours: 0.25,
                }),
                facetBy: "level",
              }),
            ])
          )

          if (!windowData.ok) {
            return yield* Effect.fail(
              failFromResult(windowData, "OTEL_STATS_FAILED", "Check Typesense health and API key")
            )
          }

          if (!recentData.ok) {
            return yield* Effect.fail(
              failFromResult(recentData, "OTEL_STATS_FAILED", "Check Typesense health and API key")
            )
          }

          const total = Number((windowData.data as any)?.found ?? 0)
          const errors = readFacet(windowData.data, "level", "error") + readFacet(windowData.data, "level", "fatal")
          const recentTotal = Number((recentData.data as any)?.found ?? 0)
          const recentErrors = readFacet(recentData.data, "level", "error") + readFacet(recentData.data, "level", "fatal")

          // Knowledge metrics (ADR-0199)
          const knowledgeData = yield* Effect.promise(() =>
            Promise.all([
              queryOtel({
                q: "system_knowledge.retrieval",
                page: 1,
                limit: 1,
                filterBy: baseFilter,
                queryBy: "action",
              }),
              queryOtel({
                q: "knowledge.watchdog.check",
                page: 1,
                limit: 1,
                filterBy: baseFilter,
                queryBy: "action",
              }),
            ]),
          )

          const knowledgeRetrievals = knowledgeData[0].ok ? Number((knowledgeData[0].data as any)?.found ?? 0) : 0
          const watchdogChecks = knowledgeData[1].ok ? Number((knowledgeData[1].data as any)?.found ?? 0) : 0

          return {
            windowHours: args.hours,
            filterBy: baseFilter,
            total,
            errors,
            errorRate: total > 0 ? errors / total : 0,
            recent15m: {
              total: recentTotal,
              errors: recentErrors,
              errorRate: recentTotal > 0 ? recentErrors / recentTotal : 0,
            },
            knowledge: {
              retrievals: knowledgeRetrievals,
              watchdog_checks: watchdogChecks,
            },
            facets: (windowData.data as any)?.facet_counts ?? [],
          }
        }
        case "emit": {
          const args = yield* decodeArgs("emit", rawArgs)
          const payloadResult = buildEmitPayload(args)

          if (!payloadResult.ok) {
            return yield* Effect.fail(
              capabilityError("OTEL_INVALID_ARGS", payloadResult.error, payloadResult.fix)
            )
          }

          const result = yield* Effect.promise(() => emitOtel(payloadResult.payload))
          if (!result.ok) {
            return yield* Effect.fail(
              failFromResult(
                result,
                "OTEL_EMIT_FAILED",
                `Ensure ${OTEL_INGEST_URL} is reachable and worker is healthy.`
              )
            )
          }

          return result.data
        }
        default:
          return yield* Effect.fail(
            capabilityError(
              "OTEL_SUBCOMMAND_UNSUPPORTED",
              `Unsupported otel subcommand: ${String(subcommand)}`
            )
          )
      }
    })
  },
}

export const __otelAdapterTestUtils = {
  buildFilter,
  parsePositiveInt,
  splitCsv,
  timestampFromDocument,
}
