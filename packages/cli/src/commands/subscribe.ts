import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import type { CapabilityError } from "../capabilities/contract"
import { executeCapabilityCommand } from "../capabilities/runtime"
import { type NextAction, respond, respondError } from "../response"

function codeOrFallback(error: CapabilityError, fallback: string): string {
  return error.code || fallback
}

function fixOrFallback(error: CapabilityError, fallback: string): string {
  return error.fix ?? fallback
}

const COMMON_NEXT_ACTIONS: NextAction[] = [
  { command: "joelclaw subscribe list", description: "List all subscriptions" },
  {
    command: "joelclaw subscribe check [--id <id>]",
    description: "Force-check a subscription or all",
    params: { id: { description: "Subscription ID (omit for all)" } },
  },
]

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function extractRunIds(result: Record<string, unknown>): string[] {
  const response = asRecord(result.response)
  const runs = Array.isArray(result.runs) ? result.runs : []
  const runIdsFromRuns = runs.flatMap((run) => {
    const record = asRecord(run)
    return record && typeof record.id === "string" ? [record.id] : []
  })

  return unique([
    ...asStringArray(result.runIds),
    ...asStringArray(result.run_ids),
    ...asStringArray(response?.runIds),
    ...asStringArray(response?.run_ids),
    ...runIdsFromRuns,
  ])
}

function extractEventIds(result: Record<string, unknown>): string[] {
  const response = asRecord(result.response)
  const responseIds = typeof result.event === "string"
    ? asStringArray(response?.ids)
    : []

  return unique([
    ...asStringArray(result.eventIds),
    ...asStringArray(result.event_ids),
    ...asStringArray(response?.eventIds),
    ...asStringArray(response?.event_ids),
    ...responseIds,
  ])
}

function runsNextAction(): NextAction {
  return {
    command: "joelclaw runs [--count <count>]",
    description: "Check feed-check run progress",
    params: { count: { default: 5, description: "Number of runs" } },
  }
}

function buildSubscribeCheckNextActions(
  result: Record<string, unknown>,
  hasScopedId: boolean,
): NextAction[] {
  if (!hasScopedId) {
    return [
      runsNextAction(),
      ...COMMON_NEXT_ACTIONS,
    ]
  }

  const runIds = extractRunIds(result)
  const eventIds = extractEventIds(result)
  const nextActions: NextAction[] = []

  if (runIds[0]) {
    nextActions.push({
      command: "joelclaw run <run-id>",
      description: "Check the run progress",
      params: { "run-id": { value: runIds[0], required: true } },
    })
  }

  if (eventIds[0]) {
    nextActions.push({
      command: "joelclaw event <event-id>",
      description: "Inspect the request event and triggered runs",
      params: { "event-id": { value: eventIds[0], required: true } },
    })
  }

  if (!runIds[0]) {
    nextActions.push(runsNextAction())
  }

  nextActions.push(...COMMON_NEXT_ACTIONS)
  return nextActions
}

const subscribeList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const result = yield* executeCapabilityCommand<Record<string, unknown>>({
      capability: "subscribe",
      subcommand: "list",
      args: {},
    }).pipe(Effect.either)

    if (result._tag === "Left") {
      const error = result.left
      yield* Console.log(
        respondError(
          "subscribe list",
          error.message,
          codeOrFallback(error, "SUBSCRIBE_LIST_FAILED"),
          fixOrFallback(error, "Check Redis connectivity and retry."),
          [{ command: "joelclaw subscribe list", description: "Retry listing subscriptions" }],
        ),
      )
      return
    }

    yield* Console.log(respond(
      "subscribe list",
      result.right,
      [
        {
          command: "joelclaw subscribe add <url> [--name <name>] [--type <type>] [--interval <interval>]",
          description: "Add a new subscription",
          params: {
            url: { description: "Feed URL, GitHub repo URL, or page URL", required: true },
            name: { description: "Display name" },
            type: { enum: ["atom", "rss", "github", "page", "bluesky"] },
            interval: { enum: ["hourly", "daily", "weekly"], default: "daily" },
          },
        },
        {
          command: "joelclaw subscribe check [--id <id>]",
          description: "Force-check subscriptions",
          params: { id: { description: "Subscription ID (omit for all)" } },
        },
        {
          command: "joelclaw subscribe remove <id>",
          description: "Remove a subscription",
          params: { id: { description: "Subscription ID", required: true } },
        },
      ],
    ))
  }),
).pipe(
  Command.withDescription("List all monitored subscriptions"),
)

