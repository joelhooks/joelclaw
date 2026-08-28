/**
 * Structural mirror of the flowing-memory read boundary.
 *
 * The semantic source of truth is `joelclaw-memory` at commit
 * `601d8c518d3078859b7cdf287a6db52fa8ee9082` — `packages/domain/src/search.ts`,
 * `packages/domain/src/flowing-memory-read.ts`, and `apps/cli/src/read-command.ts`.
 * That source runs Effect v4; this CLI runs Effect v3, so the boundary is a
 * process, not an import. This module mirrors the wire contract field for field.
 *
 * What this mirror enforces, matching the source:
 *
 * - canonical ID, hash, and scope-key patterns;
 * - the echoed `MemorySearchQueryV1` including all three limits and the
 *   access/query scope agreement filter;
 * - ordered ISO health times and the snapshot hash carried by `Healthy`/`Stale`;
 * - the source's bare sha-256 producer receipt or canonical `failure:<sha256>` ID on `Failed` health;
 * - the source's path and credential exclusions on every runtime capture
 *   identifier, which are cheap to mirror because they are pure predicates;
 * - non-empty, unique, bounded search-hit evidence;
 * - `Superseded` matched claims carrying `relationId`, `supersedingClaimId`,
 *   and `supersedingReflectionId`;
 * - non-empty `supportingObservations` on every reflection hit, with the
 *   set-equality against `reflection.sourceObservationIds` the source requires;
 * - producer ranks that are sequential 1..n per hit kind, never re-derived here;
 * - per-kind hit counts inside the echoed limits;
 * - legacy hits decoded in full, including `payloadHash` and the redaction
 *   attestation, purely so a malformed one is a contract violation rather than
 *   a silently dropped field.
 *
 * What this mirror deliberately does not re-derive: `canonicalEvidenceId`,
 * `legacySearchPayloadHash`, `supersessionIndexHash`, and the observation and
 * reflection record-identity invariants. Those are content-addressed proofs the
 * producer computes over its own canonical encoding; recomputing them here would
 * mean vendoring the identity module and its hash canonicalisation, which is the
 * Effect-major coupling this boundary exists to avoid. They are named here so
 * the gap is explicit rather than implied.
 *
 * A different `schemaVersion` is a hard contract mismatch, never coerced.
 */

import { Schema } from "effect";

export const FLOWING_MEMORY_READ_SCHEMA_VERSION = 1 as const;
export const FLOWING_MEMORY_READ_V2_SCHEMA_VERSION = 2 as const;
export const MEMORY_SEARCH_SCHEMA_VERSION = 1 as const;
export const MEMORY_SEARCH_V2_SCHEMA_VERSION = 2 as const;
export const OBSERVATION_SCHEMA_VERSION = 2 as const;
export const REFLECTION_SCHEMA_VERSION = 1 as const;
export const REFLECTION_V2_SCHEMA_VERSION = 2 as const;

/** Mirrors `limits.ts` at the pinned source revision. */
export const MAX_SEARCH_HITS_PER_KIND = 50;
export const MAX_SEARCH_QUERY_LENGTH = 1_000;
export const MAX_EVIDENCE_REFERENCES_PER_RECORD = 256;
export const MAX_CLAIMS_PER_REFLECTION = 128;
export const MAX_SUPPORTING_OBSERVATIONS_PER_HIT = 256;
export const MAX_SOURCE_OBSERVATIONS_PER_REFLECTION = 256;
export const MAX_CLAIMS_PER_OBSERVATION_SECTION = 64;
export const MAX_RELATIONS_PER_REFLECTION = 128;
export const MAX_CLAIM_TEXT_LENGTH = 4_000;

const pattern = (regex: RegExp, expected: string) =>
  Schema.String.pipe(Schema.filter((value) => regex.test(value), { message: () => expected }));

const NonEmptySchema = Schema.String.pipe(
  Schema.filter((value) => value.length > 0 && value.length <= 16_000, {
    message: () => "expected bounded non-empty text",
  }),
);

const bounded = (max: number) =>
  Schema.String.pipe(
    Schema.filter((value) => value.length > 0 && value.length <= max, {
      message: () => `expected non-empty text of at most ${max} characters`,
    }),
  );

