import { createHash } from "node:crypto";

import { Schema } from "effect";

const NonEmpty = Schema.String.check(Schema.isMinLength(1));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Scope = Schema.Struct({
  _tag: Schema.Literal("ProjectWorkstream"),
  project: NonEmpty,
  workstream: NonEmpty,
});
const Evidence = Schema.Struct({
  _tag: NonEmpty,
  evidenceId: NonEmpty,
  privacy: Schema.Union([
    Schema.Literal("public"),
    Schema.Literal("private"),
    Schema.Literal("sensitive"),
  ]),
  scope: Scope,
});
const Claim = Schema.Struct({
  claimId: NonEmpty,
  evidenceIds: Schema.Array(NonEmpty),
  text: NonEmpty,
});
const Relation = Schema.Struct({
  _tag: Schema.Union([Schema.Literal("Contradicts"), Schema.Literal("Supersedes")]),
  reason: NonEmpty,
  sourceClaimId: NonEmpty,
  targetClaimId: NonEmpty,
  targetReflectionId: NonEmpty,
});

export const ObservationBodySchema = Schema.Struct({
  createdAt: NonEmpty,
  decisions: Schema.Array(Claim),
  evidence: Schema.Array(Evidence),
  gist: Claim,
  observationId: NonEmpty,
  observations: Schema.Array(Claim),
  openQuestions: Schema.Array(Claim),
  privacy: Schema.Union([Schema.Literal("public"), Schema.Literal("private")]),
  schemaVersion: Schema.Literal(2),
  scope: Scope,
  type: Schema.Literal("observation"),
});
export type ObservationBody = typeof ObservationBodySchema.Type;

export const ReflectionBodySchema = Schema.Struct({
  claims: Schema.Array(Claim),
  evidence: Schema.Array(Evidence),
  observedAt: NonEmpty,
  privacy: Schema.Union([Schema.Literal("public"), Schema.Literal("private")]),
  reflectionId: NonEmpty,
  relations: Schema.Array(Relation),
  schemaVersion: Schema.Literal(1),
  scope: Scope,
  type: Schema.Literal("reflection"),
});
export type ReflectionBody = typeof ReflectionBodySchema.Type;

export const SourceRecordSchema = Schema.Struct({
  body: Schema.Unknown,
  commitCreatedAt: NonEmpty,
  commitId: Hash,
  contentHash: Hash,
  kind: Schema.Union([Schema.Literal("observation"), Schema.Literal("reflection")]),
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  privacy: Schema.Union([
    Schema.Literal("public"),
    Schema.Literal("private"),
    Schema.Literal("sensitive"),
  ]),
  recordId: NonEmpty,
  schemaVersion: Schema.Int,
  scopeProject: NonEmpty,
  scopeWorkstream: NonEmpty,
});
export type SourceRecord = typeof SourceRecordSchema.Type;

export const BoundarySchema = Schema.Struct({
  commitCreatedAt: NonEmpty,
  commitId: Hash,
});
export type Boundary = typeof BoundarySchema.Type;

const AllowedScopeSchema = Schema.Struct({
  project: NonEmpty,
  workstream: NonEmpty,
});
export const ForwarderPolicySchema = Schema.Struct({
  allowedPrivacy: Schema.Array(
    Schema.Union([Schema.Literal("public"), Schema.Literal("private")]),
  ).check(Schema.isMinLength(1)),
  allowedScopes: Schema.Array(AllowedScopeSchema).check(Schema.isMinLength(1)),
  canaryRecordId: Schema.optional(NonEmpty),
  containerTag: NonEmpty,
  destinationVisibility: Schema.Literal("private"),
  executorUrl: Schema.String.check(Schema.isPattern(/^http:\/\/127\.0\.0\.1(?::\d+)?\/mcp$/u)),
  maxPayloadBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(256), Schema.isLessThanOrEqualTo(8_000)),
  maxReconcileAttempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  pollIntervalMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1_000)),
  reconnectIntervalMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1_000), Schema.isLessThanOrEqualTo(60_000)),
  ),
  recoveryScanIntervalMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(60_000)),
  ),
  supermemoryConnection: Schema.String.check(
    Schema.isPattern(/^supermemory_mcp\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u),
  ),
  schemaVersion: Schema.Literal(1),
});
export type ForwarderPolicy = typeof ForwarderPolicySchema.Type;

export type ExclusionReason =
  | "body-invalid"
  | "content-export-guard"
  | "evidence-not-exportable"
  | "privacy-not-allowed"
  | "reviewed-card-not-supported-v1"
  | "scope-not-allowed"
  | "schema-not-supported";

export interface PreparedMemory {
  readonly commitCreatedAt: string;
  readonly commitId: string;
  readonly contentHash: string;
  readonly marker: string;
  readonly payload: string;
  readonly payloadHash: string;
  readonly privacy: "private" | "public";
  readonly recordId: string;
  readonly scopeProject: string;
  readonly scopeWorkstream: string;
  readonly supersedes: readonly string[];
}

export type Assessment =
  | { readonly _tag: "Eligible"; readonly memory: PreparedMemory }
  | { readonly _tag: "Excluded"; readonly reason: ExclusionReason; readonly record: SourceRecord };

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const exportDenied = [
  /(?:^|\s)\/(?:Users|home|var|etc|opt|private|tmp)\//u,
  /(?:^|\s)~\//u,
  /\.brain\//iu,
  /(?:^|\s)skills\//iu,
  /raw transcript/iu,
  /customer (?:data|record|ticket)/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bsk-[A-Za-z0-9_-]{12,}\b/u,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|secret|token)\s*[:=]/iu,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/u,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
] as const;

