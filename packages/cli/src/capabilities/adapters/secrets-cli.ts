import { Effect, Schema } from "effect"
import { type CapabilityPort, capabilityError } from "../contract"
import { parseJsonFromMixedOutput, runCommandSync } from "../shell"

const SecretsStatusArgsSchema = Schema.Struct({})
const SecretsStatusResultSchema = Schema.Struct({
  backend: Schema.String,
  exitCode: Schema.Number,
  output: Schema.String,
  parsed: Schema.optional(Schema.Unknown),
})

const SecretsLeaseArgsSchema = Schema.Struct({
  name: Schema.String,
  ttl: Schema.optional(Schema.String),
  clientId: Schema.optional(Schema.String),
})

const SecretsLeaseResultSchema = Schema.Struct({
  backend: Schema.String,
  name: Schema.String,
  ttl: Schema.String,
  value: Schema.String,
  leaseId: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.String),
  parsed: Schema.optional(Schema.Unknown),
})

const SecretsRevokeArgsSchema = Schema.Struct({
  leaseId: Schema.optional(Schema.String),
  all: Schema.optional(Schema.Boolean),
})

const SecretsRevokeResultSchema = Schema.Struct({
  backend: Schema.String,
  exitCode: Schema.Number,
  target: Schema.String,
  output: Schema.String,
  parsed: Schema.optional(Schema.Unknown),
})

const SecretsAuditArgsSchema = Schema.Struct({
  tail: Schema.optional(Schema.Number),
})

const SecretsAuditResultSchema = Schema.Struct({
  backend: Schema.String,
  exitCode: Schema.Number,
  tail: Schema.Number,
  output: Schema.String,
  parsed: Schema.optional(Schema.Unknown),
})

const SecretsEnvArgsSchema = Schema.Struct({
  ttl: Schema.optional(Schema.String),
  dryRun: Schema.optional(Schema.Boolean),
  force: Schema.optional(Schema.Boolean),
})

const SecretsEnvResultSchema = Schema.Struct({
  backend: Schema.String,
  exitCode: Schema.Number,
  output: Schema.String,
  ttl: Schema.optional(Schema.String),
  dryRun: Schema.Boolean,
  force: Schema.Boolean,
  parsed: Schema.optional(Schema.Unknown),
})

const commands = {
  status: {
    summary: "Inspect agent-secrets daemon status",
    argsSchema: SecretsStatusArgsSchema,
    resultSchema: SecretsStatusResultSchema,
  },
  lease: {
    summary: "Lease a secret with TTL",
    argsSchema: SecretsLeaseArgsSchema,
    resultSchema: SecretsLeaseResultSchema,
  },
  revoke: {
    summary: "Revoke a lease or trigger killswitch",
    argsSchema: SecretsRevokeArgsSchema,
    resultSchema: SecretsRevokeResultSchema,
  },
  audit: {
    summary: "Read audit log entries from secrets backend",
    argsSchema: SecretsAuditArgsSchema,
    resultSchema: SecretsAuditResultSchema,
  },
  env: {
    summary: "Generate or refresh .env.local via secrets backend",
    argsSchema: SecretsEnvArgsSchema,
    resultSchema: SecretsEnvResultSchema,
  },
} as const

type SecretsCommandName = keyof typeof commands

