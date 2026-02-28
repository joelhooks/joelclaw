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

function parseContextJson(input: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(input)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        error: "--context must decode to a JSON object",
      }
    }

    return {
      ok: true,
      value: parsed as Record<string, unknown>,
    }
  } catch (error) {
    return {
      ok: false,
      error: `Invalid JSON in --context: ${String(error)}`,
    }
  }
}

function normalizeTimeoutMs(value: number): number {
  return Math.max(1_000, Math.floor(value))
}

function normalizeMaxOutputLines(value: number): number {
  return Math.max(5, Math.floor(value))
}

function codeOrFallback(error: CapabilityError): string {
  return error.code || "CAPABILITY_EXECUTION_FAILED"
}

function fixOrFallback(error: CapabilityError, fallback: string): string {
  return error.fix ?? fallback
}

const HEAL_PHASES = ["diagnose", "fix", "verify", "rollback", "all"] as const

const adapterOption = Options.text("adapter").pipe(
  Options.withDescription("Override capability adapter (phase-0 precedence: flags > env > config)"),
  Options.optional,
)

const healList = Command.make(
  "list",
  { adapter: adapterOption },
  ({ adapter }) =>
    Effect.gen(function* () {
      const adapterOverride = parseOptionalText(adapter)
      const result = yield* executeCapabilityCommand({
        capability: "heal",
        subcommand: "list",
        args: {},
        flags: adapterOverride ? { adapter: adapterOverride } : undefined,
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "heal list",
            error.message,
            codeOrFallback(error),
            fixOrFallback(error, "Verify heal capability adapter configuration and retry."),
            [
              { command: "joelclaw capabilities", description: "Inspect capability adapter registry and flows" },
              { command: "joelclaw recover list", description: "Fallback to legacy recover surface" },
            ]
          )
        )
        return
      }

      yield* Console.log(
        respond(
          "heal list",
          result.right,
          [
            {
              command: "joelclaw heal run <error-code> [--phase <phase>] [--context <context>]",
              description: "Preview deterministic runbook phase plan",
              params: {
                "error-code": { description: "Runbook error code", required: true },
                phase: { description: "Runbook phase", value: "fix", enum: HEAL_PHASES },
                context: { description: "JSON context for placeholders", value: "{}", default: "{}" },
              },
            },
            { command: "joelclaw recover list", description: "Legacy deterministic runbook list" },
          ]
        )
      )
    })
).pipe(Command.withDescription("List deterministic heal runbooks"))

const healRun = Command.make(
  "run",
  {
    code: Args.text({ name: "error-code" }).pipe(
      Args.withDescription("Runbook error code (e.g. RUN_FAILED, REDIS_CONNECT_FAILED)")
    ),
    phase: Options.choice("phase", HEAL_PHASES).pipe(
      Options.withDescription("Runbook phase to plan/execute"),
      Options.withDefault("fix"),
    ),
    context: Options.text("context").pipe(
      Options.withDescription("JSON object for placeholder substitution"),
      Options.withDefault("{}"),
    ),
    execute: Options.boolean("execute").pipe(
      Options.withDescription("Execute selected phase commands (default dry-run)"),
      Options.withDefault(false),
    ),
    timeoutMs: Options.integer("timeout-ms").pipe(
      Options.withDescription("Per-command timeout when --execute is set"),
      Options.withDefault(20_000),
    ),
    maxOutputLines: Options.integer("max-output-lines").pipe(
      Options.withDescription("Max output lines captured per executed command"),
      Options.withDefault(40),
    ),
    adapter: adapterOption,
  },
  ({ code, phase, context, execute, timeoutMs, maxOutputLines, adapter }) =>
    Effect.gen(function* () {
      const parsedContext = parseContextJson(context)
      if (!parsedContext.ok) {
        yield* Console.log(
          respondError(
            "heal run",
            parsedContext.error,
            "INVALID_CONTEXT_JSON",
            "Pass --context as a valid JSON object",
            [
              {
                command: "joelclaw heal run <error-code> --context <context>",
                description: "Retry with valid JSON context",
                params: {
                  "error-code": { description: "Runbook error code", value: code, required: true },
                  context: { description: "JSON context", value: "{}" },
                },
              },
            ]
          )
        )
        return
      }

      const adapterOverride = parseOptionalText(adapter)
      const result = yield* executeCapabilityCommand({
        capability: "heal",
        subcommand: "run",
        args: {
          code,
          phase,
          context: parsedContext.value,
          execute,
          timeoutMs: normalizeTimeoutMs(timeoutMs),
          maxOutputLines: normalizeMaxOutputLines(maxOutputLines),
        },
        flags: adapterOverride ? { adapter: adapterOverride } : undefined,
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "heal run",
            error.message,
            codeOrFallback(error),
            fixOrFallback(error, "Inspect runbook and context, then retry."),
            [
              { command: "joelclaw heal list", description: "List available heal runbooks" },
              {
                command: "joelclaw heal run <error-code> --phase diagnose [--context <context>]",
                description: "Preview diagnostics phase for the runbook",
                params: {
                  "error-code": { description: "Runbook error code", value: code, required: true },
                  context: { description: "JSON context", value: context, default: "{}" },
                },
              },
              { command: "joelclaw recover list", description: "Fallback to legacy recover command surface" },
            ]
          )
        )
        return
      }

      const payload = result.right as { mode?: string }
      const isDryRun = payload.mode === "dry-run"

      yield* Console.log(
        respond(
          "heal run",
          result.right,
          isDryRun
            ? [
                {
                  command: "joelclaw heal run <error-code> --phase <phase> --execute [--context <context>]",
                  description: "Execute selected runbook phase after reviewing dry-run plan",
                  params: {
                    "error-code": { description: "Runbook error code", value: code, required: true },
                    phase: { description: "Runbook phase", value: phase, enum: HEAL_PHASES },
                    context: { description: "JSON context", value: context, default: "{}" },
                  },
                },
                { command: "joelclaw status", description: "Check system health before executing fixes" },
              ]
            : [
                {
                  command: "joelclaw heal run <error-code> --phase verify --execute [--context <context>]",
                  description: "Run explicit verify phase after fix execution",
                  params: {
                    "error-code": { description: "Runbook error code", value: code, required: true },
                    context: { description: "JSON context", value: context, default: "{}" },
                  },
                },
                { command: "joelclaw status", description: "Confirm overall system health" },
                { command: "joelclaw recover list", description: "Legacy recover fallback" },
              ]
        )
      )
    })
).pipe(Command.withDescription("Plan/execute deterministic heal runbook phases"))

export const healCmd = Command.make("heal").pipe(
  Command.withDescription("Capability: deterministic runbook-based recovery orchestration"),
  Command.withSubcommands([healList, healRun]),
)

export const __healTestUtils = {
  parseOptionalText,
  parseContextJson,
  normalizeTimeoutMs,
  normalizeMaxOutputLines,
}
