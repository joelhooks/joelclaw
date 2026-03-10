import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import { enqueueQueueEventViaWorker } from "../lib/queue-admission"
import { respond } from "../response"

const DISCOVERY_SITES = ["joelclaw", "wizardshit", "shared"] as const
const DISCOVERY_VISIBILITIES = ["public", "private", "archived", "migration-only"] as const

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
    site: Options.choice("site", DISCOVERY_SITES).pipe(
      Options.withDescription("Canonical site for the captured piece"),
      Options.withDefault("joelclaw"),
    ),
    visibility: Options.choice("visibility", DISCOVERY_VISIBILITIES).pipe(
      Options.withDescription("Visibility for the captured piece"),
      Options.withDefault("public"),
    ),
  },
  ({ url, context, site, visibility }) =>
    Effect.gen(function* () {
      const data: Record<string, unknown> = { url, site, visibility }
      if (context._tag === "Some") {
        data.context = context.value
      }

      const followPayload = JSON.stringify(data)

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
              site,
              visibility,
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
                command: "joelclaw send <event> --data <data> --follow",
                description: "Run the canonical follow path when you need the final link back from discovery-capture",
                params: {
                  event: { description: "Event name", value: "discovery/noted", required: true },
                  data: { description: "JSON payload", value: followPayload, required: true },
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
            site,
            visibility,
            event: "discovery/noted",
            mode: "inngest",
            response: result,
          },
          [
            {
              command: "joelclaw send <event> --data <data> --follow",
              description: "Canonical discovery path when you need the final link returned in the terminal result",
              params: {
                event: { description: "Event name", value: "discovery/noted", required: true },
                data: { description: "JSON payload", value: followPayload, required: true },
              },
            },
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
