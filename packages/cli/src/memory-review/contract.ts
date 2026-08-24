import { Schema } from "effect";

export const MEMORY_REVIEW_SCHEMA_VERSION = 1 as const;
export const MEMORY_REVIEW_SOURCES = ["sessions", "git", "brain", "otel", "flowing"] as const;
export const MEMORY_REVIEW_STATUSES = [
  "available",
  "partial",
  "stale",
  "unavailable",
  "failed",
] as const;

export const MemoryReviewStatusSchema = Schema.Literal(...MEMORY_REVIEW_STATUSES);
export type MemoryReviewStatus = Schema.Schema.Type<typeof MemoryReviewStatusSchema>;

const NullableStringSchema = Schema.NullOr(Schema.String);
const CountSchema = Schema.Number.pipe(
  Schema.filter((value) => Number.isFinite(value) && Number.isInteger(value) && value >= 0, {
    message: () => "expected a finite non-negative integer",
  }),
);
const RankSchema = Schema.Number.pipe(
  Schema.filter((value) => Number.isFinite(value) && Number.isInteger(value) && value >= 1, {
    message: () => "expected a finite positive integer rank",
  }),
);

export const MemoryReviewIssueSchema = Schema.Struct({
  code: Schema.String,
  host: NullableStringSchema,
  message: Schema.String,
  source: Schema.Literal(...MEMORY_REVIEW_SOURCES),
});
export type MemoryReviewIssue = Schema.Schema.Type<typeof MemoryReviewIssueSchema>;

export const MemoryReviewHostSchema = Schema.Struct({
  alias: Schema.String,
  current: Schema.Boolean,
  lastVerifiedAt: NullableStringSchema,
  status: MemoryReviewStatusSchema,
});
export type MemoryReviewHost = Schema.Schema.Type<typeof MemoryReviewHostSchema>;

export const MemoryReviewSessionEvidenceSchema = Schema.Struct({
  conversationId: NullableStringSchema,
  endedAt: Schema.String,
  host: Schema.String,
  runId: Schema.String,
  runtime: Schema.String,
  turnCount: CountSchema,
});

export const MemoryReviewGitEvidenceSchema = Schema.Struct({
  at: Schema.String,
  branch: Schema.String,
  hash: Schema.String,
  host: Schema.String,
  repository: Schema.String,
  subject: Schema.String,
});

export const MemoryReviewBrainEvidenceSchema = Schema.Struct({
  modifiedAt: Schema.String,
  ref: Schema.String,
  privacy: Schema.Literal("public", "private"),
  root: Schema.String,
  title: Schema.String,
});

export const MemoryReviewOtelEvidenceSchema = Schema.Struct({
  action: Schema.String,
  component: Schema.String,
  host: NullableStringSchema,
  level: Schema.String,
  success: Schema.Boolean,
  timestamp: Schema.String,
});

export const MemoryReviewFlowingEvidenceSchema = Schema.Struct({
  health: Schema.String,
  id: Schema.String,
  kind: Schema.String,
  lane: Schema.Literal("flowing-reflections", "flowing-observations"),
  rank: RankSchema,
  title: Schema.String,
});

const LaneBaseFields = {
  issues: Schema.Array(MemoryReviewIssueSchema),
  status: MemoryReviewStatusSchema,
};

export const MemoryReviewResultV1Schema = Schema.Struct({
  _tag: Schema.Literal("MemoryReviewResultV1"),
  currentRequestExcluded: Schema.Boolean,
  generatedAt: Schema.String,
  hosts: Schema.Array(MemoryReviewHostSchema),
  lanes: Schema.Struct({
    brain: Schema.Struct({
      ...LaneBaseFields,
      omittedSensitive: CountSchema,
      pages: Schema.Array(MemoryReviewBrainEvidenceSchema),
      total: CountSchema,
    }),
    flowing: Schema.Struct({
      ...LaneBaseFields,
      activeJobs: CountSchema,
      blockedJobs: CountSchema,
      items: Schema.Array(MemoryReviewFlowingEvidenceSchema),
      records: CountSchema,
    }),
    git: Schema.Struct({
      ...LaneBaseFields,
      commits: Schema.Array(MemoryReviewGitEvidenceSchema),
      repositories: CountSchema,
      total: CountSchema,
    }),
    otel: Schema.Struct({
      ...LaneBaseFields,
      errors: CountSchema,
      events: Schema.Array(MemoryReviewOtelEvidenceSchema),
      total: CountSchema,
    }),
    sessions: Schema.Struct({
      ...LaneBaseFields,
      byHost: Schema.Record({ key: Schema.String, value: CountSchema }),
      excludedCurrent: CountSchema,
      sessions: Schema.Array(MemoryReviewSessionEvidenceSchema),
      total: CountSchema,
    }),
  }),
  schemaVersion: Schema.Literal(MEMORY_REVIEW_SCHEMA_VERSION),
  scope: Schema.Struct({
    mode: Schema.Literal("fleet", "filtered"),
    project: NullableStringSchema,
    workstream: NullableStringSchema,
  }),
  summary: Schema.Array(Schema.String),
  window: Schema.Struct({
    cutoff: Schema.String,
    requested: Schema.String,
  }),
});

export type MemoryReviewResultV1 = Schema.Schema.Type<typeof MemoryReviewResultV1Schema>;
export type MemoryReviewSessionEvidence = Schema.Schema.Type<
  typeof MemoryReviewSessionEvidenceSchema
>;
export type MemoryReviewGitEvidence = Schema.Schema.Type<typeof MemoryReviewGitEvidenceSchema>;
export type MemoryReviewBrainEvidence = Schema.Schema.Type<typeof MemoryReviewBrainEvidenceSchema>;
export type MemoryReviewOtelEvidence = Schema.Schema.Type<typeof MemoryReviewOtelEvidenceSchema>;
export type MemoryReviewFlowingEvidence = Schema.Schema.Type<
  typeof MemoryReviewFlowingEvidenceSchema
>;