const HashSchema = pattern(/^[a-f0-9]{64}$/u, "expected a lowercase sha-256 hex digest");
const ScopeKeySchema = pattern(
  /^[a-z0-9](?:[a-z0-9._/-]{0,238}[a-z0-9])?$/u,
  "expected a canonical scope key",
);
const ObservationIdSchema = pattern(
  /^observation:v2:[a-f0-9]{64}$/u,
  "expected a canonical observation ID",
);
const ReflectionIdSchema = pattern(
  /^reflection:v(?:1|2):[a-f0-9]{64}$/u,
  "expected a canonical reflection ID",
);
const EvidenceIdSchema = pattern(/^evidence:[a-f0-9]{64}$/u, "expected a canonical evidence ID");
const ClaimIdSchema = pattern(/^claim:[a-f0-9]{64}$/u, "expected a canonical claim ID");
const ClaimRelationIdSchema = pattern(
  /^relation:v1:[a-f0-9]{64}$/u,
  "expected a canonical claim-relation ID",
);
const FailureReceiptIdSchema = pattern(
  /^(?:failure:)?[a-f0-9]{64}$/u,
  "expected a sha-256 failure receipt ID with an optional canonical failure prefix",
);

/**
 * Mirrors the source `SENSITIVE_IDENTIFIER_PATTERN`. A capture identifier that
 * looks like a credential is refused at the source, so accepting one here would
 * mean accepting an envelope the pinned contract rejects.
 */
const SENSITIVE_IDENTIFIER_PATTERN =
  /(?:^|[._:@-])(?:api[_-]?key|bearer|credential|password|secret|token)(?:$|[._:@-])/iu;

const RuntimeCaptureIdentifierSchema = pattern(
  /^[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,238}[A-Za-z0-9])?$/u,
  "expected a bounded runtime capture identifier",
).pipe(
  Schema.filter(
    (value) =>
      !value.includes("..") &&
      !value.startsWith("ghp_") &&
      !value.startsWith("gho_") &&
      !value.startsWith("ghs_") &&
      !value.startsWith("github_pat_") &&
      !SENSITIVE_IDENTIFIER_PATTERN.test(value),
    { message: () => "expected a non-path, non-credential runtime capture identifier" },
  ),
);

/** The source encodes every instant as canonical UTC text. */
const IsoInstantSchema = Schema.String.pipe(
  Schema.filter((value) => value.length > 0 && Number.isFinite(Date.parse(value)), {
    message: () => "expected an ISO-8601 instant",
  }),
);

const NaturalSchema = Schema.Number.pipe(
  Schema.filter((value) => Number.isInteger(value) && value >= 0, {
    message: () => "expected a non-negative integer",
  }),
);

const PositiveIntSchema = Schema.Number.pipe(
  Schema.filter((value) => Number.isInteger(value) && value >= 1, {
    message: () => "expected a positive integer",
  }),
);

const SearchLimitSchema = Schema.Number.pipe(
  Schema.filter(
    (value) => Number.isInteger(value) && value >= 1 && value <= MAX_SEARCH_HITS_PER_KIND,
    { message: () => "expected a search limit between 1 and 50" },
  ),
);

const UnitIntervalSchema = Schema.Number.pipe(
  Schema.filter((value) => Number.isFinite(value) && value >= 0 && value <= 1, {
    message: () => "expected a score in the unit interval",
  }),
);

const PrivacySchema = Schema.Literal("public", "private", "sensitive");

const PrivacyTierSetSchema = Schema.Array(PrivacySchema).pipe(
  Schema.filter(
    (tiers) => tiers.length > 0 && tiers.length <= 3 && new Set(tiers).size === tiers.length,
    { message: () => "expected a non-empty set of unique privacy tiers" },
  ),
);

const ScopeSchema = Schema.Struct({
  _tag: Schema.Literal("ProjectWorkstream"),
  project: ScopeKeySchema,
  workstream: ScopeKeySchema,
});

const at = (value: string) => Date.parse(value);

// ── access and query ───────────────────────────────────────────────────────

const AccessSchema = Schema.Struct({
  _tag: Schema.Literal("MemorySearchAccessV1"),
  allowedPrivacy: PrivacyTierSetSchema,
  decidedAt: IsoInstantSchema,
  principalRef: NonEmptySchema,
  purpose: NonEmptySchema,
  schemaVersion: Schema.Literal(MEMORY_SEARCH_SCHEMA_VERSION),
  scope: ScopeSchema,
});

const QuerySchema = Schema.Struct({
  _tag: Schema.Literal("MemorySearchQueryV1"),
  access: AccessSchema,
  includeSuperseded: Schema.Boolean,
  legacyLimit: SearchLimitSchema,
  observationLimit: SearchLimitSchema,
  reflectionLimit: SearchLimitSchema,
  schemaVersion: Schema.Literal(MEMORY_SEARCH_SCHEMA_VERSION),
  scope: ScopeSchema,
  text: bounded(MAX_SEARCH_QUERY_LENGTH),
}).pipe(
  Schema.filter(
    (query) =>
      query.access.scope.project === query.scope.project &&
      query.access.scope.workstream === query.scope.workstream,
    { message: () => "expected search access covering the requested project and workstream" },
  ),
);
export type FlowingMemorySearchQueryV1 = Schema.Schema.Type<typeof QuerySchema>;

