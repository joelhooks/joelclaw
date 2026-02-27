import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { loadConfig } from "../config"
import { Inngest } from "../inngest"
import { respond, respondError } from "../response"

type NasRun = {
  id: string
  status: string
  functionName?: string
  startedAt?: string
}

type SamplePayload = {
  status?: string
  md2ResyncActive?: boolean
  md2ProgressPct?: number
  mounts?: Array<{
    mount?: string
    errorCount?: number
    writeMbps?: number
    readMbps?: number
  }>
}

type NasStatusResult = {
  ok: boolean
  code: string
  review: {
    code: string
    summary: string
    runId: string | null
    status: string | null
    startedAt: string | null
    output: string | null
  }
  sample: {
    code: string
    summary: string
    runId: string | null
    status: string | null
    startedAt: string | null
    payload: SamplePayload | null
  }
}

const cfg = loadConfig()
const WORKER_URL = cfg.workerUrl
const WORKER_REGISTER_URL = `${WORKER_URL}/api/inngest`
const WORKER_LABEL = "com.joel.system-bus-worker"
const HOME_DIR = process.env.HOME ?? "/Users/joel"
const SYSTEM_BUS_CONFIG_PATH = `${HOME_DIR}/.joelclaw/system-bus.config.json`
const DEFAULT_SELF_HEALING_CONFIG = {
  selfHealing: {
    router: {
      model: "gpt-5.2-codex-spark",
      fallbackModel: "gpt-5.3-codex",
      maxRetries: 5,
      sleepMinMs: 5 * 60_000,
      sleepMaxMs: 4 * 60 * 60_000,
      sleepStepMs: 30_000,
    },
    transport: {
      nasRecoveryWindowHours: 4,
      nasMaxAttempts: 12,
      nasRetryBaseMs: 10_000,
      nasRetryMaxMs: 120_000,
      nasSshHost: "joel@three-body",
      nasSshFlags: "-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2",
      nasHddRoot: "/Volumes/three-body",
      nasNvmeRoot: "/Volumes/nas-nvme",
    },
  },
  backupFailureRouter: {
    model: "gpt-5.2-codex-spark",
    fallbackModel: "gpt-5.3-codex",
    maxRetries: 5,
    sleepMinMs: 5 * 60_000,
    sleepMaxMs: 4 * 60 * 60_000,
    sleepStepMs: 30_000,
  },
  backupTransport: {
    nasRecoveryWindowHours: 4,
    nasMaxAttempts: 12,
    nasRetryBaseMs: 10_000,
    nasRetryMaxMs: 120_000,
    nasSshHost: "joel@three-body",
    nasSshFlags: "-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2",
    nasHddRoot: "/Volumes/three-body",
    nasNvmeRoot: "/Volumes/nas-nvme",
  },
}
const DEFAULT_BACKUP_CONFIG = {
  backupFailureRouter: {
    model: "gpt-5.2-codex-spark",
    fallbackModel: "gpt-5.3-codex",
    maxRetries: 5,
    sleepMinMs: 5 * 60_000,
    sleepMaxMs: 4 * 60 * 60_000,
    sleepStepMs: 30_000,
  },
  backupTransport: {
    nasRecoveryWindowHours: 4,
    nasMaxAttempts: 12,
    nasRetryBaseMs: 10_000,
    nasRetryMaxMs: 120_000,
    nasSshHost: "joel@three-body",
    nasSshFlags: "-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2",
    nasHddRoot: "/Volumes/three-body",
    nasNvmeRoot: "/Volumes/nas-nvme",
  },
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const parsePositiveInt = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.floor(value)
    return normalized > 0 ? normalized : fallback
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }
  return fallback
}

