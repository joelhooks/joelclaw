import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import { respond } from "../response"

type AgentDispatchCanaryProbe = {
  requestId: string
  workflowId: string
  baseSha: string
  terminal: {
    status: "running" | "completed" | "failed" | "cancelled"
    error?: string
    result?: string
    sandboxId?: string
    sandboxPath?: string
    cleanupAfter?: string
    logs?: {
      stdout?: string
      stderr?: string
    }
  }
  registry: {
    state: "running" | "completed" | "failed" | "cancelled"
    sandboxId: string
    updatedAt: string
    cleanupAfter?: string
  } | null
  stillRunning: { requestId?: string; sandboxId?: string; state?: string } | null
}

type AgentDispatchCanaryStatus = {
  enabled: boolean
  ok: boolean
  summary: string
  durationMs?: number
  scriptPath?: string
  requestId?: string
  workflowId?: string
  baseSha?: string
  terminalStatus?: string
  terminalError?: string
  registryState?: string | null
  stillRunning?: { requestId?: string; sandboxId?: string; state?: string } | null
  logs?: {
    stdout?: string
    stderr?: string
  }
  error?: string
}

type AgentDispatchCanaryLatestSummary = {
  requestId: string
  mode: "on-demand" | "scheduled"
  status: "running" | "completed" | "failed" | "cancelled"
  updatedAt: string
  completedAt?: string
  error?: string
  sandboxId?: string
}

const AGENT_DISPATCH_CANARY_INBOX_PREFIXES = [
  "agent-dispatch-timeout-",
  "health-agent-dispatch-timeout-",
] as const
const AGENT_DISPATCH_CANARY_INBOX_DIR = join(
  process.env.HOME || "/Users/joel",
  ".joelclaw",
  "workspace",
  "inbox",
)

const agentDispatchCanaryOption = Options.boolean("agent-dispatch-canary").pipe(
  Options.withDefault(false),
  Options.withDescription("Run the deterministic non-LLM agent-dispatch timeout canary as part of status"),
)

function decode(value: string | Uint8Array | null | undefined): string {
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  return ""
}

function resolveJoelclawRepoRoot(): string {
  const repoCandidates = [
    process.env.JOELCLAW_ROOT?.trim(),
    process.env.HOME ? join(process.env.HOME, "Code", "joelhooks", "joelclaw") : undefined,
  ].filter((value): value is string => Boolean(value))

  for (const repoRoot of repoCandidates) {
    if (existsSync(repoRoot)) {
      return repoRoot
    }
  }

  return process.cwd()
}

function resolveAgentDispatchCanaryScriptPath(): string {
  const script = join("scripts", "verify-agent-dispatch-timeout.ts")
  const cwdCandidate = resolve(process.cwd(), script)
  if (existsSync(cwdCandidate)) return cwdCandidate
  return join(resolveJoelclawRepoRoot(), script)
}

function resolveAgentDispatchCanaryMode(requestId: string): "on-demand" | "scheduled" {
  return requestId.startsWith("health-agent-dispatch-timeout-") ? "scheduled" : "on-demand"
}

function readLatestAgentDispatchCanarySummary(
  inboxDir = AGENT_DISPATCH_CANARY_INBOX_DIR,
): AgentDispatchCanaryLatestSummary | null {
  if (!existsSync(inboxDir)) {
    return null
  }

  const candidates = readdirSync(inboxDir)
    .filter((name) => name.endsWith(".json"))
    .filter((name) => AGENT_DISPATCH_CANARY_INBOX_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .map((name) => join(inboxDir, name))

  const parsed = candidates.flatMap((filePath) => {
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as {
        requestId?: string
        status?: "running" | "completed" | "failed" | "cancelled"
        updatedAt?: string
        completedAt?: string
        error?: string
        localSandbox?: { sandboxId?: string }
      }
      if (!raw.requestId || !raw.status || !raw.updatedAt) {
        return []
      }
      return [{
        requestId: raw.requestId,
        mode: resolveAgentDispatchCanaryMode(raw.requestId),
        status: raw.status,
        updatedAt: raw.updatedAt,
        ...(raw.completedAt ? { completedAt: raw.completedAt } : {}),
        ...(raw.error ? { error: raw.error } : {}),
        ...(raw.localSandbox?.sandboxId ? { sandboxId: raw.localSandbox.sandboxId } : {}),
      } satisfies AgentDispatchCanaryLatestSummary]
    } catch {
      return []
    }
  })

  return parsed.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
}

