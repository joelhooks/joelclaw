export interface JoelclawNextActionParam {
  readonly description?: string
  readonly value?: string | number
  readonly default?: string | number
  readonly enum?: readonly string[]
  readonly required?: boolean
}

export interface JoelclawNextAction {
  readonly command: string
  readonly description: string
  readonly params?: Record<string, JoelclawNextActionParam>
}

export interface JoelclawEnvelope<TResult = unknown> {
  readonly ok: boolean
  readonly command: string
  readonly result: TResult
  readonly error?: {
    readonly message: string
    readonly code: string
  }
  readonly fix?: string
  readonly next_actions: readonly JoelclawNextAction[]
}

export type JoelclawEnv = Record<string, string | undefined>

export type JoelclawTransport = "subprocess" | "inprocess" | "hybrid"

export interface JoelclawClientOptions {
  readonly bin?: string
  readonly cwd?: string
  readonly env?: JoelclawEnv
  readonly timeoutMs?: number
  readonly transport?: JoelclawTransport
}

export interface JoelclawRunOptions {
  readonly cwd?: string
  readonly env?: JoelclawEnv
  readonly timeoutMs?: number
  readonly stdinText?: string
  readonly stdinJson?: unknown
}

export type OtelEventLevel = "debug" | "info" | "warn" | "error" | "fatal"

export interface OtelListOptions {
  readonly level?: string | readonly string[]
  readonly source?: string | readonly string[]
  readonly component?: string | readonly string[]
  readonly session?: string
  readonly system?: string
  readonly success?: boolean
  readonly hours?: number
  readonly limit?: number
  readonly page?: number
}

export interface OtelSearchOptions extends Omit<OtelListOptions, "page"> {
  readonly page?: number
}

export interface OtelEmitInput {
  readonly action: string
  readonly source?: string
  readonly component?: string
  readonly level?: OtelEventLevel
  readonly success?: boolean
  readonly metadata?: Record<string, unknown>
  readonly id?: string
  readonly timestamp?: number
  readonly error?: string
}

export type RecallBudget = "auto" | "lean" | "balanced" | "deep"

export interface RecallQueryOptions {
  readonly limit?: number
  readonly minScore?: number
  readonly includeHold?: boolean
  readonly includeDiscard?: boolean
  readonly budget?: RecallBudget
  readonly category?: string
}

export interface DeployWorkerOptions {
  readonly restart?: boolean
  readonly force?: boolean
  readonly waitMs?: number
  readonly execute?: boolean
}

export interface LogWriteInput {
  readonly action: string
  readonly tool: string
  readonly detail: string
  readonly reason?: string
}

export type NotifyPriority = "low" | "normal" | "high" | "urgent"

export interface NotifySendInput {
  readonly message: string
  readonly channel?: string
  readonly priority?: NotifyPriority
  readonly context?: Record<string, unknown>
  readonly type?: string
  readonly source?: string
  readonly telegramOnly?: boolean
}

export interface SecretsLeaseInput {
  readonly name: string
  readonly ttl?: string
  readonly clientId?: string
}

export interface SecretsRevokeOptions {
  readonly leaseId?: string
  readonly all?: boolean
}

export interface SecretsAuditOptions {
  readonly tail?: number
}

export interface SecretsEnvOptions {
  readonly ttl?: string
  readonly dryRun?: boolean
  readonly force?: boolean
}

export interface VaultSearchOptions {
  readonly semantic?: boolean
  readonly limit?: number
}

export interface VaultAdrListOptions {
  readonly status?: string
  readonly limit?: number
}

export interface VaultAdrRankOptions {
  readonly status?: string
  readonly limit?: number
  readonly strict?: boolean
}
