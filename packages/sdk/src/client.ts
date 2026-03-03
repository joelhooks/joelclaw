import { spawn } from "node:child_process"
import { executeSdkCapabilityCommand, type SdkCapability } from "./capabilities"
import { JoelclawCapabilityError, JoelclawEnvelopeError, JoelclawProcessError } from "./errors"
import type {
  DeployWorkerOptions,
  JoelclawClientOptions,
  JoelclawEnvelope,
  JoelclawRunOptions,
  JoelclawTransport,
  LogWriteInput,
  OtelEmitInput,
  OtelListOptions,
  OtelSearchOptions,
  RecallQueryOptions,
  SecretsAuditOptions,
  SecretsEnvOptions,
  SecretsLeaseInput,
  SecretsRevokeOptions,
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

type RecallCapabilityPayload = {
  raw: boolean
  text?: string
  payload?: Record<string, unknown>
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

function buildSuccessEnvelope<TResult>(command: string, result: TResult): JoelclawEnvelope<TResult> {
  return {
    ok: true,
    command,
    result,
    next_actions: [],
  }
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
  readonly #transport: JoelclawTransport

  constructor(options: JoelclawClientOptions = {}) {
    this.#bin = options.bin ?? process.env.JOELCLAW_BIN ?? "joelclaw"
    this.#defaults = options
    this.#transport = options.transport ?? "hybrid"
  }

  private shouldTryInProcess(): boolean {
    return this.#transport === "inprocess" || this.#transport === "hybrid"
  }

  private shouldUseSubprocessFallback(): boolean {
    return this.#transport === "subprocess" || this.#transport === "hybrid"
  }

  private async runSdkCapability<TResult>(input: {
    capability: SdkCapability
    subcommand: string
    args: unknown
    command: string
  }): Promise<JoelclawEnvelope<TResult> | null> {
    if (!this.shouldTryInProcess()) return null

    const result = await executeSdkCapabilityCommand<TResult>({
      capability: input.capability,
      subcommand: input.subcommand,
      args: input.args,
    })

    if (result.ok) {
      return buildSuccessEnvelope(input.command, result.result)
    }

    if (this.#transport === "inprocess") {
      throw new JoelclawCapabilityError({
        capability: input.capability,
        subcommand: input.subcommand,
        error: result.error,
      })
    }

    return null
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

  async deployWorker<TResult = unknown>(options: DeployWorkerOptions = {}): Promise<JoelclawEnvelope<TResult>> {
    const inProcess = await this.runSdkCapability<TResult>({
      capability: "deploy",
      subcommand: "worker",
      args: {
        restart: options.restart ?? false,
        force: options.force ?? false,
        waitMs: options.waitMs ?? 1500,
        execute: options.execute ?? false,
      },
      command: "joelclaw deploy worker",
    })

    if (inProcess) return inProcess
    if (!this.shouldUseSubprocessFallback()) {
      throw new Error("subprocess transport is disabled")
    }

    const args = ["deploy", "worker"]
    appendFlag(args, "restart", options.restart)
    appendFlag(args, "force", options.force)
    appendOption(args, "wait-ms", options.waitMs)
    appendFlag(args, "execute", options.execute)

    return await this.runOrThrow<TResult>(args)
  }

  async logWrite<TResult = unknown>(input: LogWriteInput): Promise<JoelclawEnvelope<TResult>> {
    const action = input.action.trim()
    const tool = input.tool.trim()
    const detail = input.detail.trim()

    if (!action || !tool || !detail) {
      throw new Error("logWrite requires non-empty action, tool, and detail")
    }

    const inProcess = await this.runSdkCapability<TResult>({
      capability: "log",
      subcommand: "write",
      args: {
        action,
        tool,
        detail,
        reason: input.reason?.trim() || undefined,
      },
      command: "joelclaw log write",
    })

    if (inProcess) return inProcess
    if (!this.shouldUseSubprocessFallback()) {
      throw new Error("subprocess transport is disabled")
    }

    const args = ["log", "write", "--action", action, "--tool", tool, "--detail", detail]
    if (input.reason?.trim()) {
      args.push("--reason", input.reason.trim())
    }

    return await this.runOrThrow<TResult>(args)
  }

  async secretsStatus<TResult = unknown>(): Promise<JoelclawEnvelope<TResult>> {
    const inProcess = await this.runSdkCapability<TResult>({
      capability: "secrets",
      subcommand: "status",
      args: {},
      command: "joelclaw secrets status",
    })

    if (inProcess) return inProcess
    if (!this.shouldUseSubprocessFallback()) {
      throw new Error("subprocess transport is disabled")
    }

    return await this.runOrThrow<TResult>(["secrets", "status"])
  }

  async secretsLease<TResult = unknown>(input: SecretsLeaseInput): Promise<JoelclawEnvelope<TResult>> {
    const name = input.name.trim()
    if (!name) {
      throw new Error("secretsLease requires a non-empty secret name")
    }

    const inProcess = await this.runSdkCapability<TResult>({
      capability: "secrets",
      subcommand: "lease",
      args: {
        name,
        ttl: input.ttl?.trim() || undefined,
        clientId: input.clientId?.trim() || undefined,
      },
      command: "joelclaw secrets lease",
    })

    if (inProcess) return inProcess
    if (!this.shouldUseSubprocessFallback()) {
      throw new Error("subprocess transport is disabled")
    }

    const args = ["secrets", "lease", name]
    if (input.ttl?.trim()) args.push("--ttl", input.ttl.trim())
    if (input.clientId?.trim()) args.push("--client-id", input.clientId.trim())

    return await this.runOrThrow<TResult>(args)
  }

  async secretsRevoke<TResult = unknown>(options: SecretsRevokeOptions = {}): Promise<JoelclawEnvelope<TResult>> {
    const leaseId = options.leaseId?.trim()
    const all = options.all === true
    if (!all && !leaseId) {
      throw new Error("secretsRevoke requires leaseId or all=true")
    }

    const inProcess = await this.runSdkCapability<TResult>({
      capability: "secrets",
      subcommand: "revoke",
      args: {
        leaseId,
        all,
      },
      command: "joelclaw secrets revoke",
    })

    if (inProcess) return inProcess
    if (!this.shouldUseSubprocessFallback()) {
      throw new Error("subprocess transport is disabled")
    }

    const args = ["secrets", "revoke"]
    if (all) {
      args.push("--all")
    } else if (leaseId) {
      args.push(leaseId)
    }

    return await this.runOrThrow<TResult>(args)
  }

  async secretsAudit<TResult = unknown>(options: SecretsAuditOptions = {}): Promise<JoelclawEnvelope<TResult>> {
    const inProcess = await this.runSdkCapability<TResult>({
      capability: "secrets",
      subcommand: "audit",
      args: {
        tail: options.tail,
      },
      command: "joelclaw secrets audit",
    })

    if (inProcess) return inProcess
    if (!this.shouldUseSubprocessFallback()) {
      throw new Error("subprocess transport is disabled")
    }

    const args = ["secrets", "audit"]
    appendOption(args, "tail", options.tail)

    return await this.runOrThrow<TResult>(args)
  }

  async secretsEnv<TResult = unknown>(options: SecretsEnvOptions = {}): Promise<JoelclawEnvelope<TResult>> {
    const inProcess = await this.runSdkCapability<TResult>({
      capability: "secrets",
      subcommand: "env",
      args: {
        ttl: options.ttl?.trim() || undefined,
        dryRun: options.dryRun ?? false,
        force: options.force ?? false,
      },
      command: "joelclaw secrets env",
    })

    if (inProcess) return inProcess
    if (!this.shouldUseSubprocessFallback()) {
      throw new Error("subprocess transport is disabled")
    }

    const args = ["secrets", "env"]
    if (options.ttl?.trim()) args.push("--ttl", options.ttl.trim())
    appendFlag(args, "dry-run", options.dryRun)
    appendFlag(args, "force", options.force)

    return await this.runOrThrow<TResult>(args)
  }

  async otelList<TResult = unknown>(options: OtelListOptions = {}): Promise<JoelclawEnvelope<TResult>> {
    const inProcess = await this.runSdkCapability<TResult>({
      capability: "otel",
      subcommand: "list",
      args: {
        level: toCsv(options.level),
        source: toCsv(options.source),
        component: toCsv(options.component),
        success: typeof options.success === "boolean" ? (options.success ? "true" : "false") : undefined,
        hours: options.hours ?? 24,
        limit: options.limit ?? 30,
        page: options.page ?? 1,
      },
      command: "joelclaw otel list",
    })

    if (inProcess) return inProcess
    if (!this.shouldUseSubprocessFallback()) {
      throw new Error("subprocess transport is disabled")
    }

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
    const inProcess = await this.runSdkCapability<TResult>({
      capability: "otel",
      subcommand: "search",
      args: {
        query,
        level: toCsv(options.level),
        source: toCsv(options.source),
        component: toCsv(options.component),
        success: typeof options.success === "boolean" ? (options.success ? "true" : "false") : undefined,
        hours: options.hours ?? 24,
        limit: options.limit ?? 30,
        page: options.page ?? 1,
      },
      command: "joelclaw otel search",
    })

    if (inProcess) return inProcess
    if (!this.shouldUseSubprocessFallback()) {
      throw new Error("subprocess transport is disabled")
    }

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
    const inProcess = await this.runSdkCapability<TResult>({
      capability: "otel",
      subcommand: "stats",
      args: {
        source: toCsv(options.source),
        component: toCsv(options.component),
        hours: options.hours ?? 24,
      },
      command: "joelclaw otel stats",
    })

    if (inProcess) return inProcess
    if (!this.shouldUseSubprocessFallback()) {
      throw new Error("subprocess transport is disabled")
    }

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

      const inProcess = await this.runSdkCapability<TResult>({
        capability: "otel",
        subcommand: "emit",
        args: { action },
        command: "joelclaw otel emit",
      })

      if (inProcess) return inProcess
      if (!this.shouldUseSubprocessFallback()) {
        throw new Error("subprocess transport is disabled")
      }

      return await this.runOrThrow<TResult>(["otel", "emit", action])
    }

    if (!event.action?.trim()) {
      throw new Error("otelEmit(event): event.action is required")
    }

    const inProcess = await this.runSdkCapability<TResult>({
      capability: "otel",
      subcommand: "emit",
      args: { event },
      command: "joelclaw otel emit",
    })

    if (inProcess) return inProcess
    if (!this.shouldUseSubprocessFallback()) {
      throw new Error("subprocess transport is disabled")
    }

    return await this.runOrThrow<TResult>(["otel", "emit"], {
      stdinJson: event,
    })
  }

  async recall<TResult = unknown>(
    query: string,
    options: RecallQueryOptions = {},
  ): Promise<JoelclawEnvelope<TResult>> {
    const inProcess = await this.runSdkCapability<TResult>({
      capability: "recall",
      subcommand: "query",
      args: {
        query,
        limit: options.limit ?? 5,
        minScore: options.minScore ?? 0,
        raw: false,
        includeHold: options.includeHold ?? false,
        includeDiscard: options.includeDiscard ?? false,
        budget: options.budget ?? "auto",
        category: options.category ?? "",
      },
      command: "joelclaw recall",
    })

    if (inProcess) return inProcess
    if (!this.shouldUseSubprocessFallback()) {
      throw new Error("subprocess transport is disabled")
    }

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
    if (this.shouldTryInProcess()) {
      const result = await executeSdkCapabilityCommand<RecallCapabilityPayload>({
        capability: "recall",
        subcommand: "query",
        args: {
          query,
          limit: options.limit ?? 5,
          minScore: options.minScore ?? 0,
          raw: true,
          includeHold: false,
          includeDiscard: false,
          budget: options.budget ?? "auto",
          category: options.category ?? "",
        },
      })

      if (result.ok) {
        return result.result.text?.trim() ?? ""
      }

      if (this.#transport === "inprocess") {
        throw new JoelclawCapabilityError({
          capability: "recall",
          subcommand: "query",
          error: result.error,
        })
      }
    }

    if (!this.shouldUseSubprocessFallback()) {
      throw new Error("subprocess transport is disabled")
    }

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
    if (error instanceof JoelclawCapabilityError) {
      return [
        error.message,
        `capability: ${error.capability}/${error.subcommand}`,
        `code: ${error.causePayload.code}`,
        error.causePayload.fix ? `fix: ${error.causePayload.fix}` : null,
      ].filter(Boolean).join("\n")
    }

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
