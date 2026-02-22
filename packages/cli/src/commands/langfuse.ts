import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { respond, respondError } from "../response"

type OptionalText = { _tag: "Some"; value: string } | { _tag: "None" }

type LangfuseConfig = {
  baseUrl: string
  publicKey: string
  secretKey: string
  projectId?: string
}

type LangfuseTrace = {
  id?: string
  projectId?: string
  name?: string
  timestamp?: string
  totalCost?: number
  latency?: number
  metadata?: Record<string, unknown>
  output?: unknown
  htmlPath?: string
}

type LangfusePageResponse = {
  data?: LangfuseTrace[]
  meta?: {
    page?: number
    limit?: number
    totalItems?: number
    totalPages?: number
  }
}

type TrendBucket = { bucketStart: string; count: number }

type SignatureTrend = {
  signature: string
  count: number
  buckets: TrendBucket[]
}

const DEFAULT_BASE_URL = "https://cloud.langfuse.com"
const SECRET_TTL = process.env.JOELCLAW_LANGFUSE_SECRET_TTL ?? "15m"
const SECRET_TIMEOUT_MS = Number.parseInt(process.env.JOELCLAW_LANGFUSE_SECRET_TIMEOUT_MS ?? "2500", 10)

function parseOptionalText(value: OptionalText): string | undefined {
  if (value._tag !== "Some") return undefined
  const normalized = value.value.trim()
  return normalized.length > 0 ? normalized : undefined
}

function parsePositiveInt(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), max)
}

