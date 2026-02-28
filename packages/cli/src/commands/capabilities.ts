import { Command } from "@effect/cli"
import { Console, Effect } from "effect"
import { resolveCapabilitiesConfig } from "../capabilities/config"
import { capabilityRegistry } from "../capabilities/setup"
import { respond } from "../response"

type CapabilityParam = {
  readonly description?: string
  readonly value?: string | number
  readonly default?: string | number
  readonly enum?: readonly string[]
  readonly required?: boolean
}

type CapabilityCommand = {
  readonly command: string
  readonly description: string
  readonly params?: Record<string, CapabilityParam>
}

type CapabilityFlow = {
  readonly id: string
  readonly category: "operations" | "diagnostics" | "memory" | "gateway" | "automation"
  readonly goal: string
  readonly prerequisites: readonly string[]
  readonly commands: readonly CapabilityCommand[]
  readonly verification: readonly string[]
}

export const CAPABILITY_FLOWS: readonly CapabilityFlow[] = [
  {
    id: "system-health",
    category: "operations",
    goal: "Answer: is joelclaw healthy right now?",
    prerequisites: ["joelclaw CLI available in PATH"],
    commands: [
      { command: "status", description: "Health check all core components" },
      { command: "secrets status", description: "Verify secrets backend availability for capability adapters" },
      { command: "functions", description: "List registered Inngest functions" },
      {
        command: "runs [--count <count>] [--hours <hours>]",
        description: "Inspect most recent execution outcomes",
        params: {
          count: { description: "Number of runs", value: 10, default: 10 },
          hours: { description: "Lookback window in hours", value: 24, default: 24 },
        },
      },
    ],
    verification: [
      "status.ok=true",
      "secrets backend reachable",
      "functions.count > 0",
      "recent failed runs are understood or recoverable",
    ],
  },
  {
    id: "operator-signals",
    category: "operations",
    goal: "Lease credentials, write structured logs, and notify gateway in one deterministic flow.",
    prerequisites: ["Capability adapters configured (secrets, log, notify)"],
    commands: [
      { command: "secrets status", description: "Confirm secrets backend daemon is healthy" },
      {
        command: "secrets lease <name> --ttl <ttl>",
        description: "Lease short-lived credential",
        params: {
          name: { description: "Secret name", required: true },
          ttl: { description: "Lease duration", value: "15m", default: "15m" },
        },
      },
      {
        command: "log write --action <action> --tool <tool> --detail <detail> [--reason <reason>]",
        description: "Record the operational mutation in canonical slog",
        params: {
          action: { description: "Mutation verb", required: true, value: "configure" },
          tool: { description: "Component name", required: true, value: "cli" },
          detail: { description: "What changed", required: true, value: "updated capability adapter config" },
          reason: { description: "Why the change was made", value: "phase-1 capability rollout" },
        },
      },
      {
        command: "notify send <message> [--priority <priority>] [--channel <channel>] [--context <json>]",
        description: "Send canonical gateway notification to operator session",
        params: {
          message: { description: "Notification text", required: true },
          priority: { description: "Escalation level", value: "normal", enum: ["low", "normal", "high", "urgent"] },
          channel: { description: "Gateway channel route", value: "gateway", enum: ["gateway", "main", "all"] },
          json: { description: "JSON context payload", value: "{\"scope\":\"capability\"}" },
        },
      },
    ],
    verification: [
      "Lease response includes credential value",
      "Log write acknowledged by slog backend",
      "Notify event appears in gateway queue/stream",
    ],
  },
  {
    id: "run-failure-triage",
    category: "diagnostics",
    goal: "Diagnose a failed function run and identify the next repair step.",
    prerequisites: ["Run ID or recent failed runs available"],
    commands: [
      {
        command: "runs [--status <status>] [--count <count>] [--hours <hours>]",
        description: "Find failed or running runs",
        params: {
          status: {
            description: "Run status filter",
            value: "FAILED",
            enum: ["COMPLETED", "FAILED", "RUNNING", "QUEUED", "CANCELLED"],
          },
          count: { description: "Number of runs", value: 20, default: 10 },
          hours: { description: "Lookback window", value: 24, default: 24 },
        },
      },
      {
        command: "run <run-id>",
        description: "Inspect one run with trace + output",
        params: {
          "run-id": { description: "Inngest run ID", required: true },
        },
      },
      {
        command: "logs <source> [--lines <lines>] [--grep <text>]",
        description: "Inspect worker/server/errors logs",
        params: {
          source: { description: "Log source", value: "errors", enum: ["worker", "errors", "server"] },
          lines: { description: "Number of lines", value: 120, default: 30 },
          text: { description: "Optional grep filter", value: "ERROR" },
        },
      },
    ],
    verification: [
      "Root cause mapped to code path or infra dependency",
      "Actionable next command exists in next_actions",
    ],
  },
  {
    id: "deterministic-recovery",
    category: "diagnostics",
    goal: "Apply dry-run-first deterministic runbooks for known failure codes.",
    prerequisites: ["Known error code from previous command response"],
    commands: [
      { command: "recover list", description: "List available recovery runbooks" },
      {
        command: "recover <error-code> [--phase <phase>] [--context <context>]",
        description: "Preview runbook steps (dry-run)",
        params: {
          "error-code": { description: "Runbook error code", required: true },
          phase: { description: "Phase to preview", value: "fix", enum: ["diagnose", "fix", "verify", "rollback", "all"] },
          context: { description: "JSON context for placeholders", value: "{}", default: "{}" },
        },
      },
      {
        command: "recover <error-code> --phase <phase> --execute [--context <context>]",
        description: "Execute selected runbook phase",
        params: {
          "error-code": { description: "Runbook error code", required: true },
          phase: { description: "Phase to execute", value: "fix", enum: ["diagnose", "fix", "verify", "rollback", "all"] },
          context: { description: "JSON context for placeholders", value: "{}", default: "{}" },
        },
      },
    ],
    verification: [
      "Dry-run preview inspected before execute",
      "Verify phase run after fix phase",
    ],
  },
  {
    id: "event-delivery",
    category: "operations",
    goal: "Send an event and verify it reached function runs.",
    prerequisites: ["Valid event name", "Worker registered"],
    commands: [
      {
        command: "send <event> [--data <data>]",
        description: "Emit event to Inngest",
        params: {
          event: { description: "Event name", required: true },
          data: { description: "JSON payload", default: "{}", value: "{}" },
        },
      },
      {
        command: "event <event-id>",
        description: "Map event to triggered runs",
        params: {
          "event-id": { description: "Event ULID from send response", required: true },
        },
      },
      { command: "runs [--count <count>]", description: "Inspect latest runs after send", params: { count: { value: 10, default: 10 } } },
    ],
    verification: [
      "event.accepted=true",
      "event maps to at least one run or expected no-op",
    ],
  },
  {
    id: "gateway-operations",
    category: "gateway",
    goal: "Operate the always-on gateway session reliably.",
    prerequisites: ["Gateway service configured"],
    commands: [
      { command: "gateway status", description: "Check gateway daemon health" },
      { command: "gateway events", description: "Peek queued events by session" },
      { command: "gateway test", description: "Send a synthetic gateway test event" },
      { command: "gateway restart", description: "Restart gateway if degraded" },
      {
        command: "gateway stream [--timeout <timeout>]",
        description: "Observe gateway event stream in real-time",
        params: { timeout: { description: "Seconds to stream", value: 30, default: 30 } },
      },
    ],
    verification: [
      "gateway status reports healthy session",
      "event queue depth behaves as expected",
    ],
  },
  {
    id: "memory-health",
    category: "memory",
    goal: "Verify memory pipeline quality, freshness, and retrieval behavior.",
    prerequisites: ["Typesense available", "Inngest memory functions registered"],
    commands: [
      { command: "inngest memory-gate --json", description: "Run memory end-to-end gate" },
      {
        command: "inngest memory-health [--hours <hours>] [--stall-minutes <minutes>] --json",
        description: "Inspect memory health checks and otel evidence",
        params: {
          hours: { description: "Lookback window", value: 24, default: 24 },
          minutes: { description: "Stall threshold", value: 30, default: 30 },
        },
      },
      {
        command: "recall <query> [--limit <limit>]",
        description: "Probe memory retrieval quality",
        params: {
          query: { description: "Recall query", required: true },
          limit: { description: "Result count", value: 5, default: 5 },
        },
      },
    ],
    verification: [
      "memory-gate ok=true",
      "recall returns relevant hits with no silent failure",
    ],
  },
  {
    id: "otel-observability",
    category: "diagnostics",
    goal: "Inspect observability signals without pod-log spelunking.",
    prerequisites: ["otel_events collection reachable"],
    commands: [
      {
        command: "otel stats [--hours <hours>]",
        description: "Get aggregate error-rate and volume",
        params: { hours: { description: "Lookback hours", value: 24, default: 24 } },
      },
      {
        command: "langfuse aggregate [--hours <hours>] [--project <project>]",
        description: "Aggregate cloud LLM trace cost/latency/signature trends",
        params: {
          hours: { description: "Lookback hours", value: 24, default: 24 },
          project: { description: "Optional Langfuse project ID" },
        },
      },
      {
        command: "otel search <query> [--hours <hours>]",
        description: "Search event stream for issue signatures",
        params: {
          query: { description: "Full-text query", required: true },
          hours: { description: "Lookback hours", value: 24, default: 24 },
        },
      },
      {
        command: "otel list [--component <component>] [--hours <hours>]",
        description: "List recent events with filters",
        params: {
          component: { description: "Optional component filter", value: "observe" },
          hours: { description: "Lookback hours", value: 24, default: 24 },
        },
      },
    ],
    verification: [
      "Incident diagnosis possible via otel list/search/stats",
      "No silent failures for changed code path",
    ],
  },
  {
    id: "loop-lifecycle",
    category: "automation",
    goal: "Start, observe, and manage autonomous coding loops safely.",
    prerequisites: ["Project path", "Goal or PRD"],
    commands: [
      {
        command: "loop start --project <project> --goal <goal> [--context <context>] [--max-retries <max-retries>]",
        description: "Start a durable loop from a goal",
        params: {
          project: { description: "Target repo path", required: true },
          goal: { description: "Single concrete outcome", required: true },
          context: { description: "Optional ADR or context path" },
          "max-retries": { description: "Retries per story", value: 2, default: 2 },
        },
      },
      {
        command: "loop status [<loop-id>]",
        description: "Inspect loop progress",
        params: {
          "loop-id": { description: "Loop ID (optional if only one active)" },
        },
      },
      {
        command: "watch [<loop-id>] [--interval <interval>]",
        description: "Follow loop changes until completion",
        params: {
          "loop-id": { description: "Loop ID (optional)" },
          interval: { description: "Polling interval seconds", value: 15, default: 15 },
        },
      },
    ],
    verification: [
      "Loop status transitions are visible",
      "Completion/failure is diagnosable via run + logs",
    ],
  },
  {
    id: "search-and-vault",
    category: "memory",
    goal: "Find canonical context fast across vault + memory + system log.",
    prerequisites: ["Typesense search available"],
    commands: [
      {
        command: "search <query> [--collection <collection>] [--limit <limit>] [--semantic]",
        description: "Cross-collection search",
        params: {
          query: { description: "Search query", required: true },
          collection: {
            description: "Optional collection filter",
            enum: ["vault_notes", "memory_observations", "blog_posts", "system_log", "discoveries", "transcripts", "voice_transcripts"],
          },
          limit: { description: "Results per collection", value: 5, default: 5 },
        },
      },
      {
        command: "vault read <path>",
        description: "Read a specific vault note",
        params: { path: { description: "Vault-relative path", required: true } },
      },
      {
        command: "vault search <query> [--limit <limit>]",
        description: "Vault-only fuzzy search",
        params: {
          query: { description: "Search query", required: true },
          limit: { description: "Result count", value: 10, default: 10 },
        },
      },
      {
        command: "vault adr audit",
        description: "Audit ADR inventory, collisions, and README index alignment",
      },
      {
        command: "skills audit [--deep]",
        description: "Run on-demand skill garden checks (ADR-0179)",
      },
    ],
    verification: [
      "Relevant context found in <= 2 command hops",
      "Search errors are structured and actionable",
    ],
  },
]

