import { randomUUID } from "node:crypto"
import { Effect, ParseResult, Schema } from "effect"
import {
  createOtelEventPayload,
  ingestOtelPayload,
  OTEL_INGEST_URL,
  readSystemBusEnv,
  resolveDefaultOtelSessionId,
  resolveDefaultOtelSystemId,
} from "../../lib/otel-ingest"
import { type CapabilityContext, type CapabilityPort, capabilityError } from "../contract"

const DEFAULT_CLICKHOUSE_URL = "http://localhost:8123"
const DEFAULT_DATABASE = "joelclaw"
const DEFAULT_TABLE = "otel_events"
const OTEL_LEVELS = new Set(["debug", "info", "warn", "error", "fatal"])

type OtelQueryResult = { ok: true; data: any } | {
  ok: false
  error: string
  code?: string
  fix?: string
}

type ClickHouseAdapterConfig = {
  url: string
  database: string
  table: string
  username?: string
  password?: string
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
  list: { summary: "List OTEL events from ClickHouse", argsSchema: ListArgsSchema, resultSchema: Schema.Unknown },
  search: { summary: "Search OTEL events from ClickHouse", argsSchema: SearchArgsSchema, resultSchema: Schema.Unknown },
  correlate: { summary: "Correlate OTEL events from ClickHouse", argsSchema: CorrelateArgsSchema, resultSchema: Schema.Unknown },
  stats: { summary: "Compute OTEL aggregate stats from ClickHouse", argsSchema: StatsArgsSchema, resultSchema: Schema.Unknown },
  emit: { summary: "Emit OTEL event to worker ingest endpoint", argsSchema: EmitArgsSchema, resultSchema: Schema.Unknown },
} as const

type OtelCommandName = keyof typeof commands

function helpCommandForSubcommand(subcommand: OtelCommandName): string {
  return subcommand === "correlate" ? "joelclaw o11y --help" : `joelclaw otel ${String(subcommand)} --help`
}

function decodeArgs<K extends OtelCommandName>(
  subcommand: K,
  args: unknown,
): Effect.Effect<Schema.Schema.Type<(typeof commands)[K]["argsSchema"]>, ReturnType<typeof capabilityError>> {
  return Schema.decodeUnknown(commands[subcommand].argsSchema)(args).pipe(
    Effect.mapError((error) => capabilityError(
      "OTEL_INVALID_ARGS",
      ParseResult.TreeFormatter.formatErrorSync(error),
      `Check \`${helpCommandForSubcommand(subcommand)}\` for valid arguments.`,
    )),
  )
}

function parsePositiveInt(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), max)
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return []
  return value.split(",").map((item) => item.trim()).filter(Boolean)
}

function sqlIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new Error(`Invalid ClickHouse identifier: ${value}`)
  return value
}

function sqlString(value: string): string {
  return `'${value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'")}'`
}

function asSettingString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function resolveClickHouseConfig(context?: CapabilityContext): ClickHouseAdapterConfig {
  const settings = context?.config.capabilities.otel?.adapters?.["clickhouse-otel"] ?? {}
  const runtimeEnv = readSystemBusEnv()
  const value = (key: string): string | undefined => process.env[key]?.trim() || runtimeEnv[key]?.trim()
  return {
    url: (asSettingString(settings.url) ?? value("CLICKHOUSE_URL") ?? DEFAULT_CLICKHOUSE_URL).replace(/\/+$/u, ""),
    database: asSettingString(settings.database) ?? value("CLICKHOUSE_DATABASE") ?? DEFAULT_DATABASE,
    table: asSettingString(settings.table) ?? value("CLICKHOUSE_OTEL_TABLE") ?? DEFAULT_TABLE,
    username: asSettingString(settings.username) ?? value("CLICKHOUSE_USER"),
    password: asSettingString(settings.password) ?? value("CLICKHOUSE_PASSWORD"),
  }
}

function tableName(config: ClickHouseAdapterConfig): string {
  return `${sqlIdent(config.database)}.${sqlIdent(config.table)}`
}

