import { createServer } from "node:net"
import { Args, Command, Options } from "@effect/cli"
import {
  DEFAULT_QUEUE_CONTROL_CONFIG,
  getQueueStats,
  init,
  listActiveQueueFamilyPauses,
  type QueueConfig,
} from "@joelclaw/queue"
import { Console, Effect } from "effect"
import Redis from "ioredis"
import { loadConfig } from "../config"
import { Inngest } from "../inngest"
import { type NextAction, respond, respondError } from "../response"

type MonitorSeverity = "healthy" | "degraded" | "down"

type QueueStatusSnapshot = {
  status: MonitorSeverity
  summary: string
  depth: number
  byPriority: Record<string, number>
  oldestAgeMs: number | null
  activePauses: Array<{
    family: string
    reason: string
    source: string
    mode: string
    appliedAt: string
    expiresAt: string
    expiresInMs: number
  }>
  redisUrl: string
  error: string | null
}

type RestateStatusSnapshot = {
  status: MonitorSeverity
  summary: string
  namespace: string
  adminUrl: string
  statefulset: {
    exists: boolean
    desiredReplicas: number
    readyReplicas: number
    phase: string
    error: string | null
  }
  service: {
    exists: boolean
    type: string | null
    ports: Array<{ name: string | null; port: number | null; targetPort: string | number | null }>
    error: string | null
  }
  admin: {
    healthy: boolean
    status: number
    response: string | null
  }
}

type DkronStatusSnapshot = {
  status: MonitorSeverity
  summary: string
  namespace: string
  serviceName: string
  statefulset: {
    exists: boolean
    desiredReplicas: number
    readyReplicas: number
    phase: string
    error: string | null
  }
  service: {
    exists: boolean
    type: string | null
    ports: Array<{ name: string | null; port: number | null; targetPort: string | number | null }>
    error: string | null
  }
  api: {
    accessible: boolean
    status: number
    response: unknown
    accessMode: string
    baseUrl: string | null
    localPort: number | null
    error: string | null
  }
  jobs: {
    total: number | null
    restate: number | null
  }
}

type InngestStatusSnapshot = {
  status: MonitorSeverity
  summary: string
  checks: Record<string, { ok: boolean; detail?: string | null }>
  recentRuns: {
    hours: number
    count: number
    byStatus: Record<string, number>
    recent: Array<{
      id: string
      functionName: string
      status: string
      startedAt: string | null
      endedAt: string | null
    }>
  }
}

type JobsStatusResult = {
  checkedAt: string
  overall: {
    status: MonitorSeverity
    summary: string
  }
  queue: QueueStatusSnapshot
  restate: RestateStatusSnapshot
  dkron: DkronStatusSnapshot
  inngest: InngestStatusSnapshot
}

type KubectlResult = {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
}

type DkronAccessMode = "direct" | "tunnel"

type DkronSession = {
  baseUrl: string
  accessMode: DkronAccessMode
  localPort?: number
  logPath?: string
  dispose: () => Promise<void>
}

type JsonHttpResult = {
  ok: boolean
  status: number
  text: string
  json: any
}

const cfg = loadConfig()
const REDIS_URL = cfg.redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:6379"
const DEFAULT_RESTATE_ADMIN_URL = process.env.RESTATE_ADMIN_URL?.trim() || "http://localhost:9070"
const DEFAULT_DKRON_BASE_URL = process.env.DKRON_URL?.trim() || ""

const QUEUE_CONFIG: QueueConfig = {
  streamKey: "joelclaw:queue:events",
  priorityKey: "joelclaw:queue:priority",
  consumerGroup: "joelclaw:queue:jobs-status",
  consumerName: "jobs-status",
}

const decode = (value: string | Uint8Array | null | undefined): string => {
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  return ""
}

const runKubectl = (args: string[]): KubectlResult => {
  const proc = Bun.spawnSync(["kubectl", ...args], { stdout: "pipe", stderr: "pipe" })
  return {
    ok: proc.exitCode === 0,
    exitCode: proc.exitCode,
    stdout: decode(proc.stdout).trim(),
    stderr: decode(proc.stderr).trim(),
  }
}

const parseJson = <T = Record<string, unknown>>(raw: string): T | null => {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

const stripTrailingSlash = (value: string): string => value.replace(/\/$/, "")

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const findFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a local port")))
        return
      }
      const { port } = address
      server.close((error) => {
        if (error) reject(error)
        else resolve(port)
      })
    })
  })

