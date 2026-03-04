import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { respond } from "../response"

type SummaryFormat = "json" | "text"

type CommandExecution = {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
}

type RunRow = {
  id?: string
  status?: string
  functionName?: string
  functionID?: string
  error?: string
}

type SlogEntry = {
  timestamp?: string
  action?: string
  tool?: string
  detail?: string
  reason?: string
}

type OTelFacetCount = {
  value?: string
  count?: number
}

type OTelFacet = {
  field_name?: string
  counts?: OTelFacetCount[]
}

type OTelStats = {
  total?: number
  errors?: number
  errorRate?: number
  facets?: OTelFacet[]
}

type SummaryResult = {
  period: {
    hours: number
    since: string
  }
  code: {
    joelclaw_commits: number
    vault_commits: number
    highlights: string[]
  }
  infrastructure: {
    deploys: string[]
    new_services: string[]
    config_changes: string[]
  }
  inngest: {
    total_runs: number
    completed: number
    failed: number
    unique_functions: number
    failures: Array<{
      id: string
      function: string
      status: string
    }>
  }
  agents: {
    codex_sessions: number
    pi_sessions: number
  }
  adrs: {
    new: number
    groomed: number
    status_changes: string[]
  }
  knowledge: {
    discoveries: number
    memory_observations: number
  }
  k8s: {
    total_pods: number
    healthy: number
    unhealthy: number
    new: string[]
  }
}

type PodRow = {
  name: string
  ready: string
  status: string
  restarts: number
  age: string
}

const HOME_DIR = process.env.HOME ?? "/Users/joel"
const JOELCLAW_REPO = `${HOME_DIR}/Code/joelhooks/joelclaw`
const VAULT_REPO = `${HOME_DIR}/Vault`
const ADR_REPO = `${VAULT_REPO}/docs/decisions`

const hoursOpt = Options.integer("hours").pipe(
  Options.withDefault(24),
  Options.withDescription("Lookback window in hours (default: 24)"),
)

const formatOpt = Options.choice("format", ["json", "text"] as const).pipe(
  Options.withDefault("json"),
  Options.withDescription("Render mode for summary payload (json default, optional text field)"),
)

function decodeOutput(value: string | Uint8Array | null | undefined): string {
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  return ""
}

function runCommand(args: string[], cwd?: string): CommandExecution {
  try {
    const proc = Bun.spawnSync(args, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })

    const stdout = decodeOutput(proc.stdout)
    const stderr = decodeOutput(proc.stderr)

    return {
      ok: proc.exitCode === 0,
      exitCode: proc.exitCode,
      stdout,
      stderr,
    }
  } catch (error) {
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function parseEnvelopeResult<T>(raw: string): T | null {
  try {
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed) || !("result" in parsed)) return null
    return parsed.result as T
  } catch {
    return null
  }
}

function parseGitLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function parseHoursFromAge(ageRaw: string): number {
  const matches = [...ageRaw.matchAll(/(\d+)([smhd])/g)]
  if (matches.length === 0) return Number.POSITIVE_INFINITY

  let totalHours = 0
  for (const match of matches) {
    const amount = Number.parseInt(match[1] ?? "0", 10)
    const unit = match[2] ?? "h"
    if (!Number.isFinite(amount)) continue
    if (unit === "d") totalHours += amount * 24
    if (unit === "h") totalHours += amount
    if (unit === "m") totalHours += amount / 60
    if (unit === "s") totalHours += amount / 3600
  }

  return totalHours
}

function parseRestartCount(raw: string): number {
  const match = raw.match(/\d+/)
  if (!match) return 0
  const value = Number.parseInt(match[0], 10)
  return Number.isFinite(value) ? value : 0
}

function parsePodRows(raw: string): PodRow[] {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const rows: PodRow[] = []

  for (const line of lines) {
    const columns = line.split(/\s{2,}|\t+/).filter((value) => value.length > 0)
    if (columns.length < 5) continue

    rows.push({
      name: columns[0] ?? "unknown",
      ready: columns[1] ?? "0/0",
      status: columns[2] ?? "Unknown",
      restarts: parseRestartCount(columns[3] ?? "0"),
      age: columns[4] ?? "",
    })
  }

  return rows
}

function isPodHealthy(pod: PodRow): boolean {
  const status = pod.status.toLowerCase()
  if (status === "completed") return true
  if (status !== "running") return false

  const [readyRaw, totalRaw] = pod.ready.split("/")
  const ready = Number.parseInt(readyRaw ?? "0", 10)
  const total = Number.parseInt(totalRaw ?? "0", 10)
  return Number.isFinite(ready) && Number.isFinite(total) && total > 0 && ready >= total
}

function isEntryWithinHours(entry: SlogEntry, sinceMs: number): boolean {
  if (!entry.timestamp) return false
  const ts = Date.parse(entry.timestamp)
  return Number.isFinite(ts) && ts >= sinceMs
}