const readSystemBusConfigFile = (): Record<string, unknown> => {
  if (!existsSync(SYSTEM_BUS_CONFIG_PATH)) return {}
  try {
    const raw = readFileSync(SYSTEM_BUS_CONFIG_PATH, "utf-8")
    if (!raw.trim()) return {}
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const resolveSystemBusConfig = () => {
  const fileConfig = readSystemBusConfigFile()

  const fileSelfHealing = isRecord(fileConfig.selfHealing)
    ? (fileConfig.selfHealing as Record<string, unknown>)
    : {}
  const fileRouter = isRecord(fileConfig.backupFailureRouter)
    ? (fileConfig.backupFailureRouter as Record<string, unknown>)
    : {}
  const fileSelfHealingRouter = isRecord(fileSelfHealing.router)
    ? (fileSelfHealing.router as Record<string, unknown>)
    : {}
  const fileSelfHealingTransport = isRecord(fileSelfHealing.transport)
    ? (fileSelfHealing.transport as Record<string, unknown>)
    : {}
  const fileTransport = isRecord(fileConfig.backupTransport)
    ? (fileConfig.backupTransport as Record<string, unknown>)
    : {}

  const resolveString = (envName: string, fromFile: unknown, fallback: string): string => {
    const envValue = process.env[envName]
    if (envValue?.trim().length) return envValue.trim()
    return typeof fromFile === "string" && fromFile.trim().length ? fromFile.trim() : fallback
  }

  const resolveInt = (envName: string, fromFile: unknown, fallback: number): number =>
    parsePositiveInt(process.env[envName], parsePositiveInt(fromFile, fallback))

  return {
    selfHealing: {
      router: {
        model: resolveString(
          "SELF_HEALING_ROUTER_MODEL",
          fileSelfHealingRouter.model,
          resolveString(
            "BACKUP_FAILURE_ROUTER_MODEL",
            fileRouter.model,
            DEFAULT_SELF_HEALING_CONFIG.selfHealing.router.model,
          ),
        ),
        fallbackModel: resolveString(
          "SELF_HEALING_ROUTER_FALLBACK_MODEL",
          fileSelfHealingRouter.fallbackModel,
          resolveString(
            "BACKUP_FAILURE_ROUTER_FALLBACK_MODEL",
            fileRouter.fallbackModel,
            DEFAULT_SELF_HEALING_CONFIG.selfHealing.router.fallbackModel,
          ),
        ),
        maxRetries: resolveInt(
          "SELF_HEALING_ROUTER_MAX_RETRIES",
          fileSelfHealingRouter.maxRetries,
          resolveInt(
            "BACKUP_ROUTER_MAX_RETRIES",
            fileRouter.maxRetries,
            DEFAULT_SELF_HEALING_CONFIG.selfHealing.router.maxRetries,
          ),
        ),
        sleepMinMs: resolveInt(
          "SELF_HEALING_ROUTER_SLEEP_MIN_MS",
          fileSelfHealingRouter.sleepMinMs,
          resolveInt(
            "BACKUP_ROUTER_SLEEP_MIN_MS",
            fileRouter.sleepMinMs,
            DEFAULT_SELF_HEALING_CONFIG.selfHealing.router.sleepMinMs,
          ),
        ),
        sleepMaxMs: resolveInt(
          "SELF_HEALING_ROUTER_SLEEP_MAX_MS",
          fileSelfHealingRouter.sleepMaxMs,
          resolveInt(
            "BACKUP_ROUTER_SLEEP_MAX_MS",
            fileRouter.sleepMaxMs,
            DEFAULT_SELF_HEALING_CONFIG.selfHealing.router.sleepMaxMs,
          ),
        ),
        sleepStepMs: resolveInt(
          "SELF_HEALING_ROUTER_SLEEP_STEP_MS",
          fileSelfHealingRouter.sleepStepMs,
          resolveInt(
            "BACKUP_ROUTER_SLEEP_STEP_MS",
            fileRouter.sleepStepMs,
            DEFAULT_SELF_HEALING_CONFIG.selfHealing.router.sleepStepMs,
          ),
        ),
      },
      transport: {
        nasRecoveryWindowHours: resolveInt(
          "SELF_HEALING_RECOVERY_WINDOW_HOURS",
          fileSelfHealingTransport.nasRecoveryWindowHours,
          resolveInt(
            "NAS_BACKUP_RECOVERY_WINDOW_HOURS",
            fileTransport.nasRecoveryWindowHours,
            DEFAULT_SELF_HEALING_CONFIG.selfHealing.transport.nasRecoveryWindowHours,
          ),
        ),
        nasMaxAttempts: resolveInt(
          "SELF_HEALING_MAX_ATTEMPTS",
          fileSelfHealingTransport.nasMaxAttempts,
          resolveInt(
            "NAS_BACKUP_MAX_ATTEMPTS",
            fileTransport.nasMaxAttempts,
            DEFAULT_SELF_HEALING_CONFIG.selfHealing.transport.nasMaxAttempts,
          ),
        ),
        nasRetryBaseMs: resolveInt(
          "SELF_HEALING_RETRY_BASE_MS",
          fileSelfHealingTransport.nasRetryBaseMs,
          resolveInt(
            "NAS_BACKUP_RETRY_BASE_MS",
            fileTransport.nasRetryBaseMs,
            DEFAULT_SELF_HEALING_CONFIG.selfHealing.transport.nasRetryBaseMs,
          ),
        ),
        nasRetryMaxMs: resolveInt(
          "SELF_HEALING_RETRY_MAX_MS",
          fileSelfHealingTransport.nasRetryMaxMs,
          resolveInt(
            "NAS_BACKUP_RETRY_MAX_MS",
            fileTransport.nasRetryMaxMs,
            DEFAULT_SELF_HEALING_CONFIG.selfHealing.transport.nasRetryMaxMs,
          ),
        ),
        nasSshHost: resolveString(
          "SELF_HEALING_NAS_HOST",
          fileSelfHealingTransport.nasSshHost,
          resolveString(
            "NAS_SSH_HOST",
            fileTransport.nasSshHost,
            DEFAULT_SELF_HEALING_CONFIG.selfHealing.transport.nasSshHost,
          ),
        ),
        nasSshFlags: resolveString(
          "SELF_HEALING_NAS_FLAGS",
          fileSelfHealingTransport.nasSshFlags,
          resolveString(
            "NAS_SSH_FLAGS",
            fileTransport.nasSshFlags,
            DEFAULT_SELF_HEALING_CONFIG.selfHealing.transport.nasSshFlags,
          ),
        ),
        nasHddRoot: resolveString(
          "SELF_HEALING_NAS_HDD_ROOT",
          fileSelfHealingTransport.nasHddRoot,
          resolveString(
            "NAS_HDD_ROOT",
            fileTransport.nasHddRoot,
            DEFAULT_SELF_HEALING_CONFIG.selfHealing.transport.nasHddRoot,
          ),
        ),
        nasNvmeRoot: resolveString(
          "SELF_HEALING_NAS_NVME_ROOT",
          fileSelfHealingTransport.nasNvmeRoot,
          resolveString(
            "NAS_NVME_ROOT",
            fileTransport.nasNvmeRoot,
            DEFAULT_SELF_HEALING_CONFIG.selfHealing.transport.nasNvmeRoot,
          ),
        ),
      },
    },
    backupFailureRouter: {
      model: resolveString(
        "BACKUP_FAILURE_ROUTER_MODEL",
        fileRouter.model,
        DEFAULT_BACKUP_CONFIG.backupFailureRouter.model
      ),
      fallbackModel: resolveString(
        "BACKUP_FAILURE_ROUTER_FALLBACK_MODEL",
        fileRouter.fallbackModel,
        DEFAULT_BACKUP_CONFIG.backupFailureRouter.fallbackModel
      ),
      maxRetries: resolveInt(
        "BACKUP_ROUTER_MAX_RETRIES",
        fileRouter.maxRetries,
        DEFAULT_BACKUP_CONFIG.backupFailureRouter.maxRetries
      ),
      sleepMinMs: resolveInt(
        "BACKUP_ROUTER_SLEEP_MIN_MS",
        fileRouter.sleepMinMs,
        DEFAULT_BACKUP_CONFIG.backupFailureRouter.sleepMinMs
      ),
      sleepMaxMs: resolveInt(
        "BACKUP_ROUTER_SLEEP_MAX_MS",
        fileRouter.sleepMaxMs,
        DEFAULT_BACKUP_CONFIG.backupFailureRouter.sleepMaxMs
      ),
      sleepStepMs: resolveInt(
        "BACKUP_ROUTER_SLEEP_STEP_MS",
        fileRouter.sleepStepMs,
        DEFAULT_BACKUP_CONFIG.backupFailureRouter.sleepStepMs
      ),
    },
    backupTransport: {
      nasRecoveryWindowHours: resolveInt(
        "NAS_BACKUP_RECOVERY_WINDOW_HOURS",
        fileTransport.nasRecoveryWindowHours,
        DEFAULT_BACKUP_CONFIG.backupTransport.nasRecoveryWindowHours
      ),
      nasMaxAttempts: resolveInt(
        "NAS_BACKUP_MAX_ATTEMPTS",
        fileTransport.nasMaxAttempts,
        DEFAULT_BACKUP_CONFIG.backupTransport.nasMaxAttempts
      ),
      nasRetryBaseMs: resolveInt(
        "NAS_BACKUP_RETRY_BASE_MS",
        fileTransport.nasRetryBaseMs,
        DEFAULT_BACKUP_CONFIG.backupTransport.nasRetryBaseMs
      ),
      nasRetryMaxMs: resolveInt(
        "NAS_BACKUP_RETRY_MAX_MS",
        fileTransport.nasRetryMaxMs,
        DEFAULT_BACKUP_CONFIG.backupTransport.nasRetryMaxMs
      ),
      nasSshHost: resolveString(
        "NAS_SSH_HOST",
        fileTransport.nasSshHost,
        DEFAULT_BACKUP_CONFIG.backupTransport.nasSshHost
      ),
      nasSshFlags: resolveString(
        "NAS_SSH_FLAGS",
        fileTransport.nasSshFlags,
        DEFAULT_BACKUP_CONFIG.backupTransport.nasSshFlags
      ),
      nasHddRoot: resolveString(
        "NAS_HDD_ROOT",
        fileTransport.nasHddRoot,
        DEFAULT_BACKUP_CONFIG.backupTransport.nasHddRoot
      ),
      nasNvmeRoot: resolveString(
        "NAS_NVME_ROOT",
        fileTransport.nasNvmeRoot,
        DEFAULT_BACKUP_CONFIG.backupTransport.nasNvmeRoot
      ),
    },
  }
}

const hasText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0

const parseTs = (ts?: string): number => {
  if (!hasText(ts)) return 0
  const normalized = ts.replace(/\.(\d{3})\d+Z$/, ".$1Z")
  const ms = Date.parse(normalized)
  return Number.isFinite(ms) ? ms : 0
}

const parseOutputJson = <T>(output: unknown): T | null => {
  if (!hasText(output)) return null
  try {
    return JSON.parse(output) as T
  } catch {
    return null
  }
}

const findLatestNasRuns = (runs: NasRun[]) => {
  const sorted = [...runs].sort((a, b) =>
    parseTs(b.startedAt) - parseTs(a.startedAt)
  )

  const review = sorted.find((r) =>
    (r.functionName ?? "").toLowerCase().includes("nas soak review")
  )
  const sample = sorted.find((r) =>
    (r.functionName ?? "").toLowerCase().includes("nas soak sample")
  )

  return { review, sample }
}

const codeFromSampleRun = (runStatus: string, payload: SamplePayload | null) => {
  if (runStatus !== "COMPLETED") {
    return { code: "S13", summary: "sample run failed" }
  }
  if (!payload) {
    return { code: "S99", summary: "sample output parse failed" }
  }
  if (payload.status !== "ok") {
    return { code: "S12", summary: `sample status=${payload.status ?? "unknown"}` }
  }

  const badMount = (payload.mounts ?? []).find((m) => (m.errorCount ?? 0) > 0)
  if (badMount) {
    return {
      code: "S11",
      summary: `${badMount.mount ?? "mount"} errorCount=${badMount.errorCount ?? 0}`,
    }
  }

  return { code: "S00", summary: "sample healthy" }
}

const codeFromReviewRun = (runStatus: string, output: string | null) => {
  if (runStatus === "COMPLETED") {
    return { code: "R00", summary: "review completed" }
  }
  if (runStatus === "RUNNING") {
    return { code: "R01", summary: "review running" }
  }

  const txt = output ?? ""
  if (txt.includes("todoist-cli") || txt.includes("TaskPort") || txt.includes("secrets lease")) {
    return { code: "R10", summary: "review failed in TaskPort/Todoist side-effect" }
  }

  return { code: "R99", summary: "review failed" }
}

const sleepMs = (ms: number) =>
  Effect.tryPromise({
    try: () => new Promise((resolve) => setTimeout(resolve, ms)),
    catch: () => new Error("sleep interrupted"),
  })

const restartWorker = () =>
  Effect.try({
    try: () => {
      const uid = process.getuid?.() ?? 0
      const proc = Bun.spawnSync([
        "launchctl",
        "kickstart",
        "-k",
        `gui/${uid}/${WORKER_LABEL}`,
      ])

      if (proc.exitCode !== 0) {
        const stderr = proc.stderr.toString().trim()
        throw new Error(stderr || `launchctl exited with ${proc.exitCode}`)
      }

      return { ok: true }
    },
    catch: (e) => new Error(`Failed to restart worker: ${e}`),
  })

const registerWorkerFunctions = () =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(WORKER_REGISTER_URL, { method: "PUT" })
      const body = await res.json().catch(() => ({}))
      return {
        ok: res.ok,
        status: res.status,
        body,
      }
    },
    catch: (e) => new Error(`Failed to register worker functions: ${e}`),
  })