const subscribeAdd = Command.make(
  "add",
  {
    url: Args.text({ name: "url" }).pipe(
      Args.withDescription("Feed URL, GitHub repo URL, or page URL to monitor"),
    ),
    name: Options.text("name").pipe(
      Options.withDescription("Display name for the subscription"),
      Options.optional,
    ),
    type: Options.text("type").pipe(
      Options.withDescription("Feed type: atom, rss, github, page, bluesky"),
      Options.optional,
    ),
    interval: Options.text("interval").pipe(
      Options.withDescription("Check interval: hourly, daily, weekly"),
      Options.withDefault("daily"),
    ),
    filter: Options.text("filter").pipe(
      Options.withAlias("f"),
      Options.withDescription("Comma-separated topic filters"),
      Options.optional,
    ),
  },
  ({ url, name, type, interval, filter }) =>
    Effect.gen(function* () {
      const result = yield* executeCapabilityCommand<Record<string, unknown>>({
        capability: "subscribe",
        subcommand: "add",
        args: {
          url,
          name: name._tag === "Some" ? name.value : undefined,
          type: type._tag === "Some" ? type.value : undefined,
          interval,
          filter: filter._tag === "Some" ? filter.value : undefined,
        },
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        const idValue = typeof url === "string" ? url : "<id>"
        yield* Console.log(
          respondError(
            "subscribe add",
            error.message,
            codeOrFallback(error, "SUBSCRIBE_ADD_FAILED"),
            fixOrFallback(error, "Check Redis connectivity and retry."),
            [
              {
                command: "joelclaw subscribe remove <id>",
                description: "Remove existing subscription",
                params: { id: { value: idValue, required: true } },
              },
              { command: "joelclaw subscribe list", description: "List all subscriptions" },
            ],
          ),
        )
        return
      }

      const added = (result.right.added as { id?: unknown } | undefined)?.id
      const addedId = typeof added === "string" ? added : "<id>"

      yield* Console.log(respond(
        "subscribe add",
        result.right,
        [
          {
            command: "joelclaw subscribe check [--id <id>]",
            description: "Force-check this subscription now",
            params: { id: { value: addedId, description: "Subscription ID" } },
          },
          { command: "joelclaw subscribe list", description: "List all subscriptions" },
          {
            command: "joelclaw subscribe remove <id>",
            description: "Remove this subscription",
            params: { id: { value: addedId, required: true } },
          },
        ],
      ))
    }),
).pipe(
  Command.withDescription("Add a URL to the monitoring list"),
)

const subscribeRemove = Command.make(
  "remove",
  {
    id: Args.text({ name: "id" }).pipe(
      Args.withDescription("Subscription ID to remove"),
    ),
  },
  ({ id }) =>
    Effect.gen(function* () {
      const result = yield* executeCapabilityCommand<Record<string, unknown>>({
        capability: "subscribe",
        subcommand: "remove",
        args: { id },
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "subscribe remove",
            error.message,
            codeOrFallback(error, "SUBSCRIBE_REMOVE_FAILED"),
            fixOrFallback(error, "Check available IDs with: joelclaw subscribe list"),
            [{ command: "joelclaw subscribe list", description: "List all subscriptions" }],
          ),
        )
        return
      }

      yield* Console.log(respond(
        "subscribe remove",
        result.right,
        COMMON_NEXT_ACTIONS,
      ))
    }),
).pipe(
  Command.withDescription("Remove a subscription from the monitoring list"),
)