const shellEscape = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`

const startDkronTunnel = async (
  namespace: string,
  serviceName: string,
  remotePort = 8080,
): Promise<DkronSession> => {
  const localPort = await findFreePort()
  const logPath = `/tmp/joelclaw-dkron-port-forward-${Date.now()}-${localPort}.log`

  const launch = Bun.spawnSync([
    "bash",
    "-lc",
    `kubectl -n ${shellEscape(namespace)} port-forward svc/${serviceName} ${localPort}:${remotePort} > ${shellEscape(logPath)} 2>&1 & echo $!`,
  ], { stdout: "pipe", stderr: "pipe" })

  const pid = Number.parseInt(decode(launch.stdout).trim(), 10)
  if (launch.exitCode !== 0 || !Number.isFinite(pid)) {
    const detail = decode(launch.stderr).trim() || decode(launch.stdout).trim()
    throw new Error(detail || "Failed to start temporary Dkron tunnel")
  }

  const baseUrl = `http://127.0.0.1:${localPort}`

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) })
      if (response.ok) {
        return {
          baseUrl,
          accessMode: "tunnel",
          localPort,
          logPath,
          dispose: async () => {
            Bun.spawnSync(["bash", "-lc", `kill ${pid} >/dev/null 2>&1 || true`], { stdout: "ignore", stderr: "ignore" })
            await sleep(50)
            Bun.spawnSync(["bash", "-lc", `rm -f ${shellEscape(logPath)}`], { stdout: "ignore", stderr: "ignore" })
          },
        }
      }
    } catch {
      // tunnel not ready yet
    }
    await sleep(250)
  }

  const logDetail = decode(Bun.spawnSync(["bash", "-lc", `cat ${shellEscape(logPath)} 2>/dev/null || true`], {
    stdout: "pipe",
    stderr: "pipe",
  }).stdout).trim()

  Bun.spawnSync(["bash", "-lc", `kill ${pid} >/dev/null 2>&1 || true`], { stdout: "ignore", stderr: "ignore" })
  Bun.spawnSync(["bash", "-lc", `rm -f ${shellEscape(logPath)}`], { stdout: "ignore", stderr: "ignore" })

  throw new Error(logDetail || "Temporary Dkron tunnel never became ready")
}

const openDkronSession = async (
  namespace: string,
  serviceName: string,
  baseUrl?: string,
): Promise<DkronSession> => {
  if (baseUrl?.trim()) {
    return {
      baseUrl: stripTrailingSlash(baseUrl.trim()),
      accessMode: "direct",
      dispose: async () => {},
    }
  }

  return startDkronTunnel(namespace, serviceName)
}

