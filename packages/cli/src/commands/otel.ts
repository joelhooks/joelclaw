import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import type { CapabilityError } from "../capabilities/contract"
import { executeCapabilityCommand } from "../capabilities/runtime"
import { respond, respondError } from "../response"

type OptionalText = { _tag: "Some"; value: string } | { _tag: "None" }

function parseOptionText(value: OptionalText): string | undefined {
  return value._tag === "Some" ? value.value : undefined
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
        },
      },
      [
        { command: "joelclaw otel list --hours 24", description: "Recent events" },
        { command: 'joelclaw otel search "gateway" --level error,fatal --hours 24', description: "Search failures by text" },
        { command: "joelclaw otel stats --hours 24", description: "Error-rate snapshot" },
      ],
      true,
    ),
  ),
).pipe(Command.withSubcommands([otelListCmd, otelSearchCmd, otelStatsCmd]))
