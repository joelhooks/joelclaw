import { existsSync } from "node:fs"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { type CapabilityContext, type CapabilityPort, capabilityError } from "../contract"
import { parseJsonFromMixedOutput, runCommandSync } from "../shell"

const DeployWorkerArgsSchema = Schema.Struct({
  restart: Schema.optional(Schema.Boolean),
  force: Schema.optional(Schema.Boolean),
  waitMs: Schema.optional(Schema.Number),
  execute: Schema.optional(Schema.Boolean),
})

const DeployWorkerResultSchema = Schema.Struct({
  backend: Schema.String,
  operation: Schema.String,
  mode: Schema.Literal("dry-run", "executed"),
  command: Schema.Array(Schema.String),
  output: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  downstreamOk: Schema.optional(Schema.Boolean),
  downstreamCommand: Schema.optional(Schema.String),
  downstreamResult: Schema.optional(Schema.Unknown),
  parsed: Schema.optional(Schema.Unknown),
})

const commands = {
  worker: {
    summary: "Plan/execute deterministic worker sync deployment via inngest sync-worker",
    argsSchema: DeployWorkerArgsSchema,
    resultSchema: DeployWorkerResultSchema,
  },
} as const

type DeployCommandName = keyof typeof commands

type DeployEnvelope = {
  ok?: unknown
  command?: unknown
  result?: unknown
  error?: unknown
  fix?: unknown
}

function decodeArgs<K extends DeployCommandName>(
  subcommand: K,
  args: unknown,
): Effect.Effect<Schema.Schema.Type<(typeof commands)[K]["argsSchema"]>, ReturnType<typeof capabilityError>> {
  return Schema.decodeUnknown(commands[subcommand].argsSchema)(args).pipe(
    Effect.mapError((error) =>
      capabilityError(
        "DEPLOY_INVALID_ARGS",
        Schema.formatIssueSync(error),
        `Check \`joelclaw deploy ${String(subcommand)} --help\` for valid arguments.`
      )
    )
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function normalizeWaitMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1500
  return Math.max(250, Math.floor(value))
}

function buildDeployCommand(
  args: Schema.Schema.Type<typeof DeployWorkerArgsSchema>,
  context: CapabilityContext,
): string[] {
  const waitMs = normalizeWaitMs(args.waitMs)
  const cliEntry = join(context.cwd, "packages", "cli", "src", "cli.ts")
  const command = existsSync(cliEntry)
    ? ["bun", "run", cliEntry, "inngest", "sync-worker"]
    : ["joelclaw", "inngest", "sync-worker"]

  if (args.restart === true) {
    command.push("--restart")
  }

  if (args.force === true) {
    command.push("--force")
  }

  command.push("--wait-ms", String(waitMs))
  return command
}

function readEnvelope(parsed: unknown): DeployEnvelope | undefined {
  return isRecord(parsed) ? (parsed as DeployEnvelope) : undefined
}

export const scriptedDeployAdapter: CapabilityPort<typeof commands> = {
  capability: "deploy",
  adapter: "scripted-deploy",
  commands,
  execute(subcommand, rawArgs, context) {
    return Effect.gen(function* () {
      switch (subcommand) {
        case "worker": {
          const args = yield* decodeArgs("worker", rawArgs)
          const command = buildDeployCommand(args, context)

          if (args.execute !== true) {
            return {
              backend: "scripted-deploy",
              operation: "worker-sync",
              mode: "dry-run" as const,
              command,
              output: "Dry-run only. Re-run with --execute to apply worker sync deployment.",
            }
          }

          const proc = runCommandSync(command, {
            timeoutMs: Math.max(30_000, normalizeWaitMs(args.waitMs) * 20),
            env: { TERM: "dumb" },
          })

          if (proc.missingExecutable) {
            return yield* Effect.fail(
              capabilityError(
                "DEPLOY_BACKEND_UNAVAILABLE",
                `Deploy backend executable is unavailable: ${proc.error ?? proc.stderr ?? "unknown error"}`,
                "Install bun/joelclaw CLI and retry `joelclaw deploy worker --execute`."
              )
            )
          }

          const parsed = parseJsonFromMixedOutput(proc.stdout, proc.stderr)
          const envelope = readEnvelope(parsed)
          const downstreamOk = asBoolean(envelope?.ok)
          const downstreamError = isRecord(envelope?.error) ? envelope?.error as Record<string, unknown> : null
          const downstreamErrorMessage = asString(downstreamError?.message)

          if (proc.exitCode !== 0 || downstreamOk === false) {
            return yield* Effect.fail(
              capabilityError(
                "DEPLOY_WORKER_SYNC_FAILED",
                downstreamErrorMessage
                  ?? proc.stderr
                  ?? proc.stdout
                  ?? "Worker sync deployment failed",
                asString(envelope?.fix)
                  ?? "Run `joelclaw inngest sync-worker --restart` directly for deeper diagnostics."
              )
            )
          }

          const output = proc.stdout || proc.stderr || "Worker sync deployment completed"

          return {
            backend: "scripted-deploy",
            operation: "worker-sync",
            mode: "executed" as const,
            command,
            output,
            exitCode: proc.exitCode,
            ...(typeof downstreamOk === "boolean" ? { downstreamOk } : {}),
            ...(asString(envelope?.command) ? { downstreamCommand: asString(envelope?.command) } : {}),
            ...(envelope && "result" in envelope ? { downstreamResult: envelope.result } : {}),
            ...(parsed !== undefined ? { parsed } : {}),
          }
        }
        default:
          return yield* Effect.fail(
            capabilityError(
              "DEPLOY_SUBCOMMAND_UNSUPPORTED",
              `Unsupported deploy subcommand: ${String(subcommand)}`
            )
          )
      }
    })
  },
}

export const __deployAdapterTestUtils = {
  normalizeWaitMs,
  buildDeployCommand,
}
