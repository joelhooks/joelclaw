/**
 * ADR-0180: Agent roster commands.
 *
 * `joelclaw agent list`              — discover agents from project + user scopes
 * `joelclaw agent show <name>`       — display full agent definition
 * `joelclaw agent run <name> <task>` — fire agent/task.run event via Inngest
 * `joelclaw agent chain <steps> --task <task>` — fire agent/chain.run event
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import { type NextAction, respond, respondError } from "../response"

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

function discoverAgents(cwd: string): AgentSummary[] {
  const agents = new Map<string, AgentSummary>()
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "/Users/joel"

  // Priority: project > user > builtin (last write wins in reverse order)
  const dirs: Array<{ dir: string; source: AgentSummary["source"] }> = [
    { dir: join(cwd, "agents"), source: "builtin" },
    { dir: join(homeDir, ".pi", "agent", "agents"), source: "user" },
    { dir: join(cwd, ".pi", "agents"), source: "project" },
  ]

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
          runNextActions(eventIds),
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
          chainNextActions(chainId),
        ),
      )
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
        { agents: summary, total: agents.length, hint: "Use 'joelclaw agent list|show|run|chain'" },
        listNextActions,
      ),
    )
  }),
).pipe(Command.withSubcommands([listCmd, showCmd, runCmd, chainCmd]))

export const __agentTestUtils = {
  parseChainStepsInput,
  listNextActions,
  showNextActions,
  runNextActions,
  chainNextActions,
  extractInngestEventIds,
}
