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

function codeOrFallback(error: CapabilityError): string {
  return error.code || "CAPABILITY_EXECUTION_FAILED"
}

function fixOrFallback(error: CapabilityError, fallback: string): string {
  return error.fix ?? fallback
}

const actionOption = Options.text("action").pipe(
  Options.withDescription("Action verb for log entry (e.g. deploy, restart, configure)"),
)

const toolOption = Options.text("tool").pipe(
  Options.withDescription("Tool/system component emitting the log"),
)

const detailOption = Options.text("detail").pipe(
  Options.withDescription("Human-readable detail of what happened"),
)

const reasonOption = Options.text("reason").pipe(
  Options.withDescription("Optional reason/context for the change"),
  Options.optional,
)

const adapterOption = Options.text("adapter").pipe(
  Options.withDescription("Override capability adapter (phase-0 precedence: flags > env > config)"),
  Options.optional,
)

const logWrite = Command.make(
  "write",
  {
    action: actionOption,
    tool: toolOption,
    detail: detailOption,
    reason: reasonOption,
    adapter: adapterOption,
  },
  ({ action, tool, detail, reason, adapter }) =>
    Effect.gen(function* () {
      const adapterOverride = parseOptionalText(adapter)
      const result = yield* executeCapabilityCommand({
        capability: "log",
        subcommand: "write",
        args: {
          action,
          tool,
          detail,
          reason: parseOptionalText(reason),
        },
        flags: adapterOverride ? { adapter: adapterOverride } : undefined,
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "log write",
            error.message,
            codeOrFallback(error),
            fixOrFallback(error, "Ensure slog CLI is available and arguments are valid."),
            [
              { command: "joelclaw log write --action <action> --tool <tool> --detail <detail>", description: "Retry log write with required fields" },
              { command: "joelclaw logs worker --lines 50", description: "Inspect recent worker logs after logging changes" },
            ]
          )
        )
        return
      }

      yield* Console.log(
        respond(
          "log write",
          result.right,
          [
            { command: "joelclaw logs worker --lines 50", description: "Inspect runtime logs related to this action" },
            { command: "joelclaw otel search \"<query>\" --hours 1", description: "Correlate structured telemetry with the log entry" },
          ]
        )
      )
    })
).pipe(Command.withDescription("Write a structured system log entry (slog)"))

export const logCmd = Command.make("log").pipe(
  Command.withDescription("Capability: structured logging (write)"),
  Command.withSubcommands([logWrite]),
)
