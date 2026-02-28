import { Effect, Schema } from "effect"
import { isTypesenseApiKeyError, resolveTypesenseApiKey } from "../../typesense-auth"
import { type CapabilityPort, capabilityError } from "../contract"

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108"
const COLLECTION = "otel_events"
const QUERY_BY = "action,error,component,source,metadata_json,search_text"

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
  success: Schema.optional(Schema.String),
  hours: Schema.Number,
  limit: Schema.Number,
  page: Schema.Number,
})

const StatsArgsSchema = Schema.Struct({
  source: Schema.optional(Schema.String),
  component: Schema.optional(Schema.String),
  hours: Schema.Number,
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
  stats: {
    summary: "Compute OTEL aggregate stats",
    argsSchema: StatsArgsSchema,
    resultSchema: Schema.Unknown,
  },
} as const

type OtelCommandName = keyof typeof commands

function decodeArgs<K extends OtelCommandName>(
  subcommand: K,
  args: unknown
): Effect.Effect<Schema.Schema.Type<(typeof commands)[K]["argsSchema"]>, ReturnType<typeof capabilityError>> {
  return Schema.decodeUnknown(commands[subcommand].argsSchema)(args).pipe(
    Effect.mapError((error) =>
      capabilityError(
        "OTEL_INVALID_ARGS",
        Schema.formatIssueSync(error),
        `Check \`joelclaw otel ${String(subcommand)} --help\` for valid arguments.`
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

function buildFilter(input: {
  level?: string
  source?: string
  component?: string
  success?: string
  hours?: number
}): string | undefined {
  const filters: string[] = []

  if (typeof input.hours === "number" && Number.isFinite(input.hours) && input.hours > 0) {
    const cutoff = Date.now() - input.hours * 60 * 60 * 1000
    filters.push(`timestamp:>=${Math.floor(cutoff)}`)
  }

  const levels = splitCsv(input.level)
  if (levels.length > 0) filters.push(`level:=[${levels.join(",")}]`)

  const sources = splitCsv(input.source)
  if (sources.length > 0) filters.push(`source:=[${sources.join(",")}]`)

  const components = splitCsv(input.component)
  if (components.length > 0) filters.push(`component:=[${components.join(",")}]`)

  if (input.success === "true" || input.success === "false") {
    filters.push(`success:=${input.success}`)
  }

  return filters.length > 0 ? filters.join(" && ") : undefined
}

async function queryOtel(options: {
  q: string
  page: number
  limit: number
  filterBy?: string
  facetBy?: string
}): Promise<OtelQueryResult> {
  try {
    const apiKey = resolveTypesenseApiKey()
    const searchParams = new URLSearchParams({
      q: options.q,
      query_by: QUERY_BY,
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

function simplifyHit(hit: unknown): Record<string, unknown> {
  const doc = (hit as { document?: Record<string, unknown> })?.document ?? {}
  const timestamp = doc.timestamp
  return {
    id: doc.id,
    ts: typeof timestamp === "number" ? new Date(timestamp).toISOString() : timestamp,
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
            facets: (windowData.data as any)?.facet_counts ?? [],
          }
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
}