type SecretsLeaseResponse = {
  ok?: unknown
  success?: unknown
  result?: unknown
  value?: unknown
  token?: unknown
  secret?: unknown
  leaseId?: unknown
  lease_id?: unknown
  expiresAt?: unknown
  expires_at?: unknown
  error?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

function extractBackendError(parsed: unknown): { message?: string; code?: string; fix?: string } {
  if (!isRecord(parsed)) return {}
  const error = isRecord(parsed.error) ? parsed.error : {}
  return {
    message: asString(error.message) ?? asString(parsed.message),
    code: asString(error.code) ?? asString(parsed.code),
    fix: asString(parsed.fix),
  }
}

function extractLeaseValue(parsed: SecretsLeaseResponse): string | undefined {
  const direct = asString(parsed.result)
    ?? asString(parsed.value)
    ?? asString(parsed.token)
    ?? asString(parsed.secret)
  if (direct) return direct

  const nested = isRecord(parsed.result) ? parsed.result : isRecord(parsed.value) ? parsed.value : null
  if (nested) {
    return asString(nested.value) ?? asString(nested.token) ?? asString(nested.secret) ?? asString(nested.result)
  }

  return undefined
}

function buildMissingBackendError(command: string) {
  return capabilityError(
    "SECRETS_BACKEND_UNAVAILABLE",
    "agent-secrets CLI is not available in PATH",
    `Install or start agent-secrets, then run: secrets ${command}`
  )
}

function runSecretsCommand(command: string[]): ReturnType<typeof runCommandSync> {
  return runCommandSync(command, { timeoutMs: 15_000, env: { TERM: "dumb" } })
}

function decodeArgs<K extends SecretsCommandName>(
  subcommand: K,
  args: unknown,
): Effect.Effect<Schema.Schema.Type<(typeof commands)[K]["argsSchema"]>, ReturnType<typeof capabilityError>> {
  return Schema.decodeUnknown(commands[subcommand].argsSchema)(args).pipe(
    Effect.mapError((error) =>
      capabilityError(
        "SECRETS_INVALID_ARGS",
        Schema.formatIssueSync(error),
        `Check \`joelclaw secrets ${String(subcommand)} --help\` for valid arguments.`,
      )
    )
  )
}

export const secretsCliAdapter: CapabilityPort<typeof commands> = {
  capability: "secrets",
  adapter: "agent-secrets-cli",
  commands,
  execute(subcommand, rawArgs) {
    return Effect.gen(function* () {
      switch (subcommand) {
        case "status": {
          const _args = yield* decodeArgs("status", rawArgs)
          const proc = runSecretsCommand(["secrets", "status"])

          if (proc.missingExecutable) {
            return yield* Effect.fail(buildMissingBackendError("status"))
          }

          const parsed = parseJsonFromMixedOutput(proc.stdout, proc.stderr)
          const backendError = extractBackendError(parsed)
          if (proc.exitCode !== 0 || backendError.message) {
            return yield* Effect.fail(
              capabilityError(
                "SECRETS_STATUS_FAILED",
                (backendError.message ?? proc.stderr) || (proc.stdout || "Failed to fetch secrets status"),
                backendError.fix ?? "Run `secrets status` directly and ensure the daemon is running."
              )
            )
          }

          return {
            backend: "agent-secrets-cli",
            exitCode: proc.exitCode,
            output: proc.stdout || proc.stderr,
            ...(parsed !== undefined ? { parsed } : {}),
          }
        }

        case "lease": {
          const args = yield* decodeArgs("lease", rawArgs)
          const ttl = args.ttl?.trim() || "1h"
          const command = ["secrets", "lease", args.name, "--ttl", ttl, "--json"]
          if (args.clientId?.trim()) {
            command.push("--client-id", args.clientId.trim())
          }

          const proc = runSecretsCommand(command)
          if (proc.missingExecutable) {
            return yield* Effect.fail(buildMissingBackendError("lease <name>"))
          }

          const parsed = parseJsonFromMixedOutput(proc.stdout, proc.stderr) as SecretsLeaseResponse | undefined
          const backendError = extractBackendError(parsed)
          const failed = proc.exitCode !== 0 || (isRecord(parsed) && parsed.ok === false) || backendError.message
          if (failed) {
            return yield* Effect.fail(
              capabilityError(
                "SECRETS_LEASE_FAILED",
                (backendError.message ?? proc.stderr) || (proc.stdout || `Failed to lease secret "${args.name}"`),
                backendError.fix ?? `Verify secret "${args.name}" exists and secrets daemon is healthy.`
              )
            )
          }

          const value = parsed ? extractLeaseValue(parsed) : asString(proc.stdout)
          if (!value) {
            return yield* Effect.fail(
              capabilityError(
                "SECRETS_LEASE_EMPTY",
                `Secret "${args.name}" returned an empty value`,
                `Check secret value with \`secrets lease ${args.name} --ttl ${ttl}\`.`
              )
            )
          }

          return {
            backend: "agent-secrets-cli",
            name: args.name,
            ttl,
            value,
            ...(parsed && asString(parsed.leaseId ?? parsed.lease_id) ? { leaseId: asString(parsed.leaseId ?? parsed.lease_id) } : {}),
            ...(parsed && asString(parsed.expiresAt ?? parsed.expires_at) ? { expiresAt: asString(parsed.expiresAt ?? parsed.expires_at) } : {}),
            ...(parsed ? { parsed } : {}),
          }
        }

        case "revoke": {
          const args = yield* decodeArgs("revoke", rawArgs)
          const revokeAll = args.all === true
          const command = revokeAll
            ? ["secrets", "revoke", "--all"]
            : args.leaseId?.trim()
              ? ["secrets", "revoke", args.leaseId.trim()]
              : []

          if (command.length === 0) {
            return yield* Effect.fail(
              capabilityError(
                "SECRETS_REVOKE_TARGET_REQUIRED",
                "Provide a lease ID or set --all to revoke all leases",
                "Use `joelclaw secrets revoke <lease-id>` or `joelclaw secrets revoke --all`."
              )
            )
          }

          const proc = runSecretsCommand(command)
          if (proc.missingExecutable) {
            return yield* Effect.fail(buildMissingBackendError("revoke"))
          }

          const parsed = parseJsonFromMixedOutput(proc.stdout, proc.stderr)
          const backendError = extractBackendError(parsed)
          if (proc.exitCode !== 0 || backendError.message) {
            return yield* Effect.fail(
              capabilityError(
                "SECRETS_REVOKE_FAILED",
                (backendError.message ?? proc.stderr) || (proc.stdout || "Failed to revoke secret lease"),
                backendError.fix ?? "Retry with a valid lease ID or `--all`."
              )
            )
          }

          return {
            backend: "agent-secrets-cli",
            exitCode: proc.exitCode,
            target: revokeAll ? "all" : args.leaseId ?? "unknown",
            output: proc.stdout || proc.stderr,
            ...(parsed !== undefined ? { parsed } : {}),
          }
        }

        case "audit": {
          const args = yield* decodeArgs("audit", rawArgs)
          const tail = Number.isFinite(args.tail) ? Math.max(0, Math.floor(args.tail ?? 50)) : 50
          const command = ["secrets", "audit", "--tail", String(tail)]
          const proc = runSecretsCommand(command)

          if (proc.missingExecutable) {
            return yield* Effect.fail(buildMissingBackendError("audit"))
          }

          const parsed = parseJsonFromMixedOutput(proc.stdout, proc.stderr)
          const backendError = extractBackendError(parsed)
          if (proc.exitCode !== 0 || backendError.message) {
            return yield* Effect.fail(
              capabilityError(
                "SECRETS_AUDIT_FAILED",
                (backendError.message ?? proc.stderr) || (proc.stdout || "Failed to read secrets audit log"),
                backendError.fix ?? "Run `secrets audit --tail 20` directly to inspect backend output."
              )
            )
          }

          return {
            backend: "agent-secrets-cli",
            exitCode: proc.exitCode,
            tail,
            output: proc.stdout || proc.stderr,
            ...(parsed !== undefined ? { parsed } : {}),
          }
        }

        case "env": {
          const args = yield* decodeArgs("env", rawArgs)
          const command = ["secrets", "env"]
          if (args.ttl?.trim()) command.push("--ttl", args.ttl.trim())
          if (args.dryRun === true) command.push("--dry-run")
          if (args.force === true) command.push("--force")

          const proc = runSecretsCommand(command)
          if (proc.missingExecutable) {
            return yield* Effect.fail(buildMissingBackendError("env"))
          }

          const parsed = parseJsonFromMixedOutput(proc.stdout, proc.stderr)
          const backendError = extractBackendError(parsed)
          if (proc.exitCode !== 0 || backendError.message) {
            return yield* Effect.fail(
              capabilityError(
                "SECRETS_ENV_FAILED",
                (backendError.message ?? proc.stderr) || (proc.stdout || "Failed to sync .env.local from secrets backend"),
                backendError.fix ?? "Run `secrets env --dry-run` and verify .secrets.json exists."
              )
            )
          }

          return {
            backend: "agent-secrets-cli",
            exitCode: proc.exitCode,
            output: proc.stdout || proc.stderr,
            ...(args.ttl?.trim() ? { ttl: args.ttl.trim() } : {}),
            dryRun: args.dryRun === true,
            force: args.force === true,
            ...(parsed !== undefined ? { parsed } : {}),
          }
        }

        default:
          return yield* Effect.fail(
            capabilityError(
              "SECRETS_SUBCOMMAND_UNSUPPORTED",
              `Unsupported secrets subcommand: ${String(subcommand)}`
            )
          )
      }
    })
  },
}
