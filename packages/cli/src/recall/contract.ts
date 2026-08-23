/**
 * Composed recall contract v1 — provider neutral.
 *
 * The canonical composed surface is exactly three lanes: flowing reflections,
 * flowing observations, and curated pages. That is the accepted cutover shape.
 * Migration-only legacy hits are not a lane here and never become public API;
 * the flowing port asks the semantic source for them only because the source
 * contract demands a positive legacy limit, then discards them.
 *
 * Each lane carries its own rank sequence, its own score scale, and its own
 * health. Nothing in this contract lets a caller merge two lanes into one
 * ordered list, because two lanes never share a score scale.
 *
 * Provider vocabulary from the old adapter (`budget`, `category`, `includeHold`,
 * `includeDiscard`, raw transcript text) does not exist here.
 */

import { Schema } from "effect";

export const COMPOSED_RECALL_SCHEMA_VERSION = 1 as const;

export const RECALL_LANES = [
  "flowing-reflections",
  "flowing-observations",
  "curated-pages",
] as const;

export type RecallLaneName = (typeof RECALL_LANES)[number];

/** Score scales are lane-local. Two lanes with different scales are never comparable. */
export const RECALL_SCORE_SCALES = ["unit-interval", "bm25-negated"] as const;

export const PRIVACY_TIERS = ["public", "private", "sensitive"] as const;

export type PrivacyTier = (typeof PRIVACY_TIERS)[number];

/** Mirrors the semantic source `CanonicalScopeKey`. */
const SCOPE_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._/-]{0,238}[a-z0-9])?$/u;

/** Mirrors the semantic source `MAX_SEARCH_QUERY_LENGTH`. */
export const MAX_RECALL_QUERY_LENGTH = 1_000;

/** Mirrors the semantic source `MAX_SEARCH_HITS_PER_KIND`. */
export const MAX_RECALL_HITS_PER_LANE = 50;

const ScopeKeySchema = Schema.String.pipe(
  Schema.filter((value) => SCOPE_KEY_PATTERN.test(value), {
    message: () => "expected a canonical lowercase scope key",
  }),
);

const NonEmptyTextSchema = Schema.String.pipe(
  Schema.filter((value) => value.trim().length > 0 && value.length <= 16_000, {
    message: () => "expected bounded non-empty text",
  }),
);

const IsoInstantSchema = Schema.String.pipe(
  Schema.filter((value) => Number.isFinite(Date.parse(value)) && value.trim().length > 0, {
    message: () => "expected an ISO-8601 instant",
  }),
);

export const RecallScopeV1Schema = Schema.Struct({
  _tag: Schema.Literal("ProjectWorkstream"),
  project: ScopeKeySchema,
  workstream: ScopeKeySchema,
});
export type RecallScopeV1 = Schema.Schema.Type<typeof RecallScopeV1Schema>;

export const RecallAccessV1Schema = Schema.Struct({
  _tag: Schema.Literal("RecallAccessV1"),
  allowedPrivacy: Schema.Array(Schema.Literal(...PRIVACY_TIERS)).pipe(
    Schema.filter((tiers) => tiers.length > 0 && new Set(tiers).size === tiers.length, {
      message: () => "expected a non-empty set of unique privacy tiers",
    }),
  ),
  decidedAt: IsoInstantSchema,
  principalRef: NonEmptyTextSchema,
  purpose: NonEmptyTextSchema,
});
export type RecallAccessV1 = Schema.Schema.Type<typeof RecallAccessV1Schema>;

const LimitSchema = Schema.Number.pipe(
  Schema.filter(
    (value) => Number.isInteger(value) && value >= 1 && value <= MAX_RECALL_HITS_PER_LANE,
    { message: () => "expected an integer limit between 1 and 50" },
  ),
);

/** Exactly the canonical lanes. There is no public legacy limit. */
export const RecallLimitsV1Schema = Schema.Struct({
  curated: LimitSchema,
  observations: LimitSchema,
  reflections: LimitSchema,
});
export type RecallLimitsV1 = Schema.Schema.Type<typeof RecallLimitsV1Schema>;

/**
 * Every composed request names one exact scope and one explicit access decision.
 * There is no implicit fleet-default scope and no principal inferred from process
 * identity.
 */
