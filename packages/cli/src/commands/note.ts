import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import Redis from "ioredis"
import { Inngest } from "../inngest"
import { respond } from "../response"

const NOTE_QUEUE_KEY = "joelclaw:notes:queue"

type NotePayload = {
  id: string
  text: string
  source: string
  createdAt: string
  tags: string[]
  status: "pending"
}

const parseTags = (value: string | undefined): string[] => {
  if (!value) return []
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
}

export const noteCmd = Command.make(
  "note",
  {
    text: Args.text({ name: "text" }).pipe(
      Args.withDescription("Thought text to capture")
    ),
    source: Options.text("source").pipe(
      Options.withDescription("Source of the note"),
      Options.withDefault("cli")
    ),
    tags: Options.text("tags").pipe(
      Options.withDescription("Comma-separated tags"),
      Options.optional
    ),
  },
  ({ text, source, tags }) =>
    Effect.gen(function* () {
      const note: NotePayload = {
        id: crypto.randomUUID(),
        text,
        source,
        createdAt: new Date().toISOString(),
        tags: tags._tag === "Some" ? parseTags(tags.value) : [],
        status: "pending",
      }

      const redis = new Redis({
        host: process.env.REDIS_HOST ?? "localhost",
        port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
      })

      yield* Effect.tryPromise(() =>
        redis.rpush(NOTE_QUEUE_KEY, JSON.stringify(note))
      ).pipe(
        Effect.ensuring(
          Effect.tryPromise(() => redis.quit()).pipe(
            Effect.catchAll(() => Effect.sync(() => redis.disconnect()))
          )
        )
      )

      const inngestClient = yield* Inngest
      yield* inngestClient.send("system/note.captured", note)

      const output = respond(
        "note",
        note,
        [
          {
            command: "joelclaw runs [--count <count>]",
            description: "Check recent processing runs",
            params: {
              count: { description: "Number of runs", value: 3, default: 10 },
            },
          },
          {
            command: "joelclaw events [--prefix <prefix>] [--hours <hours>]",
            description: "Verify note capture events",
            params: {
              prefix: { description: "Event prefix", value: "system/note.captured" },
              hours: { description: "Lookback window in hours", value: 1, default: 4 },
            },
          },
          { command: "joelclaw note \"another thought\"", description: "Capture another note" },
        ]
      )
      yield* Console.log(output)
    })
)