const evaluateNasStatus = (
  inngestClient: InstanceType<typeof Inngest>,
  hours: number
) =>
  Effect.gen(function* () {
    const runs = (yield* inngestClient.runs({ count: 200, hours })) as NasRun[]
    const { review, sample } = findLatestNasRuns(runs)

    if (!review && !sample) {
      return {
        ok: false,
        code: "N00",
        review: {
          code: "R98",
          summary: "review run missing",
          runId: null,
          status: null,
          startedAt: null,
          output: null,
        },
        sample: {
          code: "S98",
          summary: "sample run missing",
          runId: null,
          status: null,
          startedAt: null,
          payload: null,
        },
      } as NasStatusResult
    }

    let sampleCode = "S98"
    let sampleSummary = "sample run missing"
    let sampleDetail: SamplePayload | null = null

    if (sample) {
      const sampleRun = yield* inngestClient.run(sample.id)
      const payload = parseOutputJson<SamplePayload>((sampleRun as any)?.run?.output)
      sampleDetail = payload
      const sampleEval = codeFromSampleRun(sample.status, payload)
      sampleCode = sampleEval.code
      sampleSummary = sampleEval.summary
    }

    let reviewCode = "R98"
    let reviewSummary = "review run missing"
    let reviewOutput: string | null = null

    if (review) {
      const reviewRun = yield* inngestClient.run(review.id)
      reviewOutput = hasText((reviewRun as any)?.run?.output) ? (reviewRun as any).run.output as string : null
      const reviewEval = codeFromReviewRun(review.status, reviewOutput)
      reviewCode = reviewEval.code
      reviewSummary = reviewEval.summary
    }

    const code = `${reviewCode}/${sampleCode}`
    return {
      ok: reviewCode === "R00" && sampleCode === "S00",
      code,
      review: {
        code: reviewCode,
        summary: reviewSummary,
        runId: review?.id ?? null,
        status: review?.status ?? null,
        startedAt: review?.startedAt ?? null,
        output: reviewOutput,
      },
      sample: {
        code: sampleCode,
        summary: sampleSummary,
        runId: sample?.id ?? null,
        status: sample?.status ?? null,
        startedAt: sample?.startedAt ?? null,
        payload: sampleDetail,
      },
    } as NasStatusResult
  })

