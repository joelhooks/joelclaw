import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import { enqueueQueueEventViaWorker } from "../lib/queue-admission"
import { respond } from "../response"

function isQueuePilotEnabled(name: string): boolean {
  return new Set(
    (process.env.QUEUE_PILOTS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  ).has(name.trim().toLowerCase())
}

export const discoverCmd = Command.make(
  "discover",
  {
    url: Args.text({ name: "url" }).pipe(
      Args.withDescription("URL to capture (repo, article, etc.)"),
    ),
    context: Options.text("context").pipe(
      Options.withAlias("c"),
      Options.withDescription("What's interesting about it"),
      Options.optional,
    ),
  },
  ({ url, context }) =>
    Effect.gen(function* () {
      const data: Record<string, unknown> = { url }
      if (context._tag === "Some") {
        data.context = context.value
      }

      if (isQueuePilotEnabled("discovery")) {
        const queued = yield* Effect.tryPromise({
          try: () =>
            enqueueQueueEventViaWorker({
              name: "discovery/noted",
              data,
              source: "cli/discover",
            }),
          catch: (error) => new Error(`Failed to enqueue discovery/noted: ${error}`),
        })

        yield* Console.log(
          respond(
            "discover",
            {
              url,
              context: context._tag === "Some" ? context.value : undefined,
              event: "discovery/noted",
              mode: "queue",
              streamId: queued.streamId,
              eventId: queued.eventId,
              priority: queued.priority,
              triageMode: queued.triageMode,
              triage: queued.triage,
            },
            [
              {
                command: "joelclaw queue inspect <stream-id>",
                description: "Inspect the queued discovery event",
                params: {
                  "stream-id": { description: "Redis stream ID", value: queued.streamId, required: true },
                },
              },
              {
                command: "joelclaw queue depth",
                description: "Check queue depth",
                params: {},
              },
              { command: "ls ~/Vault/Resources/discoveries/", description: "Check vault output" },
            ],
          ),
        )

        return
      }

      const inngestClient = yield* Inngest
      const result = yield* inngestClient.send("discovery/noted", data)
      const ids = (result as any)?.ids ?? []

      yield* Console.log(
        respond(
          "discover",
          {
            url,
            context: context._tag === "Some" ? context.value : undefined,
            event: "discovery/noted",
            mode: "inngest",
            response: result,
          },
          [
            {
              command: "joelclaw runs [--count <count>]",
              description: "Check discovery-capture progress",
              params: {
                count: { description: "Number of runs", value: 3, default: 10 },
              },
            },
            {
              command: "joelclaw run <run-id>",
              description: "Inspect the run",
              params: {
                "run-id": { description: "Run ID", value: ids[0] ?? "RUN_ID", required: true },
              },
            },
            { command: "ls ~/Vault/Resources/discoveries/", description: "Check vault output" },
          ],
        ),
      )
    }),
)
