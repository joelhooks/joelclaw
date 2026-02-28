import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { __recallTestUtils } from "../capabilities/adapters/typesense-recall"
import type { CapabilityError } from "../capabilities/contract"
import { executeCapabilityCommand } from "../capabilities/runtime"
import { respond, respondError } from "../response"

type RecallCapabilityResult = {
  raw: boolean
  text?: string
  payload?: Record<string, unknown>
}

function codeOrFallback(error: CapabilityError, fallback: string): string {
  return error.code || fallback
}

function fixOrFallback(error: CapabilityError, fallback: string): string {
  return error.fix ?? fallback
}

const query = Args.text({ name: "query" })
const limit = Options.integer("limit").pipe(Options.withDefault(5))
const minScore = Options.float("min-score").pipe(Options.withDefault(0))
const raw = Options.boolean("raw").pipe(Options.withDefault(false))
const includeHold = Options.boolean("include-hold").pipe(Options.withDefault(false))
const includeDiscard = Options.boolean("include-discard").pipe(Options.withDefault(false))
const budget = Options.text("budget").pipe(Options.withDefault("auto"))
const category = Options.text("category").pipe(Options.withDefault(""))

export const recallCmd = Command.make(
  "recall",
  { query, limit, minScore, raw, includeHold, includeDiscard, budget, category },
  ({ query, limit, minScore, raw, includeHold, includeDiscard, budget, category }) =>
    Effect.gen(function* () {
      const result = yield* executeCapabilityCommand<RecallCapabilityResult>({
        capability: "recall",
        subcommand: "query",
        args: {
          query,
          limit,
          minScore,
          raw,
          includeHold,
          includeDiscard,
          budget,
          category,
        },
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        const code = codeOrFallback(error, "UNKNOWN")

        if (code.startsWith("TYPESENSE_API_KEY_")) {
          yield* Console.log(respondError(
            "recall",
            error.message,
            code,
            fixOrFallback(error, "Configure Typesense API key and retry."),
            [
              { command: "joelclaw status", description: "Check system health" },
              { command: "joelclaw inngest status", description: "Check worker/server status" },
            ],
          ))
          return
        }

        if (code === "TYPESENSE_UNREACHABLE") {
          yield* Console.log(respondError(
            "recall",
            error.message,
            code,
            fixOrFallback(error, "kubectl port-forward -n joelclaw svc/typesense 8108:8108 &"),
            [{ command: "joelclaw status", description: "Check all services" }],
          ))
          return
        }

        yield* Console.log(respondError(
          "recall",
          error.message,
          code,
          fixOrFallback(error, "Check Typesense (localhost:8108)"),
          [{ command: "joelclaw status", description: "Check all services" }],
        ))
        return
      }

      if (result.right.raw) {
        yield* Console.log(result.right.text ?? "")
        return
      }

      const payload = result.right.payload ?? {}

      yield* Console.log(
        respond("recall", payload, [
          {
            command: `joelclaw recall "${query}" --limit 10`,
            description: "Get more results",
          },
          {
            command: `joelclaw search "${query}"`,
            description: "Search all collections (vault, blog, slog too)",
          },
          {
            command: `joelclaw recall "${query}" --raw`,
            description: "Raw observations for injection",
          },
          {
            command: `joelclaw recall "${query}" --budget deep --limit 10`,
            description: "Run deeper retrieval for difficult queries",
          },
          {
            command: `joelclaw recall "${query}" --category jc:memory-system --limit 10`,
            description: "Constrain retrieval to a specific memory category",
          },
        ])
      )
    })
)

export { __recallTestUtils }