// ── health ─────────────────────────────────────────────────────────────────

const HealthSchema = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("Healthy"),
    builtAt: IsoInstantSchema,
    freshAt: IsoInstantSchema,
    sourceSnapshotHash: HashSchema,
  }).pipe(
    Schema.filter((health) => at(health.builtAt) <= at(health.freshAt), {
      message: () => "expected healthy freshness at or after build time",
    }),
  ),
  Schema.Struct({
    _tag: Schema.Literal("Stale"),
    builtAt: IsoInstantSchema,
    freshAt: IsoInstantSchema,
    sourceSnapshotHash: HashSchema,
    staleSince: IsoInstantSchema,
  }).pipe(
    Schema.filter(
      (health) =>
        at(health.builtAt) <= at(health.freshAt) && at(health.freshAt) <= at(health.staleSince),
      { message: () => "expected ordered build, freshness, and stale times" },
    ),
  ),
  Schema.Struct({
    _tag: Schema.Literal("Failed"),
    failureReceiptId: FailureReceiptIdSchema,
    lastValidSnapshotHash: Schema.optional(HashSchema),
  }),
  Schema.Struct({
    _tag: Schema.Literal("Unknown"),
    reason: NonEmptySchema,
  }),
);
export type FlowingProjectionHealthV1 = Schema.Schema.Type<typeof HealthSchema>;

// ── evidence ───────────────────────────────────────────────────────────────

const RedactionSchema = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("clean"),
    policyHash: HashSchema,
    scannedAt: IsoInstantSchema,
    schemaVersion: Schema.Literal(1),
  }),
  Schema.Struct({
    _tag: Schema.Literal("redacted"),
    policyHash: HashSchema,
    redactionCount: PositiveIntSchema,
    scannedAt: IsoInstantSchema,
    schemaVersion: Schema.Literal(1),
  }),
);

const ParentEvidenceIdsSchema = Schema.Array(EvidenceIdSchema).pipe(
  Schema.filter((ids) => ids.length > 0 && ids.length <= 64 && new Set(ids).size === ids.length, {
    message: () => "expected unique non-empty parent evidence IDs",
  }),
);

const evidenceCommon = {
  evidenceId: EvidenceIdSchema,
  href: Schema.optional(NonEmptySchema),
  privacy: PrivacySchema,
  scope: ScopeSchema,
} as const;

const EvidenceReferenceSchema = Schema.Union(
  Schema.Struct({
    ...evidenceCommon,
    _tag: Schema.Literal("AcceptedRun"),
    acceptedAt: IsoInstantSchema,
    redactionPolicyHash: HashSchema,
    runId: RuntimeCaptureIdentifierSchema,
  }),
  Schema.Struct({
    ...evidenceCommon,
    _tag: Schema.Literal("TranscriptWindow"),
    conversationId: RuntimeCaptureIdentifierSchema,
    fromTurn: NaturalSchema,
    redaction: RedactionSchema,
    runId: RuntimeCaptureIdentifierSchema,
    toTurn: NaturalSchema,
    transcriptHash: HashSchema,
  }).pipe(
    Schema.filter((reference) => reference.fromTurn <= reference.toTurn, {
      message: () => "expected an ordered transcript evidence window",
    }),
  ),
  Schema.Struct({
    ...evidenceCommon,
    _tag: Schema.Literal("Observation"),
    observationId: ObservationIdSchema,
    parentEvidenceIds: ParentEvidenceIdsSchema,
    sourceSchemaVersion: Schema.Literal(OBSERVATION_SCHEMA_VERSION),
  }),
  Schema.Struct({
    ...evidenceCommon,
    _tag: Schema.Literal("Reflection"),
    parentEvidenceIds: ParentEvidenceIdsSchema,
    reflectionId: ReflectionIdSchema,
    sourceSchemaVersion: Schema.Literal(REFLECTION_SCHEMA_VERSION),
  }),
);
export type FlowingEvidenceReferenceV1 = Schema.Schema.Type<typeof EvidenceReferenceSchema>;

const RecordEvidenceSchema = Schema.Array(EvidenceReferenceSchema).pipe(
  Schema.filter(
    (evidence) => evidence.length > 0 && evidence.length <= MAX_EVIDENCE_REFERENCES_PER_RECORD,
    {
      message: () => "expected non-empty bounded record evidence",
    },
  ),
);

