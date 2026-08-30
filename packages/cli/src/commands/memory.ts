/**
 * `joelclaw memory` — composed recall and recent fleet review.
 *
 * Direct observation writes are retired. Agent work enters flowing memory
 * through accepted Runs; durable curated knowledge belongs in Brain pages.
 */

import { Args, Command, Options } from "@effect/cli";
import { Console, Effect } from "effect";
import { memoryReviewCmd } from "../memory-review/command";
import { respond, respondError } from "../response";

const MEMORY_REVIEW_ACTION = {
  command: "joelclaw memory review --since 48h",
  description: "Review recent whole-fleet memory evidence",
} as const;

const RECALL_OTEL_ACTION = {
  command:
    'joelclaw otel search "memory.recall.completed" --hours 24 --component recall-cli --limit 20',
  description: "Inspect recent recall telemetry",
} as const;

const INTERACTIVE_RECALL_ACTION = {
  command: 'joelclaw recall "<query>"',
  description: "Search composed flowing and curated memory interactively",
} as const;

const PRIVATE_RECALL_ACTION = {
  command: "joelclaw recall --request-file -",
  description: "Pass an exact composed recall request on stdin",
} as const;

const MEMORY_HEALTH_NEXT_ACTIONS = [MEMORY_REVIEW_ACTION, RECALL_OTEL_ACTION] as const;

// ── Write subcommand ────────────────────────────────────────────
const writeCmd = Command.make(
  "write",
  {
    observation: Args.text({ name: "observation" }).pipe(
      Args.withDescription("The observation to remember (concrete, reusable, future-tense useful)"),
    ),
    category: Options.text("category").pipe(
      Options.withAlias("c"),
      Options.withDefault("ops"),
      Options.withDescription("Legacy category compatibility flag (ignored)"),
    ),
    tags: Options.text("tags").pipe(
      Options.withAlias("t"),
      Options.withDefault(""),
      Options.withDescription("Comma-separated tags"),
    ),
    source: Options.text("source").pipe(
      Options.withAlias("s"),
      Options.withDefault("cli"),
      Options.withDescription("Source identifier (default: cli)"),
    ),
  },
  () =>
    Effect.gen(function* () {
      process.exitCode = 3;
      yield* Console.log(
        respondError(
          "memory write",
          "Direct observation writes are retired",
          "MEMORY_WRITE_RETIRED",
          "Agent work enters flowing memory through accepted Runs. Curate durable knowledge as a Brain .svx page.",
          [
            {
              command: "joelclaw memory review --since 48h",
              description: "Review recent fleet memory",
            },
            {
              command: "joelclaw recall <query>",
              description: "Search composed flowing and curated memory",
            },
          ],
        ),
      );
    }),
).pipe(Command.withDescription("Retired compatibility pointer for direct memory writes"));

// ── Search subcommand ───────────────────────────────────────────
const searchCmd = Command.make(
  "search",
  {
    query: Args.text({ name: "query" }),
    limit: Options.integer("limit").pipe(Options.withDefault(5)),
    category: Options.text("category").pipe(
      Options.withAlias("c"),
      Options.withDefault(""),
      Options.withDescription("Filter by category"),
    ),
    raw: Options.boolean("raw").pipe(Options.withDefault(false)),
  },
  () =>
    Effect.gen(function* () {
      process.exitCode = 3;
      yield* Console.log(
        respondError(
          "memory search",
          "Memory search is retired",
          "MEMORY_SEARCH_RETIRED",
          'Use joelclaw recall "<query>" interactively or joelclaw recall --request-file - for an exact composed request.',
          [INTERACTIVE_RECALL_ACTION, PRIVATE_RECALL_ACTION, MEMORY_REVIEW_ACTION],
        ),
      );
    }),
).pipe(Command.withDescription("Retired compatibility pointer for memory search"));

// ── Recent subcommand ───────────────────────────────────────────
const recentCmd = Command.make(
  "recent",
  {
    count: Options.integer("count").pipe(Options.withAlias("n"), Options.withDefault(10)),
    hours: Options.integer("hours").pipe(Options.withDefault(24)),
  },
  () =>
    Effect.gen(function* () {
      process.exitCode = 3;
      yield* Console.log(
        respondError(
          "memory recent",
          "Recent observation events are retired",
          "MEMORY_RECENT_RETIRED",
          "Use fleet memory review and narrow recall telemetry instead.",
          MEMORY_HEALTH_NEXT_ACTIONS,
        ),
      );
    }),
).pipe(Command.withDescription("Retired compatibility pointer for recent observations"));

// ── Scorecard subcommand ───────────────────────────────────────
const scorecardCmd = Command.make(
  "scorecard",
  {
    hours: Options.integer("hours").pipe(Options.withDefault(24)),
  },
  () =>
    Effect.gen(function* () {
      process.exitCode = 3;
      yield* Console.log(
        respondError(
          "memory scorecard",
          "The Typesense-era memory scorecard is retired",
          "MEMORY_SCORECARD_RETIRED",
          "Use fleet memory review and narrow recall telemetry instead.",
          MEMORY_HEALTH_NEXT_ACTIONS,
        ),
      );
    }),
).pipe(Command.withDescription("Retired compatibility pointer for the memory scorecard"));

// ── Root memory command ─────────────────────────────────────────
export const memoryCmd = Command.make("memory", {}, () =>
  Console.log(
    respond(
      "memory",
      {
        description: "Composed recall and recent whole-fleet memory review",
        usage: ["joelclaw memory review --since 48h", 'joelclaw recall "<query>"'],
        retired: [
          {
            command: "joelclaw memory write",
            status: "retired",
            replacement: "Curate durable knowledge as a Brain .svx page",
          },
          {
            command: "joelclaw memory search",
            status: "retired",
            replacement: INTERACTIVE_RECALL_ACTION.command,
          },
          {
            command: "joelclaw memory recent",
            status: "retired",
            replacement: MEMORY_REVIEW_ACTION.command,
          },
          {
            command: "joelclaw memory scorecard",
            status: "retired",
            replacement: RECALL_OTEL_ACTION.command,
          },
        ],
      },
      [INTERACTIVE_RECALL_ACTION, PRIVATE_RECALL_ACTION, MEMORY_REVIEW_ACTION],
    ),
  ),
).pipe(
  Command.withDescription("Recall through canonical surfaces and review recent fleet evidence"),
  Command.withSubcommands([writeCmd, searchCmd, recentCmd, scorecardCmd, memoryReviewCmd]),
);
