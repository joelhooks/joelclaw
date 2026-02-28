/**
 * ADR-0180: Agent roster commands.
 *
 * `joelclaw agent list`              — discover agents from project + user scopes
 * `joelclaw agent show <name>`       — display full agent definition
 * `joelclaw agent run <name> <task>` — fire agent/task.run event via Inngest
 * `joelclaw agent chain <steps> --task <task>` — fire agent/chain.run event
 * `joelclaw agent watch <id>`        — stream task/chain progress via Redis + Inngest fallback
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import { type NextAction, respond, respondError } from "../response"
import {
  emitError,
  emitLog,
  emitProgress,
  emitResult,
  emitStart,
  emitStep,
} from "../stream"

// ── Agent definition parsing (mirror of system-bus agent-roster.ts) ──

interface AgentSummary {
  name: string
  description?: string
  model: string
  thinking?: string
  tools: string[]
  skills: string[]
  source: "project" | "user" | "builtin"
  filePath: string
}

type ChainStepSpec =
  | {
      agent: string
      task?: string
    }
  | {
      parallel: Array<{
        agent: string
        task?: string
      }>
    }

function parseAgentFile(filePath: string, source: AgentSummary["source"]): AgentSummary | null {
  try {
    const content = readFileSync(filePath, "utf-8")
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
    if (!fmMatch) return null

    const fm = fmMatch[1]
    const get = (key: string): string | undefined => {
      const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))
      return m?.[1]?.trim()
    }
    const getList = (key: string): string[] => {
      const v = get(key)
      return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []
    }

    const name = get("name")
    const model = get("model")
    if (!name || !model) return null

    return {
      name,
      description: get("description"),
      model,
      thinking: get("thinking"),
      tools: getList("tools"),
      skills: [...getList("skill"), ...getList("skills")],
      source,
      filePath,
    }
  } catch {
    return null
  }
}

function collectAncestors(startDir: string, maxDepth = 8): string[] {
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

/**
 * Resolve the joelclaw repo root for builtin agent discovery.
 * Priority: JOELCLAW_REPO env var → ancestor scan from cwd → well-known fallback.
 */
function resolveRepoRoot(cwd: string, homeDir: string): string | null {
  // 1. Explicit env override
  const envRepo = process.env.JOELCLAW_REPO?.trim()
  if (envRepo && existsSync(join(envRepo, "agents"))) return envRepo

  // 2. Ancestor traversal: find a directory containing both agents/ and pnpm-workspace.yaml
  for (const dir of collectAncestors(resolve(cwd))) {
    if (existsSync(join(dir, "agents")) && existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir
    }
  }

  // 3. Well-known fallback (matches inngest.ts convention)
  const fallback = join(homeDir, "Code", "joelhooks", "joelclaw")
  if (existsSync(join(fallback, "agents"))) return fallback

  return null
}

function discoverAgents(cwd: string): AgentSummary[] {
  const agents = new Map<string, AgentSummary>()
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "/Users/joel"
  const ancestors = collectAncestors(resolve(cwd))
  const repoRoot = resolveRepoRoot(cwd, homeDir)

  // Priority: project > user > builtin (last write wins in reverse order).
  const dirs: Array<{ dir: string; source: AgentSummary["source"] }> = []

  // Builtin: repo-root agents/ (canonical), then ancestor fallbacks
  if (repoRoot) {
    dirs.push({ dir: join(repoRoot, "agents"), source: "builtin" })
  }
  for (const d of ancestors.toReversed()) {
    const candidate = join(d, "agents")
    if (repoRoot && candidate === join(repoRoot, "agents")) continue // already added
    dirs.push({ dir: candidate, source: "builtin" })
  }

  // User: fixed absolute path
  dirs.push({ dir: join(homeDir, ".pi", "agent", "agents"), source: "user" })

  // Project: ancestor scan for .pi/agents/ (closest wins)
  for (const d of ancestors.toReversed()) {
    dirs.push({ dir: join(d, ".pi", "agents"), source: "project" })
  }

  for (const { dir, source } of dirs) {
    if (!existsSync(dir)) continue
    try {
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith(".md")) continue
        const parsed = parseAgentFile(join(dir, entry), source)
        if (parsed) agents.set(parsed.name, parsed)
      }
    } catch {
      // skip unreadable dirs
    }
  }

  return Array.from(agents.values()).sort((a, b) => a.name.localeCompare(b.name))
}

