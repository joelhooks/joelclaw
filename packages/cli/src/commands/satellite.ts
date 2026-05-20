import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { respond, respondError } from "../response"

type Probe = {
  name: string
  ok: boolean
  detail: string
  fix?: string
}

function run(command: string, args: string[], timeout = 10_000): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const proc = spawnSync(command, args, { encoding: "utf8", timeout, maxBuffer: 1024 * 1024 })
  return {
    ok: proc.status === 0 && !proc.error,
    stdout: (proc.stdout ?? "").trim(),
    stderr: (proc.stderr ?? proc.error?.message ?? "").trim(),
    status: proc.status,
  }
}

function hostname(): string {
  return run("hostname", []).stdout || "unknown"
}

function probeCommand(name: string, command: string, args: string[], fix: string): Probe {
  const result = run(command, args)
  return {
    name,
    ok: result.ok,
    detail: result.ok ? result.stdout || `${command} ok` : result.stderr || result.stdout || `${command} failed`,
    ...(result.ok ? {} : { fix }),
  }
}

function collectHealth(): { machine: string; ok: boolean; probes: Probe[] } {
  const home = process.env.HOME ?? ""
  const machine = hostname().replace(/\.local$/, "")
  const probes: Probe[] = [
    probeCommand("python3", "python3", ["--version"], "Install or expose python3 on PATH"),
    probeCommand("jq", "jq", ["--version"], "Install jq or expose it on PATH"),
    probeCommand("joelclaw", "joelclaw", ["session", "search", "joel-writing-style", "--source", "local", "--machine", machine, "--limit", "1"], "Install/rebuild joelclaw and ensure ~/.local/bin is on PATH"),
  ]

  const sessionRoot = join(home, ".pi", "agent", "sessions")
  probes.push({
    name: "pi-session-root",
    ok: existsSync(sessionRoot),
    detail: sessionRoot,
    ...(existsSync(sessionRoot) ? {} : { fix: "Create/copy ~/.pi/agent/sessions or verify this Machine has Pi session capture" }),
  })

  const localSearch = run("joelclaw", ["session", "search", "joel-writing-style", "--source", "local", "--machine", machine, "--limit", "1"], 20_000)
  probes.push({
    name: "session-local-search-json",
    ok: localSearch.ok && localSearch.stdout.startsWith("{"),
    detail: localSearch.ok ? "local session search returned JSON" : localSearch.stderr || localSearch.stdout || "local session search failed",
    ...(localSearch.ok ? {} : { fix: "Run: joelclaw session search joel-writing-style --source local --machine <machine> --limit 1" }),
  })

  return { machine, ok: probes.every((probe) => probe.ok), probes }
}

function notifyCentral(input: { centralSsh: string; priority: string; summary: string; context: Record<string, unknown> }): { ok: boolean; detail: string } {
  const context = JSON.stringify(input.context).replace(/'/g, "'\\''")
  const message = input.summary.replace(/'/g, "'\\''")
  const remote = `JOELCLAW=$(command -v joelclaw || command -v ~/.local/bin/joelclaw || command -v ~/.bun/bin/joelclaw); "$JOELCLAW" notify send '${message}' --priority ${input.priority} --source satellite-health --type satellite/repair.requested --context '${context}'`
  const result = run("ssh", [input.centralSsh, remote], 30_000)
  return {
    ok: result.ok,
    detail: result.ok ? result.stdout : result.stderr || result.stdout || "central notify failed",
  }
}

const notifyOpt = Options.boolean("notify").pipe(
  Options.withDefault(false),
  Options.withDescription("Notify Central gateway when health is degraded"),
)

const centralSshOpt = Options.text("central-ssh").pipe(
  Options.withDefault("joel@panda"),
  Options.withDescription("SSH target for Central Machine notification relay"),
)

const priorityOpt = Options.choice("priority", ["normal", "high", "urgent"] as const).pipe(
  Options.withDefault("high" as const),
  Options.withDescription("Gateway notification priority when --notify is used"),
)

const healthCmd = Command.make(
  "health",
  { notify: notifyOpt, centralSsh: centralSshOpt, priority: priorityOpt },
  ({ notify, centralSsh, priority }) => Effect.gen(function* () {
    const health = collectHealth()
    const failed = health.probes.filter((probe) => !probe.ok)
    const notification = notify && failed.length > 0
      ? notifyCentral({
        centralSsh,
        priority,
        summary: `Satellite ${health.machine} repair requested: ${failed.map((probe) => probe.name).join(", ")}`,
        context: { machine: health.machine, failed, source: "joelclaw satellite health", centralSsh },
      })
      : undefined

    yield* Console.log(respond("satellite health", {
      ...health,
      failedCount: failed.length,
      sourceBehavior: "local probes run on this satellite; --notify relays repair request to Central gateway over SSH",
      notification,
    }, [
      { command: "joelclaw satellite health --notify", description: "Run satellite health and ask Central gateway for repair if degraded" },
      { command: "joelclaw session search <query> --source local --machine <machine> --extract", description: "Verify local session recovery", params: { query: { required: true }, machine: { value: health.machine } } },
    ], health.ok))
  })
).pipe(Command.withDescription("Check satellite Machine health and optionally notify Central gateway for repair"))

const repairRequestCmd = Command.make(
  "repair-request",
  { centralSsh: centralSshOpt, priority: priorityOpt },
  ({ centralSsh, priority }) => Effect.gen(function* () {
    const health = collectHealth()
    const failed = health.probes.filter((probe) => !probe.ok)
    const notification = notifyCentral({
      centralSsh,
      priority,
      summary: `Satellite ${health.machine} repair requested${failed.length ? `: ${failed.map((probe) => probe.name).join(", ")}` : ""}`,
      context: { machine: health.machine, failed, probes: health.probes, source: "joelclaw satellite repair-request", centralSsh },
    })

    if (!notification.ok) {
      yield* Console.log(respondError("satellite repair-request", notification.detail, "SATELLITE_NOTIFY_FAILED", "Verify SSH to Central and that joelclaw notify works there: ssh joel@panda 'joelclaw notify send test --priority normal'", [
        { command: "joelclaw satellite health", description: "Inspect local health without notification" },
      ]))
      return
    }

    yield* Console.log(respond("satellite repair-request", { ...health, notification }, [
      { command: "joelclaw satellite health", description: "Re-check local health" },
    ], health.ok))
  })
).pipe(Command.withDescription("Send Central gateway a repair request for this satellite"))

export const satelliteCmd = Command.make("satellite").pipe(
  Command.withDescription("Satellite Machine health and Central repair request tools"),
  Command.withSubcommands([healthCmd, repairRequestCmd]),
)
