#!/usr/bin/env bun

import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(scriptDir)
const fixtureDir = join(repoRoot, "packages/agent-execution/__fixtures__/full-mode-runtime")
const inboxDir = join(process.env.HOME || "/Users/joel", ".joelclaw", "workspace", "inbox")
const artifactDir = mkdtempSync(join(tmpdir(), "workload-full-mode-"))
const pollTimeoutMs = 240_000
const pollIntervalMs = 2_000

type CliEnvelope<T> = {
  ok: boolean
  result: T
}

type WorkloadPlanResult = {
  artifact?: { path?: string }
  plan: { workloadId: string }
}

type WorkloadRunResult = {
  runtimeRequest: { requestId: string }
}

type InboxResult = {
  requestId: string
  status: "running" | "completed" | "failed" | "cancelled"
  result?: string
  error?: string
  localSandbox?: {
    mode?: "minimal" | "full"
    path?: string
    workDir?: string
    composeProjectName?: string
    composeFiles?: string[]
    devcontainerPath?: string
  }
}

function decode(value: string | Uint8Array | null | undefined): string {
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  return ""
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

async function waitForTerminalResult(requestId: string): Promise<InboxResult> {
  const deadline = Date.now() + pollTimeoutMs
  const inboxPath = join(inboxDir, `${requestId}.json`)

  while (Date.now() < deadline) {
    if (existsSync(inboxPath)) {
      const parsed = (await Bun.file(inboxPath).json()) as InboxResult
      if (parsed.status !== "running") {
        return parsed
      }
    }

    await Bun.sleep(pollIntervalMs)
  }

  throw new Error(`Timed out waiting for terminal inbox result: ${requestId}`)
}

const planIntent = [
  "Dogfood ADR-0221 full local sandbox mode through the workflow rig.",
  "For stage-2, run inside the fixture repo only.",
  "Use bash to print a single line in the format full-mode-ok|$JOELCLAW_SANDBOX_MODE|$COMPOSE_PROJECT_NAME|$(pwd).",
  "Return that exact line and do not touch files outside the fixture.",
].join(" ")

const plan = runJson<WorkloadPlanResult>([
  "joelclaw",
  "workload",
  "plan",
  planIntent,
  "--kind",
  "runtime.proof",
  "--shape",
  "serial",
  "--repo",
  fixtureDir,
  "--paths",
  "compose.yaml,.devcontainer/devcontainer.json",
  "--write-plan",
  artifactDir,
])

const planArtifactPath =
  plan.result.artifact?.path || join(artifactDir, `${plan.result.plan.workloadId}.json`)

const runResult = runJson<WorkloadRunResult>([
  "joelclaw",
  "workload",
  "run",
  planArtifactPath,
  "--stage",
  "stage-2",
  "--tool",
  "pi",
  "--execution-mode",
  "sandbox",
  "--sandbox-backend",
  "local",
  "--sandbox-mode",
  "full",
])

const terminal = await waitForTerminalResult(runResult.result.runtimeRequest.requestId)

const composeProjectName = terminal.localSandbox?.composeProjectName
const runningContainers = composeProjectName
  ? run([
      "docker",
      "ps",
      "--filter",
      `label=com.docker.compose.project=${composeProjectName}`,
      "--format",
      "{{.ID}}",
    ]).split("\n").map((line) => line.trim()).filter(Boolean)
  : []

const report = {
  planArtifactPath,
  requestId: terminal.requestId,
  status: terminal.status,
  result: terminal.result,
  error: terminal.error,
  localSandbox: terminal.localSandbox,
  runningContainers,
}

console.log(JSON.stringify(report, null, 2))

if (terminal.status !== "completed") {
  throw new Error(`Expected completed full-mode workload run, got ${terminal.status}: ${terminal.error || "no error"}`)
}

if (!terminal.result?.startsWith("full-mode-ok|full|")) {
  throw new Error(`Unexpected result payload: ${terminal.result || "missing result"}`)
}

if (terminal.localSandbox?.mode !== "full") {
  throw new Error(`Expected localSandbox.mode=full, got ${terminal.localSandbox?.mode || "missing"}`)
}

if (!terminal.localSandbox?.workDir?.includes("packages/agent-execution/__fixtures__/full-mode-runtime")) {
  throw new Error(`Unexpected sandbox workDir: ${terminal.localSandbox?.workDir || "missing"}`)
}

if (!terminal.localSandbox?.composeFiles?.length) {
  throw new Error("Expected full-mode sandbox to record compose files")
}

if (!terminal.localSandbox?.devcontainerPath?.includes(".devcontainer")) {
  throw new Error(`Unexpected devcontainer path: ${terminal.localSandbox?.devcontainerPath || "missing"}`)
}

if (runningContainers.length > 0) {
  throw new Error(`Expected full-mode teardown to remove runtime containers, still running: ${runningContainers.join(", ")}`)
}