function parseChainStepsInput(raw: string): {
  steps: ChainStepSpec[]
  agents: string[]
  error?: string
} {
  const rawSegments = raw.split(",")
  if (rawSegments.some((segment) => segment.trim().length === 0)) {
    return {
      steps: [],
      agents: [],
      error: "Chain steps contain an empty segment",
    }
  }

  const segments = rawSegments.map((segment) => segment.trim())

  if (segments.length === 0) {
    return { steps: [], agents: [], error: "Chain steps cannot be empty" }
  }

  const steps: ChainStepSpec[] = []
  const agents: string[] = []

  for (const [segmentIndex, segment] of segments.entries()) {
    const parallelParts = segment
      .split("+")
      .map((part) => part.trim())

    if (parallelParts.some((part) => part.length === 0)) {
      return {
        steps: [],
        agents: [],
        error: `Invalid chain segment at position ${segmentIndex + 1}`,
      }
    }

    if (parallelParts.length === 1) {
      steps.push({ agent: parallelParts[0] })
      agents.push(parallelParts[0])
      continue
    }

    steps.push({
      parallel: parallelParts.map((agent) => ({ agent })),
    })
    agents.push(...parallelParts)
  }

  return { steps, agents }
}

// ── Next actions ──

const listNextActions: readonly NextAction[] = [
  { command: "joelclaw agent show <name>", description: "View full agent definition" },
  { command: "joelclaw agent run <name> <task>", description: "Run an agent task via Inngest" },
  {
    command: "joelclaw agent chain scout,planner+reviewer,coder --task <task>",
    description: "Run a sequential/parallel agent chain",
  },
]

const showNextActions = (name: string): readonly NextAction[] => [
  {
    command: `joelclaw agent run ${name} <task>`,
    description: `Run ${name} agent with a task`,
  },
  { command: "joelclaw agent list", description: "List all available agents" },
]

function extractInngestEventIds(result: unknown): string[] {
  if (!result || typeof result !== "object") return []
  const ids = (result as { ids?: unknown }).ids
  if (!Array.isArray(ids)) return []
  return ids
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter(Boolean)
}

const runNextActions = (eventIds: readonly string[]): readonly NextAction[] => {
  const actions: NextAction[] = [
    { command: "joelclaw runs --count 5", description: "Check run progress" },
  ]

  const eventId = eventIds.find((id) => id.trim().length > 0)
  if (eventId) {
    actions.push({
      command: "joelclaw event <event-id>",
      description: "Inspect emitted event and mapped function runs",
      params: {
        "event-id": {
          value: eventId,
          required: true,
          description: "Inngest event ID returned by the send API",
        },
      },
    })
  } else {
    actions.push({
      command: "joelclaw events --prefix agent/task. --hours 1 --count 20",
      description: "Find recent agent task events when event ID is unavailable",
    })
  }

  actions.push({ command: "joelclaw agent list", description: "List available agents" })
  return actions
}

const chainNextActions = (chainId: string): readonly NextAction[] => [
  { command: "joelclaw runs --count 5", description: "Check worker run progress" },
  { command: "joelclaw events --prefix agent/chain --hours 1", description: "Inspect chain events" },
  { command: "joelclaw agent list", description: "Inspect available roster agents" },
]

type AgentWatchKind = "task" | "chain"

type AgentWatchTarget = {
  id: string
  kind: AgentWatchKind
  timeoutSeconds: number
}

type GatewayQueueEvent = {
  id: string
  type: string
  source?: string
  payload: Record<string, unknown>
  ts?: number
}

type InngestEventRecord = {
  id: string
  name: string
  occurredAt: string
  data: Record<string, unknown>
}

type InngestRunState = {
  eventId: string
  eventName: string
  run?: {
    id: string
    status?: string
    functionName?: string
    output?: string
    startedAt?: string
    finishedAt?: string
  }
}

type TaskCompletionData = {
  taskId: string
  agent?: string
  status: "completed" | "failed"
  text?: string
  model?: string
  provider?: string
  durationMs?: number
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
  error?: string
}

type ChainCompletionData = {
  chainId: string
  status: "completed" | "completed_with_errors" | "failed"
  task?: string
  results?: Array<Record<string, unknown>>
  durationMs?: number
  error?: string
}

type AgentCompletion =
  | { kind: "task"; source: "inngest" | "gateway"; data: TaskCompletionData }
  | { kind: "chain"; source: "inngest" | "gateway"; data: ChainCompletionData }

type AgentProgress = {
  id: string
  agent?: string
  step?: string
  message?: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function readPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
  return readString(payload[key]) ?? readString(asRecord(payload.data)[key])
}

function detectWatchTarget(id: string, timeout: number | undefined): AgentWatchTarget | null {
  if (id.startsWith("at-")) {
    return { id, kind: "task", timeoutSeconds: timeout ?? 300 }
  }
  if (id.startsWith("ac-")) {
    return { id, kind: "chain", timeoutSeconds: timeout ?? 900 }
  }
  return null
}

