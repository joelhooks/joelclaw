import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { buildMemorySkillIndex, formatMemorySkillIndexText } from "../lib/memory-skill-index"
import { respond, respondError } from "../response"

const repo = Options.text("repo").pipe(
  Options.withDefault(process.cwd()),
  Options.withDescription("Repository to scope the briefing to"),
)
const budget = Options.integer("budget").pipe(
  Options.withAlias("n"),
  Options.withDefault(10),
  Options.withDescription("Maximum number of memory index entries"),
)
const format = Options.choice("format", ["json", "text"] as const).pipe(
  Options.withDefault("json" as const),
  Options.withDescription("Output format: HATEOAS JSON or prompt-ready text"),
)

export const briefingCmd = Command.make(
  "briefing",
  { repo, budget, format },
  ({ repo, budget, format }) =>
    Effect.gen(function* () {
      try {
        const index = buildMemorySkillIndex({ repo, budget })
        if (format === "text") {
          yield* Console.log(formatMemorySkillIndexText(index))
          return
        }
        yield* Console.log(respond("briefing", index, [
          {
            command: "joelclaw briefing --repo <path> [--budget <n>] [--format text]",
            description: "Recompute a repo-scoped session briefing",
            params: {
              path: { description: "Repository path", value: index.repo, required: true },
              n: { description: "Maximum memory entries", value: index.budget, default: 10 },
              format: { description: "Output format", enum: ["json", "text"], default: "json" },
            },
          },
          { command: "joelclaw recall <query>", description: "Search deeper when an indexed memory is not enough" },
        ]))
      } catch (error) {
        yield* Console.log(respondError(
          "briefing",
          error instanceof Error ? error.message : String(error),
          "BRIEFING_FAILED",
          "Provide an existing repository path and retry.",
          [{ command: "joelclaw briefing --repo <path>", description: "Build a briefing for a repository" }],
        ))
      }
    }),
).pipe(Command.withDescription("Build a repo-scoped session heading and unfoldable memory index"))