import { spawn } from "node:child_process"
import { JoelclawEnvelopeError, JoelclawProcessError } from "./errors"
import type {
  JoelclawClientOptions,
  JoelclawEnvelope,
  JoelclawRunOptions,
  OtelEmitInput,
  OtelListOptions,
  OtelSearchOptions,
  RecallQueryOptions,
  VaultAdrListOptions,
  VaultAdrRankOptions,
  VaultSearchOptions,
} from "./types"

const DEFAULT_TIMEOUT_MS = 20_000

type ProcessRunResult = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

type InternalRunOptions = JoelclawRunOptions & {
  throwOnEnvelopeError?: boolean
}

function appendOption(args: string[], name: string, value: string | number | undefined): void {
  if (value === undefined) return
  args.push(`--${name}`, String(value))
}

function appendFlag(args: string[], name: string, enabled: boolean | undefined): void {
  if (!enabled) return
  args.push(`--${name}`)
}

function toCsv(value: string | readonly string[] | undefined): string | undefined {
  if (!value) return undefined
  if (Array.isArray(value)) {
    const values = value.map((entry) => entry.trim()).filter(Boolean)
    return values.length > 0 ? values.join(",") : undefined
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function isEnvelopeLike(value: unknown): value is JoelclawEnvelope {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>

  return (
    typeof candidate.ok === "boolean"
    && typeof candidate.command === "string"
    && "result" in candidate
    && Array.isArray(candidate.next_actions)
  )
}

function tryParseEnvelope(raw: string): JoelclawEnvelope | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const candidates: string[] = [trimmed]

  const firstBrace = raw.indexOf("{")
  const lastBrace = raw.lastIndexOf("}")
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1).trim())
  }

  for (const line of trimmed.split(/\r?\n/).reverse()) {
    const candidate = line.trim()
    if (candidate.startsWith("{") && candidate.endsWith("}")) {
      candidates.push(candidate)
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (isEnvelopeLike(parsed)) {
        return parsed
      }
    } catch {
      // keep trying parse candidates
    }
  }

  return null
}