function extractFacetCount(facets: OTelFacet[] | undefined, field: string, value: string): number {
  if (!facets) return 0
  const facet = facets.find((item) => item.field_name === field)
  if (!facet?.counts) return 0
  const target = facet.counts.find((item) => (item.value ?? "").toLowerCase() === value.toLowerCase())
  return target?.count ?? 0
}

function renderTextSummary(summary: SummaryResult): string {
  return [
    `Daily summary (last ${summary.period.hours}h since ${summary.period.since})`,
    `Code: joelclaw ${summary.code.joelclaw_commits}, vault ${summary.code.vault_commits}`,
    `Infrastructure: deploys ${summary.infrastructure.deploys.length}, config changes ${summary.infrastructure.config_changes.length}, new services ${summary.infrastructure.new_services.length}`,
    `Inngest: total ${summary.inngest.total_runs}, completed ${summary.inngest.completed}, failed ${summary.inngest.failed}, unique functions ${summary.inngest.unique_functions}`,
    `Agents: codex ${summary.agents.codex_sessions}, pi ${summary.agents.pi_sessions}`,
    `ADRs: new ${summary.adrs.new}, groomed ${summary.adrs.groomed}, status changes ${summary.adrs.status_changes.length}`,
    `Knowledge: discoveries ${summary.knowledge.discoveries}, memory observations ${summary.knowledge.memory_observations}`,
    `K8s: total ${summary.k8s.total_pods}, healthy ${summary.k8s.healthy}, unhealthy ${summary.k8s.unhealthy}, new ${summary.k8s.new.length}`,
  ].join("\n")
}

