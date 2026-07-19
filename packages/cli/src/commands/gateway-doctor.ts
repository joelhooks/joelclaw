import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export const GATEWAY_RESTART_MARKER_PATH = "/tmp/joelclaw/gateway.operator-restart.json"
const GATEWAY_PID_PATH = "/tmp/joelclaw/gateway.pid"
const GATEWAY_WS_PORT_PATH = "/tmp/joelclaw/gateway.ws.port"

export const GATEWAY_RUNTIME_SOURCE_PATHS = [
  "packages/gateway",
  "packages/channel-routing",
  "packages/discord-ui",
  "packages/endpoint-resolver",
  "packages/inference-router",
  "packages/markdown-formatter",
  "packages/message-contract",
  "packages/message-journal",
  "packages/message-store",
  "packages/model-fallback",
  "packages/telemetry",
  "packages/vault-reader",
] as const

export type GatewayDoctorStageStatus = "PASS" | "FAIL" | "SKIP"

export interface GatewayDoctorStage {
  readonly name: "daemon" | "source" | "transport" | "live-delivery"
  readonly status: GatewayDoctorStageStatus
  readonly detail: string
  readonly remediation: readonly string[]
  readonly evidence?: Record<string, unknown>
}

export interface GatewayDoctorReport {
  readonly ok: boolean
  readonly checkedAt: string
  readonly live: boolean
  readonly lines: readonly string[]
  readonly stages: readonly GatewayDoctorStage[]
  readonly warnings: readonly string[]
}

export interface GatewayRestartMarker {
  readonly status: "requested" | "completed" | "failed"
  readonly requestedAt: string
  readonly completedAt?: string
  readonly previousPid: string | null
  readonly newPid?: string | null
}

export interface GatewayLiveProbeReceipt {
  readonly eventId: string
  readonly flowId: string
  readonly platform: string
  readonly platformMessageId: string | null
  readonly deliveryState: string
}

type GatewayHealthSnapshot = {
  available?: boolean
  healthy?: boolean
  checkedAt?: string
  components?: Record<string, unknown>
  status?: {
    pid?: number
    uptimeMs?: number
    channels?: Record<string, unknown>
  }
}

export interface GatewayDoctorDependencies {
  readonly now?: () => number
  readonly health?: () => Promise<GatewayHealthSnapshot | null>
  readonly redisPing?: () => Promise<boolean>
  readonly pid?: () => string | null
  readonly processAlive?: (pid: number) => boolean
  readonly processStartAt?: (pid: number) => string | null
  readonly repoRoot?: (pid: number | null) => string
  readonly sourceChanges?: (repoRoot: string) => readonly string[]
  readonly restartMarker?: () => GatewayRestartMarker | null
  readonly liveProbe?: () => Promise<GatewayLiveProbeReceipt>
}

function readTrimmed(path: string): string | null {
  try {
    if (!existsSync(path)) return null
    const value = readFileSync(path, "utf-8").trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

function readJson<T>(path: string): T | null {
  const raw = readTrimmed(path)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function readGatewayHealth(): Promise<GatewayHealthSnapshot | null> {
  const rawPort = readTrimmed(GATEWAY_WS_PORT_PATH)
  const port = rawPort ? Number.parseInt(rawPort, 10) : Number.NaN
  if (!Number.isFinite(port) || port <= 0) return Promise.resolve(null)

  return fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(2_500),
  })
    .then(async (response) => {
      if (!response.ok) return null
      const body = await response.text()
      return body.trim().length > 0 ? JSON.parse(body) as GatewayHealthSnapshot : null
    })
    .catch(() => null)
}

async function pingGatewayRedis(): Promise<boolean> {
  let redis: { connect: () => Promise<unknown>; ping: () => Promise<string>; quit: () => Promise<unknown>; disconnect: (reconnect?: boolean) => void } | undefined
  try {
    const Redis = (await import("ioredis")).default
    redis = new Redis({
      host: process.env.REDIS_HOST ?? "127.0.0.1",
      port: Number.parseInt(process.env.REDIS_PORT ?? "6379", 10),
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 3_000,
      commandTimeout: 5_000,
    })
    await redis.connect()
    return await redis.ping() === "PONG"
  } catch {
    redis?.disconnect(false)
    return false
  } finally {
    await redis?.quit().catch(() => {})
  }
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function defaultProcessStartAt(pid: number): string | null {
  try {
    const raw = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf-8",
      timeout: 2_000,
    }).trim()
    const timestamp = Date.parse(raw)
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
  } catch {
    return null
  }
}

