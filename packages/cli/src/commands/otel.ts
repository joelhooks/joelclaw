import { readFileSync } from "node:fs"
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import type { CapabilityError } from "../capabilities/contract"
import { executeCapabilityCommand } from "../capabilities/runtime"
import { respond, respondError } from "../response"

type OptionalValue<T> = { _tag: "Some"; value: T } | { _tag: "None" }
type OptionalText = OptionalValue<string>

function parseOptionText(value: OptionalText): string | undefined {
  if (value._tag !== "Some") return undefined
  const trimmed = value.value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function parseOptionalValue<T>(value: OptionalValue<T>): T | undefined {
  return value._tag === "Some" ? value.value : undefined
}

function parseJsonObject(input: string | undefined): Record<string, unknown> | null {
  if (!input) return {}
  try {
    const parsed = JSON.parse(input)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function readStdinJsonObject(): {
  ok: true
  value?: Record<string, unknown>
} | {
  ok: false
  message: string
} {
  if (process.stdin.isTTY) return { ok: true }

  try {
    const raw = readFileSync(0, "utf8")
    const trimmed = raw.trim()
    if (trimmed.length === 0) return { ok: true }
    const parsed = parseJsonObject(trimmed)
    if (!parsed) {
      return {
        ok: false,
        message: "stdin payload must be a valid JSON object.",
      }
    }
    return { ok: true, value: parsed }
  } catch (error) {
    return {
      ok: false,
      message: `Unable to read stdin: ${String(error)}`,
    }
  }
}

function codeOrFallback(error: CapabilityError, fallback: string): string {
  return error.code || fallback
}

function fixOrFallback(error: CapabilityError, fallback: string): string {
  return error.fix ?? fallback
}

const levelOpt = Options.text("level").pipe(
  Options.withDescription("Comma-separated levels (debug,info,warn,error,fatal)"),
  Options.optional,
)

const sourceOpt = Options.text("source").pipe(
  Options.withDescription("Comma-separated source filter"),
  Options.optional,
)

const componentOpt = Options.text("component").pipe(
  Options.withDescription("Comma-separated component filter"),
  Options.optional,
)

const successOpt = Options.text("success").pipe(
  Options.withDescription("true | false"),
  Options.optional,
)

const hoursOpt = Options.integer("hours").pipe(
  Options.withAlias("h"),
  Options.withDefault(24),
  Options.withDescription("Lookback window in hours"),
)

const limitOpt = Options.integer("limit").pipe(
  Options.withAlias("n"),
  Options.withDefault(30),
  Options.withDescription("Results per page"),
)

const pageOpt = Options.integer("page").pipe(
  Options.withDefault(1),
  Options.withDescription("Page number"),
)

const emitLevelOpt = Options.choice("level", ["debug", "info", "warn", "error", "fatal"] as const).pipe(
  Options.withDescription("Event severity level"),
  Options.optional,
)

const emitSourceOpt = Options.text("source").pipe(
  Options.withDescription("Event source (default: cli)"),
  Options.optional,
)

const emitComponentOpt = Options.text("component").pipe(
  Options.withDescription("Event component (default: otel-cli)"),
  Options.optional,
)

const emitActionOpt = Options.text("action").pipe(
  Options.withDescription("Action name (alternative to positional action argument)"),
  Options.optional,
)

const emitIdOpt = Options.text("id").pipe(
  Options.withDescription("Optional event id (defaults to generated uuid)"),
  Options.optional,
)

const emitTimestampOpt = Options.integer("timestamp").pipe(
  Options.withDescription("Optional event timestamp in milliseconds (defaults to Date.now())"),
  Options.optional,
)

const emitSuccessOpt = Options.choice("success", ["true", "false"] as const).pipe(
  Options.withDescription("Optional success flag (defaults to true)"),
  Options.optional,
)

const emitMetadataOpt = Options.text("metadata").pipe(
  Options.withDescription("Optional metadata JSON object"),
  Options.optional,
)

const emitErrorOpt = Options.text("error").pipe(
  Options.withDescription("Optional error text"),
  Options.optional,
)

const otelListCmd = Command.make(
  "list",
  {
    level: levelOpt,
    source: sourceOpt,
    component: componentOpt,
    success: successOpt,
    hours: hoursOpt,
    limit: limitOpt,
    page: pageOpt,
  },
  ({ level, source, component, success, hours, limit, page }) =>
    Effect.gen(function* () {
      const result = yield* executeCapabilityCommand<Record<string, unknown>>({
        capability: "otel",
        subcommand: "list",
        args: {
          level: parseOptionText(level),
          source: parseOptionText(source),
          component: parseOptionText(component),
          success: parseOptionText(success),
          hours,
          limit,
          page,
        },
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "otel list",
            error.message,
            codeOrFallback(error, "OTEL_QUERY_FAILED"),
            fixOrFallback(error, "Check Typesense health and API key"),
            [{ command: "joelclaw status", description: "Check worker/server health" }],
          ),
        )
        return
      }

      yield* Console.log(
        respond(
          "otel list",
          result.right,
          [
            { command: "joelclaw otel search \"fatal\" --hours 24", description: "Search text in recent events" },
            { command: "joelclaw otel stats --hours 24", description: "Error-rate snapshot" },
          ],
        ),
      )
    }),
)

const searchArg = Args.text({ name: "query" }).pipe(Args.withDescription("Full-text query"))

const otelSearchCmd = Command.make(
  "search",
  {
    query: searchArg,
    level: levelOpt,
    source: sourceOpt,
    component: componentOpt,
    success: successOpt,
    hours: hoursOpt,
    limit: limitOpt,
    page: pageOpt,
  },
  ({ query, level, source, component, success, hours, limit, page }) =>
    Effect.gen(function* () {
      const result = yield* executeCapabilityCommand<Record<string, unknown>>({
        capability: "otel",
        subcommand: "search",
        args: {
          query,
          level: parseOptionText(level),
          source: parseOptionText(source),
          component: parseOptionText(component),
          success: parseOptionText(success),
          hours,
          limit,
          page,
        },
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "otel search",
            error.message,
            codeOrFallback(error, "OTEL_QUERY_FAILED"),
            fixOrFallback(error, "Check Typesense health and API key"),
            [{ command: "joelclaw status", description: "Check worker/server health" }],
          ),
        )
        return
      }

      yield* Console.log(
        respond(
          "otel search",
          result.right,
          [
            {
              command: `joelclaw otel search "${query}" --level error,fatal --hours 24`,
              description: "Narrow to high-severity",
            },
            { command: "joelclaw otel stats --hours 24", description: "Get aggregate error rate" },
          ],
        ),
      )
    }),
)

const otelStatsCmd = Command.make(
  "stats",
  {
    source: sourceOpt,
    component: componentOpt,
    hours: hoursOpt,
  },
  ({ source, component, hours }) =>
    Effect.gen(function* () {
      const result = yield* executeCapabilityCommand<Record<string, unknown>>({
        capability: "otel",
        subcommand: "stats",
        args: {
          source: parseOptionText(source),
          component: parseOptionText(component),
          hours,
        },
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "otel stats",
            error.message,
            codeOrFallback(error, "OTEL_STATS_FAILED"),
            fixOrFallback(error, "Check Typesense health and API key"),
            [{ command: "joelclaw status", description: "Check worker/server health" }],
          ),
        )
        return
      }

      yield* Console.log(
        respond(
          "otel stats",
          result.right,
          [
            { command: "joelclaw otel list --level error,fatal --hours 24", description: "Inspect high severity events" },
            { command: "joelclaw otel search \"system.fatal\" --hours 48", description: "Find escalation history" },
          ],
        ),
      )
    }),
)