async function runAgentDispatchCanaryProbe(): Promise<AgentDispatchCanaryStatus> {
  const scriptPath = resolveAgentDispatchCanaryScriptPath()
  const startedAt = Date.now()

  if (!existsSync(scriptPath)) {
    return {
      enabled: true,
      ok: false,
      summary: "agent-dispatch canary script missing",
      scriptPath,
      error: `Cannot find ${scriptPath}`,
      durationMs: Date.now() - startedAt,
    }
  }

  const proc = Bun.spawnSync(["bun", scriptPath, "--json-only"], {
    cwd: resolveJoelclawRepoRoot(),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })

  const stdout = decode(proc.stdout).trim()
  const stderr = decode(proc.stderr).trim()
  const durationMs = Date.now() - startedAt

  if (proc.exitCode !== 0) {
    return {
      enabled: true,
      ok: false,
      summary: "agent-dispatch canary failed",
      scriptPath,
      durationMs,
      error: stderr || stdout || `canary exited ${proc.exitCode}`,
    }
  }

  let parsed: AgentDispatchCanaryProbe
  try {
    parsed = JSON.parse(stdout) as AgentDispatchCanaryProbe
  } catch (error) {
    return {
      enabled: true,
      ok: false,
      summary: "agent-dispatch canary returned invalid JSON",
      scriptPath,
      durationMs,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const ok =
    parsed.terminal.status === "failed" &&
    Boolean(parsed.terminal.error?.includes("timed out")) &&
    parsed.registry?.state === "failed" &&
    !parsed.stillRunning

  return {
    enabled: true,
    ok,
    summary: ok
      ? `agent-dispatch timeout canary passed (${parsed.requestId})`
      : `agent-dispatch timeout canary returned unexpected truth (${parsed.requestId})`,
    scriptPath,
    durationMs,
    requestId: parsed.requestId,
    workflowId: parsed.workflowId,
    baseSha: parsed.baseSha,
    terminalStatus: parsed.terminal.status,
    terminalError: parsed.terminal.error,
    registryState: parsed.registry?.state ?? null,
    stillRunning: parsed.stillRunning,
    logs: parsed.terminal.logs,
    ...(ok
      ? {}
      : {
          error:
            parsed.terminal.error ||
            `terminal=${parsed.terminal.status} registry=${parsed.registry?.state ?? "missing"}`,
        }),
  }
}

export const statusCmd = Command.make(
  "status",
  {
    agentDispatchCanary: agentDispatchCanaryOption,
  },
  ({ agentDispatchCanary }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      const checks = yield* inngestClient.health()
      const latestAgentDispatchCanary = readLatestAgentDispatchCanarySummary()
      const canary = agentDispatchCanary
        ? yield* Effect.tryPromise({
            try: () => runAgentDispatchCanaryProbe(),
            catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
          })
        : ({
            enabled: false,
            ok: true,
            summary: "agent-dispatch canary not requested",
          } satisfies AgentDispatchCanaryStatus)

      const result = {
        ...checks,
        latestAgentDispatchCanary,
        agentDispatchCanary: canary,
      }
      const allOk = Object.values(checks).every((c) => c.ok) && canary.ok

      const next = []
      if (!checks.server?.ok) {
        next.push({ command: `kubectl rollout restart statefulset/inngest -n joelclaw`, description: "Restart Inngest pod" })
      }
      if (!checks.worker?.ok) {
        next.push({ command: `launchctl kickstart -k gui/$(id -u)/com.joel.system-bus-worker`, description: "Restart worker" })
      }
      if (!agentDispatchCanary) {
        next.push({ command: "joelclaw status --agent-dispatch-canary", description: "Run the deterministic non-LLM agent-dispatch timeout canary" })
      }
      if (latestAgentDispatchCanary) {
        next.push({
          command: "python3 -m json.tool <inbox-file>",
          description: "Inspect the latest persisted agent-dispatch canary snapshot",
          params: {
            "inbox-file": {
              description: "Latest agent-dispatch canary inbox file",
              value: join(AGENT_DISPATCH_CANARY_INBOX_DIR, `${latestAgentDispatchCanary.requestId}.json`),
              required: true,
            },
          },
        })
      }
      next.push(
        { command: `joelclaw functions`, description: "View registered functions" },
        {
          command: "joelclaw runs [--count <count>]",
          description: "Recent runs",
          params: {
            count: { description: "Number of runs", value: 5, default: 10 },
          },
        },
        { command: `joelclaw logs errors`, description: "Check worker errors" },
      )

      yield* Console.log(respond("status", result, next, allOk))
    })
)

export const functionsCmd = Command.make(
  "functions",
  {},
  () =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      const fns = yield* inngestClient.functions()

      const next = fns.flatMap((f) =>
        f.triggers.slice(0, 1).map((t) => ({
          command: "joelclaw send <event> [--data <data>]",
          description: `Trigger ${f.name}`,
          params: {
            event: { description: "Event name", value: t.value, required: true },
            data: { description: "JSON payload", value: "{}", default: "{}" },
          },
        }))
      )
      next.push({
        command: "joelclaw runs [--count <count>]",
        description: "See recent runs",
        params: {
          count: { description: "Number of runs", value: 5, default: 10 },
        },
      })

      yield* Console.log(respond("functions", { count: fns.length, functions: fns }, next))
    })
)

export const __statusTestables = {
  readLatestAgentDispatchCanarySummary,
  resolveAgentDispatchCanaryScriptPath,
}