function defaultRepoRoot(pid: number | null): string {
  const configured = process.env.JOELCLAW_GATEWAY_REPO_ROOT?.trim()
  if (configured) return configured
  if (pid) {
    try {
      const raw = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
        encoding: "utf-8",
        timeout: 2_000,
      })
      const cwd = raw.split("\n").find((line) => line.startsWith("n"))?.slice(1).trim()
      if (cwd) return cwd
    } catch {
      // Fall through to the canonical operator checkout.
    }
  }
  return `${process.env.HOME ?? "/Users/joel"}/Code/joelhooks/joelclaw`
}

function defaultSourceChanges(repoRoot: string): readonly string[] {
  try {
    const raw = execFileSync(
      "git",
      ["-C", repoRoot, "status", "--porcelain=v1", "--untracked-files=all", "--", ...GATEWAY_RUNTIME_SOURCE_PATHS],
      { encoding: "utf-8", timeout: 5_000 },
    ).trim()
    return raw.length > 0 ? raw.split("\n") : []
  } catch (error) {
    return [`?? source inspection failed: ${String(error)}`]
  }
}

function field(record: unknown, key: string): unknown {
  return record && typeof record === "object" ? (record as Record<string, unknown>)[key] : undefined
}

function yesNo(value: boolean | null): string {
  if (value === null) return "unknown"
  return value ? "YES" : "no"
}

function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0) return "unknown"
  const seconds = Math.floor(milliseconds / 1_000)
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainingSeconds = seconds % 60
  return `${hours}h ${minutes}m ${remainingSeconds}s`
}

export function detectCrashRelaunch(input: {
  readonly currentPid: string | null
  readonly processStartAt: string | null
  readonly marker: GatewayRestartMarker | null
}): boolean | null {
  const { currentPid, processStartAt, marker } = input
  if (!currentPid || !processStartAt || !marker?.completedAt || !marker.newPid) return null
  if (currentPid === marker.newPid) return false
  const processStart = Date.parse(processStartAt)
  const operatorRestartCompleted = Date.parse(marker.completedAt)
  if (!Number.isFinite(processStart) || !Number.isFinite(operatorRestartCompleted)) return null
  return processStart > operatorRestartCompleted
}

export function writeGatewayRestartMarker(marker: GatewayRestartMarker): void {
  mkdirSync(dirname(GATEWAY_RESTART_MARKER_PATH), { recursive: true })
  writeFileSync(GATEWAY_RESTART_MARKER_PATH, `${JSON.stringify(marker, null, 2)}\n`, "utf-8")
}

function stageLine(stage: GatewayDoctorStage): string {
  return `${stage.status} ${stage.name} — ${stage.detail}`
}

function failureCommands(repoRoot: string) {
  const runtimePaths = GATEWAY_RUNTIME_SOURCE_PATHS.join(" ")
  return {
    restart: "joelclaw gateway restart",
    logs: "rg -n 'daemon started|gateway-start.sh invoked|ERROR|failed|notify.compat_v2|channel.delivery' /tmp/joelclaw/gateway.log /tmp/joelclaw/gateway.err",
    sourceStatus: `git -C ${repoRoot} status --short -- ${runtimePaths}`,
    stash: `git -C ${repoRoot} stash push -u -m 'gateway doctor safety stash' -- ${runtimePaths}`,
  }
}