export const ComposedRecallRequestV1Schema = Schema.Struct({
  _tag: Schema.Literal("ComposedRecallRequestV1"),
  access: RecallAccessV1Schema,
  includeSuperseded: Schema.Boolean,
  limits: RecallLimitsV1Schema,
  schemaVersion: Schema.Literal(COMPOSED_RECALL_SCHEMA_VERSION),
  scope: RecallScopeV1Schema,
  text: NonEmptyTextSchema.pipe(
    Schema.filter((value) => value.length <= MAX_RECALL_QUERY_LENGTH, {
      message: () => "expected query text of at most 1000 characters",
    }),
  ),
}).pipe(
  Schema.filter(
    (request) =>
      request.access.decidedAt.length > 0 &&
      request.scope.project.length > 0 &&
      request.scope.workstream.length > 0,
    { message: () => "expected an exact scope and an explicit access decision" },
  ),
);
export type ComposedRecallRequestV1 = Schema.Schema.Type<typeof ComposedRecallRequestV1Schema>;

export const RecallLaneHealthV1Schema = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("Healthy"),
    builtAt: Schema.optional(IsoInstantSchema),
    freshAt: Schema.optional(IsoInstantSchema),
    sourceSnapshotHash: Schema.optional(NonEmptyTextSchema),
  }),
  Schema.Struct({
    _tag: Schema.Literal("Stale"),
    builtAt: Schema.optional(IsoInstantSchema),
    detail: NonEmptyTextSchema,
    freshAt: Schema.optional(IsoInstantSchema),
    staleSince: Schema.optional(IsoInstantSchema),
    sourceSnapshotHash: Schema.optional(NonEmptyTextSchema),
  }),
  Schema.Struct({
    _tag: Schema.Literal("Failed"),
    detail: NonEmptyTextSchema,
    /**
     * The producer's own receipt for the failure. Opaque and content-free, so
     * it survives into the comparison receipt and gives an operator something
     * to look the failure up by.
     */
    failureReceiptId: Schema.optional(
      Schema.String.pipe(
        Schema.filter((value) => /^failure:[a-f0-9]{64}$/u.test(value), {
          message: () => "expected a canonical failure receipt ID",
        }),
      ),
    ),
    lastValidSnapshotHash: Schema.optional(
      Schema.String.pipe(
        Schema.filter((value) => /^[a-f0-9]{64}$/u.test(value), {
          message: () => "expected a lowercase sha-256 hex digest",
        }),
      ),
    ),
  }),
  Schema.Struct({
    _tag: Schema.Literal("Unknown"),
    reason: NonEmptyTextSchema,
  }),
);
export type RecallLaneHealthV1 = Schema.Schema.Type<typeof RecallLaneHealthV1Schema>;

/**
 * A lane item carries identity, ordering, provenance, and access facts. It never
 * carries transcript bodies, credentials, or machine topology. `summary` is a
 * bounded human-readable label the receipt writer always drops.
 */
export const RecallLaneItemV1Schema = Schema.Struct({
  evidenceIds: Schema.Array(NonEmptyTextSchema).pipe(
    Schema.filter((ids) => ids.length <= 256 && new Set(ids).size === ids.length, {
      message: () => "expected unique bounded evidence IDs",
    }),
  ),
  id: NonEmptyTextSchema,
  kind: NonEmptyTextSchema,
  lane: Schema.Literal(...RECALL_LANES),
  privacy: Schema.Literal(...PRIVACY_TIERS),
  rank: Schema.Number.pipe(
    Schema.filter((value) => Number.isInteger(value) && value >= 1, {
      message: () => "expected a 1-based integer rank",
    }),
  ),
  scope: RecallScopeV1Schema,
  /**
   * `record-scope` means the record itself declares this exact scope.
   * `retrieval-scope` means the record has no project/workstream of its own and
   * carries the scope the caller asked under. Curated Brain pages are the second
   * kind, and the contract refuses to blur the difference.
   */
  scopeBinding: Schema.Literal("record-scope", "retrieval-scope"),
  score: Schema.Number.pipe(
    Schema.filter((value) => Number.isFinite(value) && value >= 0, {
      message: () => "expected a finite non-negative lane-local score",
    }),
  ),
  summary: Schema.optional(
    Schema.String.pipe(
      Schema.filter((value) => value.length <= 1_000, {
        message: () => "expected a summary of at most 1000 characters",
      }),
    ),
  ),
  supersededClaimIds: Schema.optional(Schema.Array(NonEmptyTextSchema)),
  title: NonEmptyTextSchema,
});
export type RecallLaneItemV1 = Schema.Schema.Type<typeof RecallLaneItemV1Schema>;

