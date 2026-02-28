import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import { respond, respondError } from "../response"

const SKILL_GARDEN_EVENT = "skill-garden/check"
const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"])

type SkillGardenFinding = {
  type?: string
  skill?: string
  location?: string
  detail?: string
}

type SkillGardenReport = {
  timestamp?: string
  isDeepReview?: boolean
  findings?: {
    total?: number
    brokenSymlinks?: number
    nonCanonical?: number
    missingFrontmatter?: number
    stalePatterns?: number
    orphans?: number
    llmStaleness?: number
  }
  details?: SkillGardenFinding[]
}

function parseRunOutput(raw: unknown): SkillGardenReport | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== "object") return null
    return parsed as SkillGardenReport
  } catch {
    return null
  }
}

const sleepMs = (ms: number) =>
  Effect.tryPromise({
    try: () => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    catch: () => new Error("sleep failed"),
  })

const deepOption = Options.boolean("deep").pipe(
  Options.withDescription("Run deep LLM staleness review in addition to structural checks"),
  Options.withDefault(false),
)

const waitMsOption = Options.integer("wait-ms").pipe(
  Options.withDescription("Max wait time for skill-garden run completion"),
  Options.withDefault(60000),
)

const pollMsOption = Options.integer("poll-ms").pipe(
  Options.withDescription("Polling interval while waiting for run state"),
  Options.withDefault(1000),
)

