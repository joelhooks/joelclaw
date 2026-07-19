import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import type { CapabilityError } from "../capabilities/contract"
import { executeCapabilityCommand } from "../capabilities/runtime"
import { respond, respondError } from "../response"

const NOTIFY_PRIORITIES = ["low", "normal", "high", "urgent"] as const
const NOTIFY_KINDS = ["memory", "alert", "digest", "ask", "receipt"] as const

type NotifyPriority = (typeof NOTIFY_PRIORITIES)[number]
type NotifyKind = (typeof NOTIFY_KINDS)[number]
type OptionalText = { _tag: "Some"; value: string } | { _tag: "None" }

function parseOptionalText(value: OptionalText): string | undefined {
  if (value._tag !== "Some") return undefined
  const normalized = value.value.trim()
  return normalized.length > 0 ? normalized : undefined
}

function parseContextJson(input: string | undefined): Record<string, unknown> | null {
  if (!input || input.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(input)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function codeOrFallback(error: CapabilityError): string {
  return error.code || "CAPABILITY_EXECUTION_FAILED"
}

function fixOrFallback(error: CapabilityError, fallback: string): string {
  return error.fix ?? fallback
}

const channelOption = Options.text("channel").pipe(
  Options.withDescription("Target channel: gateway (default), main, or all"),
  Options.withDefault("gateway"),
)

const priorityOption = Options.choice("priority", NOTIFY_PRIORITIES).pipe(
  Options.withDescription("Notification priority (controls escalation metadata)"),
  Options.withDefault("normal"),
)

const contextOption = Options.text("context").pipe(
  Options.withDescription("Optional JSON context payload"),
  Options.withDefault("{}"),
)

const typeOption = Options.text("type").pipe(
  Options.withDescription("Event type (default: notify.message)"),
  Options.optional,
)

const sourceOption = Options.text("source").pipe(
  Options.withDescription("Event source (default: cli/notify)"),
  Options.optional,
)

const kindOption = Options.choice("kind", NOTIFY_KINDS).pipe(
  Options.withDescription(
    "Contract-v2 message kind; controls routing lane. ask/alert/memory deliver to Telegram operator lane; digest may batch or suppress; receipt goes to Slack. Default: inferred from priority/source"
  ),
  Options.optional,
)

const telegramOnlyOption = Options.boolean("telegram-only").pipe(
  Options.withDescription("Mark notification for immediate Telegram delivery only"),
  Options.withDefault(false),
)

const adapterOption = Options.text("adapter").pipe(
  Options.withDescription("Override capability adapter (phase-0 precedence: flags > env > config)"),
  Options.optional,
)

const eventIdOption = Options.text("event-id").pipe(
  Options.withDescription("Stable UUID v4 for idempotent notification delivery"),
  Options.optional,
)

const notifySend = Command.make(
  "send",
  {
    message: Args.text({ name: "message" }).pipe(
      Args.withDescription("Notification message text (be explicit and actionable)")
    ),
    channel: channelOption,
    priority: priorityOption,
    context: contextOption,
    type: typeOption,
    source: sourceOption,
    kind: kindOption,
    telegramOnly: telegramOnlyOption,
    adapter: adapterOption,
    eventId: eventIdOption,
  },
  ({ message, channel, priority, context, type, source, kind, telegramOnly, adapter, eventId }) =>
    Effect.gen(function* () {
      const parsedContext = parseContextJson(context)
      if (!parsedContext) {
        yield* Console.log(
          respondError(
            "notify send",
            "Invalid --context JSON payload",
            "INVALID_JSON",
            "Provide a valid JSON object for --context, e.g. --context '{\"runId\":\"...\"}'",
            [
              {
                command: "joelclaw notify send <message> --context <json>",
                description: "Retry with a valid JSON context object",
                params: {
                  message: { description: "Notification text", required: true },
                  json: { description: "JSON object", value: "{\"runId\":\"...\"}" },
                },
              },
            ]
          )
        )
        return
      }

      const adapterOverride = parseOptionalText(adapter)
      const result = yield* executeCapabilityCommand({
        capability: "notify",
        subcommand: "send",
        args: {
          message,
          channel,
          priority: priority as NotifyPriority,
          context: parsedContext,
          type: parseOptionalText(type),
          source: parseOptionalText(source),
          kind: kind._tag === "Some" ? (kind.value as NotifyKind) : undefined,
          telegramOnly,
          eventId: parseOptionalText(eventId),
        },
        flags: adapterOverride ? { adapter: adapterOverride } : undefined,
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "notify send",
            error.message,
            codeOrFallback(error),
            fixOrFallback(error, "Verify Redis/gateway health and retry."),
            [
              { command: "joelclaw gateway status", description: "Check gateway daemon and Redis bridge health" },
              { command: "joelclaw notify send <message> --priority high", description: "Retry with explicit priority" },
            ]
          )
        )
        return
      }

      yield* Console.log(
        respond(
          "notify send",
          result.right,
          [
            { command: "joelclaw otel search \"<eventId>\" --hours 1", description: "Verify terminal delivery state (notify.compat_v2.confirmed) — queue entry alone is not delivery" },
            { command: "joelclaw gateway status", description: "Verify gateway session is healthy" },
            { command: "joelclaw notify send \"<message>\" --kind ask", description: "Route to the Telegram operator lane (always delivers; digest kind may suppress)" },
          ]
        )
      )
    })
).pipe(Command.withDescription("Send canonical operator notification through gateway"))

export const notifyCmd = Command.make("notify").pipe(
  Command.withDescription("Capability: alerts/notifications through gateway"),
  Command.withSubcommands([notifySend]),
)
