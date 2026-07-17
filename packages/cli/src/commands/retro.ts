import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import { respond, respondError } from "../response"

type OptionalText = { _tag: "Some"; value: string } | { _tag: "None" }

export type RetroRequestPayload = {
  brief_path: string
  repo: string
  requested_by: string
  session_id?: string
}

function optionalText(value: OptionalText): string | undefined {
  if (value._tag !== "Some") return undefined
  const trimmed = value.value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function expandHome(path: string): string {
  const trimmed = path.trim()
  if (trimmed === "~") return homedir()
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2))
  return trimmed
}

export function buildRetroRequestPayload(input: {
  briefPath: string
  cwd?: string
  repo?: string
  requestedBy?: string
  sessionId?: string
}): RetroRequestPayload {
  const cwd = resolve(input.cwd ?? process.cwd())
  const repository = resolve(expandHome(input.repo ?? cwd))
  const expandedBriefPath = expandHome(input.briefPath)
  const briefPath = isAbsolute(expandedBriefPath)
    ? resolve(expandedBriefPath)
    : resolve(repository, expandedBriefPath)

  return {
    brief_path: briefPath,
    repo: repository,
    requested_by: input.requestedBy?.trim() || "joelclaw-cli",
    ...(input.sessionId?.trim() ? { session_id: input.sessionId.trim() } : {}),
  }
}

export const retroCmd = Command.make(
  "retro",
  {
    briefPath: Args.text({ name: "brief-path" }).pipe(
      Args.withDescription("Closed Brain brief to condense into a retro"),
    ),
    repo: Options.text("repo").pipe(
      Options.withDescription("Repository root used to resolve a relative brief path"),
      Options.optional,
    ),
    sessionId: Options.text("session-id").pipe(
      Options.withDescription("Optional originating agent session ID"),
      Options.optional,
    ),
    requestedBy: Options.text("requested-by").pipe(
      Options.withDescription("Hook or agent requesting the retro"),
      Options.withDefault("joelclaw-cli"),
    ),
  },
  ({ briefPath, repo, sessionId, requestedBy }) =>
    Effect.gen(function* () {
      const payload = buildRetroRequestPayload({
        briefPath,
        repo: optionalText(repo as OptionalText),
        sessionId: optionalText(sessionId as OptionalText),
        requestedBy,
      })

      if (!existsSync(payload.brief_path)) {
        yield* Console.log(
          respondError(
            "retro",
            `Brief does not exist: ${payload.brief_path}`,
            "BRIEF_NOT_FOUND",
            "Pass a readable closed brief path",
            [{ command: "joelclaw retro <brief-path>", description: "Request a retro for a closed brief" }],
          ),
        )
        return
      }

      const inngestClient = yield* Inngest
      const result = yield* inngestClient.send("memory/retro.requested", payload).pipe(Effect.either)

      if (result._tag === "Left") {
        yield* Console.log(
          respondError(
            "retro",
            `Failed to send memory/retro.requested: ${String(result.left)}`,
            "SEND_FAILED",
            "Check the host worker and Inngest",
            [
              { command: "joelclaw inngest status", description: "Check Inngest health" },
              { command: "joelclaw functions", description: "Verify memory-retro-writer is registered" },
            ],
          ),
        )
        return
      }

      const ids = (result.right as { ids?: string[] })?.ids ?? []
      yield* Console.log(
        respond(
          "retro",
          {
            event: "memory/retro.requested",
            payload,
            response: result.right,
          },
          [
            {
              command: "joelclaw event <event-id>",
              description: "Inspect the event and its function run",
              params: {
                "event-id": { description: "Inngest event ID", value: ids[0] ?? "EVENT_ID", required: true },
              },
            },
            { command: "joelclaw runs --count 3", description: "Check recent run status" },
          ],
        ),
      )
    }),
).pipe(Command.withDescription("Request a source-grounded retro for a closed Brain brief"))
