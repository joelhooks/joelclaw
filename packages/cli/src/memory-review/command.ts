import { Command, Options } from "@effect/cli";
import { Console, Effect } from "effect";
import { respond, respondError } from "../response";
import { defaultMemoryReviewDependencies } from "./adapters";
import { buildMemoryReview } from "./review";

const since = Options.text("since").pipe(
  Options.withDefault("48h"),
  Options.withDescription("Past duration such as 48h or a past ISO-8601 instant"),
);
const project = Options.text("project").pipe(
  Options.withDefault(""),
  Options.withDescription("Optional project filter, for example joelhooks.joelclaw"),
);
const workstream = Options.text("workstream").pipe(
  Options.withDefault(""),
  Options.withDescription("Optional workstream filter; pair with --project for flowing evidence"),
);
const limit = Options.integer("limit").pipe(
  Options.withDefault(20),
  Options.withDescription("Maximum evidence items per lane (1-100)"),
);

const SCOPE_FILTER_PATTERN = /^[a-z0-9](?:[a-z0-9._/-]{0,238}[a-z0-9])?$/u;

export const memoryReviewCmd = Command.make(
  "review",
  { since, project, workstream, limit },
  (options) =>
    Effect.gen(function* () {
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
        process.exitCode = 1;
        yield* Console.log(
          respondError(
            "memory review",
            "Evidence limit must be an integer between 1 and 100",
            "MEMORY_REVIEW_LIMIT_INVALID",
            "Pass --limit between 1 and 100.",
          ),
        );
        return;
      }

      const invalidScope = [options.project.trim(), options.workstream.trim()]
        .filter(Boolean)
        .find((value) => !SCOPE_FILTER_PATTERN.test(value));
      if (invalidScope) {
        process.exitCode = 1;
        yield* Console.log(
          respondError(
            "memory review",
            "Project and workstream filters must be canonical lowercase scope keys",
            "MEMORY_REVIEW_SCOPE_INVALID",
            "Use lowercase letters, digits, dots, slashes, underscores, or hyphens.",
          ),
        );
        return;
      }

      const result = yield* Effect.tryPromise({
        try: () =>
          buildMemoryReview(
            {
              since: options.since,
              project: options.project.trim() || undefined,
              workstream: options.workstream.trim() || undefined,
              limit: options.limit,
            },
            defaultMemoryReviewDependencies,
          ),
        catch: () => new Error("Memory review could not satisfy its output contract"),
      }).pipe(Effect.either);

      if (result._tag === "Left") {
        process.exitCode = 1;
        yield* Console.log(
          respondError(
            "memory review",
            result.left.message,
            "MEMORY_REVIEW_INVALID",
            "Use --since 48h and optional --project/--workstream filters.",
          ),
        );
        return;
      }

      yield* Console.log(
        respond("memory review", result.right, [
          {
            command: "joelclaw sessions search <query> --source both --extract",
            description: "Drill into explicit session evidence",
          },
          {
            command:
              "joelclaw memory review --since 48h --project <project> --workstream <workstream>",
            description: "Narrow the review to one exact flowing-memory scope",
          },
        ]),
      );
    }),
).pipe(Command.withDescription("Review recent fleet memory as separate evidence lanes"));
