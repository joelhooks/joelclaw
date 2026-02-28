/**
 * ADR-0168: Content management commands.
 *
 * `joelclaw content seed`            — full Vault → Convex sync
 * `joelclaw content verify`          — strict diff Vault vs Convex (missing + ADR extras)
 * `joelclaw content prune`           — dry-run ADR prune candidates in Convex
 * `joelclaw content prune --apply`   — remove ADR extras from Convex
 */

import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import { type NextAction, respond } from "../response"

const CONTENT_COMMANDS = {
  seed: "Full Vault → Convex content sync",
  verify: "Strict ADR diff (missing + extra in Convex)",
  prune: "Dry-run ADR extras in Convex (use --apply to remove)",
} as const

const seedNextActions: readonly NextAction[] = [
  {
    command: "joelclaw runs --count 5",
    description: "Check run progress",
  },
  {
    command: "joelclaw content verify",
    description: "Verify sync completeness after run finishes",
  },
]

const verifyNextActions: readonly NextAction[] = [
  {
    command: "joelclaw runs --count 5",
    description: "Check run results",
  },
  {
    command: "joelclaw content prune",
    description: "Inspect Convex ADR records that should be pruned",
  },
]

const buildPruneNextActions = (apply: boolean): readonly NextAction[] =>
  apply
    ? [
        {
          command: "joelclaw runs --count 5",
          description: "Check prune run completion",
        },
        {
          command: "joelclaw content verify",
          description: "Confirm ADR source-of-truth is now clean",
        },
      ]
    : [
        {
          command: "joelclaw runs --count 5",
          description: "Inspect dry-run output",
        },
        {
          command: "joelclaw content prune --apply",
          description: "Apply ADR prune in Convex after review",
        },
      ]

const seedCmd = Command.make("seed", {}, () =>
  Effect.gen(function* () {
    const inngest = yield* Inngest
    const result = yield* inngest.send("content/seed.requested", {
      source: "cli",
    })
    yield* Console.log(
      respond("content seed", { event: "content/seed.requested", ...result }, seedNextActions),
    )
  }),
).pipe(Command.withDescription(CONTENT_COMMANDS.seed))

const verifyCmd = Command.make("verify", {}, () =>
  Effect.gen(function* () {
    const inngest = yield* Inngest
    const result = yield* inngest.send("content/verify.requested", {
      source: "cli",
    })
    yield* Console.log(
      respond("content verify", { event: "content/verify.requested", ...result }, verifyNextActions),
    )
  }),
).pipe(Command.withDescription("Strict diff Vault sources vs Convex records"))

const pruneApplyOpt = Options.boolean("apply").pipe(
  Options.withDefault(false),
  Options.withDescription("Apply prune (default is dry-run)"),
)

const pruneCmd = Command.make("prune", { apply: pruneApplyOpt }, ({ apply }) =>
  Effect.gen(function* () {
    const inngest = yield* Inngest
    const result = yield* inngest.send("content/prune.requested", {
      source: "cli",
      apply,
    })
    yield* Console.log(
      respond(
        apply ? "content prune --apply" : "content prune",
        { event: "content/prune.requested", apply, ...result },
        buildPruneNextActions(apply),
      ),
    )
  }),
).pipe(Command.withDescription("Report or remove ADR extras from Convex"))

export const contentCmd = Command.make("content", {}, () =>
  Effect.gen(function* () {
    yield* Console.log(
      respond(
        "content",
        {
          commands: CONTENT_COMMANDS,
        },
        [
          { command: "joelclaw content seed", description: "Sync all content" },
          { command: "joelclaw content verify", description: "Strictly check for ADR drift" },
          { command: "joelclaw content prune", description: "Dry-run ADR prune candidates" },
        ],
      ),
    )
  }),
).pipe(
  Command.withDescription("Content management (ADR-0168)"),
  Command.withSubcommands([seedCmd, verifyCmd, pruneCmd]),
)

export const __contentTestUtils = {
  CONTENT_COMMANDS,
  buildPruneNextActions,
}