const nasStatusCmd = Command.make(
  "status",
  {
    hours: Options.integer("hours").pipe(
      Options.withDefault(168),
      Options.withDescription("Look back N hours for NAS runs (default: 168)")
    ),
    compact: Options.boolean("compact").pipe(
      Options.withAlias("c"),
      Options.withDefault(false),
      Options.withDescription("Return compact code-focused JSON payload")
    ),
  },
  ({ hours, compact }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      const status = yield* evaluateNasStatus(inngestClient, hours)

      if (status.code === "N00") {
        yield* Console.log(respond("nas status", {
          code: "N00",
          message: "no NAS soak runs found in lookback window",
          compact,
        }, [
          { command: "joelclaw functions", description: "Verify NAS soak functions are registered" },
          { command: "joelclaw nas review", description: "Trigger a manual ADR gate review" },
        ], false))
        return
      }

      if (compact) {
        yield* Console.log(respond("nas status", {
          code: status.code,
          short_code: status.code,
          review: {
            code: status.review.code,
            summary: status.review.summary,
            runId: status.review.runId,
            status: status.review.status,
            startedAt: status.review.startedAt,
          },
          sample: {
            code: status.sample.code,
            summary: status.sample.summary,
            runId: status.sample.runId,
            status: status.sample.status,
            startedAt: status.sample.startedAt,
          },
          reply_hint: `Reply with ${status.code}`,
        }, [
          { command: "joelclaw nas review", description: "Trigger manual ADR gate review" },
          { command: "joelclaw nas runs", description: "List recent NAS soak runs" },
          { command: "joelclaw runs --status FAILED --hours 24", description: "Inspect failures around NAS runs" },
        ], status.ok))
        return
      }

      yield* Console.log(respond("nas status", {
        code: status.code,
        review: {
          code: status.review.code,
          summary: status.review.summary,
          runId: status.review.runId,
          status: status.review.status,
          startedAt: status.review.startedAt,
          output: status.review.output,
        },
        sample: {
          code: status.sample.code,
          summary: status.sample.summary,
          runId: status.sample.runId,
          status: status.sample.status,
          startedAt: status.sample.startedAt,
          payload: status.sample.payload,
        },
      }, [
        { command: "joelclaw nas review", description: "Trigger manual ADR gate review" },
        { command: "joelclaw nas runs", description: "List recent NAS soak runs" },
        { command: "joelclaw runs --status FAILED --hours 24", description: "Inspect failures around NAS runs" },
      ], status.ok))
    })
)

