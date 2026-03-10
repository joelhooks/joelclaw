#!/usr/bin/env bun

import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(scriptDir)
const inboxDir = join(process.env.HOME || "/Users/joel", ".joelclaw", "workspace", "inbox")
const registryPath = join(process.env.HOME || "/Users/joel", ".joelclaw", "sandboxes", "registry.json")
const pollTimeoutMs = 180_000
const pollIntervalMs = 2_000

const jsonOnly = process.argv.includes("--json-only")
const requestSuffix = `${Date.now()}`
const workflowId = `agent-dispatch-timeout-verify-${requestSuffix}`
const storyId = "timeout-canary"
const baseSha = git(["rev-parse", "--short=8", "HEAD"])
const requestId = `agent-dispatch-timeout-${requestSuffix}`

type CliEnvelope<T> = {
  ok: boolean
  result: T
}

type InboxResult = {
  requestId: string
  status: "running" | "completed" | "failed" | "cancelled"
  error?: string
  result?: string
  logs?: {
    stdout?: string
    stderr?: string
  }
  localSandbox?: {
    sandboxId?: string
    path?: string
    cleanupAfter?: string
  }
}

type SandboxRegistryEntry = {
  requestId: string
  sandboxId: string
  state: "running" | "completed" | "failed" | "cancelled"
  mode: "minimal" | "full"
  backend: "local" | "k8s"
  path: string
  cleanupAfter?: string
  updatedAt: string
}

type SandboxesListResult = {
  entries: Array<{ requestId?: string; sandboxId?: string; state?: string }>
}

function run(command: string[], cwd = repoRoot): string {
  const proc = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })

  const stdout = decode(proc.stdout).trim()
  const stderr = decode(proc.stderr).trim()

  if (proc.exitCode !== 0) {
    throw new Error(stderr || stdout || `${command.join(" ")} failed with exit ${proc.exitCode}`)
  }

  return stdout
}

function runJson<T>(command: string[], cwd = repoRoot): CliEnvelope<T> {
  return JSON.parse(run(command, cwd)) as CliEnvelope<T>
}

function git(args: string[]): string {
  return run(["git", ...args])
}

function decode(value: string | Uint8Array | null | undefined): string {
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  return ""
}

function sendRequest(payload: Record<string, unknown>): void {
  run(["joelclaw", "send", "system/agent.requested", "-d", JSON.stringify(payload)])
}

async function waitForTerminalResult(targetRequestId: string): Promise<InboxResult> {
  const deadline = Date.now() + pollTimeoutMs
  const inboxPath = join(inboxDir, `${targetRequestId}.json`)

  while (Date.now() < deadline) {
    if (existsSync(inboxPath)) {
      const parsed = (await Bun.file(inboxPath).json()) as InboxResult
      if (parsed.status !== "running") {
        return parsed
      }
    }

    await Bun.sleep(pollIntervalMs)
  }

  throw new Error(`Timed out waiting for terminal inbox result: ${targetRequestId}`)
}

async function readRegistryEntry(targetRequestId: string): Promise<SandboxRegistryEntry | null> {
  const file = Bun.file(registryPath)
  if (!(await file.exists())) {
    return null
  }

  const registry = (await file.json()) as { entries?: SandboxRegistryEntry[] }
  return registry.entries?.find((entry) => entry.requestId === targetRequestId) ?? null
}

const payload = {
  requestId,
  workflowId,
  storyId,
  baseSha,
  task: "Force the non-LLM outer-timeout canary path.",
  tool: "canary",
  canary: {
    scenario: "sleep-timeout",
    sleepSeconds: 120,
  },
  cwd: repoRoot,
  timeout: 5,
  executionMode: "sandbox",
  sandboxBackend: "local",
  sandbox: "read-only",
  readFiles: false,
} as const

if (!jsonOnly) {
  console.log(`Dispatching timeout canary: ${requestId}`)
}
sendRequest(payload)

const terminal = await waitForTerminalResult(requestId)
const registryEntry = await readRegistryEntry(requestId)
const runningSandboxes = runJson<SandboxesListResult>([
  "joelclaw",
  "workload",
  "sandboxes",
  "list",
  "--state",
  "running",
  "--limit",
  "200",
])
const stillRunning = runningSandboxes.result.entries.find((entry) => entry.requestId === requestId)

const report = {
  requestId,
  workflowId,
  baseSha,
  terminal: {
    status: terminal.status,
    error: terminal.error,
    result: terminal.result,
    sandboxId: terminal.localSandbox?.sandboxId,
    sandboxPath: terminal.localSandbox?.path,
    cleanupAfter: terminal.localSandbox?.cleanupAfter,
    logs: {
      stdout: terminal.logs?.stdout?.slice(-300) ?? "",
      stderr: terminal.logs?.stderr?.slice(-300) ?? "",
    },
  },
  registry: registryEntry,
  stillRunning: stillRunning ?? null,
}

console.log(JSON.stringify(report, null, 2))

if (terminal.status !== "failed") {
  throw new Error(`Expected failed timeout canary, got ${terminal.status}`)
}

if (!terminal.error?.includes("timed out")) {
  throw new Error(`Expected terminal error to mention timeout, got: ${terminal.error || "missing"}`)
}

if (!registryEntry) {
  throw new Error(`Expected sandbox registry entry for ${requestId}`)
}

if (registryEntry.state !== "failed") {
  throw new Error(`Expected sandbox registry state failed, got ${registryEntry.state}`)
}

if (stillRunning) {
  throw new Error(`Timeout canary still appears in running sandboxes: ${JSON.stringify(stillRunning)}`)
}
