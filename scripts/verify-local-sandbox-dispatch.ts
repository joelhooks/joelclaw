#!/usr/bin/env bun

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(scriptDir)
const inboxDir = join(process.env.HOME || "/Users/joel", ".joelclaw", "workspace", "inbox")
const pollTimeoutMs = 180_000
const pollIntervalMs = 2_000

const requestSuffix = `${Date.now()}`
const workflowId = `sandbox-dispatch-verify-${requestSuffix}`
const storyId = "completion-proof"
const baseSha = git(["rev-parse", "--short=8", "HEAD"])
const successRequestId = `sandbox-verify-ok-${requestSuffix}`
const failureRequestId = `sandbox-verify-badsha-${requestSuffix}`

type InboxResult = {
  requestId: string
  status: "running" | "completed" | "failed" | "cancelled"
  error?: string
  result?: string
  localSandbox?: {
    path?: string
    composeProjectName?: string
    sandboxId?: string
  }
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

async function waitForTerminalResult(requestId: string): Promise<InboxResult> {
  const deadline = Date.now() + pollTimeoutMs
  const inboxPath = join(inboxDir, `${requestId}.json`)

  while (Date.now() < deadline) {
    const file = Bun.file(inboxPath)
    if (await file.exists()) {
      const parsed = (await file.json()) as InboxResult
      if (parsed.status !== "running") {
        return parsed
      }
    }

    await Bun.sleep(pollIntervalMs)
  }

  throw new Error(`Timed out waiting for terminal inbox result: ${requestId}`)
}

const successPayload = {
  requestId: successRequestId,
  workflowId,
  storyId,
  baseSha,
  task: "Return the exact text sandbox-ok.",
  tool: "pi",
  cwd: repoRoot,
  timeout: 90,
  executionMode: "sandbox",
  sandboxBackend: "local",
  sandbox: "workspace-write",
  readFiles: false,
}

const failurePayload = {
  requestId: failureRequestId,
  workflowId,
  storyId,
  baseSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  task: "Return the exact text sandbox-should-fail.",
  tool: "pi",
  cwd: repoRoot,
  timeout: 90,
  executionMode: "sandbox",
  sandboxBackend: "local",
  sandbox: "workspace-write",
  readFiles: false,
}

console.log(`Dispatching success probe: ${successRequestId}`)
sendRequest(successPayload)
console.log(`Dispatching failure probe: ${failureRequestId}`)
sendRequest(failurePayload)

const success = await waitForTerminalResult(successRequestId)
const failure = await waitForTerminalResult(failureRequestId)

const report = {
  workflowId,
  baseSha,
  success: {
    requestId: success.requestId,
    status: success.status,
    result: success.result,
    sandboxPath: success.localSandbox?.path,
    composeProjectName: success.localSandbox?.composeProjectName,
  },
  failure: {
    requestId: failure.requestId,
    status: failure.status,
    error: failure.error,
    sandboxPath: failure.localSandbox?.path,
    composeProjectName: failure.localSandbox?.composeProjectName,
  },
}

console.log(JSON.stringify(report, null, 2))

if (success.status !== "completed") {
  throw new Error(`Expected completed success probe, got ${success.status}`)
}

if (failure.status !== "failed") {
  throw new Error(`Expected failed negative probe, got ${failure.status}`)
}