const nasRunsCmd = Command.make(
  "runs",
  {
    count: Options.integer("count").pipe(
      Options.withAlias("n"),
      Options.withDefault(20),
      Options.withDescription("Number of NAS runs to show")
    ),
    hours: Options.integer("hours").pipe(
      Options.withDefault(168),
      Options.withDescription("Look back N hours (default: 168)")
    ),
    compact: Options.boolean("compact").pipe(
      Options.withAlias("c"),
      Options.withDefault(false),
      Options.withDescription("Return compact JSON rows")
    ),
  },
  ({ count, hours, compact }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      const runs = (yield* inngestClient.runs({ count: 300, hours })) as NasRun[]
      const nasRuns = runs
        .filter((r) => (r.functionName ?? "").toLowerCase().includes("nas soak "))
        .sort((a, b) =>
          parseTs(b.startedAt) - parseTs(a.startedAt)
        )
        .slice(0, count)

      if (compact) {
        const rows = nasRuns.map((r) => ({
          id: r.id,
          idShort: r.id.slice(0, 12),
          status: r.status,
          when: r.startedAt ?? null,
          function: (r.functionName ?? "?")
            .replace(" (ADR-0088 gate telemetry)", "")
            .replace(" (ADR-0088 gate evaluation)", ""),
        }))
        yield* Console.log(respond("nas runs", {
          count: rows.length,
          rows,
        }, [
          { command: "joelclaw nas status --compact", description: "Show compact NAS health code" },
          { command: "joelclaw nas review", description: "Trigger manual ADR gate review" },
        ]))
        return
      }

      yield* Console.log(respond("nas runs", {
        count: nasRuns.length,
        runs: nasRuns,
      }, [
        { command: "joelclaw nas status", description: "Show compact NAS status/failure codes" },
        { command: "joelclaw nas review", description: "Trigger manual ADR gate review" },
      ]))
    })
)