/** The source requires non-empty, bounded, uniquely identified search-hit evidence. */
const SearchHitEvidenceSchema = Schema.Array(EvidenceReferenceSchema).pipe(
  Schema.filter(
    (evidence) =>
      evidence.length > 0 &&
      evidence.length <= MAX_EVIDENCE_REFERENCES_PER_RECORD &&
      new Set(evidence.map((reference) => reference.evidenceId)).size === evidence.length,
    { message: () => "expected non-empty unique search-hit evidence IDs" },
  ),
);

// ── records ────────────────────────────────────────────────────────────────

const ClaimEvidenceIdsSchema = Schema.Array(EvidenceIdSchema).pipe(
  Schema.filter((ids) => ids.length > 0 && ids.length <= 64 && new Set(ids).size === ids.length, {
    message: () => "expected unique non-empty claim evidence IDs",
  }),
);

const ClaimSchema = Schema.Struct({
  claimId: ClaimIdSchema,
  evidenceIds: ClaimEvidenceIdsSchema,
  text: bounded(MAX_CLAIM_TEXT_LENGTH),
});

const DerivationSchema = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("Deterministic"),
    contractHash: HashSchema,
    producer: NonEmptySchema,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Model"),
    contractHash: HashSchema,
    modelId: NonEmptySchema,
    promptHash: HashSchema,
    producer: NonEmptySchema,
  }),
);

const relationFields = {
  evidenceIds: ClaimEvidenceIdsSchema,
  reason: bounded(MAX_CLAIM_TEXT_LENGTH),
  relationId: ClaimRelationIdSchema,
  sourceClaimId: ClaimIdSchema,
  targetClaimId: ClaimIdSchema,
  targetReflectionId: ReflectionIdSchema,
} as const;

const ClaimRelationSchema = Schema.Union(
  Schema.Struct({ ...relationFields, _tag: Schema.Literal("Contradicts") }),
  Schema.Struct({ ...relationFields, _tag: Schema.Literal("Supersedes") }),
);

const BoundedClaimsSchema = Schema.Array(ClaimSchema).pipe(
  Schema.filter((claims) => claims.length <= MAX_CLAIMS_PER_OBSERVATION_SECTION, {
    message: () => "expected a bounded claim section",
  }),
);

const ObservationSourceSchema = Schema.Struct({
  acceptedAt: IsoInstantSchema,
  conversationId: RuntimeCaptureIdentifierSchema,
  fromTurn: NaturalSchema,
  isFinal: Schema.Boolean,
  observedFrom: IsoInstantSchema,
  observedThrough: IsoInstantSchema,
  redaction: RedactionSchema,
  runId: RuntimeCaptureIdentifierSchema,
  toTurn: NaturalSchema,
  transcriptHash: HashSchema,
}).pipe(
  Schema.filter(
    (source) =>
      source.fromTurn <= source.toTurn &&
      at(source.observedFrom) <= at(source.observedThrough) &&
      at(source.observedThrough) <= at(source.acceptedAt),
    { message: () => "expected ordered turn and observation time ranges" },
  ),
);

const ObservationSchema = Schema.Struct({
  createdAt: IsoInstantSchema,
  decisions: BoundedClaimsSchema,
  derivation: DerivationSchema,
  evidence: RecordEvidenceSchema,
  gist: ClaimSchema,
  observationId: ObservationIdSchema,
  observations: BoundedClaimsSchema,
  openQuestions: BoundedClaimsSchema,
  privacy: PrivacySchema,
  schemaVersion: Schema.Literal(OBSERVATION_SCHEMA_VERSION),
  scope: ScopeSchema,
  source: ObservationSourceSchema,
  type: Schema.Literal("observation"),
}).pipe(
  Schema.filter((observation) => at(observation.source.acceptedAt) <= at(observation.createdAt), {
    message: () => "expected observation creation at or after Run acceptance",
  }),
);
export type FlowingObservationV2 = Schema.Schema.Type<typeof ObservationSchema>;