export const RECALL_LANE_UNAVAILABLE_CODES = [
  "not-configured",
  "untrusted-executable",
  "credential-unavailable",
  "invalid-input",
  "store-unavailable",
  "contract-violation",
  "contract-mismatch",
  "malformed-response",
  "timeout",
  "process-failed",
  "not-requested",
] as const;

export type RecallLaneUnavailableCode = (typeof RECALL_LANE_UNAVAILABLE_CODES)[number];

const RecallLaneAvailableV1Schema = Schema.Struct({
  _tag: Schema.Literal("RecallLaneAvailableV1"),
  health: RecallLaneHealthV1Schema,
  items: Schema.Array(RecallLaneItemV1Schema).pipe(
    Schema.filter((items) => items.length <= MAX_RECALL_HITS_PER_LANE, {
      message: () => "expected at most 50 items in one lane",
    }),
  ),
  lane: Schema.Literal(...RECALL_LANES),
  scoreScale: Schema.Literal(...RECALL_SCORE_SCALES),
  source: NonEmptyTextSchema,
}).pipe(
  Schema.filter(
    (lane) =>
      lane.items.every((item, index) => item.rank === index + 1 && item.lane === lane.lane) &&
      new Set(lane.items.map((item) => item.id)).size === lane.items.length,
    {
      message: () =>
        "expected sequentially ranked, uniquely identified items that all belong to this lane",
    },
  ),
);

const RecallLaneUnavailableV1Schema = Schema.Struct({
  _tag: Schema.Literal("RecallLaneUnavailableV1"),
  code: Schema.Literal(...RECALL_LANE_UNAVAILABLE_CODES),
  lane: Schema.Literal(...RECALL_LANES),
  message: NonEmptyTextSchema.pipe(
    Schema.filter((value) => value.length <= 500, {
      message: () => "expected an unavailable message of at most 500 characters",
    }),
  ),
  source: NonEmptyTextSchema,
});

export const RecallLaneV1Schema = Schema.Union(
  RecallLaneAvailableV1Schema,
  RecallLaneUnavailableV1Schema,
);
export type RecallLaneV1 = Schema.Schema.Type<typeof RecallLaneV1Schema>;
export type RecallLaneAvailableV1 = Schema.Schema.Type<typeof RecallLaneAvailableV1Schema>;
export type RecallLaneUnavailableV1 = Schema.Schema.Type<typeof RecallLaneUnavailableV1Schema>;

/**
 * Each lane's score scale is fixed by which store answers it. Flowing memory
 * returns unit-interval relevance; curated SQLite returns negated BM25. A lane
 * carrying the other lane's scale is a mislabelled result, not a preference.
 */
export const LANE_SCORE_SCALE: Record<
  RecallLaneName,
  (typeof RECALL_SCORE_SCALES)[number]
> = {
  "curated-pages": "bm25-negated",
  "flowing-observations": "unit-interval",
  "flowing-reflections": "unit-interval",
};

/** Which requested limit bounds each lane. */
export const LANE_LIMIT_KEY: Record<RecallLaneName, keyof RecallLimitsV1> = {
  "curated-pages": "curated",
  "flowing-observations": "observations",
  "flowing-reflections": "reflections",
};

export type ComposedRecallLaneField =
  | "curatedPages"
  | "flowingObservations"
  | "flowingReflections";

export const LANE_FIELDS: ReadonlyArray<readonly [ComposedRecallLaneField, RecallLaneName]> = [
  ["flowingReflections", "flowing-reflections"],
  ["flowingObservations", "flowing-observations"],
  ["curatedPages", "curated-pages"],
];

/**
 * The canonical composed result. Lanes are named fields, never one merged array,
 * so no caller can accidentally cross-rank flowing memory against Brain pages.
 */