function watchNextActions(target: AgentWatchTarget): readonly NextAction[] {
  const prefix = target.kind === "task" ? "agent/task" : "agent/chain"
  return [
    {
      command: `joelclaw agent watch ${target.id}`,
      description: "Resume streaming for this target",
    },
    {
      command: `joelclaw events --prefix ${prefix} --hours 1 --count 30`,
      description: "Inspect recent matching events",
    },
    { command: "joelclaw runs --count 10", description: "Inspect recent Inngest runs" },
  ]
}

function isTargetProgressTaskId(taskId: string, target: AgentWatchTarget): boolean {
  if (target.kind === "task") return taskId === target.id
  return taskId.startsWith(`chain-${target.id}-`)
}

function gatewayEventMatchesTarget(event: GatewayQueueEvent, target: AgentWatchTarget): boolean {
  const payload = asRecord(event.payload)
  const taskId = readPayloadString(payload, "taskId")
  const chainId = readPayloadString(payload, "chainId")

  if (target.kind === "task") {
    return taskId === target.id
  }

  if (chainId === target.id) return true
  if (taskId && isTargetProgressTaskId(taskId, target)) return true
  return false
}

function parseGatewayQueueEvent(raw: string): GatewayQueueEvent | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const id = readString(parsed.id)
    const type = readString(parsed.type)
    if (!id || !type) return null
    return {
      id,
      type,
      source: readString(parsed.source),
      payload: asRecord(parsed.payload),
      ts: readNumber(parsed.ts),
    }
  } catch {
    return null
  }
}

function eventFromInngest(raw: unknown): InngestEventRecord | null {
  const parsed = asRecord(raw)
  const id = readString(parsed.id)
  const name = readString(parsed.name)
  const occurredAt = readString(parsed.occurredAt)
  if (!id || !name || !occurredAt) return null
  return { id, name, occurredAt, data: asRecord(parsed.data) }
}

function completionFromInngestEvent(
  target: AgentWatchTarget,
  event: InngestEventRecord,
): AgentCompletion | null {
  if (target.kind === "task") {
    if (event.name !== "agent/task.complete") return null
    if (readString(event.data.taskId) !== target.id) return null

    const status = readString(event.data.status)
    if (status !== "completed" && status !== "failed") return null

    return {
      kind: "task",
      source: "inngest",
      data: {
        taskId: target.id,
        agent: readString(event.data.agent),
        status,
        text: readString(event.data.text),
        model: readString(event.data.model),
        provider: readString(event.data.provider),
        durationMs: readNumber(event.data.durationMs),
        usage: asRecord(event.data.usage) as TaskCompletionData["usage"],
        error: readString(event.data.error),
      },
    }
  }

  if (event.name !== "agent/chain.complete") return null
  if (readString(event.data.chainId) !== target.id) return null

  const status = readString(event.data.status)
  if (status !== "completed" && status !== "completed_with_errors" && status !== "failed") {
    return null
  }

  return {
    kind: "chain",
    source: "inngest",
    data: {
      chainId: target.id,
      status,
      task: readString(event.data.task),
      results: Array.isArray(event.data.results) ? (event.data.results as Array<Record<string, unknown>>) : [],
      durationMs: readNumber(event.data.durationMs),
      error: readString(event.data.error),
    },
  }
}

function completionFromGatewayEvent(
  target: AgentWatchTarget,
  event: GatewayQueueEvent,
): AgentCompletion | null {
  const payload = asRecord(event.payload)
  const type = event.type.toLowerCase()
  const status = readPayloadString(payload, "status")

  if (
    !type.includes("complete") &&
    !type.includes("failed") &&
    status !== "completed" &&
    status !== "completed_with_errors" &&
    status !== "failed"
  ) {
    return null
  }

  if (target.kind === "task") {
    if (readPayloadString(payload, "taskId") !== target.id) return null

    const taskStatus = status === "failed" ? "failed" : "completed"
    return {
      kind: "task",
      source: "gateway",
      data: {
        taskId: target.id,
        agent: readPayloadString(payload, "agent"),
        status: taskStatus,
        text: readPayloadString(payload, "text"),
        model: readPayloadString(payload, "model"),
        provider: readPayloadString(payload, "provider"),
        durationMs: readNumber(payload.durationMs),
        usage: asRecord(payload.usage) as TaskCompletionData["usage"],
        error: readPayloadString(payload, "error"),
      },
    }
  }

  if (readPayloadString(payload, "chainId") !== target.id) return null
  const chainStatus =
    status === "failed" || type.includes("failed")
      ? "failed"
      : status === "completed_with_errors"
        ? "completed_with_errors"
        : "completed"
  return {
    kind: "chain",
    source: "gateway",
    data: {
      chainId: target.id,
      status: chainStatus,
      task: readPayloadString(payload, "task"),
      results: Array.isArray(payload.results) ? (payload.results as Array<Record<string, unknown>>) : [],
      durationMs: readNumber(payload.durationMs),
      error: readPayloadString(payload, "error"),
    },
  }
}

