import { spawnSync } from "node:child_process"
import { hostname } from "node:os"

import type { FleetHostExpectation } from "./manifest"

export const SSH_CONNECT_TIMEOUT_SECONDS = 5
export const SSH_COMMAND_TIMEOUT_MS = 15_000
const BASE_SSH_ARGS = [
  "-o", "BatchMode=yes",
  "-o", `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
  "-o", "ServerAliveInterval=5",
  "-o", "ServerAliveCountMax=1",
] as const

const REMOTE_FACTS_SCRIPT = [
  "export PATH=\"$HOME/.local/bin:$HOME/.pi/agent/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH\"",
  "printf 'hostname='; hostname -s 2>/dev/null || true; printf '\\n'",
  "printf 'piVersion='; pi --version 2>/dev/null | head -1 || true; printf '\\n'",
  "printf 'modelThinking='; node -e \"const fs=require('fs'); const p=process.env.HOME+'/.pi/agent/settings.json'; try { const s=JSON.parse(fs.readFileSync(p,'utf8')); console.log([s.defaultModel||'',s.thinking||''].join('|')) } catch { console.log('|') }\" 2>/dev/null || true; printf '\\n'",
  "printf 'skillsFingerprint='; find \"$HOME/.pi/agent/skills\" -maxdepth 1 -type l -print 2>/dev/null | sort | cksum | awk '{print $1}' || true; printf '\\n'",
  "printf 'cliVersion='; joelclaw --version 2>/dev/null | head -1 || true; printf '\\n'",
].join("; ")

const REMOTE_SATELLITE_FACTS_SCRIPT = `${REMOTE_FACTS_SCRIPT}; printf 'satelliteHealth='; joelclaw satellite health >/dev/null 2>&1 && printf ok || printf failed; printf '\\n'`

type CommandResult = {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
  readonly timedOut?: boolean
}

export type CommandExecutor = (command: string, args: readonly string[], timeoutMs: number) => CommandResult

export type FleetProbeFailure = {
  readonly probe: string
  readonly code: "ssh_failed" | "timeout" | "unavailable" | "identity_mismatch"
  readonly detail: string
}

export type FleetHostFacts = {
  readonly hostname?: string
  readonly piVersion?: string
  readonly model?: string
  readonly thinking?: string
  readonly skillsFingerprint?: string
  readonly cliVersion?: string
  readonly satelliteHealth?: "ok" | "failed"
}

export type FleetHostProbeResult = {
  readonly alias: string
  readonly expectedHostname: string
  readonly role: FleetHostExpectation["role"]
  readonly facts: FleetHostFacts
  readonly failures: readonly FleetProbeFailure[]
  readonly ok: boolean
}

function executeSsh(command: string, args: readonly string[], timeoutMs: number): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  })

  return {
    ok: result.status === 0 && !result.error,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? result.error?.message ?? "").trim(),
    timedOut: result.error?.code === "ETIMEDOUT",
  }
}

function parseFacts(stdout: string): FleetHostFacts {
  const values = new Map<string, string>()
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf("=")
    if (separator === -1) continue
    values.set(line.slice(0, separator), line.slice(separator + 1).trim())
  }

  const [model = "", thinking = ""] = (values.get("modelThinking") ?? "|").split("|", 2)
  const satelliteHealth = values.get("satelliteHealth")

  return {
    ...(values.get("hostname") ? { hostname: values.get("hostname") } : {}),
    ...(values.get("piVersion") ? { piVersion: values.get("piVersion") } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(values.get("skillsFingerprint") ? { skillsFingerprint: values.get("skillsFingerprint") } : {}),
    ...(values.get("cliVersion") ? { cliVersion: values.get("cliVersion") } : {}),
    ...(satelliteHealth === "ok" || satelliteHealth === "failed" ? { satelliteHealth } : {}),
  }
}

function unavailable(field: string): FleetProbeFailure {
  return { probe: field, code: "unavailable", detail: `${field} was unavailable from the remote host` }
}

export function probeFleetHost(
  host: FleetHostExpectation,
  execute: CommandExecutor = executeSsh,
  currentHostname = hostname().split(".")[0],
): FleetHostProbeResult {
  const remoteScript = host.role === "satellite" ? REMOTE_SATELLITE_FACTS_SCRIPT : REMOTE_FACTS_SCRIPT
  const isLocalHost = currentHostname === host.expectedHostname
  const result = isLocalHost
    ? execute("sh", ["-lc", remoteScript], SSH_COMMAND_TIMEOUT_MS)
    : execute("ssh", [...BASE_SSH_ARGS, "--", host.sshTarget, remoteScript], SSH_COMMAND_TIMEOUT_MS)

  if (!result.ok) {
    const code = result.timedOut ? "timeout" : "ssh_failed"
    return {
      alias: host.alias,
      expectedHostname: host.expectedHostname,
      role: host.role,
      facts: {},
      failures: [{
        probe: isLocalHost ? "local" : "ssh",
        code,
        detail: code === "timeout"
          ? `${isLocalHost ? "Local" : "SSH"} command timed out`
          : `${isLocalHost ? "Local" : "SSH"} command failed`,
      }],
      ok: false,
    }
  }

  const facts = parseFacts(result.stdout)
  const failures: FleetProbeFailure[] = []
  for (const field of ["hostname", "piVersion", "skillsFingerprint", "cliVersion"] as const) {
    if (!facts[field]) failures.push(unavailable(field))
  }
  if (host.role === "satellite" && !facts.satelliteHealth) failures.push(unavailable("satelliteHealth"))
  if (facts.hostname && facts.hostname !== host.expectedHostname) {
    failures.push({
      probe: "hostname",
      code: "identity_mismatch",
      detail: `expected ${host.expectedHostname}, observed ${facts.hostname}`,
    })
  }

  return {
    alias: host.alias,
    expectedHostname: host.expectedHostname,
    role: host.role,
    facts,
    failures,
    ok: failures.length === 0,
  }
}

export const __fleetProbeTestUtils = { parseFacts, REMOTE_FACTS_SCRIPT, REMOTE_SATELLITE_FACTS_SCRIPT }
