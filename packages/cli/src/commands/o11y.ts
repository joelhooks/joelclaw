import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import type { CapabilityError } from "../capabilities/contract"
import { executeCapabilityCommand } from "../capabilities/runtime"
import { respond, respondError } from "../response"

function codeOrFallback(error: CapabilityError, fallback: string): string {
  return error.code || fallback
}

function fixOrFallback(error: CapabilityError, fallback: string): string {
  return error.fix ?? fallback
}

const hoursOpt = Options.integer("hours").pipe(
  Options.withAlias("h"),
  Options.withDefault(24),
  Options.withDescription("Lookback window in hours"),
)

const limitOpt = Options.integer("limit").pipe(
  Options.withAlias("n"),
  Options.withDefault(50),
  Options.withDescription("Merged results to return"),
)

const sessionIdArg = Args.text({ name: "sessionId" }).pipe(
  Args.withDescription("Session identifier to correlate"),
)

const systemIdArg = Args.text({ name: "systemId" }).pipe(
  Args.withDescription("System identifier to correlate"),
)

const o11ySessionCmd = Command.make(
  "session",
  {
    sessionId: sessionIdArg,
    hours: hoursOpt,
    limit: limitOpt,
  },
  ({ sessionId, hours, limit }) =>
    Effect.gen(function* () {
      const result = yield* executeCapabilityCommand<Record<string, unknown>>({
        capability: "otel",
        subcommand: "correlate",
        args: {
          sessionId,
          hours,
          limit,
        },
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "o11y session",
            error.message,
            codeOrFallback(error, "O11Y_QUERY_FAILED"),
            fixOrFallback(error, "Check Typesense health and API key"),
            [
              { command: "joelclaw status", description: "Check worker/server health" },
              { command: `joelclaw otel list --session ${sessionId} --hours ${hours}`, description: "Retry OTEL-only view" },
            ],
          ),
        )
        return
      }

      yield* Console.log(
        respond(
          "o11y session",
          result.right,
          [
            { command: `joelclaw otel list --session ${sessionId} --hours ${hours}`, description: "Inspect OTEL events only" },
            { command: `joelclaw otel search "error" --session ${sessionId} --hours ${hours}`, description: "Search failures within this session" },
          ],
        ),
      )
    }),
).pipe(Command.withDescription("Correlate one session across otel_events and system_log"))

const o11ySystemCmd = Command.make(
  "system",
  {
    systemId: systemIdArg,
    hours: hoursOpt,
    limit: limitOpt,
  },
  ({ systemId, hours, limit }) =>
    Effect.gen(function* () {
      const result = yield* executeCapabilityCommand<Record<string, unknown>>({
        capability: "otel",
        subcommand: "correlate",
        args: {
          systemId,
          hours,
          limit,
        },
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "o11y system",
            error.message,
            codeOrFallback(error, "O11Y_QUERY_FAILED"),
            fixOrFallback(error, "Check Typesense health and API key"),
            [
              { command: "joelclaw status", description: "Check worker/server health" },
              { command: `joelclaw otel list --system ${systemId} --hours ${hours}`, description: "Retry OTEL-only view" },
            ],
          ),
        )
        return
      }

      yield* Console.log(
        respond(
          "o11y system",
          result.right,
          [
            { command: `joelclaw otel list --system ${systemId} --hours ${hours}`, description: "Inspect OTEL events only" },
            { command: `joelclaw otel search "error" --system ${systemId} --hours ${hours}`, description: "Search failures on this system" },
          ],
        ),
      )
    }),
).pipe(Command.withDescription("Correlate one system across otel_events and system_log"))

export const o11yCmd = Command.make("o11y", {}, () =>
  Console.log(
    respond(
      "o11y",
      {
        description: "Unified observability correlation across otel_events and system_log (ADR-0233 phase 4)",
        subcommands: {
          session: "joelclaw o11y session <sessionId> [--hours 24] [--limit 50]",
          system: "joelclaw o11y system <systemId> [--hours 24] [--limit 50]",
        },
      },
      [
        { command: "joelclaw o11y session <sessionId> --hours 24", description: "Trace one session across both stores" },
        { command: "joelclaw o11y system panda --hours 24", description: "Trace one system across both stores" },
        { command: "joelclaw otel list --hours 24", description: "Inspect OTEL events only" },
      ],
      true,
    ),
  ),
).pipe(Command.withSubcommands([o11ySessionCmd, o11ySystemCmd]))