const fetchJson = async (
  baseUrl: string,
  pathname: string,
  init?: RequestInit,
): Promise<JsonHttpResult> => {
  const response = await fetch(`${stripTrailingSlash(baseUrl)}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(5_000),
  })

  const text = await response.text()
  return {
    ok: response.ok,
    status: response.status,
    text,
    json: parseJson(text),
  }
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function severityRank(status: MonitorSeverity): number {
  if (status === "down") return 3
  if (status === "degraded") return 2
  return 1
}

function worstSeverity(...statuses: MonitorSeverity[]): MonitorSeverity {
  return statuses.reduce<MonitorSeverity>((worst, current) =>
    severityRank(current) > severityRank(worst) ? current : worst,
  "healthy")
}

function summarizeRunStatuses(runs: Array<{ status: string }>): Record<string, number> {
  return runs.reduce<Record<string, number>>((acc, run) => {
    acc[run.status] = (acc[run.status] ?? 0) + 1
    return acc
  }, {})
}

function describeQueueOverall(queue: QueueStatusSnapshot): string {
  const pauseSuffix = queue.activePauses.length > 0
    ? `, ${queue.activePauses.length} pause${queue.activePauses.length === 1 ? "" : "s"}`
    : ""

  if (queue.status === "down") {
    return "queue down"
  }

  if (queue.depth === 0) {
    return pauseSuffix ? `queue idle (depth 0${pauseSuffix})` : "queue idle"
  }

  if (queue.activePauses.length > 0) {
    return `queue held (depth ${queue.depth}${pauseSuffix})`
  }

  return `queue ${queue.status} (depth ${queue.depth})`
}

function buildOverallSummary(input: {
  queue: QueueStatusSnapshot
  restate: RestateStatusSnapshot
  dkron: DkronStatusSnapshot
  inngest: InngestStatusSnapshot
}): string {
  const status = worstSeverity(input.queue.status, input.restate.status, input.dkron.status, input.inngest.status)
  const summaryBits = [
    describeQueueOverall(input.queue),
    `restate ${input.restate.status}`,
    `dkron ${input.dkron.status}`,
    `inngest ${input.inngest.status}`,
  ]

  if (status === "healthy") {
    return `Runtime healthy: ${summaryBits.join("; ")}.`
  }

  return `Runtime needs attention: ${summaryBits.join("; ")}.`
}

function statusPhase(status: MonitorSeverity): string {
  if (status === "healthy") return "ready"
  if (status === "degraded") return "degraded"
  return "down"
}

async function inspectQueue(redisUrl: string): Promise<QueueStatusSnapshot> {
  const redis = new Redis(redisUrl)
  try {
    await init(redis, QUEUE_CONFIG)
    const stats = await getQueueStats()
    const activePauses = await listActiveQueueFamilyPauses(redis, {
      config: DEFAULT_QUEUE_CONTROL_CONFIG,
    })
    const oldestAgeMs = stats.oldestTimestamp == null ? null : Math.max(0, Date.now() - stats.oldestTimestamp)
    const status = stats.total >= 25 || (oldestAgeMs ?? 0) >= 15 * 60_000 ? "degraded" : "healthy"
    const summary = stats.total === 0
      ? `Queue idle${activePauses.length > 0 ? ` with ${activePauses.length} active pause${activePauses.length === 1 ? "" : "s"}` : ""}.`
      : activePauses.length > 0
        ? `Queue holding ${stats.total} queued entr${stats.total === 1 ? "y" : "ies"} behind ${activePauses.length} active pause${activePauses.length === 1 ? "" : "s"}; oldest age ${oldestAgeMs ?? 0}ms.`
        : `Queue depth ${stats.total}; oldest age ${oldestAgeMs ?? 0}ms.`

    return {
      status,
      summary,
      depth: stats.total,
      byPriority: stats.byPriority,
      oldestAgeMs,
      activePauses: activePauses.map((pause) => ({
        family: pause.family,
        reason: pause.reason,
        source: pause.source,
        mode: pause.mode,
        appliedAt: pause.appliedAt,
        expiresAt: pause.expiresAt,
        expiresInMs: pause.expiresInMs,
      })),
      redisUrl,
      error: null,
    }
  } catch (error) {
    return {
      status: "down",
      summary: "Queue Redis is unavailable.",
      depth: 0,
      byPriority: { P0: 0, P1: 0, P2: 0, P3: 0 },
      oldestAgeMs: null,
      activePauses: [],
      redisUrl,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    try {
      await redis.quit()
    } catch {
      redis.disconnect()
    }
  }
}

async function inspectRestate(namespace: string, adminUrl: string): Promise<RestateStatusSnapshot> {
  const stsRes = runKubectl(["-n", namespace, "get", "statefulset", "restate", "-o", "json"])
  const svcRes = runKubectl(["-n", namespace, "get", "service", "restate", "-o", "json"])

  const sts = parseJson<Record<string, any>>(stsRes.stdout)
  const svc = parseJson<Record<string, any>>(svcRes.stdout)
  const desired = Number(sts?.spec?.replicas ?? 0)
  const ready = Number(sts?.status?.readyReplicas ?? 0)

  const adminProbe = await (async () => {
    try {
      const response = await fetch(`${adminUrl.replace(/\/$/, "")}/health`, {
        signal: AbortSignal.timeout(3000),
      })
      const body = await response.text()
      return {
        healthy: response.ok,
        status: response.status,
        response: body.slice(0, 300),
      }
    } catch (error) {
      return {
        healthy: false,
        status: 0,
        response: error instanceof Error ? error.message : String(error),
      }
    }
  })()

  const status = !stsRes.ok || desired === 0 || ready === 0
    ? "down"
    : ready < desired || !svcRes.ok || !adminProbe.healthy
      ? "degraded"
      : "healthy"

  return {
    status,
    summary: `Restate ${statusPhase(status)} · ${ready}/${desired} replicas ready · admin ${adminProbe.healthy ? "reachable" : "unreachable"}.`,
    namespace,
    adminUrl,
    statefulset: {
      exists: stsRes.ok,
      desiredReplicas: desired,
      readyReplicas: ready,
      phase: ready >= desired && desired > 0 ? "ready" : statusPhase(status),
      error: stsRes.ok ? null : stsRes.stderr || stsRes.stdout,
    },
    service: {
      exists: svcRes.ok,
      type: svc?.spec?.type ?? null,
      ports: Array.isArray(svc?.spec?.ports)
        ? svc.spec.ports.map((port: any) => ({
          name: asNonEmptyString(port?.name),
          port: typeof port?.port === "number" ? port.port : null,
          targetPort: typeof port?.targetPort === "number" || typeof port?.targetPort === "string"
            ? port.targetPort
            : null,
        }))
        : [],
      error: svcRes.ok ? null : svcRes.stderr || svcRes.stdout,
    },
    admin: adminProbe,
  }
}

async function inspectDkron(
  namespace: string,
  serviceName: string,
  baseUrl: string,
): Promise<DkronStatusSnapshot> {
  const stsRes = runKubectl(["-n", namespace, "get", "statefulset", "dkron", "-o", "json"])
  const svcRes = runKubectl(["-n", namespace, "get", "service", serviceName, "-o", "json"])

  const sts = parseJson<Record<string, any>>(stsRes.stdout)
  const svc = parseJson<Record<string, any>>(svcRes.stdout)
  const desired = Number(sts?.spec?.replicas ?? 0)
  const ready = Number(sts?.status?.readyReplicas ?? 0)

  let api = {
    accessible: false,
    status: 0,
    response: null as unknown,
    accessMode: baseUrl ? "direct" : "tunnel",
    baseUrl: baseUrl || null,
    localPort: null as number | null,
    error: null as string | null,
  }
  let jobs = { total: null as number | null, restate: null as number | null }

  try {
    const session = await openDkronSession(namespace, serviceName, baseUrl || undefined)
    try {
      const health = await fetchJson(session.baseUrl, "/health", { method: "GET" })
      api = {
        accessible: health.ok,
        status: health.status,
        response: health.json ?? health.text,
        accessMode: session.accessMode,
        baseUrl: session.baseUrl,
        localPort: session.localPort ?? null,
        error: health.ok ? null : health.text,
      }

      if (health.ok) {
        const jobsRes = await fetchJson(session.baseUrl, "/v1/jobs", { method: "GET" })
        if (jobsRes.ok && Array.isArray(jobsRes.json)) {
          const allJobs = jobsRes.json as Array<Record<string, any>>
          const restateJobs = allJobs.filter((job) => job?.metadata?.runtime === "restate")
          jobs = {
            total: allJobs.length,
            restate: restateJobs.length,
          }
        }
      }
    } finally {
      await session.dispose()
    }
  } catch (error) {
    api = {
      accessible: false,
      status: 0,
      response: null,
      accessMode: baseUrl ? "direct" : "tunnel",
      baseUrl: baseUrl || null,
      localPort: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const status = !stsRes.ok || desired === 0 || ready === 0
    ? "down"
    : ready < desired || !svcRes.ok || !api.accessible
      ? "degraded"
      : "healthy"

  return {
    status,
    summary: `Dkron ${statusPhase(status)} · ${ready}/${desired} replicas ready · api ${api.accessible ? "reachable" : "unreachable"}${jobs.restate != null ? ` · ${jobs.restate} restate jobs` : ""}.`,
    namespace,
    serviceName,
    statefulset: {
      exists: stsRes.ok,
      desiredReplicas: desired,
      readyReplicas: ready,
      phase: ready >= desired && desired > 0 ? "ready" : statusPhase(status),
      error: stsRes.ok ? null : stsRes.stderr || stsRes.stdout,
    },
    service: {
      exists: svcRes.ok,
      type: svc?.spec?.type ?? null,
      ports: Array.isArray(svc?.spec?.ports)
        ? svc.spec.ports.map((port: any) => ({
          name: asNonEmptyString(port?.name),
          port: typeof port?.port === "number" ? port.port : null,
          targetPort: typeof port?.targetPort === "number" || typeof port?.targetPort === "string"
            ? port.targetPort
            : null,
        }))
        : [],
      error: svcRes.ok ? null : svcRes.stderr || svcRes.stdout,
    },
    api,
    jobs,
  }
}

async function inspectInngest(
  inngestClient: any,
  hours: number,
  count: number,
): Promise<InngestStatusSnapshot> {
  const checks = await Effect.runPromise(inngestClient.health())
  const runs = await Effect.runPromise(inngestClient.runs({ hours, count }))
  const byStatus = summarizeRunStatuses(runs)
  const failingChecks = Object.entries(checks).filter(([, value]) => !value.ok)
  const criticalFailingChecks = failingChecks.filter(([key]) => key === "server" || key === "worker")
  const informationalFailingChecks = failingChecks.filter(([key]) => key !== "server" && key !== "worker")
  const status = criticalFailingChecks.length > 0
    ? "down"
    : (byStatus.FAILED ?? 0) > 0 || (byStatus.QUEUED ?? 0) > 0
      ? "degraded"
      : "healthy"

  const runsSummary = Object.entries(byStatus)
    .map(([name, total]) => `${name.toLowerCase()}:${total}`)
    .join(", ") || "none"
  const checkSummary = criticalFailingChecks.length > 0
    ? `${criticalFailingChecks.length} critical failing check${criticalFailingChecks.length === 1 ? "" : "s"}`
    : "server/worker healthy"
  const informationalSummary = informationalFailingChecks.length > 0
    ? ` · ${informationalFailingChecks.length} informational failing check${informationalFailingChecks.length === 1 ? "" : "s"}`
    : ""
  const summary = `Inngest ${statusPhase(status)} · ${checkSummary}${informationalSummary} · ${runs.length} recent run${runs.length === 1 ? "" : "s"} (${runsSummary}).`

  return {
    status,
    summary,
    checks,
    recentRuns: {
      hours,
      count: runs.length,
      byStatus,
      recent: runs.map((run: any) => ({
        id: String(run.id),
        functionName: String(run.functionName ?? run.functionID ?? "unknown"),
        status: String(run.status),
        startedAt: asNonEmptyString(run.startedAt),
        endedAt: asNonEmptyString(run.endedAt),
      })),
    },
  }
}

function buildJobsNextActions(result: JobsStatusResult, hours: number, count: number): NextAction[] {
  const next: NextAction[] = [
    {
      command: "joelclaw jobs status [--hours <hours>] [--count <count>]",
      description: "Refresh the unified runtime workload snapshot",
      params: {
        hours: { value: hours, default: 1, description: "Lookback window for recent runs" },
        count: { value: count, default: 10, description: "Recent Inngest run count" },
      },
    },
    { command: "joelclaw queue depth", description: "Inspect live queue depth" },
    { command: "joelclaw queue control status --hours 1", description: "Inspect active deterministic queue controls" },
    {
      command: "joelclaw queue observe [--hours <hours>]",
      description: "Run the bounded queue observer surface",
      params: {
        hours: { value: hours, default: 1, description: "Lookback window for observer history" },
      },
    },
    { command: `joelclaw restate status --admin-url ${result.restate.adminUrl}`, description: "Check Restate runtime health directly" },
    { command: "joelclaw restate cron status", description: "Check Dkron scheduler health directly" },
    {
      command: "joelclaw runs [--count <count>] [--hours <hours>]",
      description: "Inspect recent Inngest runs directly",
      params: {
        count: { value: count, default: 10, description: "Recent run count" },
        hours: { value: hours, default: 1, description: "Lookback window" },
      },
    },
  ]

  const pausedFamily = result.queue.activePauses[0]?.family
  if (pausedFamily) {
    next.splice(2, 0, {
      command: "joelclaw queue resume <family>",
      description: "Resume the first active paused family",
      params: {
        family: { value: pausedFamily, required: true, description: "Queue family to resume" },
      },
    })
  }

  if (result.queue.depth > 0) {
    next.splice(2, 0, {
      command: "joelclaw queue list [--limit <n>]",
      description: "Inspect currently queued workload entries",
      params: {
        n: { value: Math.min(20, Math.max(10, result.queue.depth)), default: 10, description: "Number of queued messages" },
      },
    })
  }

  return next
}

const hoursOption = Options.integer("hours").pipe(
  Options.withDefault(1),
  Options.withDescription("Lookback window in hours for recent run status"),
)

const countOption = Options.integer("count").pipe(
  Options.withDefault(10),
  Options.withDescription("Number of recent Inngest runs to include"),
)

const namespaceOption = Options.text("namespace").pipe(
  Options.withDefault("joelclaw"),
  Options.withDescription("Kubernetes namespace for Restate and Dkron runtime checks"),
)

const restateAdminUrlOption = Options.text("restate-admin-url").pipe(
  Options.withDefault(DEFAULT_RESTATE_ADMIN_URL),
  Options.withDescription("Restate admin endpoint URL"),
)

const dkronServiceNameOption = Options.text("dkron-service-name").pipe(
  Options.withDefault("dkron-svc"),
  Options.withDescription("Kubernetes service name for the Dkron HTTP API"),
)

const dkronBaseUrlOption = Options.text("dkron-base-url").pipe(
  Options.withDefault(DEFAULT_DKRON_BASE_URL),
  Options.withDescription("Optional direct Dkron API base URL (skips temporary kubectl tunnel)"),
)

const jobsStatusCmd = Command.make(
  "status",
  {
    hours: hoursOption,
    count: countOption,
    namespace: namespaceOption,
    restateAdminUrl: restateAdminUrlOption,
    dkronServiceName: dkronServiceNameOption,
    dkronBaseUrl: dkronBaseUrlOption,
  },
  ({ hours, count, namespace, restateAdminUrl, dkronServiceName, dkronBaseUrl }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest

      const [queue, restate, dkron, inngest] = yield* Effect.all([
        Effect.tryPromise({
          try: () => inspectQueue(REDIS_URL),
          catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
        }),
        Effect.tryPromise({
          try: () => inspectRestate(namespace, restateAdminUrl),
          catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
        }),
        Effect.tryPromise({
          try: () => inspectDkron(namespace, dkronServiceName, dkronBaseUrl),
          catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
        }),
        Effect.tryPromise({
          try: () => inspectInngest(inngestClient, hours, count),
          catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
        }),
      ]).pipe(
        Effect.catchAll((error) =>
          Effect.fail(new Error(error.message)),
        ),
      )

      const result: JobsStatusResult = {
        checkedAt: new Date().toISOString(),
        overall: {
          status: worstSeverity(queue.status, restate.status, dkron.status, inngest.status),
          summary: buildOverallSummary({ queue, restate, dkron, inngest }),
        },
        queue,
        restate,
        dkron,
        inngest,
      }

      yield* Console.log(respond(
        "jobs status",
        result,
        buildJobsNextActions(result, hours, count),
        result.overall.status !== "down",
      ))
    }).pipe(
      Effect.catchAll((error) =>
        Console.log(respondError(
          "jobs status",
          error.message,
          "JOBS_STATUS_FAILED",
          "Check kubectl access, Redis connectivity, and Inngest API health before retrying.",
          [
            { command: "joelclaw status", description: "Check base worker/server health" },
            { command: "joelclaw restate status", description: "Check Restate runtime health directly" },
            { command: "joelclaw restate cron status", description: "Check Dkron scheduler health directly" },
          ],
        )),
      ),
    ),
).pipe(Command.withDescription("Unified runtime workload snapshot across queue, Restate, Dkron, and transitional Inngest"))

export const jobsCmd = Command.make("jobs", {}, () =>
  Console.log(respond("jobs", {
    description: "Unified workload monitoring surfaces for ADR-0217 runtime operations",
    subcommands: {
      status: "joelclaw jobs status [--hours <hours>] [--count <count>]",
    },
  }, [
    {
      command: "joelclaw jobs status [--hours <hours>] [--count <count>]",
      description: "Inspect queue, Restate, Dkron, and Inngest in one snapshot",
      params: {
        hours: { default: 1, description: "Lookback window for recent runs" },
        count: { default: 10, description: "Recent run count" },
      },
    },
  ]))
).pipe(
  Command.withDescription("Manage and monitor runtime jobs during the ADR-0217 migration"),
  Command.withSubcommands([jobsStatusCmd]),
)

export const __jobsTestUtils = {
  severityRank,
  worstSeverity,
  summarizeRunStatuses,
  describeQueueOverall,
  buildOverallSummary,
}
