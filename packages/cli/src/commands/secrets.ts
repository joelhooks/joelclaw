import { Args, Command, Options } from "@effect/cli"
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

function asError(error: CapabilityError): string {
  return error.message
}

function codeOrFallback(error: CapabilityError): string {
  return error.code || "CAPABILITY_EXECUTION_FAILED"
}

function fixOrFallback(error: CapabilityError, fallback: string): string {
  return error.fix ?? fallback
}

const adapterOption = Options.text("adapter").pipe(
  Options.withDescription("Override capability adapter (phase-0 precedence: flags > env > config)"),
  Options.optional,
)

const secretsStatus = Command.make(
  "status",
  { adapter: adapterOption },
  ({ adapter }) =>
    Effect.gen(function* () {
      const adapterOverride = parseOptionalText(adapter)
      const result = yield* executeCapabilityCommand({
        capability: "secrets",
        subcommand: "status",
        args: {},
        flags: adapterOverride ? { adapter: adapterOverride } : undefined,
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "secrets status",
            asError(error),
            codeOrFallback(error),
            fixOrFallback(error, "Ensure `secrets` CLI and daemon are available."),
            [
              { command: "joelclaw status", description: "Check core system health" },
              { command: "joelclaw secrets lease <name> --ttl <ttl>", description: "Lease a secret once backend is healthy" },
            ]
          )
        )
        return
      }

      yield* Console.log(
        respond(
          "secrets status",
          result.right,
          [
            { command: "joelclaw secrets lease <name> --ttl <ttl>", description: "Lease a short-lived secret value" },
            { command: "joelclaw secrets audit --tail <tail>", description: "Inspect recent secret access audit entries" },
          ]
        )
      )
    })
).pipe(Command.withDescription("Show secrets backend status"))

const leaseTtlOption = Options.text("ttl").pipe(
  Options.withDescription("Lease TTL (e.g., 15m, 1h)"),
  Options.withDefault("1h"),
)

const leaseClientId = Options.text("client-id").pipe(
  Options.withDescription("Optional client identifier for audit attribution"),
  Options.optional,
)

const secretsLease = Command.make(
  "lease",
  {
    name: Args.text({ name: "name" }).pipe(Args.withDescription("Secret name to lease")),
    ttl: leaseTtlOption,
    clientId: leaseClientId,
    adapter: adapterOption,
  },
  ({ name, ttl, clientId, adapter }) =>
    Effect.gen(function* () {
      const adapterOverride = parseOptionalText(adapter)
      const result = yield* executeCapabilityCommand({
        capability: "secrets",
        subcommand: "lease",
        args: {
          name,
          ttl,
          clientId: parseOptionalText(clientId),
        },
        flags: adapterOverride ? { adapter: adapterOverride } : undefined,
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "secrets lease",
            asError(error),
            codeOrFallback(error),
            fixOrFallback(error, "Verify secret exists and backend daemon is healthy."),
            [
              { command: "joelclaw secrets status", description: "Check backend health before retry" },
              { command: "joelclaw secrets lease <name> --ttl <ttl>", description: "Retry with corrected name/ttl" },
            ]
          )
        )
        return
      }

      yield* Console.log(
        respond(
          "secrets lease",
          result.right,
          [
            { command: "joelclaw secrets revoke <lease-id>", description: "Revoke a lease when work is complete" },
            { command: "joelclaw secrets audit --tail 20", description: "Verify lease was recorded in audit trail" },
          ]
        )
      )
    })
).pipe(Command.withDescription("Lease a secret with TTL (JSON envelope)"))

const revokeAllOption = Options.boolean("all").pipe(
  Options.withDescription("Revoke all active leases (killswitch)"),
  Options.withDefault(false),
)

const revokeLeaseIdArg = Args.text({ name: "lease-id" }).pipe(
  Args.withDescription("Lease ID to revoke"),
  Args.optional,
)