const ReflectionV1Schema = Schema.Struct({
  claims: Schema.Array(ClaimSchema).pipe(
    Schema.filter((claims) => claims.length > 0 && claims.length <= MAX_CLAIMS_PER_REFLECTION, {
      message: () => "expected non-empty bounded reflection claims",
    }),
  ),
  derivation: DerivationSchema,
  evidence: RecordEvidenceSchema,
  observedAt: IsoInstantSchema,
  privacy: PrivacySchema,
  reflectionId: ReflectionIdSchema,
  relations: Schema.Array(ClaimRelationSchema).pipe(
    Schema.filter((relations) => relations.length <= MAX_RELATIONS_PER_REFLECTION, {
      message: () => "expected bounded reflection relations",
    }),
  ),
  schemaVersion: Schema.Literal(REFLECTION_SCHEMA_VERSION),
  scope: ScopeSchema,
  sourceObservationIds: Schema.Array(ObservationIdSchema).pipe(
    Schema.filter((ids) => ids.length > 0 && ids.length <= MAX_SOURCE_OBSERVATIONS_PER_REFLECTION, {
      message: () => "expected non-empty bounded source observation IDs",
    }),
  ),
  type: Schema.Literal("reflection"),
  validFrom: IsoInstantSchema,
  validThrough: IsoInstantSchema,
}).pipe(
  Schema.filter(
    (reflection) =>
      at(reflection.validFrom) <= at(reflection.validThrough) &&
      at(reflection.validThrough) <= at(reflection.observedAt),
    { message: () => "expected an ordered validity range ending no later than observedAt" },
  ),
);
export type FlowingReflectionV1 = Schema.Schema.Type<typeof ReflectionV1Schema>;

const ReflectionV2Schema = Schema.Struct({
  cardId: HashSchema,
  cardSchemaVersion: Schema.Literal(1),
  claims: Schema.Array(ClaimSchema).pipe(
    Schema.filter((claims) => claims.length === 4, {
      message: () => "expected four canonical card claims",
    }),
  ),
  consequence: bounded(500),
  counterfactual: bounded(500),
  derivation: DerivationSchema,
  evidence: RecordEvidenceSchema,
  kind: Schema.Literal(
    "Decision",
    "Constraint",
    "FailurePattern",
    "OpenLoop",
    "Preference",
    "Capability",
  ),
  memory: bounded(700),
  observedAt: IsoInstantSchema,
  privacy: PrivacySchema,
  reflectionId: ReflectionIdSchema,
  relations: Schema.Array(ClaimRelationSchema).pipe(
    Schema.filter((relations) => relations.length <= MAX_RELATIONS_PER_REFLECTION, {
      message: () => "expected bounded reflection relations",
    }),
  ),
  reviewAttestationId: HashSchema,
  rubricDigest: HashSchema,
  schemaVersion: Schema.Literal(REFLECTION_V2_SCHEMA_VERSION),
  scope: ScopeSchema,
  sourceObservationIds: Schema.Array(ObservationIdSchema).pipe(
    Schema.filter((ids) => ids.length > 0 && ids.length <= MAX_SOURCE_OBSERVATIONS_PER_REFLECTION, {
      message: () => "expected non-empty bounded source observation IDs",
    }),
  ),
  status: Schema.Literal("active", "blocked"),
  trigger: bounded(280),
  type: Schema.Literal("reflection"),
  usefulUntil: Schema.optional(IsoInstantSchema),
  validFrom: IsoInstantSchema,
  validThrough: IsoInstantSchema,
}).pipe(
  Schema.filter(
    (reflection) =>
      at(reflection.validFrom) <= at(reflection.validThrough) &&
      at(reflection.validThrough) <= at(reflection.observedAt) &&
      (reflection.usefulUntil === undefined ||
        at(reflection.observedAt) < at(reflection.usefulUntil)),
    { message: () => "expected an ordered active ReflectionV2 validity range" },
  ),
  Schema.filter(
    (reflection) =>
      reflection.claims[0]?.text === reflection.trigger &&
      reflection.claims[1]?.text === reflection.memory &&
      reflection.claims[2]?.text === reflection.consequence &&
      reflection.claims[3]?.text === reflection.counterfactual,
    { message: () => "expected card fields to match their canonical claims" },
  ),
);
export type FlowingReflectionV2 = Schema.Schema.Type<typeof ReflectionV2Schema>;

const AnyReflectionSchema = Schema.Union(ReflectionV1Schema, ReflectionV2Schema);
export type FlowingReflection = Schema.Schema.Type<typeof AnyReflectionSchema>;

// ── hits ───────────────────────────────────────────────────────────────────

/** `Superseded` carries the full relation identity the source requires. */
const MatchedClaimSchema = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("Active"), claimId: ClaimIdSchema }),
  Schema.Struct({
    _tag: Schema.Literal("Superseded"),
    claimId: ClaimIdSchema,
    relationId: ClaimRelationIdSchema,
    supersedingClaimId: ClaimIdSchema,
    supersedingReflectionId: ReflectionIdSchema,
  }),
);