function progressFromInngestEvent(
  target: AgentWatchTarget,
  event: InngestEventRecord,
): AgentProgress | null {
  if (event.name !== "agent/task.progress") return null
  const taskId = readString(event.data.taskId)
  if (!taskId) return null
  if (!isTargetProgressTaskId(taskId, target)) return null
  return {
    id: taskId,
    agent: readString(event.data.agent),
    step: readString(event.data.step),
    message: readString(event.data.message),
  }
}

function progressFromGatewayEvent(
  target: AgentWatchTarget,
  event: GatewayQueueEvent,
): AgentProgress | null {
  if (event.type !== "progress") return null
  if (!gatewayEventMatchesTarget(event, target)) return null

  const payload = asRecord(event.payload)
  const taskId = readPayloadString(payload, "taskId") ?? target.id
  return {
    id: taskId,
    agent: readPayloadString(payload, "agent"),
    step: readPayloadString(payload, "phase"),
    message: readPayloadString(payload, "message"),
  }
}

function parseRunOutput(output: string | undefined): unknown {
  if (!output) return undefined
  try {
    return JSON.parse(output)
  } catch {
    return output
  }
}

function mapRunState(raw: unknown): InngestRunState | null {
  const parsed = asRecord(raw)
  const event = asRecord(parsed.event)
  const eventId = readString(event.id)
  const eventName = readString(event.name)
  if (!eventId || !eventName) return null

  const runs = Array.isArray(parsed.runs) ? parsed.runs.map((entry) => asRecord(entry)) : []
  const run = runs[0]

  return {
    eventId,
    eventName,
    run: run
      ? {
          id: readString(run.id) ?? "",
          status: readString(run.status),
          functionName: readString(run.functionName),
          output: readString(run.output),
          startedAt: readString(run.startedAt),
          finishedAt: readString(run.finishedAt),
        }
      : undefined,
  }
}

// ── Subcommands ──

const listCmd = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const cwd = resolve(process.cwd())
    const agents = discoverAgents(cwd)

    if (agents.length === 0) {
      yield* Console.log(
        respondError(
          "agent list",
          "No agent definitions found",
          "NO_AGENTS",
          "Create .pi/agents/<name>.md with YAML frontmatter (name, model required)",
          listNextActions,
        ),
      )
      return
    }

    const summary = agents.map((a) => ({
      name: a.name,
      model: a.model,
      thinking: a.thinking ?? "off",
      description: a.description ?? "",
      tools: a.tools.length,
      skills: a.skills.length,
      source: a.source,
    }))

    yield* Console.log(
      respond("agent list", { agents: summary, total: agents.length }, listNextActions),
    )
  }),
)

const showName = Args.text({ name: "name" })

const showCmd = Command.make("show", { name: showName }, ({ name }) =>
  Effect.gen(function* () {
    const cwd = resolve(process.cwd())
    const agents = discoverAgents(cwd)
    const agent = agents.find((a) => a.name === name)

    if (!agent) {
      yield* Console.log(
        respondError(
          "agent show",
          `Agent "${name}" not found`,
          "AGENT_NOT_FOUND",
          `Run 'joelclaw agent list' to see available agents. Check .pi/agents/${name}.md exists.`,
          listNextActions,
        ),
      )
      return
    }

    // Read full file content for display
    let body = ""
    try {
      const content = readFileSync(agent.filePath, "utf-8")
      const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/)
      body = bodyMatch?.[1]?.trim() ?? ""
    } catch {
      // ignore read errors
    }

    yield* Console.log(
      respond(
        "agent show",
        { ...agent, systemPrompt: body },
        showNextActions(name),
      ),
    )
  }),
)

const runAgentName = Args.text({ name: "name" })
const runTask = Args.text({ name: "task" })
const runCwd = Options.text("cwd").pipe(Options.optional)
const runTimeout = Options.integer("timeout").pipe(Options.optional)