const skillsAuditCmd = Command.make(
  "audit",
  {
    deep: deepOption,
    waitMs: waitMsOption,
    pollMs: pollMsOption,
  },
  ({ deep, waitMs, pollMs }) =>
    Effect.gen(function* () {
      const inngest = yield* Inngest
      const safeWaitMs = Math.max(5_000, waitMs)
      const safePollMs = Math.max(250, pollMs)
      const payload = deep ? { deep: true } : {}

      const sendResult = yield* inngest.send(SKILL_GARDEN_EVENT, payload)
      const eventId = Array.isArray((sendResult as any)?.ids)
        ? ((sendResult as any).ids[0] as string | undefined)
        : undefined

      if (!eventId) {
        yield* Console.log(
          respondError(
            "skills audit",
            "Skill audit event was not accepted",
            "EVENT_DISPATCH_FAILED",
            "Verify Inngest server/worker health and retry",
            [
              { command: "joelclaw status", description: "Check system health" },
              { command: "joelclaw functions", description: "Verify skill-garden function is registered" },
              {
                command: "joelclaw send skill-garden/check --data '{}'",
                description: "Dispatch the event manually",
              },
            ],
          ),
        )
        return
      }

      const deadline = Date.now() + safeWaitMs
      let runId: string | undefined

      while (!runId && Date.now() < deadline) {
        const eventState = yield* inngest.event(eventId).pipe(Effect.either)
        if (eventState._tag === "Right") {
          const runs = eventState.right.runs ?? []
          const matchingRun = runs.find((run) =>
            String(run.functionName ?? run.functionID ?? "")
              .toLowerCase()
              .includes("skill-garden"),
          )
          runId = String((matchingRun ?? runs[0])?.id ?? "") || undefined
        }

        if (!runId) {
          yield* sleepMs(safePollMs)
        }
      }

      if (!runId) {
        yield* Console.log(
          respondError(
            "skills audit",
            "Timed out waiting for skill-garden run to start",
            "RUN_RESOLVE_TIMEOUT",
            "Increase --wait-ms or inspect event/run state manually",
            [
              { command: `joelclaw event ${eventId}`, description: "Inspect event → run linkage" },
              { command: "joelclaw runs --status RUNNING --count 20", description: "Check active runs" },
              {
                command: "joelclaw skills audit [--deep] [--wait-ms <wait-ms>]",
                description: "Retry with larger wait window",
                params: {
                  "wait-ms": { description: "Max wait in ms", value: 120000, default: 60000 },
                },
              },
            ],
          ),
        )
        return
      }

      let runState: any = null
      let status = "QUEUED"

      while (Date.now() < deadline) {
        const detail = yield* inngest.run(runId).pipe(Effect.either)
        if (detail._tag === "Right") {
          runState = detail.right
          status = String(detail.right?.run?.status ?? "UNKNOWN")
          if (TERMINAL_STATUSES.has(status)) break
        }

        yield* sleepMs(safePollMs)
      }

      if (!TERMINAL_STATUSES.has(status)) {
        yield* Console.log(
          respondError(
            "skills audit",
            `Timed out waiting for run ${runId} to finish`,
            "RUN_WAIT_TIMEOUT",
            "Increase --wait-ms or inspect run details directly",
            [
              { command: `joelclaw run ${runId}`, description: "Inspect current run state" },
              {
                command: "joelclaw skills audit [--deep] [--wait-ms <wait-ms>]",
                description: "Retry with a larger timeout",
                params: {
                  "wait-ms": { description: "Max wait in ms", value: 120000, default: 60000 },
                },
              },
            ],
          ),
        )
        return
      }

      if (status === "FAILED") {
        yield* Console.log(
          respondError(
            "skills audit",
            `Skill audit run failed (${runId})`,
            "RUN_FAILED",
            `Inspect run details and worker logs: joelclaw run ${runId}`,
            [
              { command: `joelclaw run ${runId}`, description: "Inspect failed run trace and errors" },
              { command: "joelclaw logs errors --lines 120", description: "Inspect worker stderr" },
            ],
          ),
        )
        return
      }

      const report = parseRunOutput(runState?.run?.output)
      const findings = report?.findings ?? {}
      const total = Number(findings.total ?? 0)
      const topFindings = (report?.details ?? []).slice(0, 10)

      yield* Console.log(
        respond(
          "skills audit",
          {
            event: {
              name: SKILL_GARDEN_EVENT,
              id: eventId,
              payload,
            },
            run: {
              id: runId,
              status,
              startedAt: runState?.run?.startedAt,
              endedAt: runState?.run?.endedAt,
            },
            findings: {
              total,
              brokenSymlinks: findings.brokenSymlinks ?? 0,
              nonCanonical: findings.nonCanonical ?? 0,
              missingFrontmatter: findings.missingFrontmatter ?? 0,
              stalePatterns: findings.stalePatterns ?? 0,
              orphans: findings.orphans ?? 0,
              llmStaleness: findings.llmStaleness ?? 0,
            },
            isDeepReview: report?.isDeepReview ?? deep,
            timestamp: report?.timestamp,
            topFindings,
            rawOutput: report ? undefined : runState?.run?.output,
          },
          [
            {
              command: "joelclaw skills audit --deep",
              description: "Run full deep review with LLM staleness checks",
            },
            {
              command: "joelclaw run <run-id>",
              description: "Inspect full run details and trace",
              params: {
                "run-id": { description: "Run ID", value: runId, required: true },
              },
            },
            {
              command: "joelclaw otel search 'skill-garden.findings' --hours 24",
              description: "Inspect emitted telemetry records",
            },
          ],
          total === 0,
        ),
      )
    }),
).pipe(Command.withDescription("Run skill-garden checks on demand and return findings report"))

export const skillsCmd = Command.make("skills", {}, () =>
  Effect.gen(function* () {
    yield* Console.log(
      respond(
        "skills",
        {
          description: "Skill inventory maintenance commands",
          commands: {
            audit: "joelclaw skills audit [--deep] [--wait-ms <wait-ms>] [--poll-ms <poll-ms>]",
          },
        },
        [
          { command: "joelclaw skills audit", description: "Run structural skill garden checks" },
          { command: "joelclaw skills audit --deep", description: "Run structural + LLM deep checks" },
        ],
      ),
    )
  }),
).pipe(Command.withSubcommands([skillsAuditCmd]))

export const __skillsTestUtils = {
  parseRunOutput,
}