export async function collectGatewayDoctor(
  options: { readonly live: boolean },
  dependencies: GatewayDoctorDependencies = {},
): Promise<GatewayDoctorReport> {
  const now = dependencies.now ?? Date.now
  const checkedAtMs = now()
  const checkedAt = new Date(checkedAtMs).toISOString()
  const health = await (dependencies.health ?? readGatewayHealth)()
  const pidText = dependencies.pid?.()
    ?? (typeof health?.status?.pid === "number" ? String(health.status.pid) : readTrimmed(GATEWAY_PID_PATH))
  const pidNumber = pidText && /^\d+$/.test(pidText) ? Number.parseInt(pidText, 10) : null
  const processAlive = pidNumber !== null && (dependencies.processAlive ?? defaultProcessAlive)(pidNumber)
  const uptimeMs = typeof health?.status?.uptimeMs === "number" ? health.status.uptimeMs : null
  const processStartAt = pidNumber === null
    ? null
    : (dependencies.processStartAt?.(pidNumber)
      ?? (uptimeMs === null ? defaultProcessStartAt(pidNumber) : new Date(checkedAtMs - uptimeMs).toISOString()))
  const marker = (dependencies.restartMarker ?? (() => readJson<GatewayRestartMarker>(GATEWAY_RESTART_MARKER_PATH)))()
  const crashRelaunched = detectCrashRelaunch({ currentPid: pidText, processStartAt, marker })
  const repoRoot = (dependencies.repoRoot ?? defaultRepoRoot)(pidNumber)
  const remediation = failureCommands(repoRoot)
  const stages: GatewayDoctorStage[] = []
  const warnings: string[] = []

  const daemonPasses = processAlive && health?.available !== false && crashRelaunched !== true
  stages.push({
    name: "daemon",
    status: daemonPasses ? "PASS" : "FAIL",
    detail: `pid=${pidText ?? "missing"} start=${processStartAt ?? "unknown"} uptime=${formatDuration(uptimeMs)} crash-relaunched=${yesNo(crashRelaunched)}`,
    remediation: daemonPasses ? [] : [remediation.restart, remediation.logs],
    evidence: {
      pid: pidText,
      processAlive,
      processStartAt,
      uptimeMs,
      crashRelaunched,
      operatorRestartMarker: marker,
    },
  })

  const sourceChanges = (dependencies.sourceChanges ?? defaultSourceChanges)(repoRoot)
  const sourceClean = sourceChanges.length === 0
  const sourceDetail = `${sourceClean ? "CLEAN" : "DIRTY"} repo=${repoRoot}${sourceClean ? "" : ` changed=${sourceChanges.length}`}`
  if (processAlive && !sourceClean) {
    warnings.push("DANGER: A RUNNING GATEWAY DAEMON AND DIRTY GATEWAY RUNTIME SOURCE COEXIST. A crash can relaunch half-edited code.")
  }
  stages.push({
    name: "source",
    status: sourceClean ? "PASS" : "FAIL",
    detail: sourceDetail,
    remediation: sourceClean ? [] : [remediation.sourceStatus, remediation.stash, remediation.restart],
    evidence: { repoRoot, state: sourceClean ? "CLEAN" : "DIRTY", changes: sourceChanges },
  })

  const redisConnected = await (dependencies.redisPing ?? pingGatewayRedis)()
  const telegram = field(health?.status?.channels, "telegram")
  const adapterReady = field(health?.components, "telegram") === "chat-sdk"
    && field(telegram, "started") === true
    && field(telegram, "companionInitialized") === true
  const pollerReady = field(telegram, "pollingActive") === true
    && field(telegram, "pollingState") === "chat-sdk-active"
  const transportPasses = redisConnected && adapterReady && pollerReady
  stages.push({
    name: "transport",
    status: transportPasses ? "PASS" : "FAIL",
    detail: `redis=${redisConnected ? "PONG" : "DOWN"} adapter=${adapterReady ? "ready" : "not-ready"} poller=${pollerReady ? "active" : "inactive"}`,
    remediation: transportPasses ? [] : [remediation.restart, remediation.logs],
    evidence: { redisConnected, adapterReady, pollerReady, telegram },
  })

  if (!options.live) {
    stages.push({
      name: "live-delivery",
      status: "SKIP",
      detail: "not requested; run joelclaw gateway doctor --live to prove Telegram delivery",
      remediation: ["joelclaw gateway doctor --live"],
    })
  } else if (!dependencies.liveProbe) {
    stages.push({
      name: "live-delivery",
      status: "FAIL",
      detail: "live probe dependency is unavailable",
      remediation: [remediation.restart, remediation.logs],
    })
  } else {
    try {
      const receipt = await dependencies.liveProbe()
      const platformMessageId = receipt.platformMessageId?.trim() || null
      const delivered = receipt.platform === "telegram"
        && receipt.deliveryState === "confirmed"
        && platformMessageId !== null
      stages.push({
        name: "live-delivery",
        status: delivered ? "PASS" : "FAIL",
        detail: delivered
          ? `eventId=${receipt.eventId} Telegram platformMessageId=${platformMessageId}`
          : `eventId=${receipt.eventId} platform=${receipt.platform} state=${receipt.deliveryState} platformMessageId=${platformMessageId ?? "missing"}`,
        remediation: delivered ? [] : [remediation.restart, remediation.logs],
        evidence: receipt,
      })
    } catch (error) {
      stages.push({
        name: "live-delivery",
        status: "FAIL",
        detail: `full notify probe failed: ${String(error)}`,
        remediation: [remediation.restart, remediation.logs],
      })
    }
  }

  return {
    ok: stages.every((stage) => stage.status !== "FAIL"),
    checkedAt,
    live: options.live,
    lines: stages.map(stageLine),
    stages,
    warnings,
  }
}
