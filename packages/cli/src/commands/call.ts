import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import { respond, respondError } from "../response"

export const callCmd = Command.make(
  "call",
  {
    text: Args.text({ name: "message" }).pipe(
      Args.withDefault(""),
      Args.withDescription("Message to speak/copy in call/SMS fallback")
    ),
    message: Options.text("message").pipe(
      Options.withAlias("m"),
      Options.withDescription("Message to speak/copy in call/SMS fallback"),
      Options.optional
    ),
    to: Options.text("to").pipe(
      Options.withDescription("Override destination phone number"),
      Options.optional
    ),
  },
  ({ text, message, to }) =>
    Effect.gen(function* () {
      const content = message._tag === "Some" ? message.value.trim() : text.trim()

      if (!content) {
        yield* Console.log(respondError(
          "call",
          "Message is required",
          "MISSING_MESSAGE",
          "Pass a message as positional arg or --message",
          [
            { command: "joelclaw call <message>", description: "Send a call request" },
            { command: "joelclaw call --message <message>", description: "Send using flag form" },
          ]
        ))
        return
      }

      const data: Record<string, unknown> = { message: content }
      if (to._tag === "Some" && to.value.trim()) {
        data.to = to.value.trim()
      }

      const inngestClient = yield* Inngest
      const result = yield* inngestClient.send("notification/call.requested", data)
      const ids = (result as any)?.ids ?? []

      yield* Console.log(respond("call", {
        event: "notification/call.requested",
        data,
        response: result,
      }, [
        {
          command: "joelclaw run <run-id>",
          description: "Inspect the notification run",
          params: {
            "run-id": { description: "Run ID", value: ids[0] ?? "RUN_ID", required: true },
          },
        },
        {
          command: "joelclaw events --prefix <prefix>",
          description: "View recent call notification events",
          params: {
            prefix: { description: "Event prefix", value: "notification/call.requested", required: true },
          },
        },
      ]))
    })
)
