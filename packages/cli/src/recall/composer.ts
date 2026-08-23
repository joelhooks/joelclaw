/**
 * Recall composer.
 *
 * Routes one request to the flowing port and the curated port, then labels the
 * lanes each one returned. It does not merge, re-score, or re-order across
 * lanes, and it never lets one lane's answer stand in for another lane's
 * failure: a lane that could not answer is typed unavailable in the result.
 */

import { Schema } from "effect";
import type { CapabilityAdapterSettings } from "../capabilities/contract";
import {
  COMPOSED_RECALL_SCHEMA_VERSION,
  type ComposedRecallRequestV1,
  type ComposedRecallResultV1,
  ComposedRecallResultV1Schema,
  collectUnavailable,
  type RecallLaneV1,
  unavailableLane,
} from "./contract";
import { type CuratedSearch, readCuratedRecall } from "./curated-port";
import {
  FLOWING_LANES,
  FLOWING_RECALL_SOURCE,
  type FlowingRecallPortConfig,
  readFlowingRecall,
  resolveFlowingRecallPortConfig,
} from "./flowing-port";
import type { BoundaryProcessRunner, CredentialLeaseRunner } from "./process-boundary";

export interface ComposeRecallInput {
  readonly request: ComposedRecallRequestV1;
  readonly flowingSettings?: CapabilityAdapterSettings;
  readonly flowingConfig?: FlowingRecallPortConfig;
  readonly runProcess?: BoundaryProcessRunner;
  readonly leaseCredential?: CredentialLeaseRunner;
  readonly curatedSearch?: CuratedSearch;
  readonly parentEnv?: Record<string, string | undefined>;
  /** Test seam only. Project config can never widen the trusted release root. */
  readonly trustedReleaseRoot?: string;
  /** Test seam only. Production always requires the pinned memory commit. */
  readonly expectedMemoryCommit?: string;
  /** Test seam only. Production always requires the anchored artifact digest. */
  readonly expectedArtifactSha256?: string;
}

export interface ComposeRecallOutcome {
  readonly result: ComposedRecallResultV1;
  readonly timings: {
    readonly flowingMs: number;
    readonly curatedMs: number;
    readonly totalMs: number;
  };
  readonly curatedBackend: string;
  readonly flowingCommand: readonly string[];
}

const validateResult = Schema.decodeUnknownEither(ComposedRecallResultV1Schema);

type FlowingLaneMap = Record<"flowing-observations" | "flowing-reflections", RecallLaneV1>;

function flowingConfigFor(
  input: ComposeRecallInput,
):
  | { readonly ok: true; readonly config: FlowingRecallPortConfig }
  | { readonly ok: false; readonly lanes: FlowingLaneMap } {
  if (input.flowingConfig) return { ok: true, config: input.flowingConfig };
  const resolved = resolveFlowingRecallPortConfig({
    settings: input.flowingSettings,
    ...(input.trustedReleaseRoot ? { trustedReleaseRoot: input.trustedReleaseRoot } : {}),
    ...(input.expectedMemoryCommit ? { expectedMemoryCommit: input.expectedMemoryCommit } : {}),
    ...(input.expectedArtifactSha256
      ? { expectedArtifactSha256: input.expectedArtifactSha256 }
      : {}),
  });
  if (resolved.ok) return { ok: true, config: resolved.config };
  return {
    ok: false,
    lanes: Object.fromEntries(
      FLOWING_LANES.map((lane) => [
        lane,
        unavailableLane(lane, FLOWING_RECALL_SOURCE, resolved.code, resolved.message),
      ]),
    ) as FlowingLaneMap,
  };
}

export async function composeRecall(input: ComposeRecallInput): Promise<ComposeRecallOutcome> {
  const startedAt = Date.now();
  const config = flowingConfigFor(input);

  const flowingPromise = config.ok
    ? readFlowingRecall({
        request: input.request,
        config: config.config,
        ...(input.runProcess ? { runProcess: input.runProcess } : {}),
        ...(input.leaseCredential ? { leaseCredential: input.leaseCredential } : {}),
        ...(input.parentEnv ? { parentEnv: input.parentEnv } : {}),
      })
    : Promise.resolve({
        lanes: config.lanes,
        durationMs: 0,
        invokedCommand: [] as readonly string[],
      });

  const curatedPromise = readCuratedRecall({
    request: input.request,
    ...(input.curatedSearch ? { search: input.curatedSearch } : {}),
  });

  // Both lanes run independently. One lane failing never cancels or answers for the other.
  const [flowing, curated] = await Promise.all([flowingPromise, curatedPromise]);

  const lanes = {
    curatedPages: curated.lane,
    flowingObservations: flowing.lanes["flowing-observations"],
    flowingReflections: flowing.lanes["flowing-reflections"],
  };

  const candidate = {
    _tag: "ComposedRecallResultV1" as const,
    lanes,
    request: input.request,
    resolvedAccess: input.request.access,
    resolvedScope: input.request.scope,
    schemaVersion: COMPOSED_RECALL_SCHEMA_VERSION,
    unavailable: collectUnavailable(lanes as ComposedRecallResultV1["lanes"]),
  };

  const validated = validateResult(candidate);
  if (validated._tag === "Left") {
    throw new Error("composed recall produced a result that violates the composed recall contract");
  }

  return {
    result: validated.right,
    timings: {
      flowingMs: flowing.durationMs,
      curatedMs: curated.durationMs,
      totalMs: Date.now() - startedAt,
    },
    curatedBackend: curated.backend,
    flowingCommand: flowing.invokedCommand,
  };
}