const nasReviewCmd = Command.make(
  "review",
  {
    reason: Options.text("reason").pipe(
      Options.withDefault("manual-cli"),
      Options.withDescription("Reason stored in review event payload")
    ),
  },
  ({ reason }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      const response = yield* inngestClient.send("nas/soak.review.requested", { reason })

      yield* Console.log(respond("nas review", {
        event: "nas/soak.review.requested",
        reason,
        response,
      }, [
        { command: "joelclaw nas status", description: "Get compact result codes" },
        { command: "joelclaw nas runs", description: "List NAS soak runs" },
      ]))
    })
)

const nasHealCmd = Command.make(
  "heal",
  {
    reason: Options.text("reason").pipe(
      Options.withDefault("nas-heal-cli"),
      Options.withDescription("Reason stored in review event payload")
    ),
    waitMs: Options.integer("wait-ms").pipe(
      Options.withDefault(2500),
      Options.withDescription("Wait after review trigger before evaluating status")
    ),
    restartWaitMs: Options.integer("restart-wait-ms").pipe(
      Options.withDefault(1800),
      Options.withDescription("Wait after worker restart before registration")
    ),
    hours: Options.integer("hours").pipe(
      Options.withDefault(168),
      Options.withDescription("Look back window for final status evaluation")
    ),
  },
  ({ reason, waitMs, restartWaitMs, hours }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest

      const restarted = yield* restartWorker().pipe(Effect.either)
      if (restarted._tag === "Left") {
        yield* Console.log(respondError(
          "nas heal",
          restarted.left.message,
          "H10_WORKER_RESTART_FAILED",
          "Run `joelclaw inngest restart-worker` and check launchd/service logs.",
          [
            { command: "joelclaw inngest restart-worker", description: "Retry worker restart" },
            { command: "joelclaw logs errors -n 100", description: "Inspect worker stderr" },
          ],
        ))
        return
      }

      if (restartWaitMs > 0) {
        yield* sleepMs(restartWaitMs)
      }

      let registration = yield* registerWorkerFunctions().pipe(Effect.either)
      if (registration._tag === "Left" || !registration.right.ok) {
        // Retry once after short backoff; launchd may need a moment after kickstart.
        yield* sleepMs(1200)
        registration = yield* registerWorkerFunctions().pipe(Effect.either)
      }

      if (registration._tag === "Left" || !registration.right.ok) {
        yield* Console.log(respondError(
          "nas heal",
          registration._tag === "Left" ? registration.left.message : `register returned status ${registration.right.status}`,
          "H20_REGISTER_FAILED",
          "Run `joelclaw inngest register` and verify worker endpoint is reachable.",
          [
            { command: "joelclaw inngest register", description: "Retry function registration" },
            { command: "joelclaw inngest status", description: "Check worker/server health" },
          ],
        ))
        return
      }

      const review = yield* inngestClient
        .send("nas/soak.review.requested", { reason })
        .pipe(
          Effect.mapError((e) => new Error(`Failed to trigger review event: ${String(e)}`)),
          Effect.either
        )

      if (review._tag === "Left") {
        yield* Console.log(respondError(
          "nas heal",
          review.left.message,
          "H30_REVIEW_TRIGGER_FAILED",
          "Run `joelclaw nas review` directly and inspect Inngest health.",
          [
            { command: "joelclaw nas review", description: "Trigger NAS review manually" },
            { command: "joelclaw inngest status", description: "Check Inngest health" },
          ],
        ))
        return
      }

      if (waitMs > 0) {
        yield* sleepMs(waitMs)
      }

      const status = yield* evaluateNasStatus(inngestClient, hours)
      const healCode = status.ok ? "H00" : "H40"

      yield* Console.log(respond("nas heal", {
        heal_code: healCode,
        short_code: status.code,
        reply_hint: `Reply with ${status.code}`,
        steps: {
          restart_worker: "ok",
          register_functions: registration.right,
          trigger_review: review.right,
        },
        status: {
          code: status.code,
          review: {
            code: status.review.code,
            summary: status.review.summary,
            runId: status.review.runId,
            status: status.review.status,
            startedAt: status.review.startedAt,
          },
          sample: {
            code: status.sample.code,
            summary: status.sample.summary,
            runId: status.sample.runId,
            status: status.sample.status,
            startedAt: status.sample.startedAt,
          },
        },
      }, [
        { command: "joelclaw nas status --compact", description: "Re-check compact NAS code" },
        { command: "joelclaw nas runs --compact", description: "Inspect recent NAS runs" },
        { command: "joelclaw runs --status FAILED --hours 24", description: "Inspect surrounding failures" },
      ], status.ok))
    })
)

