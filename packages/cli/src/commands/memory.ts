/**
 * `joelclaw memory` — composed recall and recent fleet review.
 *
 * Direct observation writes are retired. Agent work enters flowing memory
 * through accepted Runs; durable curated knowledge belongs in Brain pages.
 */

import { Args, Command, Options } from "@effect/cli";
import { Console, Effect } from "effect";
import type { CapabilityError } from "../capabilities/contract";
import { executeCapabilityCommand } from "../capabilities/runtime";
import { memoryReviewCmd } from "../memory-review/command";
import { respond, respondError } from "../response";

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
};

const VALID_CATEGORIES = ["ops", "rules", "arch", "projects", "prefs", "people", "memory"];

const MEMORY_REVIEW_ACTION = {
  command: "joelclaw memory review --since 48h",
  description: "Review recent whole-fleet memory evidence",
} as const;

const RECALL_OTEL_ACTION = {
  command:
    'joelclaw otel search "memory.recall.completed" --hours 24 --component recall-cli --limit 20',
  description: "Inspect recent recall telemetry",
} as const;

const MEMORY_HEALTH_NEXT_ACTIONS = [MEMORY_REVIEW_ACTION, RECALL_OTEL_ACTION] as const;

function resolveCategory(input: string): string {
  const lower = input.toLowerCase().trim();
  if (lower.startsWith("jc:")) return lower;
  return CATEGORY_MAP[lower] ?? `jc:${lower}`;
}

type RecallCapabilityResult = {
  raw: boolean;
  text?: string;
  payload?: Record<string, unknown>;
};

function codeOrFallback(error: CapabilityError, fallback: string): string {
  return error.code || fallback;
}

function fixOrFallback(error: CapabilityError, fallback: string): string {
  return error.fix ?? fallback;
}

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
      Options.withDescription(`Category: ${VALID_CATEGORIES.join(", ")}`),
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
  ({ query, limit, category, raw }) =>
    Effect.gen(function* () {
      const resolvedCategory = category ? resolveCategory(category) : "";

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
      }).pipe(Effect.either);

      if (result._tag === "Left") {
        const error = result.left;
        const code = codeOrFallback(error, "UNKNOWN");

        yield* Console.log(
          respondError(
            "memory search",
            error.message,
            code,
            fixOrFallback(error, "Check Typesense: joelclaw status"),
            [{ command: "joelclaw status", description: "Check system health" }],
          ),
        );
        return;
      }

      if (result.right.raw) {
        yield* Console.log(result.right.text ?? "");
        return;
      }

      yield* Console.log(
        respond("memory search", result.right.payload ?? {}, [
          {
            command: `joelclaw memory search "${query}" --limit 10`,
            description: "More results",
          },
          MEMORY_REVIEW_ACTION,
          {
            command: `joelclaw recall "${query}"`,
            description: "Search composed flowing and curated memory directly",
          },
        ]),
      );
    }),
).pipe(Command.withDescription("Search agent memory (semantic recall)"));

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
        categories: VALID_CATEGORIES,
        usage: [
          'joelclaw memory search "<query>"',
          "joelclaw memory review --since 48h",
          'joelclaw recall "<query>"',
        ],
        retired: [
          {
            command: "joelclaw memory write",
            status: "retired",
            replacement: "Curate durable knowledge as a Brain .svx page",
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
      [
        {
          command: 'joelclaw memory search "<query>" [--limit 5]',
          description: "Search composed memory",
        },
        MEMORY_REVIEW_ACTION,
        {
          command: 'joelclaw recall "<query>"',
          description: "Search composed flowing and curated memory directly",
        },
      ],
    ),
  ),
).pipe(
  Command.withDescription("Search composed memory and review recent fleet evidence"),
  Command.withSubcommands([writeCmd, searchCmd, recentCmd, scorecardCmd, memoryReviewCmd]),
);