export function buildCapabilitiesCatalog() {
  const config = resolveCapabilitiesConfig()
  const registry = capabilityRegistry.list()
  const configuredCapabilities = Object.entries(config.capabilities)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, capability]) => ({
      capability: name,
      enabled: capability.enabled,
      adapter: capability.adapter,
      sources: capability.source,
      availableAdapters: registry
        .filter((entry) => entry.capability === name)
        .map((entry) => entry.adapter),
    }))

  const categories = Array.from(
    CAPABILITY_FLOWS.reduce<Map<string, number>>((acc, flow) => {
      acc.set(flow.category, (acc.get(flow.category) ?? 0) + 1)
      return acc
    }, new Map())
  )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, count]) => ({ category, flowCount: count }))

  return {
    description: "Agent navigation map: goals -> command templates -> verification",
    flowCount: CAPABILITY_FLOWS.length,
    capabilityContract: {
      configuredCount: configuredCapabilities.length,
      registryEntries: registry.length,
      configPaths: config.paths,
      configuredCapabilities,
      adapters: registry,
    },
    categories,
    flows: CAPABILITY_FLOWS,
  }
}

export const capabilitiesCmd = Command.make(
  "capabilities",
  {},
  () =>
    Effect.gen(function* () {
      yield* Console.log(
        respond(
          "capabilities",
          buildCapabilitiesCatalog(),
          [
            { command: "status", description: "Start with full system health" },
            {
              command: "runs [--status <status>] [--count <count>]",
              description: "Jump to recent failures or completions",
              params: {
                status: {
                  description: "Run status filter",
                  value: "FAILED",
                  enum: ["COMPLETED", "FAILED", "RUNNING", "QUEUED", "CANCELLED"],
                },
                count: { description: "Number of runs", value: 20, default: 10 },
              },
            },
            {
              command: "otel stats [--hours <hours>]",
              description: "Quick observability pulse",
              params: {
                hours: { description: "Lookback window in hours", value: 24, default: 24 },
              },
            },
            { command: "secrets status", description: "Check capability backend readiness for secrets/log/notify flows" },
            {
              command: "notify send <message> [--priority <priority>]",
              description: "Send canonical gateway notification",
              params: {
                message: { description: "Notification text", required: true },
                priority: { description: "Priority", value: "normal", enum: ["low", "normal", "high", "urgent"] },
              },
            },
          ]
        )
      )
    })
)