function truncateOutput(value: string, maxChars = 1000): string {
  const trimmed = value.trim()
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars)}...`
}

async function runProcess(
  bin: string,
  args: readonly string[],
  options: JoelclawRunOptions,
  defaults: JoelclawClientOptions,
): Promise<ProcessRunResult> {
  const cwd = options.cwd ?? defaults.cwd
  const timeoutMs = options.timeoutMs ?? defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const stdinPayload = options.stdinText ?? (options.stdinJson === undefined ? undefined : JSON.stringify(options.stdinJson))

  return await new Promise<ProcessRunResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: {
        ...process.env,
        ...defaults.env,
        ...options.env,
      },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, timeoutMs)

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })

    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer)

      if (timedOut) {
        reject(
          new JoelclawProcessError({
            message: `joelclaw command timed out after ${timeoutMs}ms`,
            bin,
            args,
            exitCode,
            signal,
            stdout,
            stderr,
          }),
        )
        return
      }

      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
      })
    })

    if (stdinPayload !== undefined) {
      child.stdin.write(stdinPayload)
    }
    child.stdin.end()
  })
}

export class JoelclawClient {
  readonly #bin: string
  readonly #defaults: JoelclawClientOptions

  constructor(options: JoelclawClientOptions = {}) {
    this.#bin = options.bin ?? process.env.JOELCLAW_BIN ?? "joelclaw"
    this.#defaults = options
  }

  async run<TResult = unknown>(
    args: readonly string[],
    options: InternalRunOptions = {},
  ): Promise<JoelclawEnvelope<TResult>> {
    const processResult = await runProcess(this.#bin, args, options, this.#defaults)
    const envelope = tryParseEnvelope(processResult.stdout)

    if (!envelope) {
      throw new JoelclawProcessError({
        message: `joelclaw output was not a valid envelope for command: ${this.#bin} ${args.join(" ")}`,
        bin: this.#bin,
        args,
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        stdout: processResult.stdout,
        stderr: processResult.stderr,
      })
    }

    if (processResult.exitCode !== 0) {
      throw new JoelclawProcessError({
        message: `joelclaw exited with code ${processResult.exitCode} for command: ${this.#bin} ${args.join(" ")}`,
        bin: this.#bin,
        args,
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        stdout: processResult.stdout,
        stderr: processResult.stderr,
      })
    }

    if (options.throwOnEnvelopeError && !envelope.ok) {
      throw new JoelclawEnvelopeError(envelope)
    }

    return envelope as JoelclawEnvelope<TResult>
  }

  async runOrThrow<TResult = unknown>(
    args: readonly string[],
    options: JoelclawRunOptions = {},
  ): Promise<JoelclawEnvelope<TResult>> {
    return await this.run<TResult>(args, {
      ...options,
      throwOnEnvelopeError: true,
    })
  }

  async runText(args: readonly string[], options: JoelclawRunOptions = {}): Promise<string> {
    const processResult = await runProcess(this.#bin, args, options, this.#defaults)
    if (processResult.exitCode !== 0) {
      throw new JoelclawProcessError({
        message: `joelclaw exited with code ${processResult.exitCode} for command: ${this.#bin} ${args.join(" ")}`,
        bin: this.#bin,
        args,
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        stdout: processResult.stdout,
        stderr: processResult.stderr,
      })
    }

    return processResult.stdout
  }

  async status<TResult = unknown>(): Promise<JoelclawEnvelope<TResult>> {
    return await this.runOrThrow<TResult>(["status"])
  }

  async otelList<TResult = unknown>(options: OtelListOptions = {}): Promise<JoelclawEnvelope<TResult>> {
    const args = ["otel", "list"]

    appendOption(args, "level", toCsv(options.level))
    appendOption(args, "source", toCsv(options.source))
    appendOption(args, "component", toCsv(options.component))
    if (typeof options.success === "boolean") {
      appendOption(args, "success", options.success ? "true" : "false")
    }
    appendOption(args, "hours", options.hours)
    appendOption(args, "limit", options.limit)
    appendOption(args, "page", options.page)

    return await this.runOrThrow<TResult>(args)
  }

  async otelSearch<TResult = unknown>(
    query: string,
    options: OtelSearchOptions = {},
  ): Promise<JoelclawEnvelope<TResult>> {
    const args = ["otel", "search", query]

    appendOption(args, "level", toCsv(options.level))
    appendOption(args, "source", toCsv(options.source))
    appendOption(args, "component", toCsv(options.component))
    if (typeof options.success === "boolean") {
      appendOption(args, "success", options.success ? "true" : "false")
    }
    appendOption(args, "hours", options.hours)
    appendOption(args, "limit", options.limit)
    appendOption(args, "page", options.page)

    return await this.runOrThrow<TResult>(args)
  }

  async otelStats<TResult = unknown>(options: {
    source?: string | readonly string[]
    component?: string | readonly string[]
    hours?: number
  } = {}): Promise<JoelclawEnvelope<TResult>> {
    const args = ["otel", "stats"]

    appendOption(args, "source", toCsv(options.source))
    appendOption(args, "component", toCsv(options.component))
    appendOption(args, "hours", options.hours)

    return await this.runOrThrow<TResult>(args)
  }

  async otelEmit<TResult = unknown>(event: string | OtelEmitInput): Promise<JoelclawEnvelope<TResult>> {
    if (typeof event === "string") {
      const action = event.trim()
      if (!action) {
        throw new Error("otelEmit(action): action must be a non-empty string")
      }
      return await this.runOrThrow<TResult>(["otel", "emit", action])
    }

    if (!event.action?.trim()) {
      throw new Error("otelEmit(event): event.action is required")
    }

    return await this.runOrThrow<TResult>(["otel", "emit"], {
      stdinJson: event,
    })
  }

  async recall<TResult = unknown>(
    query: string,
    options: RecallQueryOptions = {},
  ): Promise<JoelclawEnvelope<TResult>> {
    const args = ["recall", query]

    appendOption(args, "limit", options.limit)
    appendOption(args, "min-score", options.minScore)
    appendFlag(args, "include-hold", options.includeHold)
    appendFlag(args, "include-discard", options.includeDiscard)
    appendOption(args, "budget", options.budget)
    appendOption(args, "category", options.category)

    return await this.runOrThrow<TResult>(args)
  }

  async recallRaw(query: string, options: Omit<RecallQueryOptions, "includeHold" | "includeDiscard"> = {}): Promise<string> {
    const args = ["recall", query, "--raw"]
    appendOption(args, "limit", options.limit)
    appendOption(args, "min-score", options.minScore)
    appendOption(args, "budget", options.budget)
    appendOption(args, "category", options.category)

    const raw = await this.runText(args)
    return raw.trim()
  }

  async vaultRead<TResult = unknown>(ref: string): Promise<JoelclawEnvelope<TResult>> {
    return await this.runOrThrow<TResult>(["vault", "read", ref])
  }

  async vaultSearch<TResult = unknown>(
    query: string,
    options: VaultSearchOptions = {},
  ): Promise<JoelclawEnvelope<TResult>> {
    const args = ["vault", "search", query]
    appendFlag(args, "semantic", options.semantic)
    appendOption(args, "limit", options.limit)
    return await this.runOrThrow<TResult>(args)
  }

  async vaultLs<TResult = unknown>(section?: string): Promise<JoelclawEnvelope<TResult>> {
    const args = ["vault", "ls"]
    if (section?.trim()) args.push(section.trim())
    return await this.runOrThrow<TResult>(args)
  }

  async vaultTree<TResult = unknown>(): Promise<JoelclawEnvelope<TResult>> {
    return await this.runOrThrow<TResult>(["vault", "tree"])
  }

  async vaultAdrList<TResult = unknown>(options: VaultAdrListOptions = {}): Promise<JoelclawEnvelope<TResult>> {
    const args = ["vault", "adr", "list"]
    appendOption(args, "status", options.status)
    appendOption(args, "limit", options.limit)
    return await this.runOrThrow<TResult>(args)
  }

  async vaultAdrCollisions<TResult = unknown>(): Promise<JoelclawEnvelope<TResult>> {
    return await this.runOrThrow<TResult>(["vault", "adr", "collisions"])
  }

  async vaultAdrAudit<TResult = unknown>(): Promise<JoelclawEnvelope<TResult>> {
    return await this.runOrThrow<TResult>(["vault", "adr", "audit"])
  }

  async vaultAdrRank<TResult = unknown>(options: VaultAdrRankOptions = {}): Promise<JoelclawEnvelope<TResult>> {
    const args = ["vault", "adr", "rank"]
    appendOption(args, "status", options.status)
    appendOption(args, "limit", options.limit)
    appendFlag(args, "strict", options.strict)
    return await this.runOrThrow<TResult>(args)
  }

  formatProcessError(error: unknown): string {
    if (!(error instanceof JoelclawProcessError)) return String(error)

    return [
      error.message,
      error.stderr.trim() ? `stderr: ${truncateOutput(error.stderr)}` : null,
      error.stdout.trim() ? `stdout: ${truncateOutput(error.stdout)}` : null,
    ].filter(Boolean).join("\n")
  }
}

export function createJoelclawClient(options: JoelclawClientOptions = {}): JoelclawClient {
  return new JoelclawClient(options)
}