const runCmd = Command.make(
  "run",
  { name: runAgentName, task: runTask, cwd: runCwd, timeout: runTimeout },
  ({ name, task, cwd, timeout }) =>
    Effect.gen(function* () {
      const resolvedCwd = resolve(process.cwd())

      // Quick local validation before firing event
      const agents = discoverAgents(resolvedCwd)
      const agent = agents.find((a) => a.name === name)

      if (!agent) {
        yield* Console.log(
          respondError(
            "agent run",
            `Agent "${name}" not found in roster`,
            "AGENT_NOT_FOUND",
            `Run 'joelclaw agent list' to see available agents.`,
            listNextActions,
          ),
        )
        return
      }

      const taskId = `at-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const eventData: Record<string, unknown> = {
        taskId,
        agent: name,
        task,
      }
      if (cwd._tag === "Some") eventData.cwd = cwd.value
      if (timeout._tag === "Some") eventData.timeoutMs = timeout.value * 1000

      const inngest = yield* Inngest
      const result = yield* inngest.send("agent/task.run", eventData)
      const eventIds = extractInngestEventIds(result)

      yield* Console.log(
        respond(
          "agent run",
          {
            taskId,
            agent: name,
            model: agent.model,
            thinking: agent.thinking ?? "off",
            task,
            eventSent: true,
            eventIds,
            inngestResult: result,
          },
          [
            { command: `joelclaw agent watch ${taskId}`, description: "Stream live task progress" },
            ...runNextActions(eventIds),
          ],
        ),
      )
    }),
)

const chainStepsArg = Args.text({ name: "steps" })
const chainTaskOption = Options.text("task")
const chainCwdOption = Options.text("cwd").pipe(Options.optional)
const chainFailFastOption = Options.boolean("fail-fast").pipe(Options.withDefault(false))

const chainCmd = Command.make(
  "chain",
  {
    steps: chainStepsArg,
    task: chainTaskOption,
    cwd: chainCwdOption,
    failFast: chainFailFastOption,
  },
  ({ steps, task, cwd, failFast }) =>
    Effect.gen(function* () {
      const resolvedCwd = resolve(process.cwd())
      const parsed = parseChainStepsInput(steps)

      if (parsed.error) {
        yield* Console.log(
          respondError(
            "agent chain",
            parsed.error,
            "INVALID_CHAIN_STEPS",
            "Use comma-separated agents and + for parallel groups, e.g. scout,planner+reviewer,coder",
            listNextActions,
          ),
        )
        return
      }

      const agents = discoverAgents(resolvedCwd)
      const knownAgents = new Set(agents.map((agent) => agent.name))
      const missing = parsed.agents.filter((agent) => !knownAgents.has(agent))

      if (missing.length > 0) {
        yield* Console.log(
          respondError(
            "agent chain",
            `Unknown agent(s): ${missing.join(", ")}`,
            "AGENT_NOT_FOUND",
            "Run 'joelclaw agent list' and update the chain steps to known roster entries.",
            listNextActions,
          ),
        )
        return
      }

      const chainId = `ac-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const eventData: Record<string, unknown> = {
        chainId,
        task,
        steps: parsed.steps,
        failFast,
      }
      if (cwd._tag === "Some") eventData.cwd = cwd.value

      const inngest = yield* Inngest
      const result = yield* inngest.send("agent/chain.run", eventData)

      yield* Console.log(
        respond(
          "agent chain",
          {
            chainId,
            task,
            steps: parsed.steps,
            failFast,
            eventSent: true,
            inngestResult: result,
          },
          [
            { command: `joelclaw agent watch ${chainId}`, description: "Stream live chain progress" },
            ...chainNextActions(chainId),
          ],
        ),
      )
    }),
)

const watchIdArg = Args.text({ name: "id" }).pipe(
  Args.withDescription("Task ID (at-...) or chain ID (ac-...)"),
)
const watchTimeoutOption = Options.integer("timeout").pipe(
  Options.withAlias("t"),
  Options.optional,
  Options.withDescription("Stop after N seconds (task default: 300, chain default: 900)"),
)