function headers(config: ClickHouseAdapterConfig): Record<string, string> {
  const result: Record<string, string> = {}
  if (config.username) result["X-ClickHouse-User"] = config.username
  if (config.password) result["X-ClickHouse-Key"] = config.password
  return result
}

function buildWhere(input: {
  level?: string
  source?: string
  component?: string
  session?: string
  system?: string
  success?: string
  hours?: number
  query?: string
}): { sql: string; debug: string | undefined } {
  const filters: string[] = []
  const debug: string[] = []

  if (typeof input.hours === "number" && Number.isFinite(input.hours) && input.hours > 0) {
    const cutoffMs = Math.floor(Date.now() - input.hours * 60 * 60 * 1000)
    filters.push(`timestamp >= fromUnixTimestamp64Milli(${cutoffMs})`)
    debug.push(`timestamp>=${cutoffMs}`)
  }

  for (const [field, value] of [["level", input.level], ["source", input.source], ["component", input.component]] as const) {
    const values = splitCsv(value)
    if (values.length > 0) {
      filters.push(`${field} IN (${values.map(sqlString).join(",")})`)
      debug.push(`${field}:=[${values.join(",")}]`)
    }
  }

  if (input.session?.trim()) {
    filters.push(`sessionId = ${sqlString(input.session.trim())}`)
    debug.push(`sessionId:=${input.session.trim()}`)
  }

  if (input.system?.trim()) {
    filters.push(`systemId = ${sqlString(input.system.trim())}`)
    debug.push(`systemId:=${input.system.trim()}`)
  }

  if (input.success === "true" || input.success === "false") {
    filters.push(`success = ${input.success === "true" ? 1 : 0}`)
    debug.push(`success:=${input.success}`)
  }

  const query = input.query?.trim()
  if (query && query !== "*") {
    const q = sqlString(query)
    filters.push(`(positionCaseInsensitive(search_text, ${q}) > 0 OR positionCaseInsensitive(action, ${q}) > 0 OR positionCaseInsensitive(error, ${q}) > 0 OR positionCaseInsensitive(component, ${q}) > 0 OR positionCaseInsensitive(source, ${q}) > 0 OR positionCaseInsensitive(metadata_json, ${q}) > 0)`)
    debug.push(`q:=${query}`)
  }

  return {
    sql: filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "",
    debug: debug.length > 0 ? debug.join(" && ") : undefined,
  }
}

async function queryClickHouse(sql: string, config: ClickHouseAdapterConfig): Promise<OtelQueryResult> {
  try {
    const resp = await fetch(config.url, {
      method: "POST",
      headers: headers(config),
      body: sql,
      signal: AbortSignal.timeout(10_000),
    })
    if (!resp.ok) {
      const text = await resp.text()
      return { ok: false, error: `ClickHouse query failed (${resp.status}): ${text}` }
    }
    return { ok: true, data: await resp.json() }
  } catch (error) {
    return {
      ok: false,
      error: String(error),
      code: "CLICKHOUSE_QUERY_FAILED",
      fix: "Check CLICKHOUSE_URL, ClickHouse health, and the otel_events table.",
    }
  }
}

function failFromResult(result: Extract<OtelQueryResult, { ok: false }>, fallbackCode: string, fallbackFix: string) {
  return capabilityError(result.code ?? fallbackCode, result.error, result.fix ?? fallbackFix)
}

function dataRows(payload: any): any[] {
  return Array.isArray(payload?.data) ? payload.data : []
}

const finalClauseCache = new Map<string, string>()

async function resolveFinalClause(config: ClickHouseAdapterConfig): Promise<string> {
  const key = `${config.url}/${config.database}/${config.table}`
  const cached = finalClauseCache.get(key)
  if (cached !== undefined) return cached

  const result = await queryClickHouse(
    `SELECT engine FROM system.tables WHERE database = ${sqlString(config.database)} AND name = ${sqlString(config.table)} LIMIT 1 FORMAT JSON`,
    config,
  )
  if (!result.ok) {
    finalClauseCache.set(key, "")
    return ""
  }
  const engine = String(dataRows(result.data)[0]?.engine ?? "")
  const final = /ReplacingMergeTree|CollapsingMergeTree|VersionedCollapsingMergeTree/u.test(engine) ? "FINAL" : ""
  finalClauseCache.set(key, final)
  return final
}

