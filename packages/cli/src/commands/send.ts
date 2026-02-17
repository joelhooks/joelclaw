import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import { respond } from "../response"

export const sendCmd = Command.make(
  "send",
  {
    event: Args.text({ name: "event" }).pipe(
      Args.withDescription("Event name (e.g. pipeline/video.download, system/log)")
    ),
    data: Options.text("data").pipe(
      Options.withAlias("d"),
      Options.withDescription("JSON data payload"),
      Options.withDefault("{}")
    ),
    url: Options.text("url").pipe(
      Options.withDescription("Shorthand: sets data.url for video.download events"),
      Options.optional
    ),
  },
  ({ event, data, url }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      let payload: Record<string, unknown>

      try {
        payload = JSON.parse(data)
      } catch {
        yield* Console.log(respond("send", { error: "Invalid JSON in --data" }, [], false))
        return
      }

      if (url._tag === "Some") {
        payload.url = url.value
      }

      const result = yield* inngestClient.send(event, payload)

      yield* Console.log(respond("send", { event, data: payload, response: result }, [
        { command: `joelclaw runs --count 3`, description: "Check if the function picked it up" },
        { command: `joelclaw run ${(result as any)?.ids?.[0] ?? "RUN_ID"}`, description: "Inspect the run once it starts" },
        { command: `joelclaw functions`, description: "See which function handles this event" },
      ]))
    })
)