const resolveNasConfigDisplay = (useEffectiveValues: boolean) => {
  const raw = readSystemBusConfigFile()
  const fileRouter = isRecord(raw.backupFailureRouter)
    ? (raw.backupFailureRouter as Record<string, unknown>)
    : {}
  const fileSelfHealing = isRecord(raw.selfHealing)
    ? (raw.selfHealing as Record<string, unknown>)
    : {}
  const fileSelfHealingRouter = isRecord(fileSelfHealing.router)
    ? (fileSelfHealing.router as Record<string, unknown>)
    : {}
  const fileSelfHealingTransport = isRecord(fileSelfHealing.transport)
    ? (fileSelfHealing.transport as Record<string, unknown>)
    : {}
  const fileTransport = isRecord(raw.backupTransport)
    ? (raw.backupTransport as Record<string, unknown>)
    : {}

  const fileValues = {
    selfHealing: {
      router: {
        ...DEFAULT_SELF_HEALING_CONFIG.selfHealing.router,
        ...fileSelfHealingRouter,
      },
      transport: {
        ...DEFAULT_SELF_HEALING_CONFIG.selfHealing.transport,
        ...fileSelfHealingTransport,
      },
    },
    backupFailureRouter: {
      ...DEFAULT_BACKUP_CONFIG.backupFailureRouter,
      ...fileRouter,
    },
    backupTransport: {
      ...DEFAULT_BACKUP_CONFIG.backupTransport,
      ...fileTransport,
    },
  }

  return {
    path: SYSTEM_BUS_CONFIG_PATH,
    fileExists: existsSync(SYSTEM_BUS_CONFIG_PATH),
    config: useEffectiveValues ? resolveSystemBusConfig() : fileValues,
    fileValues,
  }
}