const subscribeCheck = Command.make(
  "check",
  {
    id: Options.text("id").pipe(
      Options.withDescription("Subscription ID to check (omit for all)"),
      Options.optional,
    ),
  },
  ({ id }) =>
    Effect.gen(function* () {
      const result = yield* executeCapabilityCommand<Record<string, unknown>>({
        capability: "subscribe",
        subcommand: "check",
        args: {
          id: id._tag === "Some" ? id.value : undefined,
        },
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        yield* Console.log(
          respondError(
            "subscribe check",
            error.message,
            codeOrFallback(error, "SUBSCRIBE_CHECK_FAILED"),
            fixOrFallback(error, "Check Inngest worker health and retry."),
            [
              { command: "joelclaw status", description: "Check worker/server health" },
              ...COMMON_NEXT_ACTIONS,
            ],
          ),
        )
        return
      }

      yield* Console.log(respond(
        "subscribe check",
        result.right,
        buildSubscribeCheckNextActions(result.right, id._tag === "Some"),
      ))
    }),
).pipe(
  Command.withDescription("Force-check subscriptions for updates"),
)

const subscribeSummary = Command.make("summary", {}, () =>
  Effect.gen(function* () {
    const result = yield* executeCapabilityCommand<Record<string, unknown>>({
      capability: "subscribe",
      subcommand: "summary",
      args: {},
    }).pipe(Effect.either)

    if (result._tag === "Left") {
      const error = result.left
      yield* Console.log(
        respondError(
          "subscribe summary",
          error.message,
          codeOrFallback(error, "SUBSCRIBE_SUMMARY_FAILED"),
          fixOrFallback(error, "Check Redis connectivity and retry."),
          [{ command: "joelclaw subscribe summary", description: "Retry summary" }],
        ),
      )
      return
    }

    const stale = typeof result.right.stale === "number" ? result.right.stale : 0

    yield* Console.log(respond(
      "subscribe summary",
      result.right,
      [
        ...(stale > 0 ? [{
          command: "joelclaw subscribe check",
          description: `Force-check all (${stale} stale)`,
        }] : []),
        { command: "joelclaw subscribe list", description: "Full subscription list" },
        {
          command: "joelclaw subscribe add <url> [--name <name>]",
          description: "Add a new subscription",
          params: {
            url: { description: "Feed URL or page URL", required: true },
            name: { description: "Display name" },
          },
        },
      ],
    ))
  }),
).pipe(
  Command.withDescription("Summary of subscription health and recent checks"),
)

export const subscribeCmd = Command.make("subscribe", {}, () =>
  Console.log(respond(
    "subscribe",
    {
      description: "Monitor blogs, repos, and pages for changes (ADR-0127)",
      subcommands: {
        list: "joelclaw subscribe list",
        add: "joelclaw subscribe add <url> [--name <name>] [--type <type>] [--interval <interval>]",
        remove: "joelclaw subscribe remove <id>",
        check: "joelclaw subscribe check [--id <id>]",
        summary: "joelclaw subscribe summary",
      },
    },
    [
      { command: "joelclaw subscribe list", description: "List all subscriptions" },
      {
        command: "joelclaw subscribe add <url> [--name <name>]",
        description: "Add a new subscription",
        params: {
          url: { description: "Feed URL, GitHub repo, or page URL", required: true },
          name: { description: "Display name" },
        },
      },
      { command: "joelclaw subscribe summary", description: "Health summary" },
    ],
  )),
).pipe(
  Command.withDescription("Monitor blogs, repos, and pages for changes (ADR-0127)"),
  Command.withSubcommands([subscribeList, subscribeAdd, subscribeRemove, subscribeCheck, subscribeSummary]),
)

export const __subscribeTestUtils = {
  extractRunIds,
  extractEventIds,
  buildSubscribeCheckNextActions,
}