const ReflectionHitSchema = Schema.Struct({
  evidence: SearchHitEvidenceSchema,
  matchedClaims: Schema.Array(MatchedClaimSchema).pipe(
    Schema.filter((claims) => claims.length > 0 && claims.length <= MAX_CLAIMS_PER_REFLECTION, {
      message: () => "expected non-empty bounded matched claims",
    }),
  ),
  rank: PositiveIntSchema,
  reflection: ReflectionV1Schema,
  score: UnitIntervalSchema,
  supportingObservations: Schema.Array(ObservationSchema).pipe(
    Schema.filter(
      (observations) =>
        observations.length > 0 && observations.length <= MAX_SUPPORTING_OBSERVATIONS_PER_HIT,
      { message: () => "expected non-empty bounded supporting observations" },
    ),
  ),
});
export type FlowingReflectionSearchHitV1 = Schema.Schema.Type<typeof ReflectionHitSchema>;

const ReflectionHitV2Schema = Schema.Struct({
  evidence: SearchHitEvidenceSchema,
  matchedClaims: Schema.Array(MatchedClaimSchema).pipe(
    Schema.filter((claims) => claims.length > 0 && claims.length <= MAX_CLAIMS_PER_REFLECTION, {
      message: () => "expected non-empty bounded matched claims",
    }),
  ),
  rank: PositiveIntSchema,
  reflection: AnyReflectionSchema,
  score: UnitIntervalSchema,
  supportingObservations: Schema.Array(ObservationSchema).pipe(
    Schema.filter(
      (observations) =>
        observations.length > 0 && observations.length <= MAX_SUPPORTING_OBSERVATIONS_PER_HIT,
      { message: () => "expected non-empty bounded supporting observations" },
    ),
  ),
});
export type FlowingReflectionSearchHitV2 = Schema.Schema.Type<typeof ReflectionHitV2Schema>;

const ObservationHitSchema = Schema.Struct({
  evidence: SearchHitEvidenceSchema,
  observation: ObservationSchema,
  rank: PositiveIntSchema,
  score: UnitIntervalSchema,
});
export type FlowingObservationSearchHitV1 = Schema.Schema.Type<typeof ObservationHitSchema>;

const legacySourceFields = {
  bodyHash: HashSchema,
  privacy: PrivacySchema,
  schemaVersion: Schema.Literal(1),
  sourceHash: HashSchema,
  sourceRef: NonEmptySchema,
  type: Schema.Literal("observation"),
} as const;

const legacyScopeFields = {
  projectHints: Schema.Array(ScopeKeySchema),
  scopeHints: Schema.optional(Schema.Array(ScopeSchema)),
} as const;

const LegacyDescriptorSchema = Schema.Union(
  Schema.Struct({
    ...legacySourceFields,
    ...legacyScopeFields,
    _tag: Schema.Literal("ExternalContext"),
    endedAt: IsoInstantSchema,
    sourceKind: NonEmptySchema,
    startedAt: IsoInstantSchema,
  }),
  Schema.Struct({
    ...legacySourceFields,
    _tag: Schema.Literal("OperationalReceipt"),
    occurredAt: IsoInstantSchema,
    receiptKind: NonEmptySchema,
  }),
  Schema.Struct({
    ...legacySourceFields,
    ...legacyScopeFields,
    _tag: Schema.Literal("Rollup"),
    endedAt: IsoInstantSchema,
    sourceRefs: Schema.Array(NonEmptySchema).pipe(
      Schema.filter((refs) => refs.length > 0 && refs.length <= 256, {
        message: () => "expected non-empty bounded rollup source refs",
      }),
    ),
    startedAt: IsoInstantSchema,
  }),
  Schema.Struct({
    ...legacySourceFields,
    ...legacyScopeFields,
    _tag: Schema.Literal("SessionEpoch"),
    endedAt: IsoInstantSchema,
    sessionId: NonEmptySchema,
    startedAt: IsoInstantSchema,
  }),
);

/**
 * Legacy hits are decoded in full so a malformed one is a typed contract
 * violation. They are migration-only and never reach the composed result.
 */
const LegacyHitSchema = Schema.Struct({
  descriptor: LegacyDescriptorSchema,
  payloadHash: HashSchema,
  rank: PositiveIntSchema,
  redaction: RedactionSchema,
  resolvedScope: ScopeSchema,
  score: UnitIntervalSchema,
  snippet: bounded(1_000),
  title: bounded(500),
});
export type FlowingLegacySearchHitV1 = Schema.Schema.Type<typeof LegacyHitSchema>;

// ── result ─────────────────────────────────────────────────────────────────

const sequentialRanks = (hits: readonly { readonly rank: number }[]) =>
  hits.every((hit, index) => hit.rank === index + 1);

const sameIdSet = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  new Set(left).size === left.length &&
  new Set(right).size === right.length &&
  left.every((id) => right.includes(id));