function simplifyRow(row: Record<string, unknown>): Record<string, unknown> {
  const timestamp = Number(row.timestamp ?? 0)
  return {
    id: row.id,
    ts: timestamp > 0 ? new Date(timestamp).toISOString() : row.timestamp,
    sessionId: row.sessionId,
    systemId: row.systemId,
    level: row.level,
    source: row.source,
    component: row.component,
    action: row.action,
    success: row.success === 1 || row.success === true,
    duration_ms: row.duration_ms,
    error: row.error,
    metadata_keys: row.metadata_keys,
  }
}

async function countRows(config: ClickHouseAdapterConfig, whereSql: string): Promise<number> {
  const final = await resolveFinalClause(config)
  const result = await queryClickHouse(`SELECT count() AS count FROM ${tableName(config)} ${final} ${whereSql} FORMAT JSON`, config)
  if (!result.ok) throw new Error(result.error)
  return Number(dataRows(result.data)[0]?.count ?? 0)
}

async function facetCounts(config: ClickHouseAdapterConfig, whereSql: string, field: string): Promise<Record<string, unknown>> {
  const final = await resolveFinalClause(config)
  const result = await queryClickHouse(`SELECT ${field} AS value, count() AS count FROM ${tableName(config)} ${final} ${whereSql} GROUP BY ${field} ORDER BY count DESC LIMIT 50 FORMAT JSON`, config)
  if (!result.ok) return { field_name: field, counts: [] }
  return {
    field_name: field,
    counts: dataRows(result.data).map((row) => ({ value: String(row.value), count: Number(row.count ?? 0) })),
  }
}

async function loadFacets(config: ClickHouseAdapterConfig, whereSql: string): Promise<Record<string, unknown>[]> {
  return Promise.all(["level", "source", "component", "success"].map((field) => facetCounts(config, whereSql, field)))
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
  return typeof value === "boolean" ? value : undefined
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
    return { ok: false, error: "OTEL emit requires an action (stdin JSON action, positional action, or --action).", fix: "Provide action via stdin payload, positional arg, or --action." }
  }

  const metadataCandidate = args.metadata !== undefined ? args.metadata : baseEvent.metadata
  const metadata = metadataCandidate === undefined ? {} : asObject(metadataCandidate)
  if (!metadata) {
    return { ok: false, error: "OTEL emit metadata must be a JSON object.", fix: "Pass --metadata as a JSON object." }
  }

  const level = normalizeLevel(args.level) ?? normalizeLevel(baseEvent.level) ?? "info"
  return {
    ok: true,
    payload: createOtelEventPayload({
      id: asNonEmptyString(args.id) ?? asNonEmptyString(baseEvent.id) ?? randomUUID(),
      timestamp: asFiniteNumber(args.timestamp) ?? asFiniteNumber(baseEvent.timestamp) ?? Date.now(),
      sessionId: asNonEmptyString(baseEvent.sessionId) ?? resolveDefaultOtelSessionId(),
      systemId: asNonEmptyString(baseEvent.systemId) ?? resolveDefaultOtelSystemId(),
      level: level as "debug" | "info" | "warn" | "error" | "fatal",
      source: asNonEmptyString(args.source) ?? asNonEmptyString(baseEvent.source) ?? "cli",
      component: asNonEmptyString(args.component) ?? asNonEmptyString(baseEvent.component) ?? "otel-cli",
      action,
      success: args.success ?? asBoolean(baseEvent.success) ?? true,
      metadata,
      error: asNonEmptyString(args.error) ?? asNonEmptyString(baseEvent.error),
    }),
  }
}

async function emitOtel(payload: Record<string, unknown>): Promise<OtelQueryResult> {
  const result = await ingestOtelPayload(payload)
  if (!result.ok) {
    return { ok: false, error: result.error, code: "OTEL_EMIT_FAILED", fix: `Ensure worker endpoint ${OTEL_INGEST_URL} is reachable and accepts the payload.` }
  }
  return { ok: true, data: { endpoint: result.endpoint, status: result.status, response: result.response, event: payload } }
}