const watchCmd = Command.make(
  "watch",
  { id: watchIdArg, timeout: watchTimeoutOption },
  ({ id, timeout }) =>
    Effect.gen(function* () {
      const timeoutValue = timeout._tag === "Some" ? timeout.value : undefined
      const target = detectWatchTarget(id, timeoutValue)

      if (!target) {
        emitError(
          "joelclaw agent watch",
          `Invalid watch target "${id}"`,
          "INVALID_WATCH_ID",
          "Use a task ID (at-...) or chain ID (ac-...).",
          [
            { command: "joelclaw agent list", description: "List available agents" },
            { command: "joelclaw events --prefix agent/ --hours 1 --count 20", description: "Find recent agent IDs" },
          ],
        )
        return
      }

      const cmd = `joelclaw agent watch ${target.id}`
      const timeoutMs = Math.max(1, target.timeoutSeconds) * 1000
      const pollIntervalMs = 2500
      const startTime = Date.now()
      const nextActions = watchNextActions(target)
      const seenGatewayEventIds = new Set<string>()
      const seenInngestProgressIds = new Set<string>()
      const startedSteps = new Set<string>()
      let terminalEmitted = false
      let redisDegraded = false
      let completionFromGateway: AgentCompletion | null = null

      const inngest = yield* Inngest
      emitStart(cmd)
      emitLog(
        "info",
        `Watching ${target.kind} ${target.id} for up to ${target.timeoutSeconds}s`,
      )

      const emitProgressUpdate = (progress: AgentProgress) => {
        const step = readString(progress.step)
        const message = readString(progress.message)
        const agent = readString(progress.agent) ?? "agent"
        const stepName = step ? `${agent}:${step}` : target.id

        if (step) {
          const normalizedStep = step.toLowerCase()
          if (normalizedStep.includes("fail")) {
            emitStep(stepName, "failed", { error: message ?? "Step failed" })
          } else if (normalizedStep === "complete" || normalizedStep === "completed") {
            emitStep(stepName, "completed")
          } else if (!startedSteps.has(stepName)) {
            startedSteps.add(stepName)
            emitStep(stepName, "started")
          }
        }

        emitProgress(target.id, { message: message ?? `${agent} progress update` })
      }

      const emitCompletionTerminal = (completion: AgentCompletion) => {
        if (terminalEmitted) return
        terminalEmitted = true

        if (completion.kind === "task") {
          if (completion.data.status === "failed") {
            emitError(
              cmd,
              `Task ${target.id} failed: ${completion.data.error ?? "unknown error"}`,
              "AGENT_TASK_FAILED",
              "Inspect run details and logs to identify the failure source.",
              nextActions,
            )
            return
          }

          emitStep(`${completion.data.agent ?? "agent"}:execute`, "completed", {
            duration_ms: completion.data.durationMs,
          })
          emitResult(
            cmd,
            {
              target: target.id,
              kind: target.kind,
              source: completion.source,
              completion: completion.data,
            },
            nextActions,
          )
          return
        }

        if (completion.data.status === "failed") {
          emitError(
            cmd,
            `Chain ${target.id} failed: ${completion.data.error ?? "unknown error"}`,
            "AGENT_CHAIN_FAILED",
            "Inspect chain results and worker logs for failing step details.",
            nextActions,
          )
          return
        }

        emitResult(
          cmd,
          {
            target: target.id,
            kind: target.kind,
            source: completion.source,
            completion: completion.data,
          },
          nextActions,
        )
      }

      const emitRunStateTerminal = (runState: InngestRunState) => {
        if (terminalEmitted) return
        terminalEmitted = true

        const status = runState.run?.status
        if (status === "FAILED" || status === "CANCELLED") {
          emitError(
            cmd,
            `${target.kind} ${target.id} ${status.toLowerCase()}`,
            "AGENT_RUN_FAILED",
            "Inspect the associated run to identify the failing step or cancellation reason.",
            nextActions,
          )
          return
        }

        emitResult(
          cmd,
          {
            target: target.id,
            kind: target.kind,
            source: "inngest-run",
            run: {
              ...runState.run,
              output: parseRunOutput(runState.run?.output),
            },
            eventId: runState.eventId,
          },
          nextActions,
        )
      }

      const fetchCompletionFromInngest = () =>
        Effect.tryPromise({
          try: async (): Promise<AgentCompletion | null> => {
            const prefix = target.kind === "task" ? "agent/task.complete" : "agent/chain.complete"
            const rawEvents = (await inngest.events({
              prefix,
              hours: 24,
              count: 200,
            })) as unknown[]
            const parsed = rawEvents
              .map(eventFromInngest)
              .filter((event): event is InngestEventRecord => event !== null)
              .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
            for (const event of parsed) {
              const completion = completionFromInngestEvent(target, event)
              if (completion) return completion
            }
            return null
          },
          catch: (error) => new Error(`Inngest completion query failed: ${error}`),
        })

      const fetchProgressFromInngest = () =>
        Effect.tryPromise({
          try: async (): Promise<InngestEventRecord[]> => {
            const rawEvents = (await inngest.events({
              prefix: "agent/task.progress",
              hours: 24,
              count: 250,
            })) as unknown[]
            return rawEvents
              .map(eventFromInngest)
              .filter((event): event is InngestEventRecord => event !== null)
              .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
          },
          catch: (error) => new Error(`Inngest progress query failed: ${error}`),
        })

      const fetchRunStateFromInngest = () =>
        Effect.tryPromise({
          try: async (): Promise<InngestRunState | null> => {
            const runPrefix = target.kind === "task" ? "agent/task.run" : "agent/chain.run"
            const runEvents = (await inngest.events({
              prefix: runPrefix,
              hours: 24,
              count: 200,
            })) as unknown[]
            const parsed = runEvents
              .map(eventFromInngest)
              .filter((event): event is InngestEventRecord => event !== null)
              .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))

            const matchedEvent = parsed.find((event) => {
              if (target.kind === "task") {
                return readString(event.data.taskId) === target.id
              }
              return readString(event.data.chainId) === target.id
            })

            if (!matchedEvent) return null
            const eventState = await inngest.event(matchedEvent.id)
            return mapRunState(eventState)
          },
          catch: (error) => new Error(`Inngest run query failed: ${error}`),
        })

      // Degradation case:
      // If the task/chain finished before watch started, return immediately from Inngest state.
      const startupCompletion = yield* fetchCompletionFromInngest().pipe(Effect.either)
      if (startupCompletion._tag === "Right" && startupCompletion.right) {
        emitCompletionTerminal(startupCompletion.right)
        return
      }

      const startupRunState = yield* fetchRunStateFromInngest().pipe(Effect.either)
      if (startupRunState._tag === "Right") {
        const runStatus = startupRunState.right?.run?.status
        if (runStatus === "COMPLETED" || runStatus === "FAILED" || runStatus === "CANCELLED") {
          emitRunStateTerminal(startupRunState.right)
          return
        }
      }

      const RedisModule = yield* Effect.tryPromise({
        try: () => import("ioredis"),
        catch: (error) => new Error(`ioredis: ${error}`),
      }).pipe(Effect.either)

      type RedisConnection = {
        connect: () => Promise<void>
        disconnect: () => void
        subscribe: (channel: string) => Promise<unknown>
        on: (event: "message", listener: (channel: string, message: string) => void) => void
        off: (event: "message", listener: (channel: string, message: string) => void) => void
        lrange: (key: string, start: number, stop: number) => Promise<string[]>
      }

      let sub: RedisConnection | null = null
      let redis: RedisConnection | null = null
      let redisMessageHandler: ((channel: string, message: string) => void) | null = null

      const cleanupRedis = () => {
        if (sub && redisMessageHandler) {
          sub.off("message", redisMessageHandler)
        }
        sub?.disconnect()
        redis?.disconnect()
      }

      const fetchGatewayEventById = (eventId: string) =>
        Effect.tryPromise({
          try: async (): Promise<GatewayQueueEvent | null> => {
            if (!redis) return null
            const rawEvents = await redis.lrange("joelclaw:events:gateway", 0, 250)
            for (const rawEvent of rawEvents) {
              const event = parseGatewayQueueEvent(rawEvent)
              if (event?.id === eventId) return event
            }
            return null
          },
          catch: (error) => new Error(`Gateway event fetch failed: ${error}`),
        })

      const handleGatewayEvent = (event: GatewayQueueEvent) => {
        if (seenGatewayEventIds.has(event.id)) return
        seenGatewayEventIds.add(event.id)
        if (!gatewayEventMatchesTarget(event, target)) return

        const completion = completionFromGatewayEvent(target, event)
        if (completion) {
          completionFromGateway = completion
          return
        }

        const progress = progressFromGatewayEvent(target, event)
        if (progress) emitProgressUpdate(progress)
      }

      const pollGatewayBacklog = () =>
        Effect.tryPromise({
          try: async () => {
            if (!redis) return
            const backlog = await redis.lrange("joelclaw:events:gateway", 0, 250)
            for (const rawEvent of backlog.reverse()) {
              const event = parseGatewayQueueEvent(rawEvent)
              if (event) handleGatewayEvent(event)
            }
          },
          catch: (error) => new Error(`Gateway backlog poll failed: ${error}`),
        })

      if (RedisModule._tag === "Right") {
        const Redis = RedisModule.right.default as new (opts: Record<string, unknown>) => RedisConnection

        sub = new Redis({
          host: process.env.REDIS_HOST ?? "localhost",
          port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
          lazyConnect: true,
          connectTimeout: 3000,
          retryStrategy: (times: number) => (times > 3 ? null : Math.min(times * 500, 5000)),
        })

        redis = new Redis({
          host: process.env.REDIS_HOST ?? "localhost",
          port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
          lazyConnect: true,
          connectTimeout: 3000,
          commandTimeout: 5000,
        })

        const redisConnect = yield* Effect.tryPromise({
          try: async () => {
            await redis?.connect()
            await sub?.connect()
            await sub?.subscribe("joelclaw:notify:gateway")
          },
          catch: (error) => new Error(`Redis connect failed: ${error}`),
        }).pipe(Effect.either)

        if (redisConnect._tag === "Right") {
          redisMessageHandler = (_channel: string, message: string) => {
            if (terminalEmitted) return
            let eventId: string | undefined
            try {
              const parsed = JSON.parse(message) as Record<string, unknown>
              eventId = readString(parsed.eventId)
            } catch {
              return
            }
            if (!eventId || seenGatewayEventIds.has(eventId)) return
            void Effect.runPromise(
              fetchGatewayEventById(eventId).pipe(
                Effect.tap((event) =>
                  Effect.sync(() => {
                    if (event) handleGatewayEvent(event)
                  }),
                ),
                Effect.catchAll(() => Effect.void),
              ),
            )
          }
          sub.on("message", redisMessageHandler)

          const preload = yield* pollGatewayBacklog().pipe(Effect.either)
          if (preload._tag === "Left") {
            emitLog("warn", "Gateway backlog preload failed; continuing with live notifications.")
          }
        } else {
          cleanupRedis()
          sub = null
          redis = null
          redisDegraded = true
          // Degradation case:
          // When Redis is unavailable, continue with Inngest polling only.
          emitLog("warn", "Redis unavailable — using Inngest polling fallback.")
        }
      } else {
        redisDegraded = true
        // Degradation case:
        // When Redis module fails to load, stream still works via Inngest completion polling.
        emitLog("warn", "Redis unavailable — using Inngest polling fallback.")
      }

      const onSignal = () => {
        if (terminalEmitted) return
        terminalEmitted = true
        cleanupRedis()
        process.off("SIGINT", onSignal)
        process.off("SIGTERM", onSignal)
        emitResult(
          cmd,
          {
            target: target.id,
            kind: target.kind,
            reason: "interrupted",
            elapsedMs: Date.now() - startTime,
            redisDegraded,
          },
          nextActions,
        )
        process.exit(0)
      }

      process.on("SIGINT", onSignal)
      process.on("SIGTERM", onSignal)

      while (!terminalEmitted) {
        if (Date.now() - startTime > timeoutMs) {
          terminalEmitted = true
          cleanupRedis()
          process.off("SIGINT", onSignal)
          process.off("SIGTERM", onSignal)
          emitError(
            cmd,
            `Timeout waiting for ${target.kind} ${target.id} completion`,
            "WATCH_TIMEOUT",
            "Increase --timeout or inspect current state via events/runs commands.",
            nextActions,
          )
          return
        }

        if (completionFromGateway) {
          cleanupRedis()
          process.off("SIGINT", onSignal)
          process.off("SIGTERM", onSignal)
          emitCompletionTerminal(completionFromGateway)
          return
        }

        if (redis) {
          const backlogPoll = yield* pollGatewayBacklog().pipe(Effect.either)
          if (backlogPoll._tag === "Left") {
            emitLog("warn", "Redis backlog poll failed; continuing with Inngest fallback.")
            cleanupRedis()
            sub = null
            redis = null
            redisDegraded = true
          }
        }

        const progressPoll = yield* fetchProgressFromInngest().pipe(Effect.either)
        if (progressPoll._tag === "Right") {
          for (const event of progressPoll.right) {
            if (seenInngestProgressIds.has(event.id)) continue
            seenInngestProgressIds.add(event.id)
            const progress = progressFromInngestEvent(target, event)
            if (progress) emitProgressUpdate(progress)
          }
        }

        const completionPoll = yield* fetchCompletionFromInngest().pipe(Effect.either)
        if (completionPoll._tag === "Right" && completionPoll.right) {
          cleanupRedis()
          process.off("SIGINT", onSignal)
          process.off("SIGTERM", onSignal)
          emitCompletionTerminal(completionPoll.right)
          return
        }

        const runStatePoll = yield* fetchRunStateFromInngest().pipe(Effect.either)
        if (runStatePoll._tag === "Right") {
          const status = runStatePoll.right?.run?.status
          if (status === "COMPLETED" || status === "FAILED" || status === "CANCELLED") {
            cleanupRedis()
            process.off("SIGINT", onSignal)
            process.off("SIGTERM", onSignal)
            emitRunStateTerminal(runStatePoll.right)
            return
          }
        }

        // Degradation case:
        // If only completion events are available, this loop emits start → wait → terminal result.
        yield* Effect.tryPromise({
          try: () => new Promise((resolve) => setTimeout(resolve, pollIntervalMs)),
          catch: () => new Error("watch sleep interrupted"),
        })
      }
    }),
)

// ── Parent command ──

export const agentCmd = Command.make("agent", {}, () =>
  Effect.gen(function* () {
    // Default: same as list
    const cwd = resolve(process.cwd())
    const agents = discoverAgents(cwd)

    const summary = agents.map((a) => ({
      name: a.name,
      model: a.model,
      description: a.description ?? "",
      source: a.source,
    }))

    yield* Console.log(
      respond(
        "agent",
        { agents: summary, total: agents.length, hint: "Use 'joelclaw agent list|show|run|chain|watch'" },
        listNextActions,
      ),
    )
  }),
).pipe(Command.withSubcommands([listCmd, showCmd, runCmd, chainCmd, watchCmd]))

export const __agentTestUtils = {
  parseChainStepsInput,
  listNextActions,
  showNextActions,
  runNextActions,
  chainNextActions,
  extractInngestEventIds,
  discoverAgents,
  resolveRepoRoot,
}