const ResultSchema = Schema.Struct({
  _tag: Schema.Literal("MemorySearchResultV1"),
  explanation: Schema.optional(bounded(500)),
  health: HealthSchema,
  legacyHits: Schema.Array(LegacyHitSchema),
  observationHits: Schema.Array(ObservationHitSchema),
  query: QuerySchema,
  reflectionHits: Schema.Array(ReflectionHitSchema),
  schemaVersion: Schema.Literal(MEMORY_SEARCH_SCHEMA_VERSION),
}).pipe(
  Schema.filter(
    (result) =>
      result.reflectionHits.length <= result.query.reflectionLimit &&
      result.observationHits.length <= result.query.observationLimit &&
      result.legacyHits.length <= result.query.legacyLimit,
    { message: () => "expected per-kind hit counts inside the echoed query limits" },
  ),
  Schema.filter(
    (result) =>
      sequentialRanks(result.reflectionHits) &&
      sequentialRanks(result.observationHits) &&
      sequentialRanks(result.legacyHits),
    { message: () => "expected sequential 1-based producer ranks in every hit kind" },
  ),
  Schema.filter(
    (result) =>
      result.reflectionHits.every((hit) => {
        const matchedIds = hit.matchedClaims.map((matched) => matched.claimId);
        const supportIds = hit.supportingObservations.map(
          (observation) => observation.observationId,
        );
        return (
          new Set(matchedIds).size === matchedIds.length &&
          matchedIds.every((claimId) =>
            hit.reflection.claims.some((claim) => claim.claimId === claimId),
          ) &&
          sameIdSet(supportIds, hit.reflection.sourceObservationIds)
        );
      }),
    {
      message: () =>
        "expected unique matched claims present on the reflection, with supporting observations covering exactly its source observations",
    },
  ),
  Schema.filter(
    (result) =>
      result.query.includeSuperseded ||
      result.reflectionHits.every((hit) =>
        hit.matchedClaims.every((matched) => matched._tag === "Active"),
      ),
    { message: () => "expected only active matched claims when supersession was not requested" },
  ),
  Schema.filter(
    (result) => result.legacyHits.every((hit) => hit.descriptor._tag !== "OperationalReceipt"),
    { message: () => "expected no operational receipt in legacy search hits" },
  ),
);

const ResultV2Schema = Schema.Struct({
  _tag: Schema.Literal("MemorySearchResultV2"),
  explanation: Schema.optional(bounded(500)),
  health: HealthSchema,
  legacyHits: Schema.Array(LegacyHitSchema),
  observationHits: Schema.Array(ObservationHitSchema),
  query: QuerySchema,
  reflectionHits: Schema.Array(ReflectionHitV2Schema),
  schemaVersion: Schema.Literal(MEMORY_SEARCH_V2_SCHEMA_VERSION),
}).pipe(
  Schema.filter(
    (result) =>
      result.reflectionHits.length <= result.query.reflectionLimit &&
      result.observationHits.length <= result.query.observationLimit &&
      result.legacyHits.length <= result.query.legacyLimit,
    { message: () => "expected per-kind hit counts inside the echoed query limits" },
  ),
  Schema.filter(
    (result) =>
      sequentialRanks(result.reflectionHits) &&
      sequentialRanks(result.observationHits) &&
      sequentialRanks(result.legacyHits),
    { message: () => "expected sequential 1-based producer ranks in every hit kind" },
  ),
  Schema.filter(
    (result) =>
      result.reflectionHits.every((hit) => {
        const matchedIds = hit.matchedClaims.map((matched) => matched.claimId);
        const supportIds = hit.supportingObservations.map(
          (observation) => observation.observationId,
        );
        return (
          new Set(matchedIds).size === matchedIds.length &&
          matchedIds.every((claimId) =>
            hit.reflection.claims.some((claim) => claim.claimId === claimId),
          ) &&
          sameIdSet(supportIds, hit.reflection.sourceObservationIds)
        );
      }),
    {
      message: () =>
        "expected unique matched claims present on the reflection, with exact source observations",
    },
  ),
  Schema.filter(
    (result) =>
      result.query.includeSuperseded ||
      result.reflectionHits.every((hit) =>
        hit.matchedClaims.every((matched) => matched._tag === "Active"),
      ),
    { message: () => "expected only active matched claims by default" },
  ),
  Schema.filter(
    (result) => result.legacyHits.every((hit) => hit.descriptor._tag !== "OperationalReceipt"),
    { message: () => "expected no operational receipt in legacy search hits" },
  ),
);

