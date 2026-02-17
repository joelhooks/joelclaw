import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import { respond } from "../response"

export const discoverCmd = Command.make(
  "discover",
  {
    url: Args.text({ name: "url" }).pipe(
      Args.withDescription("URL to capture (repo, article, etc.)")
    ),
    context: Options.text("context").pipe(
      Options.withAlias("c"),
      Options.withDescription("What's interesting about it"),
      Options.optional
    ),
  },
  ({ url, context }) =>
    Effect.gen(function* () {
      const igs = yield* Inngest

      const data: Record<string, unknown> = { url }
      if (context._tag === "Some") {
        data.context = context.value
      }

      const result = yield* igs.send("discovery/noted", data)
      const ids = (result as any)?.ids ?? []

      yield* Console.log(respond("discover", {
        url,
        context: context._tag === "Some" ? context.value : undefined,
        event: "discovery/noted",
        response: result,
      }, [
        { command: `igs runs --count 3`, description: "Check discovery-capture progress" },
        { command: `igs run ${ids[0] ?? "RUN_ID"}`, description: "Inspect the run" },
        { command: `ls ~/Vault/Resources/discoveries/`, description: "Check vault output" },
      ]))
    })
)
