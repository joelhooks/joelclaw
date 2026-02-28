/**
 * ADR-0168: Content management commands.
 *
 * `joelclaw content seed`   — full Vault → Convex sync
 * `joelclaw content verify` — diff Vault vs Convex, report gaps
 */

import { Command } from "@effect/cli";
import { Console, Effect } from "effect";
import { Inngest } from "../inngest";
import { respond } from "../response";

const seedCmd = Command.make("seed", {}, () =>
  Effect.gen(function* () {
    const inngest = yield* Inngest;
    const result = yield* inngest.send("content/seed.requested", {
      source: "cli",
    });
    yield* Console.log(
      respond("content seed", { event: "content/seed.requested", ...result }, [
        {
          command: "joelclaw runs --count 5",
          description: "Check run progress",
        },
        {
          command: "joelclaw content verify",
          description: "Verify sync completeness after run finishes",
        },
      ]),
    );
  }),
).pipe(Command.withDescription("Full Vault → Convex content sync"));

const verifyCmd = Command.make("verify", {}, () =>
  Effect.gen(function* () {
    const inngest = yield* Inngest;
    const result = yield* inngest.send("content/verify.requested", {
      source: "cli",
    });
    yield* Console.log(
      respond("content verify", { event: "content/verify.requested", ...result }, [
        {
          command: "joelclaw runs --count 5",
          description: "Check run results",
        },
      ]),
    );
  }),
).pipe(Command.withDescription("Diff Vault sources vs Convex records"));

export const contentCmd = Command.make("content", {}, () =>
  Effect.gen(function* () {
    yield* Console.log(
      respond("content", {
        commands: {
          seed: "Full Vault → Convex content sync",
          verify: "Diff Vault sources vs Convex records, report gaps",
        },
      }, [
        { command: "joelclaw content seed", description: "Sync all content" },
        { command: "joelclaw content verify", description: "Check for gaps" },
      ]),
    );
  }),
).pipe(
  Command.withDescription("Content management (ADR-0168)"),
  Command.withSubcommands([seedCmd, verifyCmd]),
);