export const FlowingMemoryReadEnvelopeV1Schema = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("FlowingMemoryReadSuccessV1"),
    result: ResultSchema,
    schemaVersion: Schema.Literal(FLOWING_MEMORY_READ_SCHEMA_VERSION),
  }),
  Schema.Struct({
    _tag: Schema.Literal("FlowingMemoryReadUnavailableV1"),
    code: Schema.Literal("invalid-input", "store-unavailable", "contract-violation"),
    message: bounded(500),
    schemaVersion: Schema.Literal(FLOWING_MEMORY_READ_SCHEMA_VERSION),
  }),
);

export type FlowingMemoryReadEnvelopeV1 = Schema.Schema.Type<
  typeof FlowingMemoryReadEnvelopeV1Schema
>;
export type FlowingMemorySearchResultV1 = Schema.Schema.Type<typeof ResultSchema>;

export const FlowingMemoryReadEnvelopeV2Schema = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("FlowingMemoryReadSuccessV2"),
    result: ResultV2Schema,
    schemaVersion: Schema.Literal(FLOWING_MEMORY_READ_V2_SCHEMA_VERSION),
  }),
  Schema.Struct({
    _tag: Schema.Literal("FlowingMemoryReadUnavailableV2"),
    code: Schema.Literal("invalid-input", "store-unavailable", "contract-violation"),
    message: bounded(500),
    schemaVersion: Schema.Literal(FLOWING_MEMORY_READ_V2_SCHEMA_VERSION),
  }),
);
export type FlowingMemoryReadEnvelopeV2 = Schema.Schema.Type<
  typeof FlowingMemoryReadEnvelopeV2Schema
>;
export type FlowingMemorySearchResultV2 = Schema.Schema.Type<typeof ResultV2Schema>;

export type FlowingEnvelopeDecodeOutcome =
  | { readonly ok: true; readonly envelope: FlowingMemoryReadEnvelopeV1 }
  | {
      readonly ok: false;
      readonly code: "malformed-response" | "contract-mismatch";
      readonly message: string;
    };

const decodeEnvelope = Schema.decodeUnknownEither(FlowingMemoryReadEnvelopeV1Schema);
const decodeEnvelopeV2 = Schema.decodeUnknownEither(FlowingMemoryReadEnvelopeV2Schema);

function declaredSchemaVersion(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  return typeof version === "number" ? version : undefined;
}

/**
 * Decodes one JSON document from the read boundary.
 *
 * A version we do not implement is reported as `contract-mismatch`, never
 * coerced. Anything else that does not match the mirrored v1 contract is
 * `malformed-response`. Neither path falls back to another backend.
 */
export function decodeFlowingEnvelope(text: string): FlowingEnvelopeDecodeOutcome {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, code: "malformed-response", message: "read command produced no output" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      ok: false,
      code: "malformed-response",
      message: "read command output was not one JSON document",
    };
  }

  const version = declaredSchemaVersion(parsed);
  if (version !== undefined && version !== FLOWING_MEMORY_READ_SCHEMA_VERSION) {
    return {
      ok: false,
      code: "contract-mismatch",
      message: `read boundary reported schemaVersion ${version}; this build implements ${FLOWING_MEMORY_READ_SCHEMA_VERSION}`,
    };
  }

  const decoded = decodeEnvelope(parsed);
  if (decoded._tag === "Left") {
    return {
      ok: false,
      code: "malformed-response",
      message: "read command output did not match the flowing-memory read envelope",
    };
  }

  return { ok: true, envelope: decoded.right };
}

export type FlowingEnvelopeV2DecodeOutcome =
  | { readonly ok: true; readonly envelope: FlowingMemoryReadEnvelopeV2 }
  | {
      readonly ok: false;
      readonly code: "malformed-response" | "contract-mismatch";
      readonly message: string;
    };

export function decodeFlowingEnvelopeV2(text: string): FlowingEnvelopeV2DecodeOutcome {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, code: "malformed-response", message: "read command produced no output" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      ok: false,
      code: "malformed-response",
      message: "read command output was not one JSON document",
    };
  }
  const version = declaredSchemaVersion(parsed);
  if (version !== undefined && version !== FLOWING_MEMORY_READ_V2_SCHEMA_VERSION) {
    return {
      ok: false,
      code: "contract-mismatch",
      message: `read boundary reported schemaVersion ${version}; this build implements ${FLOWING_MEMORY_READ_V2_SCHEMA_VERSION}`,
    };
  }
  const decoded = decodeEnvelopeV2(parsed);
  if (decoded._tag === "Left") {
    return {
      ok: false,
      code: "malformed-response",
      message: "read command output did not match the flowing-memory V2 read envelope",
    };
  }
  return { ok: true, envelope: decoded.right };
}