function readShellText(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  if (value == null) return ""
  return String(value)
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function compact(value: string, max = 180): string {
  const oneLine = value.replace(/\s+/gu, " ").trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(max - 3, 1))}...`
}

function sanitizeBaseUrl(value: string | undefined): string {
  if (!value) return DEFAULT_BASE_URL
  return value.trim().replace(/\/$/u, "")
}

function leaseSecret(name: string): string | undefined {
  try {
    const proc = Bun.spawnSync(["secrets", "lease", name, "--ttl", SECRET_TTL], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: SECRET_TIMEOUT_MS,
      env: { ...process.env, TERM: "dumb" },
    })

    if (proc.exitCode !== 0) return undefined
    const value = readShellText(proc.stdout).trim()
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

export function parseProjectIdFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined

  const direct = trimmed.match(/^[a-z0-9]{20,}$/iu)
  if (direct) return direct[0]

  const match = trimmed.match(/\/project\/([a-z0-9]{20,})/iu)
  return match?.[1]
}

function resolveLangfuseConfig(project?: string, projectUrl?: string): LangfuseConfig | null {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim() || leaseSecret("langfuse_public_key")
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim() || leaseSecret("langfuse_secret_key")
  const baseUrl = sanitizeBaseUrl(process.env.LANGFUSE_BASE_URL?.trim() || leaseSecret("langfuse_base_url"))

  if (!publicKey || !secretKey) return null

  const projectId = project
    ?? parseProjectIdFromUrl(projectUrl)
    ?? parseProjectIdFromUrl(process.env.LANGFUSE_PROJECT_URL)
    ?? process.env.LANGFUSE_PROJECT_ID?.trim()

  return {
    baseUrl,
    publicKey,
    secretKey,
    projectId: projectId && projectId.length > 0 ? projectId : undefined,
  }
}

async function fetchTracePage(config: LangfuseConfig, page: number, limit: number): Promise<LangfusePageResponse> {
  const url = new URL(`${config.baseUrl}/api/public/traces`)
  url.searchParams.set("page", String(page))
  url.searchParams.set("limit", String(limit))

  const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")
  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(`Langfuse API ${resp.status}: ${compact(text || resp.statusText || "request_failed")}`)
  }

  return await resp.json() as LangfusePageResponse
}

function safeRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined
}

function traceSignature(trace: LangfuseTrace): string {
  const metadata = safeRecord(trace.metadata)
  const component = typeof metadata?.component === "string" ? metadata.component.trim() : ""
  const action = typeof metadata?.action === "string" ? metadata.action.trim() : ""

  if (component && action) return `${component}.${action}`
  if (component) return component
  if (action) return action
  if (typeof trace.name === "string" && trace.name.trim().length > 0) return trace.name.trim()
  return "unknown"
}

function traceDurationMs(trace: LangfuseTrace): number | undefined {
  const metadata = safeRecord(trace.metadata)
  const metadataDuration = toFiniteNumber(metadata?.durationMs)
  if (metadataDuration != null) return metadataDuration

  const latency = toFiniteNumber(trace.latency)
  if (latency == null) return undefined

  // Langfuse latency can arrive in seconds for some APIs.
  if (latency > 0 && latency < 100) return latency * 1000
  return latency
}

function traceCost(trace: LangfuseTrace): number {
  const value = toFiniteNumber(trace.totalCost)
  return value != null ? value : 0
}

function traceProvider(trace: LangfuseTrace): string {
  const metadata = safeRecord(trace.metadata)
  const provider = typeof metadata?.provider === "string" ? metadata.provider.trim() : ""
  return provider || "unknown"
}

function traceModel(trace: LangfuseTrace): string {
  const metadata = safeRecord(trace.metadata)
  const model = typeof metadata?.model === "string" ? metadata.model.trim() : ""
  return model || "unknown"
}

function traceComponent(trace: LangfuseTrace): string {
  const metadata = safeRecord(trace.metadata)
  const component = typeof metadata?.component === "string" ? metadata.component.trim() : ""
  return component || "unknown"
}

function traceAction(trace: LangfuseTrace): string {
  const metadata = safeRecord(trace.metadata)
  const action = typeof metadata?.action === "string" ? metadata.action.trim() : ""
  return action || "unknown"
}

function traceHasFailureSignal(trace: LangfuseTrace): boolean {
  const metadata = safeRecord(trace.metadata)
  const output = safeRecord(trace.output)

  if (typeof metadata?.error === "string" && metadata.error.trim().length > 0) return true
  if (output?.failed === true) return true

  const name = typeof trace.name === "string" ? trace.name.toLowerCase() : ""
  return name.includes("failed") || name.includes("error")
}

function addCount(map: Map<string, number>, key: string, increment = 1): void {
  map.set(key, (map.get(key) ?? 0) + increment)
}

function topCounts(map: Map<string, number>, limit: number): Array<{ key: string; count: number }> {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }))
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index] ?? 0
}

function bucketStartIso(timestampMs: number, bucketMinutes: number): string {
  const bucketMs = bucketMinutes * 60 * 1000
  const floored = Math.floor(timestampMs / bucketMs) * bucketMs
  return new Date(floored).toISOString()
}

export function aggregateLangfuseTraces(
  traces: LangfuseTrace[],
  bucketMinutes: number
): {
  traceCount: number
  totalCost: number
  averageCost: number
  durations: { avgMs: number; p50Ms: number; p95Ms: number }
  failureSignals: number
  unique: { names: number; signatures: number; models: number; components: number }
  breakdowns: {
    names: Array<{ name: string; count: number }>
    signatures: Array<{ signature: string; count: number }>
    providers: Array<{ provider: string; count: number }>
    models: Array<{ model: string; count: number }>
    components: Array<{ component: string; count: number }>
    actions: Array<{ action: string; count: number }>
  }
  signatureTrends: SignatureTrend[]
  samples: {
    expensive: Array<Record<string, unknown>>
    slow: Array<Record<string, unknown>>
  }
} {
  const byName = new Map<string, number>()
  const bySignature = new Map<string, number>()
  const byProvider = new Map<string, number>()
  const byModel = new Map<string, number>()
  const byComponent = new Map<string, number>()
  const byAction = new Map<string, number>()
  const trendMap = new Map<string, Map<string, number>>()
  const durations: number[] = []
  const expensive = [...traces]
    .sort((a, b) => traceCost(b) - traceCost(a))
    .slice(0, 5)
  const slow = [...traces]
    .sort((a, b) => (traceDurationMs(b) ?? 0) - (traceDurationMs(a) ?? 0))
    .slice(0, 5)

  let totalCost = 0
  let failureSignals = 0

  for (const trace of traces) {
    const name = typeof trace.name === "string" && trace.name.trim().length > 0 ? trace.name.trim() : "unknown"
    const signature = traceSignature(trace)
    const provider = traceProvider(trace)
    const model = traceModel(trace)
    const component = traceComponent(trace)
    const action = traceAction(trace)
    const timestamp = typeof trace.timestamp === "string" ? Date.parse(trace.timestamp) : Number.NaN

    addCount(byName, name)
    addCount(bySignature, signature)
    addCount(byProvider, provider)
    addCount(byModel, model)
    addCount(byComponent, component)
    addCount(byAction, action)

    if (Number.isFinite(timestamp)) {
      const bucket = bucketStartIso(timestamp, bucketMinutes)
      const byBucket = trendMap.get(signature) ?? new Map<string, number>()
      byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + 1)
      trendMap.set(signature, byBucket)
    }

    totalCost += traceCost(trace)

    const duration = traceDurationMs(trace)
    if (duration != null && duration >= 0) durations.push(duration)

    if (traceHasFailureSignal(trace)) failureSignals += 1
  }

  const topSignatures = topCounts(bySignature, 8)
  const signatureTrends: SignatureTrend[] = topSignatures.map(({ key, count }) => {
    const buckets = trendMap.get(key) ?? new Map<string, number>()
    return {
      signature: key,
      count,
      buckets: [...buckets.entries()]
        .sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]))
        .map(([bucketStart, bucketCount]) => ({ bucketStart, count: bucketCount })),
    }
  })

  return {
    traceCount: traces.length,
    totalCost,
    averageCost: traces.length > 0 ? totalCost / traces.length : 0,
    durations: {
      avgMs: durations.length > 0 ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
    },
    failureSignals,
    unique: {
      names: byName.size,
      signatures: bySignature.size,
      models: byModel.size,
      components: byComponent.size,
    },
    breakdowns: {
      names: topCounts(byName, 10).map(({ key, count }) => ({ name: key, count })),
      signatures: topSignatures.map(({ key, count }) => ({ signature: key, count })),
      providers: topCounts(byProvider, 10).map(({ key, count }) => ({ provider: key, count })),
      models: topCounts(byModel, 10).map(({ key, count }) => ({ model: key, count })),
      components: topCounts(byComponent, 10).map(({ key, count }) => ({ component: key, count })),
      actions: topCounts(byAction, 10).map(({ key, count }) => ({ action: key, count })),
    },
    signatureTrends,
    samples: {
      expensive: expensive.map((trace) => ({
        id: trace.id,
        timestamp: trace.timestamp,
        name: trace.name,
        cost: traceCost(trace),
        model: traceModel(trace),
        provider: traceProvider(trace),
      })),
      slow: slow.map((trace) => ({
        id: trace.id,
        timestamp: trace.timestamp,
        name: trace.name,
        durationMs: traceDurationMs(trace),
        model: traceModel(trace),
        provider: traceProvider(trace),
      })),
    },
  }
}

const hoursOpt = Options.integer("hours").pipe(
  Options.withAlias("h"),
  Options.withDefault(24),
  Options.withDescription("Lookback window in hours")
)

const maxTracesOpt = Options.integer("max-traces").pipe(
  Options.withDefault(2000),
  Options.withDescription("Maximum traces to aggregate")
)

const pageSizeOpt = Options.integer("page-size").pipe(
  Options.withDefault(100),
  Options.withDescription("Langfuse page size per request")
)

const bucketMinutesOpt = Options.integer("bucket-minutes").pipe(
  Options.withDefault(60),
  Options.withDescription("Trend bucket size in minutes")
)

const projectOpt = Options.text("project").pipe(
  Options.optional,
  Options.withDescription("Project ID override (e.g. cmlx4cd4901lyad07ih16f95i)")
)

const projectUrlOpt = Options.text("project-url").pipe(
  Options.optional,
  Options.withDescription("Project URL override (extracts project ID)")
)

const namePrefixOpt = Options.text("name-prefix").pipe(
  Options.optional,
  Options.withDescription("Optional trace name prefix filter")
)

const aggregateCmd = Command.make(
  "aggregate",
  {
    hours: hoursOpt,
    maxTraces: maxTracesOpt,
    pageSize: pageSizeOpt,
    bucketMinutes: bucketMinutesOpt,
    project: projectOpt,
    projectUrl: projectUrlOpt,
    namePrefix: namePrefixOpt,
  },
  ({ hours, maxTraces, pageSize, bucketMinutes, project, projectUrl, namePrefix }) =>
    Effect.gen(function* () {
      const safeHours = parsePositiveInt(hours, 24, 24 * 365)
      const safeMaxTraces = parsePositiveInt(maxTraces, 2000, 10_000)
      const safePageSize = parsePositiveInt(pageSize, 100, 500)
      const safeBucketMinutes = parsePositiveInt(bucketMinutes, 60, 24 * 60)
      const projectOverride = parseOptionalText(project)
      const projectUrlOverride = parseOptionalText(projectUrl)
      const prefixFilter = parseOptionalText(namePrefix)

      const config = resolveLangfuseConfig(projectOverride, projectUrlOverride)
      if (!config) {
        yield* Console.log(
          respondError(
            "langfuse aggregate",
            "Langfuse credentials are missing",
            "LANGFUSE_CREDENTIALS_MISSING",
            "Set LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY or store langfuse_public_key + langfuse_secret_key in agent-secrets",
            [
              { command: "secrets lease langfuse_public_key --ttl 15m", description: "Verify Langfuse public key is available" },
              { command: "secrets lease langfuse_secret_key --ttl 15m", description: "Verify Langfuse secret key is available" },
            ]
          )
        )
        return
      }

      const cutoffMs = Date.now() - safeHours * 60 * 60 * 1000
      const projectFilter = config.projectId
      const traces: LangfuseTrace[] = []
      const projectIds = new Set<string>()

      let page = 1
      let totalPages = 1
      let reachedWindowBoundary = false

      try {
        while (page <= totalPages && traces.length < safeMaxTraces && !reachedWindowBoundary) {
          const response = yield* Effect.promise(() => fetchTracePage(config, page, safePageSize))
          const pageTraces = Array.isArray(response.data) ? response.data : []
          totalPages = Number(response.meta?.totalPages ?? totalPages)

          if (pageTraces.length === 0) break

          for (const trace of pageTraces) {
            if (trace.projectId) projectIds.add(trace.projectId)

            if (projectFilter && trace.projectId && trace.projectId !== projectFilter) continue

            if (prefixFilter) {
              const traceName = typeof trace.name === "string" ? trace.name : ""
              if (!traceName.startsWith(prefixFilter)) continue
            }

            const traceTime = typeof trace.timestamp === "string" ? Date.parse(trace.timestamp) : Number.NaN
            if (Number.isFinite(traceTime) && traceTime < cutoffMs) {
              reachedWindowBoundary = true
              continue
            }

            traces.push(trace)
            if (traces.length >= safeMaxTraces) break
          }

          page += 1
        }
      } catch (error) {
        yield* Console.log(
          respondError(
            "langfuse aggregate",
            error instanceof Error ? error.message : String(error),
            "LANGFUSE_API_FAILED",
            "Verify langfuse_base_url and keys, then retry. Use --project-url to target a specific project.",
            [
              { command: "joelclaw status", description: "Check local worker + ingress health" },
              { command: "joelclaw logs analyze --lines 300", description: "Compare with local aggregate logs" },
            ]
          )
        )
        return
      }

      const aggregate = aggregateLangfuseTraces(traces, safeBucketMinutes)
      const effectiveProjectId = projectFilter ?? [...projectIds][0]
      const projectDashboardUrl = effectiveProjectId
        ? `${config.baseUrl}/project/${effectiveProjectId}`
        : undefined

      yield* Console.log(
        respond(
          "langfuse aggregate",
          {
            scope: {
              baseUrl: config.baseUrl,
              projectId: effectiveProjectId ?? null,
              projectIdsSeen: [...projectIds],
              projectDashboardUrl: projectDashboardUrl ?? null,
              hours: safeHours,
              bucketMinutes: safeBucketMinutes,
              maxTraces: safeMaxTraces,
              pageSize: safePageSize,
              namePrefix: prefixFilter ?? null,
            },
            collection: {
              tracesInWindow: traces.length,
              windowStart: new Date(cutoffMs).toISOString(),
              reachedWindowBoundary,
              exhaustedMaxTraces: traces.length >= safeMaxTraces,
            },
            aggregate,
          },
          [
            {
              command: "joelclaw langfuse aggregate [--hours <hours>] [--project <project>] [--bucket-minutes <bucket-minutes>]",
              description: "Re-run aggregate with different window or project",
              params: {
                hours: { description: "Lookback window", value: Math.min(safeHours * 2, 168), default: 24 },
                ...(effectiveProjectId
                  ? { project: { description: "Langfuse project ID", value: effectiveProjectId } }
                  : {}),
                "bucket-minutes": { description: "Trend bucket size", value: safeBucketMinutes, default: 60 },
              },
            },
            {
              command: "joelclaw logs analyze [--lines <lines>]",
              description: "Compare cloud traces against local/system logs",
              params: {
                lines: { description: "Line budget per source", value: 400, default: 300 },
              },
            },
            {
              command: "joelclaw otel stats --hours <hours>",
              description: "Cross-check OTEL error-rate against Langfuse trends",
              params: {
                hours: { description: "Lookback window", value: safeHours, default: 24 },
              },
            },
          ]
        )
      )
    })
)

export const langfuseCmd = Command.make("langfuse", {}, () =>
  Console.log(
    respond(
      "langfuse",
      {
        description: "Langfuse cloud analytics (LLM-only observability under ADR-0101)",
        subcommands: {
          aggregate:
            "joelclaw langfuse aggregate [--hours 24] [--project <project-id>] [--bucket-minutes 60] [--name-prefix joelclaw.]",
        },
      },
      [
        { command: "joelclaw langfuse aggregate --hours 24", description: "Project-level Langfuse aggregate" },
        { command: "joelclaw logs analyze --lines 300", description: "Aggregate local/system logs" },
        { command: "joelclaw otel stats --hours 24", description: "Aggregate OTEL event rates" },
      ],
      true
    )
  )
).pipe(Command.withSubcommands([aggregateCmd]))
