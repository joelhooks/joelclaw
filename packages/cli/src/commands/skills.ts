import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import { respond, respondError } from "../response"

const SKILL_GARDEN_EVENT = "skill-garden/check"
const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"])
const SKILL_CONSUMERS = ["all", "agents", "pi", "claude"] as const

type SkillConsumer = Exclude<(typeof SKILL_CONSUMERS)[number], "all">

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

type ResolvedSkillSource = {
  name: string
  sourceRoot: string
  skillDir: string
  skillFile: string
}

type SkillEnsureStatus = "created" | "updated" | "unchanged"

type SkillEnsureLinkResult = {
  consumer: SkillConsumer
  target: string
  source: string
  status: SkillEnsureStatus
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

function collectAncestors(startDir: string, maxDepth = 10): string[] {
  const dirs: string[] = []
  let current = resolve(startDir)
  for (let depth = 0; depth < maxDepth; depth++) {
    dirs.push(current)
    const parent = resolve(current, "..")
    if (parent === current) break
    current = parent
  }
  return dirs
}

function skillConsumerDirs(homeDir = homedir()): Record<SkillConsumer, string> {
  return {
    agents: join(homeDir, ".agents", "skills"),
    pi: join(homeDir, ".pi", "agent", "skills"),
    claude: join(homeDir, ".claude", "skills"),
  }
}

function pathExistsOrSymlink(path: string): boolean {
  if (existsSync(path)) return true
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function resolveSkillSource(options: {
  name: string
  sourceRoot?: string
  cwd?: string
  homeDir?: string
}): ResolvedSkillSource {
  const cwd = options.cwd ?? process.cwd()
  const homeDir = options.homeDir ?? homedir()
  const candidates: string[] = []

  if (options.sourceRoot) {
    candidates.push(resolve(options.sourceRoot, "skills", options.name))
  }

  for (const dir of collectAncestors(cwd)) {
    candidates.push(join(dir, "skills", options.name))
  }

  candidates.push(
    join(homeDir, "Code", "joelhooks", "joelclaw", "skills", options.name),
  )

  for (const skillDir of candidates) {
    const skillFile = join(skillDir, "SKILL.md")
    if (!existsSync(skillFile)) continue
    return {
      name: options.name,
      sourceRoot: resolve(skillDir, "..", ".."),
      skillDir,
      skillFile,
    }
  }

  throw new Error(
    `Could not resolve canonical skill source for ${options.name}; pass --source-root <repo> when the skill lives in another repo`,
  )
}

function targetPathForConsumer(name: string, consumer: SkillConsumer, homeDir = homedir()): string {
  return join(skillConsumerDirs(homeDir)[consumer], name)
}

function ensureSkillLink(options: {
  sourceDir: string
  name: string
  consumer: SkillConsumer
  homeDir?: string
}): SkillEnsureLinkResult {
  const homeDir = options.homeDir ?? homedir()
  const target = targetPathForConsumer(options.name, options.consumer, homeDir)
  mkdirSync(dirname(target), { recursive: true })

  if (pathExistsOrSymlink(target)) {
    const stat = lstatSync(target)
    if (!stat.isSymbolicLink()) {
      throw new Error(
        `Cannot ensure ${options.consumer} skill ${options.name}: ${target} exists and is not a symlink`,
      )
    }

    const currentTarget = resolve(dirname(target), readlinkSync(target))
    if (currentTarget === options.sourceDir) {
      return {
        consumer: options.consumer,
        target,
        source: options.sourceDir,
        status: "unchanged",
      }
    }

    unlinkSync(target)
    symlinkSync(options.sourceDir, target)
    return {
      consumer: options.consumer,
      target,
      source: options.sourceDir,
      status: "updated",
    }
  }

  symlinkSync(options.sourceDir, target)
  return {
    consumer: options.consumer,
    target,
    source: options.sourceDir,
    status: "created",
  }
}

function normalizeConsumers(
  consumer: (typeof SKILL_CONSUMERS)[number],
): SkillConsumer[] {
  if (consumer === "all") return ["agents", "pi", "claude"]
  return [consumer]
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

const ensureSkillArg = Args.text({ name: "skill" }).pipe(
  Args.withDescription("Skill name to install/maintain in agent consumer directories"),
)

const sourceRootOption = Options.text("source-root").pipe(
  Options.withDescription("Repo root containing skills/<name>/SKILL.md (defaults to cwd/ancestors or joelclaw repo)"),
  Options.optional,
)

const consumerOption = Options.choice("consumer", SKILL_CONSUMERS).pipe(
  Options.withDescription("Which consumer directories to maintain"),
  Options.withDefault("all"),
)

const skillsEnsureCmd = Command.make(
  "ensure",
  {
    skill: ensureSkillArg,
    sourceRoot: sourceRootOption,
    consumer: consumerOption,
  },
  ({ skill, sourceRoot, consumer }) =>
    Effect.gen(function* () {
      const sourceRootValue = sourceRoot._tag === "Some" ? sourceRoot.value : undefined
      const sourceEither = yield* Effect.try({
        try: () =>
          resolveSkillSource({
            name: skill.trim(),
            sourceRoot: sourceRootValue,
          }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(Effect.either)

      if (sourceEither._tag === "Left") {
        yield* Console.log(
          respondError(
            "skills ensure",
            sourceEither.left.message,
            "SKILL_SOURCE_NOT_FOUND",
            "Pass --source-root <repo> for repo-local skills or install external skills with `npx skills add -y -g <source>`.",
            [
              {
                command: "joelclaw skills ensure <skill> [--source-root <repo>] [--consumer <consumer>]",
                description: "Retry with an explicit skill source root",
                params: {
                  skill: {
                    description: "Skill name",
                    value: skill,
                    required: true,
                  },
                  repo: {
                    description: "Repo root containing skills/<name>/SKILL.md",
                    value: sourceRootValue ?? process.cwd(),
                  },
                  consumer: {
                    description: "Consumer directories to maintain",
                    value: consumer,
                    enum: SKILL_CONSUMERS,
                  },
                },
              },
              {
                command: "npx skills add -y -g <source>",
                description: "Install an external third-party skill package globally",
                params: {
                  source: {
                    description: "Package/repo source understood by the skills CLI",
                    value: "owner/repo-or-package",
                    required: true,
                  },
                },
              },
            ],
          ),
        )
        return
      }

      const source = sourceEither.right
      const consumers = normalizeConsumers(consumer)
      const ensureEither = yield* Effect.try({
        try: () => consumers.map((targetConsumer) =>
          ensureSkillLink({
            sourceDir: source.skillDir,
            name: source.name,
            consumer: targetConsumer,
          }),
        ),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(Effect.either)

      if (ensureEither._tag === "Left") {
        yield* Console.log(
          respondError(
            "skills ensure",
            ensureEither.left.message,
            "SKILL_ENSURE_FAILED",
            "Remove the conflicting target or convert it back to a symlink, then retry.",
            [
              {
                command: "joelclaw skills ensure <skill> [--source-root <repo>] [--consumer <consumer>]",
                description: "Retry after fixing the conflicting consumer path",
                params: {
                  skill: {
                    description: "Skill name",
                    value: source.name,
                    required: true,
                  },
                  repo: {
                    description: "Repo root containing skills/<name>/SKILL.md",
                    value: source.sourceRoot,
                  },
                  consumer: {
                    description: "Consumer directories to maintain",
                    value: consumer,
                    enum: SKILL_CONSUMERS,
                  },
                },
              },
              {
                command: "joelclaw skills audit",
                description: "Inspect broader skill drift after repair",
              },
            ],
          ),
        )
        return
      }

      const results = ensureEither.right
      const piPath = targetPathForConsumer(source.name, "pi")

      yield* Console.log(
        respond(
          "skills ensure",
          {
            skill: source.name,
            sourceRoot: source.sourceRoot,
            sourceDir: source.skillDir,
            sourceFile: source.skillFile,
            ensured: results,
            installSurface: {
              localRepoSkill: "joelclaw skills ensure",
              externalSkill: "npx skills add -y -g <source>",
            },
          },
          [
            {
              command: "read <path>",
              description: "Load the installed skill into the agent context",
              params: {
                path: {
                  description: "Installed skill path",
                  value: piPath,
                  required: true,
                },
              },
            },
            {
              command: "joelclaw skills audit",
              description: "Check the wider skill garden for drift",
            },
            {
              command: "npx skills add -y -g <source>",
              description: "Use the upstream skills CLI when you need an external third-party skill package",
              params: {
                source: {
                  description: "Package/repo source understood by the skills CLI",
                  value: "owner/repo-or-package",
                  required: true,
                },
              },
            },
          ],
        ),
      )
    }),
).pipe(Command.withDescription("Install or repair canonical skill symlinks for local repo skills"))

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
            ensure: "joelclaw skills ensure <skill> [--source-root <repo>] [--consumer all|agents|pi|claude]",
            audit: "joelclaw skills audit [--deep] [--wait-ms <wait-ms>] [--poll-ms <poll-ms>]",
          },
          installSurface: {
            localRepoSkill: "joelclaw skills ensure",
            externalSkill: "npx skills add -y -g <source>",
          },
        },
        [
          { command: "joelclaw skills ensure agent-workloads", description: "Install/repair a canonical local skill in agent consumer dirs" },
          { command: "joelclaw skills audit", description: "Run structural skill garden checks" },
          { command: "joelclaw skills audit --deep", description: "Run structural + LLM deep checks" },
        ],
      ),
    )
  }),
).pipe(Command.withSubcommands([skillsEnsureCmd, skillsAuditCmd]))

export const __skillsTestUtils = {
  parseRunOutput,
  collectAncestors,
  resolveSkillSource,
  targetPathForConsumer,
  ensureSkillLink,
}
