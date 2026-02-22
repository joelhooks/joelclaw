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

export const nasCmd = Command.make("nas", {}, () =>
  Console.log(respond("nas", {
    description: "NAS soak shortcuts (ADR-0088)",
    subcommands: {
      status: "joelclaw nas status [-c] [--hours 168]",
      runs: "joelclaw nas runs [-n 20] [-c] [--hours 168]",
      review: "joelclaw nas review [--reason manual-cli]",
      heal: "joelclaw nas heal [--reason nas-heal-cli] [--wait-ms 2500]",
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
  Command.withSubcommands([nasStatusCmd, nasRunsCmd, nasReviewCmd, nasHealCmd])
)
