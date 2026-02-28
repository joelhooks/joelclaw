import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import type { CapabilityError } from "../capabilities/contract"
import { executeCapabilityCommand } from "../capabilities/runtime"
import { respond, respondError } from "../response"

type OptionalText = { _tag: "Some"; value: string } | { _tag: "None" }

function parseOptionalText(value: OptionalText): string | undefined {
  if (value._tag !== "Some") return undefined
  const normalized = value.value.trim()
  return normalized.length > 0 ? normalized : undefined
}

function normalizeWaitMs(value: number): number {
  return Math.max(250, Math.floor(value))
}

function codeOrFallback(error: CapabilityError): string {
  return error.code || "CAPABILITY_EXECUTION_FAILED"
}

function fixOrFallback(error: CapabilityError, fallback: string): string {
  return error.fix ?? fallback
}

const restartOption = Options.boolean("restart").pipe(
  Options.withDescription("Restart worker before register/probe (default: false, safe dry-run path)"),
  Options.withDefault(false),
)

const forceOption = Options.boolean("force").pipe(
  Options.withDescription("Allow restart even with RUNNING/QUEUED runs when --execute is set"),
  Options.withDefault(false),
)

const waitMsOption = Options.integer("wait-ms").pipe(
  Options.withDescription("Wait between restart/register/probe checks (default: 1500ms)"),
  Options.withDefault(1500),
)

const executeOption = Options.boolean("execute").pipe(
  Options.withDescription("Execute deployment (default dry-run plan only)"),
  Options.withDefault(false),
)

const adapterOption = Options.text("adapter").pipe(
  Options.withDescription("Override capability adapter (phase-0 precedence: flags > env > config)"),
  Options.optional,
)

const deployWorker = Command.make(
  "worker",
  {
    restart: restartOption,
    force: forceOption,
    waitMs: waitMsOption,
    execute: executeOption,
    adapter: adapterOption,
  },
  ({ restart, force, waitMs, execute, adapter }) =>
    Effect.gen(function* () {
      const normalizedWaitMs = normalizeWaitMs(waitMs)
      const adapterOverride = parseOptionalText(adapter)
      const result = yield* executeCapabilityCommand({
        capability: "deploy",
        subcommand: "worker",
        args: {
          restart,
          force,
          waitMs: normalizedWaitMs,
          execute,
        },
        flags: adapterOverride ? { adapter: adapterOverride } : undefined,
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "deploy worker",
            error.message,
            codeOrFallback(error),
            fixOrFallback(error, "Verify deploy capability adapter health and retry."),
            [
              { command: "joelclaw capabilities", description: "Inspect capability adapter registry and active flows" },
              { command: "joelclaw inngest status", description: "Check worker/server health before retry" },
              { command: "joelclaw deploy worker --restart --execute", description: "Retry deploy orchestration with restart" },
            ]
          )
        )
        return
      }

      const payload = result.right as { mode?: string }
      const isDryRun = payload.mode === "dry-run"

      yield* Console.log(
        respond(
          "deploy worker",
          result.right,
          isDryRun
            ? [
                {
                  command: "joelclaw deploy worker --restart --execute [--wait-ms <wait-ms>] [--force]",
                  description: "Execute deterministic worker sync deployment",
                  params: {
                    "wait-ms": { description: "Inter-step wait in ms", value: normalizedWaitMs, default: 1500 },
                  },
                },
                { command: "joelclaw inngest status", description: "Check current worker/server state before apply" },
              ]
            : [
                { command: "joelclaw inngest status", description: "Verify worker and Inngest are healthy after deploy" },
                { command: "joelclaw functions", description: "Confirm function registry after deploy sync" },
                { command: "joelclaw deploy worker", description: "Preview the next deploy run in dry-run mode" },
              ]
        )
      )
    })
).pipe(Command.withDescription("Plan/execute deterministic worker deploy sync via capability adapter"))

export const deployCmd = Command.make("deploy").pipe(
  Command.withDescription("Capability: deployment orchestration (worker sync)"),
  Command.withSubcommands([deployWorker]),
)

export const __deployTestUtils = {
  parseOptionalText,
  normalizeWaitMs,
}