export const ComposedRecallResultV1Schema = Schema.Struct({
  _tag: Schema.Literal("ComposedRecallResultV1"),
  lanes: Schema.Struct({
    curatedPages: RecallLaneV1Schema,
    flowingObservations: RecallLaneV1Schema,
    flowingReflections: RecallLaneV1Schema,
  }),
  request: ComposedRecallRequestV1Schema,
  resolvedAccess: RecallAccessV1Schema,
  resolvedScope: RecallScopeV1Schema,
  schemaVersion: Schema.Literal(COMPOSED_RECALL_SCHEMA_VERSION),
  unavailable: Schema.Array(RecallLaneUnavailableV1Schema),
}).pipe(
  Schema.filter(
    (result) => {
      // The resolved scope and access are what the lanes were actually read
      // under. If they differ from the request in any way, the caller was
      // answered for a question it did not ask.
      if (
        result.resolvedScope.project !== result.request.scope.project ||
        result.resolvedScope.workstream !== result.request.scope.workstream
      ) {
        return false;
      }
      if (
        result.resolvedAccess.principalRef !== result.request.access.principalRef ||
        result.resolvedAccess.purpose !== result.request.access.purpose ||
        result.resolvedAccess.decidedAt !== result.request.access.decidedAt ||
        result.resolvedAccess.allowedPrivacy.length !==
          result.request.access.allowedPrivacy.length ||
        !result.resolvedAccess.allowedPrivacy.every((tier) =>
          result.request.access.allowedPrivacy.includes(tier),
        )
      ) {
        return false;
      }

      for (const [field, lane] of LANE_FIELDS) {
        const value = result.lanes[field];
        if (value.lane !== lane) return false;
        if (value._tag !== "RecallLaneAvailableV1") continue;

        if (value.scoreScale !== LANE_SCORE_SCALE[lane]) return false;
        if (value.items.length > result.request.limits[LANE_LIMIT_KEY[lane]]) return false;

        for (const item of value.items) {
          // Retrieval-scope items are records with no scope of their own, so
          // the scope they carry must be exactly the one they were retrieved
          // under. Record-scope items declare it themselves. Either way the
          // scope on the item equals the resolved scope; the binding says why.
          if (
            item.scope.project !== result.resolvedScope.project ||
            item.scope.workstream !== result.resolvedScope.workstream
          ) {
            return false;
          }
          if (!result.resolvedAccess.allowedPrivacy.includes(item.privacy)) return false;
          // A flowing claim with no evidence is an assertion, not a record.
          if (lane !== "curated-pages" && item.evidenceIds.length === 0) return false;
        }
      }

      // The summary is a bijection with the unavailable lanes, not a matching
      // count of plausible entries. Duplicating one lane while omitting another
      // keeps the totals equal and still hides a lane that could not answer, so
      // the mapping is checked one-to-one in both directions.
      const summarised = new Map<string, string>();
      for (const entry of result.unavailable) {
        if (summarised.has(entry.lane)) return false;
        summarised.set(entry.lane, entry.code);
      }

      let unavailableLanes = 0;
      for (const [field, lane] of LANE_FIELDS) {
        const value = result.lanes[field];
        if (value._tag !== "RecallLaneUnavailableV1") {
          if (summarised.has(lane)) return false;
          continue;
        }
        unavailableLanes += 1;
        if (summarised.get(lane) !== value.code) return false;
      }

      return summarised.size === unavailableLanes;
    },
    {
      message: () =>
        "expected lanes bound to the resolved scope and access, each with its own score scale, inside its requested limit, with evidence on every flowing item and unavailability mirrored exactly once per lane",
    },
  ),
);
export type ComposedRecallResultV1 = Schema.Schema.Type<typeof ComposedRecallResultV1Schema>;

export const decodeComposedRecallRequest = Schema.decodeUnknownSync(ComposedRecallRequestV1Schema);
export const decodeComposedRecallResult = Schema.decodeUnknownSync(ComposedRecallResultV1Schema);
export const encodeComposedRecallResult = Schema.encodeSync(ComposedRecallResultV1Schema);

export function unavailableLane(
  lane: RecallLaneName,
  source: string,
  code: RecallLaneUnavailableCode,
  message: string,
): RecallLaneUnavailableV1 {
  const trimmed = message.trim() || code;
  return {
    _tag: "RecallLaneUnavailableV1",
    code,
    lane,
    message: trimmed.slice(0, 500),
    source,
  };
}

/** Collects unavailable lanes without merging any available lane into another. */
export function collectUnavailable(
  lanes: ComposedRecallResultV1["lanes"],
): RecallLaneUnavailableV1[] {
  return LANE_FIELDS.flatMap(([field]) => {
    const value = lanes[field];
    return value._tag === "RecallLaneUnavailableV1" ? [value] : [];
  });
}
