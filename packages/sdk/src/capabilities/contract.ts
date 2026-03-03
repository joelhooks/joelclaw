import type { Effect, Schema } from "effect"

export type CapabilityConfigSource = "default" | "user" | "project" | "env" | "flag"

export type CapabilityAdapterValue = string | number | boolean

export interface CapabilityAdapterSettings {
  readonly [key: string]: CapabilityAdapterValue
}

export interface ResolvedCapabilityConfig {
  readonly enabled: boolean
  readonly adapter: string
  readonly adapters: Record<string, CapabilityAdapterSettings>
  readonly source: {
    readonly enabled: CapabilityConfigSource
    readonly adapter: CapabilityConfigSource
  }
}

export interface JoelclawCapabilitiesConfig {
  readonly capabilities: Record<string, ResolvedCapabilityConfig>
  readonly paths: {
    readonly projectConfig: string
    readonly userConfig: string
  }
}

export interface CapabilityContext {
  readonly cwd: string
  readonly now: Date
  readonly config: JoelclawCapabilitiesConfig
}

export interface CapabilityCommandSpec<TArgs, TResult> {
  readonly summary: string
  readonly argsSchema: Schema.Schema<TArgs>
  readonly resultSchema: Schema.Schema<TResult>
}

export interface CapabilityError {
  readonly code: string
  readonly message: string
  readonly retriable: boolean
  readonly fix?: string
}

export interface CapabilityPort<
  TCommands extends Record<string, CapabilityCommandSpec<any, any>>,
> {
  readonly capability: string
  readonly adapter: string
  readonly commands: TCommands
  execute<K extends keyof TCommands>(
    subcommand: K,
    args: Schema.Schema.Type<TCommands[K]["argsSchema"]>,
    context: CapabilityContext,
  ): Effect.Effect<
    Schema.Schema.Type<TCommands[K]["resultSchema"]>,
    CapabilityError
  >
}

export type AnyCapabilityPort = CapabilityPort<Record<string, CapabilityCommandSpec<any, any>>>

export const capabilityError = (
  code: string,
  message: string,
  fix?: string,
  retriable = false,
): CapabilityError => ({
  code,
  message,
  retriable,
  ...(fix ? { fix } : {}),
})
