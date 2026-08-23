/**
 * Non-default `recall` adapter: composed flowing + curated retrieval.
 *
 * It is registered in the capability registry but nothing binds to it.
 * `DEFAULT_CAPABILITY_CONFIG.recall.adapter` stays `typesense-recall`, so the
 * CLI, the SDK, the gateway, and every production caller keep the old path
 * until someone deliberately selects this adapter with config, an environment
 * variable, or `--adapter`.
 */

import { Effect, ParseResult, Schema } from "effect";
import type { ComposeRecallInput } from "../../recall/composer";
import { composeRecall } from "../../recall/composer";
import {
  COMPOSED_RECALL_SCHEMA_VERSION,
  ComposedRecallRequestV1Schema,
  encodeComposedRecallResult,
} from "../../recall/contract";
import type { AnyCapabilityPort } from "../contract";
import { capabilityError } from "../contract";

export const FLOWING_MEMORY_RECALL_ADAPTER = "flowing-memory-recall";

const PrivacyTierSchema = Schema.Literal("public", "private", "sensitive");

/**
 * Every field is required. There is no default principal, no default purpose,
 * no default privacy grant, and no default scope. An unscoped caller is refused,
 * not silently pointed at `joelclaw-fleet/default`.
 */
const ComposedQueryArgsSchema = Schema.Struct({
  allowedPrivacy: Schema.Array(PrivacyTierSchema),
  curatedLimit: Schema.Number,
  decidedAt: Schema.String,
  includeSuperseded: Schema.Boolean,
  observationLimit: Schema.Number,
  principalRef: Schema.String,
  project: Schema.String,
  purpose: Schema.String,
  query: Schema.String,
  reflectionLimit: Schema.Number,
  workstream: Schema.String,
});

const ComposedQueryResultSchema = Schema.Struct({
  raw: Schema.Boolean,
  payload: Schema.optional(Schema.Unknown),
});

const commands = {
  query: {
    summary: "Compose separately ranked flowing and curated recall lanes",
    argsSchema: ComposedQueryArgsSchema,
    resultSchema: ComposedQueryResultSchema,
  },
} as const;

type ComposedQueryArgs = Schema.Schema.Type<typeof ComposedQueryArgsSchema>;

const decodeQueryArgs = Schema.decodeUnknown(ComposedQueryArgsSchema);

export function buildComposedRequest(args: ComposedQueryArgs) {
  return {
    _tag: "ComposedRecallRequestV1" as const,
    access: {
      _tag: "RecallAccessV1" as const,
      allowedPrivacy: args.allowedPrivacy,
      decidedAt: args.decidedAt,
      principalRef: args.principalRef,
      purpose: args.purpose,
    },
    includeSuperseded: args.includeSuperseded,
    limits: {
      curated: args.curatedLimit,
      observations: args.observationLimit,
      reflections: args.reflectionLimit,
    },
    schemaVersion: COMPOSED_RECALL_SCHEMA_VERSION,
    scope: {
      _tag: "ProjectWorkstream" as const,
      project: args.project,
      workstream: args.workstream,
    },
    text: args.query,
  };
}

const decodeRequest = Schema.decodeUnknownEither(ComposedRecallRequestV1Schema);

/**
 * Process-boundary seams. Production leaves every one of them empty and gets the
 * real child process, the real credential lease, and the real local
 * `critical.db`. Tests build their own adapter instance with fakes and register
 * it in their own registry, so the production adapter has no mutable test state.
 */
export interface FlowingMemoryRecallOverrides {
  readonly runProcess?: ComposeRecallInput["runProcess"];
  readonly leaseCredential?: ComposeRecallInput["leaseCredential"];
  readonly curatedSearch?: ComposeRecallInput["curatedSearch"];
  readonly parentEnv?: ComposeRecallInput["parentEnv"];
  readonly trustedReleaseRoot?: string;
  readonly expectedMemoryCommit?: string;
  readonly expectedArtifactSha256?: string;
}

export function createFlowingMemoryRecallAdapter(
  overrides: FlowingMemoryRecallOverrides = {},
): AnyCapabilityPort {
  return {
  capability: "recall",
  adapter: FLOWING_MEMORY_RECALL_ADAPTER,
  commands,
  execute(subcommand, rawArgs, context) {
    return Effect.gen(function* () {
      if (subcommand !== "query") {
        return yield* Effect.fail(
          capabilityError(
            "RECALL_SUBCOMMAND_UNSUPPORTED",
            `Unsupported composed recall subcommand: ${String(subcommand)}`,
          ),
        );
      }

      const args = yield* decodeQueryArgs(rawArgs).pipe(
        Effect.mapError((error) =>
          capabilityError(
            "COMPOSED_RECALL_INVALID_ARGS",
            ParseResult.TreeFormatter.formatErrorSync(error),
            "Pass exact --project, --workstream, --principal-ref, --purpose, --decided-at, and --allowed-privacy.",
          ),
        ),
      );

      const request = decodeRequest(buildComposedRequest(args));
      if (request._tag === "Left") {
        return yield* Effect.fail(
          capabilityError(
            "COMPOSED_RECALL_SCOPE_REQUIRED",
            "Composed recall requires an exact project/workstream scope and an explicit access decision",
            "Supply --project, --workstream, --principal-ref, --purpose, --decided-at, and at least one privacy tier.",
          ),
        );
      }

      const settings =
        context.config.capabilities.recall?.adapters?.[FLOWING_MEMORY_RECALL_ADAPTER];

      const outcome = yield* Effect.tryPromise({
        try: () =>
          composeRecall({
            request: request.right,
            ...(settings ? { flowingSettings: settings } : {}),
            ...(overrides.runProcess ? { runProcess: overrides.runProcess } : {}),
            ...(overrides.leaseCredential ? { leaseCredential: overrides.leaseCredential } : {}),
            ...(overrides.curatedSearch ? { curatedSearch: overrides.curatedSearch } : {}),
            ...(overrides.parentEnv ? { parentEnv: overrides.parentEnv } : {}),
            ...(overrides.trustedReleaseRoot
              ? { trustedReleaseRoot: overrides.trustedReleaseRoot }
              : {}),
            ...(overrides.expectedMemoryCommit
              ? { expectedMemoryCommit: overrides.expectedMemoryCommit }
              : {}),
            ...(overrides.expectedArtifactSha256
              ? { expectedArtifactSha256: overrides.expectedArtifactSha256 }
              : {}),
          }),
        catch: (error) =>
          capabilityError(
            "COMPOSED_RECALL_FAILED",
            error instanceof Error ? error.message : String(error),
            "Inspect the per-lane unavailability in the composed result.",
          ),
      });

      return {
        raw: false,
        payload: {
          adapter: FLOWING_MEMORY_RECALL_ADAPTER,
          composed: encodeComposedRecallResult(outcome.result),
          curatedBackend: outcome.curatedBackend,
          timings: outcome.timings,
        },
      };
    });
  },
  };
}

export const flowingMemoryRecallAdapter: AnyCapabilityPort =
  createFlowingMemoryRecallAdapter();

export const __flowingMemoryRecallTestUtils = {
  buildComposedRequest,
  commands,
};
