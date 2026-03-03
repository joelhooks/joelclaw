import { Effect } from "effect"
import { scriptedDeployAdapter } from "./adapters/deploy-scripted"
import { secretsCliAdapter } from "./adapters/secrets-cli"
import { slogCliAdapter } from "./adapters/slog-cli"
import { typesenseOtelAdapter } from "./adapters/typesense-otel"
import { typesenseRecallAdapter } from "./adapters/typesense-recall"
import { type CapabilityContext, type CapabilityError, capabilityError } from "./contract"

const capabilityRegistry = {
  deploy: scriptedDeployAdapter,
  log: slogCliAdapter,
  otel: typesenseOtelAdapter,
  recall: typesenseRecallAdapter,
  secrets: secretsCliAdapter,
} as const

export type SdkCapability = keyof typeof capabilityRegistry

export interface SdkCapabilityExecutionOptions {
  readonly capability: SdkCapability
  readonly subcommand: string
  readonly args: unknown
  readonly cwd?: string
}

export type SdkCapabilityExecutionResult<TResult = unknown> =
  | {
      ok: true
      result: TResult
    }
  | {
      ok: false
      error: CapabilityError
    }

function buildRuntimeContext(cwd?: string): CapabilityContext {
  return {
    cwd: cwd ?? process.cwd(),
    now: new Date(),
    config: {
      capabilities: {},
      paths: {
        projectConfig: "",
        userConfig: "",
      },
    },
  }
}

export async function executeSdkCapabilityCommand<TResult = unknown>(
  options: SdkCapabilityExecutionOptions,
): Promise<SdkCapabilityExecutionResult<TResult>> {
  const capability = options.capability.trim().toLowerCase() as SdkCapability
  const subcommand = options.subcommand.trim().toLowerCase()
  const adapter = capabilityRegistry[capability]

  if (!adapter) {
    return {
      ok: false,
      error: capabilityError(
        "SDK_CAPABILITY_UNSUPPORTED",
        `Unsupported SDK capability: ${options.capability}`,
        `Supported capabilities: ${Object.keys(capabilityRegistry).join(", ")}`,
      ),
    }
  }

  if (!(subcommand in adapter.commands)) {
    return {
      ok: false,
      error: capabilityError(
        "SDK_SUBCOMMAND_UNSUPPORTED",
        `Capability "${capability}" does not support subcommand "${subcommand}"`,
        `Available subcommands: ${Object.keys(adapter.commands).join(", ")}`,
      ),
    }
  }

  const result = await Effect.runPromise(
    adapter.execute(subcommand as never, options.args as never, buildRuntimeContext(options.cwd)).pipe(Effect.either),
  )

  if (result._tag === "Left") {
    return {
      ok: false,
      error: result.left,
    }
  }

  return {
    ok: true,
    result: result.right as TResult,
  }
}
