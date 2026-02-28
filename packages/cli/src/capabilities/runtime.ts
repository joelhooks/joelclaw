import { Effect } from "effect"
import { type CapabilityFlagsOverride, resolveCapabilitiesConfig } from "./config"
import { type CapabilityContext, type CapabilityError, capabilityError } from "./contract"
import { capabilityRegistry } from "./setup"

export interface CapabilityExecutionOptions {
  readonly capability: string
  readonly subcommand: string
  readonly args: unknown
  readonly cwd?: string
  readonly env?: Record<string, string | undefined>
  readonly flags?: CapabilityFlagsOverride
}

export function buildCapabilityContext(options: {
  cwd?: string
  env?: Record<string, string | undefined>
  overrides?: Record<string, CapabilityFlagsOverride | undefined>
} = {}): CapabilityContext {
  const cwd = options.cwd ?? process.cwd()
  return {
    cwd,
    now: new Date(),
    config: resolveCapabilitiesConfig({
      cwd,
      env: options.env,
      flags: options.overrides,
    }),
  }
}

export function executeCapabilityCommand<TResult = unknown>(
  options: CapabilityExecutionOptions
): Effect.Effect<TResult, CapabilityError> {
  const normalizedCapability = options.capability.trim().toLowerCase()
  const normalizedSubcommand = options.subcommand.trim().toLowerCase()
  const context = buildCapabilityContext({
    cwd: options.cwd,
    env: options.env,
    overrides: {
      [normalizedCapability]: options.flags,
    },
  })

  const resolved = capabilityRegistry.resolve(normalizedCapability, context.config)
  if (!resolved.port) {
    return Effect.fail(
      resolved.error
        ?? capabilityError(
          "CAPABILITY_RESOLVE_FAILED",
          `Unable to resolve capability ${normalizedCapability}`,
          `Run \`joelclaw capabilities\` for supported capability flows.`
        )
    )
  }

  if (!(normalizedSubcommand in resolved.port.commands)) {
    return Effect.fail(
      capabilityError(
        "CAPABILITY_SUBCOMMAND_UNSUPPORTED",
        `Capability "${normalizedCapability}" does not support subcommand "${normalizedSubcommand}"`,
        `Available subcommands: ${Object.keys(resolved.port.commands).join(", ") || "none"}.`
      )
    )
  }

  return resolved.port.execute(normalizedSubcommand as any, options.args, context) as Effect.Effect<TResult, CapabilityError>
}