const emitActionArg = Args.text({ name: "action" }).pipe(
  Args.withDescription("Action name (convenience positional form)"),
  Args.optional,
)

const otelEmitCmd = Command.make(
  "emit",
  {
    actionArg: emitActionArg,
    actionOpt: emitActionOpt,
    source: emitSourceOpt,
    component: emitComponentOpt,
    level: emitLevelOpt,
    success: emitSuccessOpt,
    metadata: emitMetadataOpt,
    id: emitIdOpt,
    timestamp: emitTimestampOpt,
    error: emitErrorOpt,
  },
  ({ actionArg, actionOpt, source, component, level, success, metadata, id, timestamp, error }) =>
    Effect.gen(function* () {
      const stdinPayload = readStdinJsonObject()
      if (!stdinPayload.ok) {
        yield* Console.log(
          respondError(
            "otel emit",
            stdinPayload.message,
            "OTEL_INVALID_ARGS",
            "Provide stdin as a JSON object payload (example: echo '{\"action\":\"test.emit\"}' | joelclaw otel emit)",
            [
              { command: "joelclaw otel emit <action> --source cli --component test", description: "Emit using CLI flags only" },
              { command: "joelclaw status", description: "Check worker/server health before retrying" },
            ],
          ),
        )
        return
      }

      const metadataText = parseOptionText(metadata)
      const parsedMetadata = parseJsonObject(metadataText)
      if (!parsedMetadata) {
        yield* Console.log(
          respondError(
            "otel emit",
            "Invalid --metadata JSON payload",
            "OTEL_INVALID_ARGS",
            "Pass --metadata as a JSON object string, e.g. --metadata '{\"key\":\"value\"}'.",
            [
              { command: "joelclaw otel emit <action> --metadata '{\"key\":\"value\"}'", description: "Retry with valid metadata JSON" },
            ],
          ),
        )
        return
      }

      const successFlag = parseOptionalValue(success)
      const result = yield* executeCapabilityCommand<Record<string, unknown>>({
        capability: "otel",
        subcommand: "emit",
        args: {
          event: stdinPayload.value,
          action: parseOptionText(actionOpt) ?? parseOptionText(actionArg),
          source: parseOptionText(source),
          component: parseOptionText(component),
          level: parseOptionalValue(level),
          success: successFlag === "true" ? true : successFlag === "false" ? false : undefined,
          metadata: metadataText ? parsedMetadata : undefined,
          id: parseOptionText(id),
          timestamp: parseOptionalValue(timestamp),
          error: parseOptionText(error),
        },
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const err = result.left
        yield* Console.log(
          respondError(
            "otel emit",
            err.message,
            codeOrFallback(err, "OTEL_EMIT_FAILED"),
            fixOrFallback(err, "Ensure worker is running on :3111 and payload includes an action."),
            [
              { command: "joelclaw status", description: "Check worker/server health" },
              { command: "joelclaw otel emit <action> --source cli --component test", description: "Retry with explicit emit args" },
            ],
          ),
        )
        return
      }

      yield* Console.log(
        respond(
          "otel emit",
          result.right,
          [
            { command: "joelclaw otel search <action> --hours 1", description: "Verify emitted event is queryable" },
            { command: "joelclaw otel stats --hours 1", description: "Inspect recent aggregate error-rate snapshot" },
          ],
        ),
      )
    }),
).pipe(Command.withDescription("Emit OTEL event from stdin JSON or convenience flags"))

export const otelCmd = Command.make("otel", {}, () =>
  Console.log(
    respond(
      "otel",
      {
        description: "Observability event explorer (ADR-0087)",
        subcommands: {
          list: "joelclaw otel list [--hours 24] [--level error,fatal]",
          search: 'joelclaw otel search "query" [filters]',
          stats: "joelclaw otel stats [--hours 24]",
          emit: "joelclaw otel emit <action> [--source cli] [--component otel-cli] [--metadata '{\"k\":\"v\"}']",
        },
      },
      [
        { command: "joelclaw otel list --hours 24", description: "Recent events" },
        { command: 'joelclaw otel search "gateway" --level error,fatal --hours 24', description: "Search failures by text" },
        { command: "joelclaw otel stats --hours 24", description: "Error-rate snapshot" },
        { command: "joelclaw otel emit system.example.ping --source cli --component otel-cli", description: "Emit test event" },
      ],
      true,
    ),
  ),
).pipe(Command.withSubcommands([otelListCmd, otelSearchCmd, otelStatsCmd, otelEmitCmd]))