const scopeAllowed = (record: SourceRecord, policy: ForwarderPolicy): boolean =>
  policy.allowedScopes.some(
    (scope) => scope.project === record.scopeProject && scope.workstream === record.scopeWorkstream,
  );

const safeText = (texts: readonly string[], maxBytes: number): string | undefined => {
  const text = texts.map((item) => item.trim()).filter(Boolean).join("\n");
  if (text.length === 0 || exportDenied.some((pattern) => pattern.test(text))) return undefined;
  if (Buffer.byteLength(text, "utf8") > maxBytes) return undefined;
  return text;
};

export const assessRecord = (record: SourceRecord, policy: ForwarderPolicy): Assessment => {
  if (record.privacy === "sensitive" || !policy.allowedPrivacy.includes(record.privacy)) {
    return { _tag: "Excluded", reason: "privacy-not-allowed", record };
  }
  if (!scopeAllowed(record, policy)) {
    return { _tag: "Excluded", reason: "scope-not-allowed", record };
  }

  let createdAt: string;
  let evidence: readonly {
    readonly privacy: "private" | "public" | "sensitive";
    readonly scope: { readonly project: string; readonly workstream: string };
  }[];
  let texts: readonly string[];
  let supersedes: readonly string[] = [];
  try {
    if (record.kind === "observation" && record.schemaVersion === 2) {
      const body = Schema.decodeUnknownSync(ObservationBodySchema)(record.body);
      if (
        body.observationId !== record.recordId ||
        body.scope.project !== record.scopeProject ||
        body.scope.workstream !== record.scopeWorkstream ||
        body.privacy !== record.privacy
      ) {
        return { _tag: "Excluded", reason: "body-invalid", record };
      }
      createdAt = body.createdAt;
      evidence = body.evidence;
      texts = [
        `Gist: ${body.gist.text}`,
        ...body.decisions.map((claim) => `Decision: ${claim.text}`),
        ...body.observations.map((claim) => `Observation: ${claim.text}`),
        ...body.openQuestions.map((claim) => `Open question: ${claim.text}`),
      ];
    } else if (record.kind === "reflection" && record.schemaVersion === 1) {
      const body = Schema.decodeUnknownSync(ReflectionBodySchema)(record.body);
      if (
        body.reflectionId !== record.recordId ||
        body.scope.project !== record.scopeProject ||
        body.scope.workstream !== record.scopeWorkstream ||
        body.privacy !== record.privacy
      ) {
        return { _tag: "Excluded", reason: "body-invalid", record };
      }
      createdAt = body.observedAt;
      evidence = body.evidence;
      texts = [
        ...body.claims.map((claim) => `Claim: ${claim.text}`),
        ...body.relations
          .filter((relation) => relation._tag === "Supersedes")
          .map((relation) => `Correction: supersedes an earlier claim because ${relation.reason}`),
      ];
      supersedes = body.relations
        .filter((relation) => relation._tag === "Supersedes")
        .map((relation) => relation.targetReflectionId);
    } else {
      return { _tag: "Excluded", reason: "schema-not-supported", record };
    }
  } catch {
    return { _tag: "Excluded", reason: "body-invalid", record };
  }

  if (
    evidence.length === 0 ||
    evidence.some(
      (item) =>
        item.privacy === "sensitive" ||
        !policy.allowedPrivacy.includes(item.privacy) ||
        item.scope.project !== record.scopeProject ||
        item.scope.workstream !== record.scopeWorkstream,
    )
  ) {
    return { _tag: "Excluded", reason: "evidence-not-exportable", record };
  }

  const marker = `flowing-record:${sha256(record.recordId)}`;
  const derived = safeText(texts, policy.maxPayloadBytes - 256);
  if (derived === undefined) {
    return { _tag: "Excluded", reason: "content-export-guard", record };
  }
  const payload = [
    `Topic: accepted Flowing semantic memory`,
    `Date: ${createdAt}`,
    `Status: current`,
    `Source privacy: ${record.privacy}`,
    derived,
    `Source reference: ${marker}`,
  ].join("\n");
  if (Buffer.byteLength(payload, "utf8") > policy.maxPayloadBytes) {
    return { _tag: "Excluded", reason: "content-export-guard", record };
  }
  return {
    _tag: "Eligible",
    memory: {
      commitCreatedAt: record.commitCreatedAt,
      commitId: record.commitId,
      contentHash: record.contentHash,
      marker,
      payload,
      payloadHash: sha256(payload),
      privacy: record.privacy,
      recordId: record.recordId,
      scopeProject: record.scopeProject,
      scopeWorkstream: record.scopeWorkstream,
      supersedes,
    },
  };
};

export const correctionMemory = (
  recordId: string,
  reason: "inactive" | "superseded",
  privacy: "private" | "public",
): PreparedMemory => {
  const sourceMarker = `flowing-record:${sha256(recordId)}`;
  const marker = `flowing-correction:${sha256(`${reason}:${recordId}`)}`;
  const payload = [
    "Topic: Flowing semantic memory correction",
    "Status: historical; do not rely on the earlier memory as current",
    `Reason: ${reason}`,
    `Source privacy: ${privacy}`,
    `Corrects: ${sourceMarker}`,
    `Source reference: ${marker}`,
  ].join("\n");
  return {
    commitCreatedAt: "correction",
    commitId: sha256(`correction:${recordId}`),
    contentHash: sha256(recordId),
    marker,
    payload,
    payloadHash: sha256(payload),
    privacy,
    recordId,
    scopeProject: "correction",
    scopeWorkstream: "correction",
    supersedes: [],
  };
};