const secretsRevoke = Command.make(
  "revoke",
  {
    leaseId: revokeLeaseIdArg,
    all: revokeAllOption,
    adapter: adapterOption,
  },
  ({ leaseId, all, adapter }) =>
    Effect.gen(function* () {
      const adapterOverride = parseOptionalText(adapter)
      const result = yield* executeCapabilityCommand({
        capability: "secrets",
        subcommand: "revoke",
        args: {
          leaseId: parseOptionalText(leaseId),
          all,
        },
        flags: adapterOverride ? { adapter: adapterOverride } : undefined,
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "secrets revoke",
            asError(error),
            codeOrFallback(error),
            fixOrFallback(error, "Provide --all or a valid lease ID."),
            [
              { command: "joelclaw secrets audit --tail 20", description: "Inspect active/recent lease activity" },
              { command: "joelclaw secrets revoke --all", description: "Emergency revoke all leases" },
            ]
          )
        )
        return
      }

      yield* Console.log(
        respond(
          "secrets revoke",
          result.right,
          [
            { command: "joelclaw secrets status", description: "Confirm expected active lease count" },
            { command: "joelclaw secrets audit --tail 20", description: "Inspect revoke event in audit log" },
          ]
        )
      )
    })
).pipe(Command.withDescription("Revoke one lease by ID or all leases with --all"))

const auditTailOption = Options.integer("tail").pipe(
  Options.withDescription("Number of audit entries to show"),
  Options.withDefault(50),
)

const secretsAudit = Command.make(
  "audit",
  {
    tail: auditTailOption,
    adapter: adapterOption,
  },
  ({ tail, adapter }) =>
    Effect.gen(function* () {
      const adapterOverride = parseOptionalText(adapter)
      const result = yield* executeCapabilityCommand({
        capability: "secrets",
        subcommand: "audit",
        args: { tail },
        flags: adapterOverride ? { adapter: adapterOverride } : undefined,
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "secrets audit",
            asError(error),
            codeOrFallback(error),
            fixOrFallback(error, "Ensure secrets backend is running and retry."),
            [
              { command: "joelclaw secrets status", description: "Check backend status" },
              { command: "joelclaw secrets audit --tail 20", description: "Retry with a smaller tail window" },
            ]
          )
        )
        return
      }

      yield* Console.log(
        respond(
          "secrets audit",
          result.right,
          [
            { command: "joelclaw secrets lease <name> --ttl 15m", description: "Acquire a short-lived credential" },
            { command: "joelclaw secrets revoke --all", description: "Emergency revoke all active leases" },
          ]
        )
      )
    })
).pipe(Command.withDescription("View secrets audit trail entries"))

const envTtlOption = Options.text("ttl").pipe(
  Options.withDescription("Override TTL for generated .env.local"),
  Options.optional,
)

const envDryRunOption = Options.boolean("dry-run").pipe(
  Options.withDescription("Preview env sync without writing"),
  Options.withDefault(false),
)

const envForceOption = Options.boolean("force").pipe(
  Options.withDescription("Overwrite existing .env.local"),
  Options.withDefault(false),
)

const secretsEnv = Command.make(
  "env",
  {
    ttl: envTtlOption,
    dryRun: envDryRunOption,
    force: envForceOption,
    adapter: adapterOption,
  },
  ({ ttl, dryRun, force, adapter }) =>
    Effect.gen(function* () {
      const adapterOverride = parseOptionalText(adapter)
      const result = yield* executeCapabilityCommand({
        capability: "secrets",
        subcommand: "env",
        args: {
          ttl: parseOptionalText(ttl),
          dryRun,
          force,
        },
        flags: adapterOverride ? { adapter: adapterOverride } : undefined,
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "secrets env",
            asError(error),
            codeOrFallback(error),
            fixOrFallback(error, "Verify .secrets.json config and backend connectivity."),
            [
              { command: "joelclaw secrets env --dry-run", description: "Preview sync without writing files" },
              { command: "joelclaw secrets status", description: "Check backend status" },
            ]
          )
        )
        return
      }

      yield* Console.log(
        respond(
          "secrets env",
          result.right,
          [
            { command: "joelclaw secrets status", description: "Confirm backend remains healthy" },
            { command: "joelclaw secrets audit --tail 20", description: "Review env sync audit entries" },
          ]
        )
      )
    })
).pipe(Command.withDescription("Generate/sync .env.local from secrets backend"))

export const secretsCmd = Command.make("secrets").pipe(
  Command.withDescription("Capability: secure credentials via agent-secrets backend"),
  Command.withSubcommands([secretsStatus, secretsLease, secretsRevoke, secretsAudit, secretsEnv]),
)
