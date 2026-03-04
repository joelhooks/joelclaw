/**
 * `joelclaw memory` — human-friendly memory interface.
 *
 * Subcommands:
 *   write <text>  — submit an observation to the memory pipeline
 *   search <query> — semantic search across observations (alias for recall)
 *   recent         — list recently written observations
 *
 * The write subcommand fires `memory/observation.submitted` to Inngest,
 * which runs the write-gate pipeline (observe → proposal-triage → promote).
 *
 * Categories use short names that map to `jc:` prefixed SKOS concepts:
 *   ops, rules, arch, projects, prefs, people, memory
 */

import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import type { CapabilityError } from "../capabilities/contract"
import { executeCapabilityCommand } from "../capabilities/runtime"
import { Inngest } from "../inngest"
import { respond, respondError } from "../response"

// ── Category mapping ────────────────────────────────────────────
const CATEGORY_MAP: Record<string, string> = {
  operations: "jc:operations",
  ops: "jc:operations",
  rules: "jc:rules-conventions",
  conventions: "jc:rules-conventions",
  architecture: "jc:system-architecture",
  arch: "jc:system-architecture",
  projects: "jc:projects",
  preferences: "jc:preferences",
  prefs: "jc:preferences",
  people: "jc:people-relationships",
  relationships: "jc:people-relationships",
  memory: "jc:memory-system",
}

const VALID_CATEGORIES = ["ops", "rules", "arch", "projects", "prefs", "people", "memory"]

function resolveCategory(input: string): string {
  const lower = input.toLowerCase().trim()
  if (lower.startsWith("jc:")) return lower
  return CATEGORY_MAP[lower] ?? `jc:${lower}`
}

type RecallCapabilityResult = {
  raw: boolean
  text?: string
  payload?: Record<string, unknown>
}

function codeOrFallback(error: CapabilityError, fallback: string): string {
  return error.code || fallback
}

function fixOrFallback(error: CapabilityError, fallback: string): string {
  return error.fix ?? fallback
}

// ── Write subcommand ────────────────────────────────────────────
const writeCmd = Command.make(
  "write",
  {
    observation: Args.text({ name: "observation" }).pipe(
      Args.withDescription("The observation to remember (concrete, reusable, future-tense useful)")
    ),
    category: Options.text("category").pipe(
      Options.withAlias("c"),
      Options.withDefault("ops"),
      Options.withDescription(`Category: ${VALID_CATEGORIES.join(", ")}`)
    ),
    tags: Options.text("tags").pipe(
      Options.withAlias("t"),
      Options.withDefault(""),
      Options.withDescription("Comma-separated tags")
    ),
    source: Options.text("source").pipe(
      Options.withAlias("s"),
      Options.withDefault("cli"),
      Options.withDescription("Source identifier (default: cli)")
    ),
  },
  ({ observation, category, tags, source }) =>
    Effect.gen(function* () {
      const trimmed = observation.trim()
      if (trimmed.length === 0) {
        yield* Console.log(
          respondError(
            "memory write",
            "Observation text cannot be empty",
            "EMPTY_TEXT",
            'Provide observation text: joelclaw memory write "your observation"',
            [{ command: 'joelclaw memory write "your observation" --category ops', description: "Write an observation" }]
          )
        )
        return
      }

      const inngestClient = yield* Inngest
      const resolvedCategory = resolveCategory(category)
      const tagList = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)

      const payload = {
        observation: trimmed,
        category: resolvedCategory,
        source,
        tags: tagList,
      }

      const result = yield* inngestClient
        .send("memory/observation.submitted", payload)
        .pipe(Effect.either)

      if (result._tag === "Left") {
        yield* Console.log(
          respondError(
            "memory write",
            `Failed to send: ${String(result.left)}`,
            "SEND_FAILED",
            "Check Inngest: joelclaw inngest status",
            [
              { command: "joelclaw inngest status", description: "Check Inngest health" },
              { command: "joelclaw status", description: "Full system health" },
            ]
          )
        )
        return
      }

      const runIds = (result.right as any)?.ids ?? []

      yield* Console.log(
        respond(
          "memory write",
          {
            observation: trimmed,
            category: resolvedCategory,
            source,
            tags: tagList,
            run_id: runIds[0] ?? null,
          },
          [
            {
              command: `joelclaw run ${runIds[0] ?? "<run-id>"}`,
              description: "Track the write-gate pipeline",
            },
            {
              command: `joelclaw memory search "${trimmed.slice(0, 40)}"`,
              description: "Verify it landed (after pipeline completes)",
            },
            {
              command: "joelclaw memory recent",
              description: "See recent observations",
            },
          ]
        )
      )
    })
).pipe(Command.withDescription("Write an observation to agent memory"))

