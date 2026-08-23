import { spawn } from "node:child_process"

import {
  COMPOSED_RECALL_SCHEMA_VERSION,
  type ComposedRecallRequestV1,
  type ParsedComposedRecall,
  parseComposedRecallEnvelope,
  type RecallPrivacyTier,
} from "./contract.js"

export type RecallAccessPolicy = {
  readonly principalRef: string
  readonly purpose: string
  readonly allowedPrivacy: readonly RecallPrivacyTier[]
}

export type RecallScopePolicy = {
  readonly project: string
  readonly workstream: string
}

export type RecallLimits = {
  readonly reflections: number
  readonly observations: number
  readonly curated: number
}

export const MAX_AUTOMATIC_RECALL_QUERY_LENGTH = 1_000

export function createComposedRecallRequest(input: {
  readonly query: string
  readonly scope: RecallScopePolicy
  readonly access: RecallAccessPolicy
  readonly decidedAt?: string
  readonly includeSuperseded?: boolean
  readonly limits?: Partial<RecallLimits>
}): ComposedRecallRequestV1 {
  return {
    _tag: "ComposedRecallRequestV1",
    access: {
      _tag: "RecallAccessV1",
      allowedPrivacy: [...input.access.allowedPrivacy],
      decidedAt: input.decidedAt ?? new Date().toISOString(),
      principalRef: input.access.principalRef,
      purpose: input.access.purpose,
    },
    includeSuperseded: input.includeSuperseded ?? false,
    limits: {
      curated: input.limits?.curated ?? 5,
      observations: input.limits?.observations ?? 5,
      reflections: input.limits?.reflections ?? 5,
    },
    schemaVersion: COMPOSED_RECALL_SCHEMA_VERSION,
    scope: {
      _tag: "ProjectWorkstream",
      project: input.scope.project,
      workstream: input.scope.workstream,
    },
    text: input.query.trim().slice(0, MAX_AUTOMATIC_RECALL_QUERY_LENGTH),
  }
}

export const RECALL_PRIVATE_STDIN_ARGS = ["recall", "--request-file", "-"] as const

export type RecallProcessOutput = {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
}

export type RecallProcessRunner = (input: {
  readonly bin: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly stdin: string
  readonly timeoutMs: number
}) => Promise<RecallProcessOutput>

export class RecallCliError extends Error {
  readonly code: string
  readonly exitCode: number | null
  readonly unavailable: readonly { readonly lane: string; readonly code: string }[]

  constructor(input: {
    readonly code: string
    readonly exitCode: number | null
    readonly unavailable?: readonly { readonly lane: string; readonly code: string }[]
  }) {
    const unavailable = input.unavailable ?? []
    const detail =
      unavailable.length > 0
        ? `: ${unavailable.map((item) => `${item.lane}=${item.code}`).join(", ")}`
        : ""
    super(`Recall CLI failed (${input.code})${detail}`)
    this.name = "RecallCliError"
    this.code = input.code
    this.exitCode = input.exitCode
    this.unavailable = unavailable
  }
}

export const runRecallProcess: RecallProcessRunner = async (input) =>
  await new Promise<RecallProcessOutput>((resolve, reject) => {
    const child = spawn(input.bin, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let timedOut = false
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let reapTimer: ReturnType<typeof setTimeout> | undefined

    const clearTimers = () => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (reapTimer) clearTimeout(reapTimer)
    }
    const rejectOnce = (error: unknown) => {
      if (settled) return
      settled = true
      clearTimers()
      reject(error)
    }
    const terminate = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        // The process may already have exited between the timer and signal.
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminate("SIGTERM")
      killTimer = setTimeout(() => terminate("SIGKILL"), 250)
      reapTimer = setTimeout(() => {
        rejectOnce(new RecallCliError({ code: "RECALL_CLI_TIMEOUT", exitCode: null }))
      }, 1_000)
    }, input.timeoutMs)

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    // Drain stderr, but do not retain it. It can contain paths or request data
    // from a child we do not trust to honor the private boundary.
    child.stderr.on("data", () => undefined)
    // SAFETY: node:child_process spawn returns an EventEmitter at runtime. Some
    // Bun consumer tsconfigs erase the inherited EventEmitter methods from the
    // declaration, so this boundary restores only the two events used here.
    const events = child as unknown as {
      on(event: "error", listener: (error: Error) => void): void
      on(
        event: "close",
        listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
      ): void
    }
    events.on("error", (error) => {
      rejectOnce(error)
    })
    events.on("close", (exitCode, signal) => {
      if (settled) return
      settled = true
      clearTimers()
      if (timedOut) {
        reject(new RecallCliError({ code: "RECALL_CLI_TIMEOUT", exitCode }))
        return
      }
      resolve({ exitCode, signal, stdout })
    })

    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // A child can exit before it drains private stdin. EPIPE belongs to that
      // child's eventual exit result; it must not become an uncaught daemon error.
      if (error.code !== "EPIPE") rejectOnce(error)
    })
    child.stdin.end(input.stdin)
  })

function parseJson(stdout: string, exitCode: number | null): unknown {
  try {
    return JSON.parse(stdout.trim())
  } catch {
    throw new RecallCliError({ code: "RECALL_CLI_INVALID_JSON", exitCode })
  }
}

function envelopeErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const error = (value as Record<string, unknown>).error
  if (!error || typeof error !== "object") return undefined
  const code = (error as Record<string, unknown>).code
  return typeof code === "string" && code.trim().length > 0 ? code : undefined
}

export async function runComposedRecallCli(input: {
  readonly request: ComposedRecallRequestV1
  readonly bin?: string
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  readonly runProcess?: RecallProcessRunner
}): Promise<ParsedComposedRecall> {
  const runProcess = input.runProcess ?? runRecallProcess
  const output = await runProcess({
    bin: input.bin ?? process.env.JOELCLAW_BIN ?? "joelclaw",
    args: RECALL_PRIVATE_STDIN_ARGS,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    env: input.env ?? process.env,
    stdin: JSON.stringify(input.request),
    timeoutMs: input.timeoutMs ?? 10_000,
  })

  const parsedJson = parseJson(output.stdout, output.exitCode)
  let parsedRecall: ParsedComposedRecall | undefined
  try {
    parsedRecall = parseComposedRecallEnvelope(parsedJson)
  } catch (error) {
    if (output.exitCode === 0) throw error
  }

  if (output.exitCode !== 0 || !parsedRecall?.ok) {
    throw new RecallCliError({
      code: parsedRecall?.unavailable.length
        ? "RECALL_LANE_UNAVAILABLE"
        : (envelopeErrorCode(parsedJson) ?? "RECALL_CLI_NONZERO_EXIT"),
      exitCode: output.exitCode,
      ...(parsedRecall ? { unavailable: parsedRecall.unavailable } : {}),
    })
  }

  return parsedRecall
}