export const clickhouseOtelAdapter: CapabilityPort<typeof commands> = {
  capability: "otel",
  adapter: "clickhouse-otel",
  commands,
  execute(subcommand, rawArgs, context) {
    return Effect.gen(function* () {
      const config = resolveClickHouseConfig(context)
      switch (subcommand) {
        case "list": {
          const args = yield* decodeArgs("list", rawArgs)
          const page = parsePositiveInt(args.page, 1, 10_000)
          const limit = parsePositiveInt(args.limit, 30, 200)
          const offset = (page - 1) * limit
          const where = buildWhere({ level: args.level, source: args.source, component: args.component, session: args.session, system: args.system, success: args.success, hours: args.hours })
          const final = yield* Effect.promise(() => resolveFinalClause(config))
          const result = yield* Effect.promise(() => queryClickHouse(`SELECT id, toUnixTimestamp64Milli(timestamp) AS timestamp, sessionId, systemId, level, source, component, action, success, duration_ms, error, metadata_keys FROM ${tableName(config)} ${final} ${where.sql} ORDER BY timestamp DESC LIMIT ${limit} OFFSET ${offset} FORMAT JSON`, config))
          if (!result.ok) return yield* Effect.fail(failFromResult(result, "OTEL_QUERY_FAILED", "Check ClickHouse health and otel_events schema"))
          const [found, facets] = yield* Effect.promise(() => Promise.all([countRows(config, where.sql), loadFacets(config, where.sql)]))
          return { found, page, limit, filterBy: where.debug, adapter: "clickhouse-otel", events: dataRows(result.data).map(simplifyRow), facets }
        }
        case "search": {
          const args = yield* decodeArgs("search", rawArgs)
          const page = parsePositiveInt(args.page, 1, 10_000)
          const limit = parsePositiveInt(args.limit, 30, 200)
          const offset = (page - 1) * limit
          const where = buildWhere({ query: args.query, level: args.level, source: args.source, component: args.component, session: args.session, system: args.system, success: args.success, hours: args.hours })
          const final = yield* Effect.promise(() => resolveFinalClause(config))
          const result = yield* Effect.promise(() => queryClickHouse(`SELECT id, toUnixTimestamp64Milli(timestamp) AS timestamp, sessionId, systemId, level, source, component, action, success, duration_ms, error, metadata_keys FROM ${tableName(config)} ${final} ${where.sql} ORDER BY timestamp DESC LIMIT ${limit} OFFSET ${offset} FORMAT JSON`, config))
          if (!result.ok) return yield* Effect.fail(failFromResult(result, "OTEL_QUERY_FAILED", "Check ClickHouse health and otel_events schema"))
          const [found, facets] = yield* Effect.promise(() => Promise.all([countRows(config, where.sql), loadFacets(config, where.sql)]))
          return { query: args.query, found, page, limit, filterBy: where.debug, adapter: "clickhouse-otel", events: dataRows(result.data).map(simplifyRow), facets }
        }
        case "correlate": {
          const args = yield* decodeArgs("correlate", rawArgs)
          const sessionId = args.sessionId?.trim()
          const systemId = args.systemId?.trim()
          if (!sessionId && !systemId) return yield* Effect.fail(capabilityError("OTEL_INVALID_ARGS", "OTEL correlate requires `sessionId` or `systemId`.", "Provide `sessionId` or `systemId`."))
          const limit = parsePositiveInt(args.limit, 50, 200)
          const where = buildWhere({ session: sessionId, system: systemId, hours: args.hours })
          const final = yield* Effect.promise(() => resolveFinalClause(config))
          const result = yield* Effect.promise(() => queryClickHouse(`SELECT id, toUnixTimestamp64Milli(timestamp) AS timestamp, sessionId, systemId, level, source, component, action, success, duration_ms, error, metadata_keys FROM ${tableName(config)} ${final} ${where.sql} ORDER BY timestamp DESC LIMIT ${limit} FORMAT JSON`, config))
          if (!result.ok) return yield* Effect.fail(failFromResult(result, "OTEL_QUERY_FAILED", "Check ClickHouse health and otel_events schema"))
          const hits = dataRows(result.data).map((row) => ({ collection: "otel_events", ...simplifyRow(row), timestamp: Number(row.timestamp ?? 0) }))
          return { windowHours: args.hours, limit, returned: hits.length, found: hits.length, filterBy: { otel_events: where.debug, system_log: undefined }, scope: sessionId ? "session" : "system", sessionId, systemId, collections: [{ collection: "otel_events", found: hits.length }], hits }
        }
        case "stats": {
          const args = yield* decodeArgs("stats", rawArgs)
          const where = buildWhere({ source: args.source, component: args.component, hours: args.hours })
          const recentWhere = buildWhere({ source: args.source, component: args.component, hours: 0.25 })
          const final = yield* Effect.promise(() => resolveFinalClause(config))
          const stats = yield* Effect.promise(() => Promise.all([
            queryClickHouse(`SELECT count() AS total, countIf(level IN ('error','fatal')) AS errors FROM ${tableName(config)} ${final} ${where.sql} FORMAT JSON`, config),
            queryClickHouse(`SELECT count() AS total, countIf(level IN ('error','fatal')) AS errors FROM ${tableName(config)} ${final} ${recentWhere.sql} FORMAT JSON`, config),
            queryClickHouse(`SELECT countIf(positionCaseInsensitive(action, 'system_knowledge.retrieval') > 0) AS retrievals, countIf(positionCaseInsensitive(action, 'knowledge.watchdog.check') > 0) AS watchdog_checks FROM ${tableName(config)} ${final} ${where.sql} FORMAT JSON`, config),
            loadFacets(config, where.sql),
          ]))
          const [windowData, recentData, knowledgeData, facets] = stats
          if (!windowData.ok) return yield* Effect.fail(failFromResult(windowData, "OTEL_STATS_FAILED", "Check ClickHouse health"))
          if (!recentData.ok) return yield* Effect.fail(failFromResult(recentData, "OTEL_STATS_FAILED", "Check ClickHouse health"))
          if (!knowledgeData.ok) return yield* Effect.fail(failFromResult(knowledgeData, "OTEL_STATS_FAILED", "Check ClickHouse health"))
          const windowRow = dataRows(windowData.data)[0] ?? {}
          const recentRow = dataRows(recentData.data)[0] ?? {}
          const knowledgeRow = dataRows(knowledgeData.data)[0] ?? {}
          const total = Number(windowRow.total ?? 0)
          const errors = Number(windowRow.errors ?? 0)
          const recentTotal = Number(recentRow.total ?? 0)
          const recentErrors = Number(recentRow.errors ?? 0)
          return { windowHours: args.hours, filterBy: where.debug, adapter: "clickhouse-otel", total, errors, errorRate: total > 0 ? errors / total : 0, recent15m: { total: recentTotal, errors: recentErrors, errorRate: recentTotal > 0 ? recentErrors / recentTotal : 0 }, knowledge: { retrievals: Number(knowledgeRow.retrievals ?? 0), watchdog_checks: Number(knowledgeRow.watchdog_checks ?? 0) }, facets }
        }
        case "emit": {
          const args = yield* decodeArgs("emit", rawArgs)
          const payload = buildEmitPayload(args)
          if (!payload.ok) return yield* Effect.fail(capabilityError("OTEL_INVALID_ARGS", payload.error, payload.fix))
          const result = yield* Effect.promise(() => emitOtel(payload.payload))
          if (!result.ok) return yield* Effect.fail(failFromResult(result, "OTEL_EMIT_FAILED", `Ensure ${OTEL_INGEST_URL} is reachable and worker is healthy.`))
          return result.data
        }
        default:
          return yield* Effect.fail(capabilityError("OTEL_SUBCOMMAND_UNSUPPORTED", `Unsupported otel subcommand: ${String(subcommand)}`))
      }
    })
  },
}

export const __clickhouseOtelAdapterTestUtils = {
  buildWhere,
  parsePositiveInt,
  resolveClickHouseConfig,
  splitCsv,
  sqlString,
}
