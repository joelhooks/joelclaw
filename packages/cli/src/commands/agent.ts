/**
 * ADR-0180: Agent roster commands.
 *
 * `joelclaw agent list`              — discover agents from project + user scopes
 * `joelclaw agent show <name>`       — display full agent definition
 * `joelclaw agent run <name> <task>` — fire agent/task.run event via Inngest
 */

import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
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

// ── Next actions ──

const listNextActions: readonly NextAction[] = [
  { command: "joelclaw agent show <name>", description: "View full agent definition" },
  { command: "joelclaw agent run <name> <task>", description: "Run an agent task via Inngest" },
]

const showNextActions = (name: string): readonly NextAction[] => [
  {
    command: `joelclaw agent run ${name} <task>`,
    description: `Run ${name} agent with a task`,
  },
  { command: "joelclaw agent list", description: "List all available agents" },
]

const runNextActions = (taskId: string): readonly NextAction[] => [
  { command: "joelclaw runs --count 5", description: "Check run progress" },
  {
    command: `joelclaw run ${taskId}`,
    description: "View run details",
    params: { "run-id": { value: taskId, description: "Inngest run ID (once available)" } },
  },
  { command: "joelclaw agent list", description: "List available agents" },
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
            inngestResult: result,
          },
          runNextActions(taskId),
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
        { agents: summary, total: agents.length, hint: "Use 'joelclaw agent list|show|run'" },
        listNextActions,
      ),
    )
  }),
).pipe(Command.withSubcommands([listCmd, showCmd, runCmd]))
