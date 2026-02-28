import { Effect, Schema } from "effect"
import { type CapabilityPort, capabilityError } from "../contract"
import { parseJsonFromMixedOutput, runCommandSync } from "../shell"

const LogWriteArgsSchema = Schema.Struct({
  action: Schema.String,
  tool: Schema.String,
  detail: Schema.String,
  reason: Schema.optional(Schema.String),
})

const LogWriteResultSchema = Schema.Struct({
  backend: Schema.String,
  exitCode: Schema.Number,
  output: Schema.String,
  action: Schema.String,
  tool: Schema.String,
  detail: Schema.String,
  reason: Schema.optional(Schema.String),
  parsed: Schema.optional(Schema.Unknown),
})

const commands = {
  write: {
    summary: "Write a structured system log entry via slog",
    argsSchema: LogWriteArgsSchema,
    resultSchema: LogWriteResultSchema,
  },
} as const

function decodeArgs<K extends keyof typeof commands>(
  subcommand: K,
  args: unknown,
): Effect.Effect<Schema.Schema.Type<(typeof commands)[K]["argsSchema"]>, ReturnType<typeof capabilityError>> {
  return Schema.decodeUnknown(commands[subcommand].argsSchema)(args).pipe(
    Effect.mapError((error) =>
      capabilityError(
        "LOG_INVALID_ARGS",
        Schema.formatIssueSync(error),
        `Check \`joelclaw log ${String(subcommand)} --help\` for valid arguments.`
      )
    )
  )
}

function asMessage(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined
  const error = (parsed as Record<string, unknown>).error
  if (typeof error === "string" && error.trim().length > 0) return error
  if (typeof (error as { message?: unknown })?.message === "string") {
    const value = ((error as { message: string }).message ?? "").trim()
    return value.length > 0 ? value : undefined
  }
  return undefined
}

export const slogCliAdapter: CapabilityPort<typeof commands> = {
  capability: "log",
  adapter: "slog-cli",
  commands,
  execute(subcommand, rawArgs) {
    return Effect.gen(function* () {
      switch (subcommand) {
        case "write": {
          const args = yield* decodeArgs("write", rawArgs)
          const command = [
            "slog",
            "write",
            "--action",
            args.action,
            "--tool",
            args.tool,
            "--detail",
            args.detail,
          ]
          if (args.reason?.trim()) {
            command.push("--reason", args.reason.trim())
          }

          const proc = runCommandSync(command, { timeoutMs: 10_000, env: { TERM: "dumb" } })
          if (proc.missingExecutable) {
            return yield* Effect.fail(
              capabilityError(
                "LOG_BACKEND_UNAVAILABLE",
                "`slog` CLI is not available in PATH",
                "Install/compile slog and retry: slog --help"
              )
            )
          }

          const parsed = parseJsonFromMixedOutput(proc.stdout, proc.stderr)
          const message = asMessage(parsed)
          if (proc.exitCode !== 0 || message) {
            return yield* Effect.fail(
              capabilityError(
                "LOG_WRITE_FAILED",
                (message ?? proc.stderr) || (proc.stdout || "Failed to write system log entry"),
                "Retry with valid --action/--tool/--detail values or run `slog write --help`."
              )
            )
          }

          return {
            backend: "slog-cli",
            exitCode: proc.exitCode,
            output: proc.stdout || proc.stderr || "slog write completed",
            action: args.action,
            tool: args.tool,
            detail: args.detail,
            ...(args.reason?.trim() ? { reason: args.reason.trim() } : {}),
            ...(parsed !== undefined ? { parsed } : {}),
          }
        }
        default:
          return yield* Effect.fail(
            capabilityError(
              "LOG_SUBCOMMAND_UNSUPPORTED",
              `Unsupported log subcommand: ${String(subcommand)}`
            )
          )
      }
    })
  },
}