// ── Search subcommand ───────────────────────────────────────────
const searchCmd = Command.make(
  "search",
  {
    query: Args.text({ name: "query" }),
    limit: Options.integer("limit").pipe(Options.withDefault(5)),
    category: Options.text("category").pipe(
      Options.withAlias("c"),
      Options.withDefault(""),
      Options.withDescription("Filter by category")
    ),
    raw: Options.boolean("raw").pipe(Options.withDefault(false)),
  },
  ({ query, limit, category, raw }) =>
    Effect.gen(function* () {
      const resolvedCategory = category ? resolveCategory(category) : ""

      const result = yield* executeCapabilityCommand<RecallCapabilityResult>({
        capability: "recall",
        subcommand: "query",
        args: {
          query,
          limit,
          minScore: 0,
          raw,
          includeHold: false,
          includeDiscard: false,
          budget: "auto",
          category: resolvedCategory,
        },
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        const error = result.left
        const code = codeOrFallback(error, "UNKNOWN")

        yield* Console.log(
          respondError(
            "memory search",
            error.message,
            code,
            fixOrFallback(error, "Check Typesense: joelclaw status"),
            [{ command: "joelclaw status", description: "Check system health" }]
          )
        )
        return
      }

      if (result.right.raw) {
        yield* Console.log(result.right.text ?? "")
        return
      }

      yield* Console.log(
        respond("memory search", result.right.payload ?? {}, [
          {
            command: `joelclaw memory search "${query}" --limit 10`,
            description: "More results",
          },
          {
            command: `joelclaw memory write "<observation>" --category ops`,
            description: "Write a new observation",
          },
        ])
      )
    })
).pipe(Command.withDescription("Search agent memory (semantic recall)"))

// ── Recent subcommand ───────────────────────────────────────────
const recentCmd = Command.make(
  "recent",
  {
    count: Options.integer("count").pipe(
      Options.withAlias("n"),
      Options.withDefault(10)
    ),
    hours: Options.integer("hours").pipe(Options.withDefault(24)),
  },
  ({ count, hours }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      const result = yield* inngestClient.events({
        prefix: "memory/observation",
        hours,
        count,
      })

      const observations = (result as any[]).map((e: any) => ({
        id: e.id,
        at: e.occurredAt,
        observation: e.data?.observation?.slice(0, 120) ?? "(no text)",
        category: e.data?.category ?? "unknown",
        source: e.data?.source ?? "unknown",
      }))

      yield* Console.log(
        respond("memory recent", { count: observations.length, hours, observations }, [
          {
            command: "joelclaw memory recent --hours 48 --count 20",
            description: "Look further back",
          },
          {
            command: 'joelclaw memory write "<observation>"',
            description: "Write a new observation",
          },
        ])
      )
    })
).pipe(Command.withDescription("List recently submitted observations"))

// ── Root memory command ─────────────────────────────────────────
export const memoryCmd = Command.make("memory", {}, () =>
  Console.log(
    respond(
      "memory",
      {
        description: "Agent memory — write, search, and inspect observations",
        categories: VALID_CATEGORIES,
        usage: [
          'joelclaw memory write "Stripe requires idempotency keys" --category ops --tags stripe,api',
          'joelclaw memory search "stripe patterns"',
          "joelclaw memory recent --hours 24",
        ],
      },
      [
        {
          command: 'joelclaw memory write "<text>" [--category ops] [--tags a,b]',
          description: "Write an observation",
        },
        {
          command: 'joelclaw memory search "<query>" [--limit 5]',
          description: "Semantic search",
        },
        {
          command: "joelclaw memory recent [--hours 24]",
          description: "Recent observations",
        },
      ]
    )
  )
).pipe(
  Command.withDescription("Agent memory — write, search, and inspect observations"),
  Command.withSubcommands([writeCmd, searchCmd, recentCmd])
)
