import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import type { CapabilityError } from "../capabilities/contract"
import { executeCapabilityCommand } from "../capabilities/runtime"
import { Inngest } from "../inngest"
import { respond, respondError } from "../response"

const MEMORY_TYPES = ["observation", "lesson", "pattern", "failed_target"] as const

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

const memoryWriteCmd = Command.make(
  "write",
  {
    text: Args.text({ name: "text" }).pipe(
      Args.withDescription("Observation text to capture")
    ),
    type: Options.choice("type", MEMORY_TYPES).pipe(
      Options.withDescription("Memory type"),
      Options.withDefault("observation")
    ),
    source: Options.text("source").pipe(
      Options.withDescription("Source label for this memory"),
      Options.withDefault("cli")
    ),
  },
  ({ text, type, source }) =>
    Effect.gen(function* () {
      const normalizedText = text.trim()
      if (normalizedText.length === 0) {
        yield* Console.log(
          respondError(
            "memory write",
            "Observation text cannot be empty",
            "INVALID_TEXT",
            "Provide a non-empty observation text argument.",
            [
              {
                command: "joelclaw memory write <text> [--type <type>] [--source <source>]",
                description: "Retry with observation text",
                params: {
                  text: { description: "Observation text", required: true },
                  type: { description: "Memory type", enum: MEMORY_TYPES, default: "observation" },
                  source: { description: "Source label", default: "cli" },
                },
              },
            ]
          )
        )
        return
      }

      const inngestClient = yield* Inngest
      const eventPayload = {
        text: normalizedText,
        type,
        source,
        ts: new Date().toISOString(),
      }

      const sendResult = yield* inngestClient
        .send("memory/observation.submitted", eventPayload)
        .pipe(Effect.either)

      if (sendResult._tag === "Left") {
        yield* Console.log(
          respondError(
            "memory write",
            "Failed to submit memory observation event",
            "INGGEST_SEND_FAILED",
            `Ensure Inngest is reachable at http://localhost:8288 and retry. ${String(sendResult.left?.message ?? "")}`,
            [
              { command: "joelclaw status", description: "Check system health" },
              { command: "joelclaw inngest status", description: "Check Inngest server/worker health" },
              {
                command: "joelclaw memory write <text> [--type <type>] [--source <source>]",
                description: "Retry memory event submission",
                params: {
                  text: { description: "Observation text", value: normalizedText, required: true },
                  type: { description: "Memory type", value: type, enum: MEMORY_TYPES, default: "observation" },
                  source: { description: "Source label", value: source, default: "cli" },
                },
              },
            ]
          )
        )
        return
      }

      const responseData = sendResult.right as Record<string, unknown>
      const ids = Array.isArray(responseData.ids) ? responseData.ids : []
      const firstId = ids[0]
      const eventId = typeof firstId === "string"
        ? firstId
        : (typeof responseData.id === "string" ? responseData.id : null)

      yield* Console.log(
        respond(
          "memory write",
          {
            eventId,
            type,
            text: normalizedText,
          },
          [
            {
              command: "joelclaw memory search <query>",
              description: "Search memory observations",
              params: {
                query: { description: "Recall query text", value: normalizedText, required: true },
              },
            },
            {
              command: "joelclaw runs [--count <count>]",
              description: "Inspect recent Inngest runs",
              params: {
                count: { description: "Number of runs", value: 3, default: 10 },
              },
            },
            {
              command: "joelclaw events [--prefix <prefix>] [--hours <hours>] [--count <count>]",
              description: "Verify emitted memory events",
              params: {
                prefix: { description: "Event prefix filter", value: "memory/observation.submitted" },
                hours: { description: "Lookback window in hours", value: 1, default: 4 },
                count: { description: "Number of events", value: 10, default: 20 },
              },
            },
          ]
        )
      )
    })
).pipe(Command.withDescription("Write a memory observation to the pipeline"))

const memorySearchCmd = Command.make(
  "search",
  {
    query: Args.text({ name: "query" }).pipe(
      Args.withDescription("Memory recall query")
    ),
  },
  ({ query }) =>
    Effect.gen(function* () {
      const result = yield* executeCapabilityCommand<RecallCapabilityResult>({
        capability: "recall",
        subcommand: "query",
        args: {
          query,
          limit: 5,
          minScore: 0,
          raw: false,
          includeHold: false,
          includeDiscard: false,
          budget: "auto",
          category: "",
        },
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        const code = codeOrFallback(error, "UNKNOWN")

        if (code.startsWith("TYPESENSE_API_KEY_")) {
          yield* Console.log(
            respondError(
              "memory search",
              error.message,
              code,
              fixOrFallback(error, "Configure Typesense API key and retry."),
              [
                { command: "joelclaw status", description: "Check system health" },
                { command: "joelclaw inngest status", description: "Check worker/server status" },
              ],
            )
          )
          return
        }

        if (code === "TYPESENSE_UNREACHABLE") {
          yield* Console.log(
            respondError(
              "memory search",
              error.message,
              code,
              fixOrFallback(error, "kubectl port-forward -n joelclaw svc/typesense 8108:8108 &"),
              [{ command: "joelclaw status", description: "Check all services" }],
            )
          )
          return
        }

        yield* Console.log(
          respondError(
            "memory search",
            error.message,
            code,
            fixOrFallback(error, "Check Typesense (localhost:8108)"),
            [{ command: "joelclaw status", description: "Check all services" }],
          )
        )
        return
      }

      const payload = result.right.payload ?? {}

      yield* Console.log(
        respond("memory search", payload, [
          {
            command: `joelclaw memory search "${query}"`,
            description: "Search memory again",
          },
          {
            command: `joelclaw recall "${query}" --raw`,
            description: "Get raw observations for injection",
          },
          {
            command: "joelclaw memory write <text> [--type <type>] [--source <source>]",
            description: "Capture a new memory observation",
            params: {
              text: { description: "Observation text", required: true },
              type: { description: "Memory type", enum: MEMORY_TYPES, default: "observation" },
              source: { description: "Source label", default: "cli" },
            },
          },
        ])
      )
    })
).pipe(Command.withDescription("Alias for joelclaw recall <query>"))

export const memoryCmd = Command.make("memory").pipe(
  Command.withDescription("Memory operations (write + search)"),
  Command.withSubcommands([memoryWriteCmd, memorySearchCmd]),
)