export const summaryCmd = Command.make(
  "summary",
  {
    hours: hoursOpt,
    format: formatOpt,
  },
  ({ hours, format }) =>
    Effect.gen(function* () {
      const now = Date.now()
      const sinceMs = now - hours * 60 * 60 * 1000
      const since = new Date(sinceMs).toISOString()

      const joelclawGitExec = runCommand([
        "git",
        "log",
        "--oneline",
        `--since=${since}`,
        "--no-merges",
      ], JOELCLAW_REPO)
      const vaultGitExec = runCommand([
        "git",
        "log",
        "--oneline",
        `--since=${since}`,
        "--no-merges",
      ], VAULT_REPO)

      const joelclawCommits = joelclawGitExec.ok ? parseGitLines(joelclawGitExec.stdout) : []
      const vaultCommits = vaultGitExec.ok ? parseGitLines(vaultGitExec.stdout) : []

      const runsExec = runCommand([
        "joelclaw",
        "runs",
        "--count",
        "200",
        "--hours",
        String(hours),
      ])
      const runsPayload = parseEnvelopeResult<{ runs?: RunRow[] }>(runsExec.stdout)
      const runs = Array.isArray(runsPayload?.runs) ? runsPayload.runs : []

      const otelStatsExec = runCommand([
        "joelclaw",
        "otel",
        "stats",
        "--hours",
        String(hours),
      ])
      const otelStatsPayload = parseEnvelopeResult<OTelStats>(otelStatsExec.stdout) ?? {}

      const otelObserveExec = runCommand([
        "joelclaw",
        "otel",
        "search",
        "observe",
        "--hours",
        String(hours),
        "--limit",
        "1",
      ])
      const otelObservePayload = parseEnvelopeResult<{ found?: number }>(otelObserveExec.stdout)
      const memoryObservations = otelObservePayload?.found ?? 0

      const kubectlExec = runCommand([
        "kubectl",
        "get",
        "pods",
        "-n",
        "joelclaw",
        "--no-headers",
      ])
      const pods = kubectlExec.ok ? parsePodRows(kubectlExec.stdout) : []
      const healthyPods = pods.filter((pod) => isPodHealthy(pod)).length
      const newPods = pods
        .filter((pod) => parseHoursFromAge(pod.age) <= hours)
        .map((pod) => pod.name)

      const slogExec = runCommand(["slog", "tail", "--count", "20"])
      const slogPayload = parseEnvelopeResult<{ entries?: SlogEntry[] }>(slogExec.stdout)
      const allSlogEntries = Array.isArray(slogPayload?.entries) ? slogPayload.entries : []
      const slogEntries = allSlogEntries.filter((entry) => isEntryWithinHours(entry, sinceMs))

      const deploys = slogEntries
        .filter((entry) => (entry.action ?? "").toLowerCase() === "deploy" || /deploy/i.test(entry.detail ?? ""))
        .map((entry) => `${entry.timestamp ?? "unknown"} ${entry.tool ?? "system"}: ${entry.detail ?? ""}`)

      const configChanges = slogEntries
        .filter((entry) => {
          const action = (entry.action ?? "").toLowerCase()
          return action === "configure" || action === "install" || action === "fix"
        })
        .map((entry) => `${entry.timestamp ?? "unknown"} ${entry.tool ?? "system"}: ${entry.detail ?? ""}`)

      const adrsExec = runCommand([
        "git",
        "log",
        "--oneline",
        `--since=${since}`,
        "--no-merges",
        "--",
        ".",
      ], ADR_REPO)
      const adrLines = adrsExec.ok ? parseGitLines(adrsExec.stdout) : []
      const adrStatusChanges = adrLines
        .filter((line) => /(shipped|accepted|proposed|deprecated|superseded|rejected|status)/i.test(line))
        .slice(0, 20)
      const adrNewCount = adrLines.filter((line) => /adr-\d+/i.test(line) && /(add|create|new|introduce|propose)/i.test(line)).length

      const completedRuns = runs.filter((run) => (run.status ?? "").toUpperCase() === "COMPLETED")
      const failedRuns = runs.filter((run) => (run.status ?? "").toUpperCase() === "FAILED")
      const uniqueFunctions = new Set(
        runs
          .map((run) => run.functionName ?? run.functionID)
          .filter((name): name is string => typeof name === "string" && name.length > 0),
      )

      const failedDetails = failedRuns.map((run) => ({
        id: run.id ?? "unknown",
        function: run.functionName ?? run.functionID ?? "unknown",
        status: run.status ?? "FAILED",
      }))

      const discoveriesFromRuns = runs.filter((run) => /discover|discovery|noted/i.test(run.functionName ?? "")).length
      const discoveriesFromSlog = slogEntries.filter((entry) => {
        return (entry.action ?? "").toLowerCase() === "noted" && /discovery/i.test(entry.tool ?? "")
      }).length

      const codexSessionsFromSlog = slogEntries.filter((entry) => /codex/i.test(`${entry.tool ?? ""} ${entry.detail ?? ""}`)).length
      const piSessionsFromSlog = slogEntries.filter((entry) => /\bpi\b/i.test(`${entry.tool ?? ""} ${entry.detail ?? ""}`)).length

      const codexFromOtel = extractFacetCount(otelStatsPayload.facets, "source", "codex")
      const gatewayFromOtel = extractFacetCount(otelStatsPayload.facets, "source", "gateway")

      const summary: SummaryResult = {
        period: {
          hours,
          since,
        },
        code: {
          joelclaw_commits: joelclawCommits.length,
          vault_commits: vaultCommits.length,
          highlights: [
            ...joelclawCommits.slice(0, 5).map((line) => `[joelclaw] ${line}`),
            ...vaultCommits.slice(0, 5).map((line) => `[vault] ${line}`),
          ],
        },
        infrastructure: {
          deploys,
          new_services: newPods,
          config_changes: configChanges,
        },
        inngest: {
          total_runs: runs.length,
          completed: completedRuns.length,
          failed: failedRuns.length,
          unique_functions: uniqueFunctions.size,
          failures: failedDetails,
        },
        agents: {
          codex_sessions: codexSessionsFromSlog > 0 ? codexSessionsFromSlog : (codexFromOtel > 0 ? 1 : 0),
          pi_sessions: piSessionsFromSlog > 0 ? piSessionsFromSlog : (gatewayFromOtel > 0 ? 1 : 0),
        },
        adrs: {
          new: adrNewCount,
          groomed: adrLines.length,
          status_changes: adrStatusChanges,
        },
        knowledge: {
          discoveries: Math.max(discoveriesFromRuns, discoveriesFromSlog),
          memory_observations: memoryObservations,
        },
        k8s: {
          total_pods: pods.length,
          healthy: healthyPods,
          unhealthy: Math.max(0, pods.length - healthyPods),
          new: newPods,
        },
      }

      const resultPayload = format === "text"
        ? {
            ...summary,
            text: renderTextSummary(summary),
          }
        : summary

      yield* Console.log(
        respond(
          "summary",
          resultPayload,
          [
            {
              command: "joelclaw summary [--hours <hours>] [--format json|text]",
              description: "Regenerate the daily summary with a different window or format",
              params: {
                hours: { description: "Lookback window in hours", default: 24, value: hours },
                format: { description: "Render mode", default: "json", value: format, enum: ["json", "text"] },
              },
            },
            {
              command: "joelclaw runs --count 200 [--hours <hours>]",
              description: "Inspect run details behind this summary",
              params: {
                hours: { description: "Lookback window", value: hours, default: 24 },
              },
            },
            {
              command: "joelclaw otel stats [--hours <hours>]",
              description: "Check telemetry totals for the same period",
              params: {
                hours: { description: "Lookback window", value: hours, default: 24 },
              },
            },
          ],
          true,
        ),
      )
    }),
).pipe(Command.withDescription("Generate a daily system summary across code, infra, runs, ADRs, and knowledge signals"))