const nasConfigShowCmd = Command.make(
  "show",
  {
    effective: Options.boolean("effective").pipe(
      Options.withDefault(false),
      Options.withDescription("Apply environment variable overrides when showing resolved values")
    ),
  },
  ({ effective }) =>
    Effect.gen(function* () {
      const resolvedConfig = resolveNasConfigDisplay(effective)

      yield* Console.log(respond("nas config show", {
        path: resolvedConfig.path,
        fileExists: resolvedConfig.fileExists,
        configFromFile: resolvedConfig.fileValues,
        effectiveValues: {
          applyEnv: effective,
          values: resolvedConfig.config,
        },
      }, [
        { command: "joelclaw nas config init [--force]", description: "Create default system-bus config file" },
        { command: "joelclaw nas config show --effective", description: "Show environment-resolved config" },
      ]))
    })
)

const nasConfigInitCmd = Command.make(
  "init",
  {
    force: Options.boolean("force").pipe(
      Options.withDefault(false),
      Options.withDescription("Overwrite an existing config file")
    ),
  },
  ({ force }) =>
    Effect.gen(function* () {
      const exists = existsSync(SYSTEM_BUS_CONFIG_PATH)
      if (exists && !force) {
        yield* Console.log(respondError(
          "nas config init",
          `Config file already exists at ${SYSTEM_BUS_CONFIG_PATH}`,
          "NASC_INIT_EXISTS",
          "Pass --force to overwrite it, or run joelclaw nas config show to inspect current values.",
          [
            { command: "joelclaw nas config show --effective", description: "Inspect currently effective config" },
            { command: "joelclaw nas config init --force", description: "Overwrite config with defaults" },
          ],
        ))
        return
      }

      mkdirSync(dirname(SYSTEM_BUS_CONFIG_PATH), { recursive: true })
      writeFileSync(SYSTEM_BUS_CONFIG_PATH, `${JSON.stringify(DEFAULT_BACKUP_CONFIG, null, 2)}\n`, "utf-8")

      yield* Console.log(respond("nas config init", {
        path: SYSTEM_BUS_CONFIG_PATH,
        action: "written",
      }, [
        { command: "joelclaw nas config show", description: "Inspect written config and defaults" },
        { command: "joelclaw nas config show --effective", description: "Verify environment-resolved values" },
      ]))
    })
)

const nasConfigCmd = Command.make("config", {}, () =>
  Console.log(respond("nas config", {
    description: "View and initialize ~/.joelclaw/system-bus.config.json",
    path: SYSTEM_BUS_CONFIG_PATH,
    defaults: DEFAULT_BACKUP_CONFIG,
    subcommands: {
      show: "joelclaw nas config show [--effective]",
      init: "joelclaw nas config init [--force]",
    },
  }, [
    { command: "joelclaw nas config show", description: "Inspect current/merged config values" },
    { command: "joelclaw nas config init", description: "Create or replace config file with defaults" },
  ]))
).pipe(
  Command.withSubcommands([nasConfigShowCmd, nasConfigInitCmd])
)

export const nasCmd = Command.make("nas", {}, () =>
  Console.log(respond("nas", {
    description: "NAS soak shortcuts (ADR-0088)",
    subcommands: {
      status: "joelclaw nas status [-c] [--hours 168]",
      runs: "joelclaw nas runs [-n 20] [-c] [--hours 168]",
      review: "joelclaw nas review [--reason manual-cli]",
      heal: "joelclaw nas heal [--reason nas-heal-cli] [--wait-ms 2500]",
      config: "joelclaw nas config [show|init]",
    },
    failure_codes: {
      H00: "heal completed and NAS gates healthy",
      H10_WORKER_RESTART_FAILED: "worker restart failed",
      H20_REGISTER_FAILED: "worker function registration failed",
      H30_REVIEW_TRIGGER_FAILED: "failed to trigger nas review event",
      H40: "heal flow completed but NAS status still failing",
      R00: "review completed",
      R01: "review running",
      R10: "review failed in TaskPort/Todoist side-effect",
      R98: "review missing",
      R99: "review failed",
      S00: "sample healthy",
      S11: "sample mount errors",
      S12: "sample status not ok",
      S13: "sample run failed",
      S98: "sample missing",
      S99: "sample output parse failed",
      N00: "no NAS runs in lookback",
    },
  }, [
    { command: "joelclaw nas status", description: "Compact status codes for quick reporting" },
    { command: "joelclaw nas heal", description: "Restart/register/review and return final short code" },
    { command: "joelclaw nas review", description: "Trigger manual ADR review" },
    { command: "joelclaw nas runs", description: "Recent NAS soak runs" },
  ]))
).pipe(
  Command.withSubcommands([nasStatusCmd, nasRunsCmd, nasReviewCmd, nasHealCmd, nasConfigCmd])
)
