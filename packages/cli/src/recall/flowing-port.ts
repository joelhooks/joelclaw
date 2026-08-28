/**
 * Flowing recall port.
 *
 * Requires an exact project/workstream scope and an explicit access decision,
 * leases a restricted runtime credential, invokes one immutable read command
 * over stdin under a hard deadline, and decodes a schema-versioned envelope.
 *
 * The executable is configured as an exact path and must resolve inside the
 * trusted release root; its arguments are owned here, never configured. The
 * credential is leased by secret name through the installed agent-secrets
 * contract, so project config cannot point the lease at arbitrary code.
 *
 * There is no fallback. When this port cannot answer, the lane is typed
 * unavailable and the composer says so.
 */

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { Schema } from "effect";
import type { CapabilityAdapterSettings } from "../capabilities/contract";
import {
  type ComposedRecallRequestV1,
  ComposedRecallRequestV1Schema,
  type RecallLaneHealthV1,
  type RecallLaneItemV1,
  type RecallLaneName,
  type RecallLaneUnavailableCode,
  type RecallLaneV1,
  unavailableLane,
} from "./contract";
import {
  decodeFlowingEnvelopeV2,
  type FlowingEvidenceReferenceV1,
  type FlowingMemorySearchResultV2,
} from "./flowing-envelope";
import {
  agentSecretsCredentialLease,
  type BoundaryProcessRunner,
  bunProcessRunner,
  type CredentialLeaseFormat,
  type CredentialLeaseRunner,
  minimalChildEnv,
  redactSecret,
} from "./process-boundary";
import {
  type ReleaseArtifactBinding,
  reverifyReleaseBinding,
  verifyReleaseArtifact,
} from "./release-manifest";

export const FLOWING_RECALL_SOURCE = "flowing-memory-read";

/** The canonical composed surface has no flowing legacy lane. */
export const FLOWING_LANES: readonly RecallLaneName[] = [
  "flowing-reflections",
  "flowing-observations",
];

export const DEFAULT_FLOWING_TIMEOUT_MS = 8_000;

/**
 * The one environment variable the read boundary reads the runtime credential
 * from. It is fixed, not configured: a configurable name lets project config
 * decide which variable a leased secret lands in, which is a way to smuggle it
 * somewhere the child was not meant to look.
 */
export const CREDENTIAL_ENV_NAME = "JOELCLAW_MEMORY_RUNTIME_DATABASE_URL";

/** Immutable releases only. Nothing configurable may widen this. */
export const DEFAULT_TRUSTED_RELEASE_ROOT = join(
  homedir(),
  ".joelclaw",
  "flowing-memory",
  "releases",
);

/**
 * Adapter-owned argv for the semantic read boundary at
 * `joelhooks/joelclaw-memory@034f082bf8bcdc5aad0d88f1d8cb5e2e05304ff0`.
 * Config supplies the executable; it never supplies arguments.
 */
export const FLOWING_READ_ARGS: readonly string[] = ["flowing-recall-read-v2", "--query-file", "-"];

/**
 * The source `MemorySearchQueryV1` requires a positive `legacyLimit`, but
 * migration-only legacy hits are not part of the composed surface. Ask for the
 * smallest legal number, decode whatever comes back so a malformed legacy hit
 * is still a typed contract violation, then discard it.
 */
export const PRIVATE_LEGACY_LIMIT = 1;

export interface FlowingRecallPortConfig {
  /** An exact, verified path inside the trusted release root. */
  readonly readExecutable: string;
  /** Adapter-owned. Present so a receipt can name what ran. */
  readonly readArgs: readonly string[];
  readonly credentialSecretName: string;
  readonly credentialFormat: CredentialLeaseFormat;
  readonly timeoutMs: number;
  /** Proof the executable is the pinned immutable release, not just a file under the root. */
  readonly release: ReleaseArtifactBinding;
}

export type FlowingRecallPortConfigOutcome =
  | { readonly ok: true; readonly config: FlowingRecallPortConfig }
  | { readonly ok: false; readonly code: RecallLaneUnavailableCode; readonly message: string };

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Resolves the configured executable and proves it lives inside the trusted
 * release root. Symlinks are resolved first, so a link planted inside the root
 * cannot point at a mutable build elsewhere.
 */
export type TrustedExecutableOutcome =
  | { readonly ok: true; readonly path: string; readonly release: ReleaseArtifactBinding }
  | { readonly ok: false; readonly code: RecallLaneUnavailableCode; readonly message: string };

export function verifyTrustedExecutable(
  candidate: string,
  trustedRoot: string,
  expectedCommit?: string,
  expectedArtifactSha256?: string,
): TrustedExecutableOutcome {
  let resolvedRoot: string;
  try {
    resolvedRoot = realpathSync(trustedRoot);
  } catch {
    return {
      ok: false,
      code: "not-configured",
      message: "flowing recall trusted release root does not exist",
    };
  }

  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    return {
      ok: false,
      code: "not-configured",
      message: "flowing recall read executable does not exist",
    };
  }

  if (!resolved.startsWith(resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`)) {
    return {
      ok: false,
      code: "untrusted-executable",
      message:
        "flowing recall read executable resolves outside the trusted flowing-memory release root",
    };
  }

  try {
    if (!statSync(resolved).isFile()) {
      return {
        ok: false,
        code: "untrusted-executable",
        message: "flowing recall read executable is not a regular file",
      };
    }
  } catch {
    return {
      ok: false,
      code: "not-configured",
      message: "flowing recall read executable could not be inspected",
    };
  }

  // Containment is necessary and nowhere near sufficient. The manifest is what
  // proves this file is the pinned release rather than something dropped in it.
  const release = verifyReleaseArtifact({
    resolvedRoot,
    resolvedArtifact: resolved,
    ...(expectedCommit ? { expectedCommit } : {}),
    ...(expectedArtifactSha256 ? { expectedArtifactSha256 } : {}),
  });
  if (!release.ok) {
    return { ok: false, code: "untrusted-executable", message: release.message };
  }

  return { ok: true, path: resolved, release: release.binding };
}

export interface ResolveFlowingRecallPortConfigInput {
  readonly settings: CapabilityAdapterSettings | undefined;
  /** Test seam only. Project config can never widen the trusted root. */
  readonly trustedReleaseRoot?: string;
  /** Test seam only. Production always requires the pinned memory commit. */
  readonly expectedMemoryCommit?: string;
  /** Test seam only. Production always requires the anchored artifact digest. */
  readonly expectedArtifactSha256?: string;
}

export function inspectFlowingRecallPortSettings(
  settings: Record<string, unknown> | undefined,
): { readonly ok: true } | { readonly ok: false; readonly code: "not-configured" } {
  const readExecutable = asString(settings?.read_executable);
  const credentialSecretName = asString(settings?.credential_secret_name);
  const credentialFormat = asString(settings?.credential_format).toLowerCase();
  if (
    !readExecutable ||
    !credentialSecretName ||
    (credentialFormat && credentialFormat !== "raw" && credentialFormat !== "json")
  ) {
    return { ok: false, code: "not-configured" };
  }
  return { ok: true };
}

/**
 * Reads adapter settings. Everything is configurable and everything is safe when
 * absent: an unconfigured port reports `not-configured` instead of guessing a
 * path or reaching for ambient credentials. Nothing here splits a string into
 * argv, so a path with a space stays one path.
 */
export function resolveFlowingRecallPortConfig(
  input: ResolveFlowingRecallPortConfigInput,
): FlowingRecallPortConfigOutcome {
  const settings = input.settings;
  const readExecutable = asString(settings?.read_executable);
  if (!readExecutable) {
    return {
      ok: false,
      code: "not-configured",
      message:
        "flowing recall read executable is not configured; set capabilities.recall.adapters.flowing-memory-recall.read_executable",
    };
  }

  const verified = verifyTrustedExecutable(
    readExecutable,
    input.trustedReleaseRoot ?? DEFAULT_TRUSTED_RELEASE_ROOT,
    input.expectedMemoryCommit,
    input.expectedArtifactSha256,
  );
  if (!verified.ok) return verified;

  const credentialSecretName = asString(settings?.credential_secret_name);
  if (!credentialSecretName) {
    return {
      ok: false,
      code: "not-configured",
      message:
        "flowing recall credential secret name is not configured; set capabilities.recall.adapters.flowing-memory-recall.credential_secret_name",
    };
  }

  const rawFormat = asString(settings?.credential_format).toLowerCase();
  if (rawFormat && rawFormat !== "raw" && rawFormat !== "json") {
    return {
      ok: false,
      code: "not-configured",
      message: 'flowing recall credential_format must be "raw" or "json"',
    };
  }

  const rawTimeout = settings?.timeout_ms;
  const timeoutMs =
    typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(Math.floor(rawTimeout), 120_000)
      : DEFAULT_FLOWING_TIMEOUT_MS;

  return {
    ok: true,
    config: {
      readExecutable: verified.path,
      readArgs: FLOWING_READ_ARGS,
      credentialSecretName,
      credentialFormat: rawFormat === "json" ? "json" : "raw",
      timeoutMs,
      release: verified.release,
    },
  };
}

export interface FlowingRecallReadInput {
  readonly request: ComposedRecallRequestV1;
  readonly config: FlowingRecallPortConfig;
  readonly runProcess?: BoundaryProcessRunner;
  readonly leaseCredential?: CredentialLeaseRunner;
  readonly parentEnv?: Record<string, string | undefined>;
}

export interface FlowingRecallReadOutcome {
  readonly lanes: Readonly<Record<RecallLaneName, RecallLaneV1>>;
  readonly durationMs: number;
  /** Argv only, for the receipt. Never the payload, never the credential. */
  readonly invokedCommand: readonly string[];
}

const validateRequest = Schema.decodeUnknownEither(ComposedRecallRequestV1Schema);

/** The encoded `MemorySearchQueryV1` the read boundary accepts on stdin. */
export function buildMemorySearchQueryPayload(
  request: ComposedRecallRequestV1,
): Record<string, unknown> {
  const scope = {
    _tag: "ProjectWorkstream",
    project: request.scope.project,
    workstream: request.scope.workstream,
  };
  return {
    _tag: "MemorySearchQueryV1",
    access: {
      _tag: "MemorySearchAccessV1",
      allowedPrivacy: [...request.access.allowedPrivacy],
      decidedAt: new Date(request.access.decidedAt).toISOString(),
      principalRef: request.access.principalRef,
      purpose: request.access.purpose,
      schemaVersion: 1,
      scope,
    },
    includeSuperseded: request.includeSuperseded,
    legacyLimit: PRIVATE_LEGACY_LIMIT,
    observationLimit: request.limits.observations,
    reflectionLimit: request.limits.reflections,
    schemaVersion: 1,
    scope,
    text: request.text,
  };
}

function allFlowingLanesUnavailable(
  code: RecallLaneUnavailableCode,
  message: string,
): Record<RecallLaneName, RecallLaneV1> {
  return {
    "flowing-reflections": unavailableLane(
      "flowing-reflections",
      FLOWING_RECALL_SOURCE,
      code,
      message,
    ),
    "flowing-observations": unavailableLane(
      "flowing-observations",
      FLOWING_RECALL_SOURCE,
      code,
      message,
    ),
    "curated-pages": unavailableLane(
      "curated-pages",
      FLOWING_RECALL_SOURCE,
      "not-requested",
      "the flowing port never answers for the curated lane",
    ),
  };
}

function healthFrom(result: FlowingMemorySearchResultV2): RecallLaneHealthV1 {
  switch (result.health._tag) {
    case "Healthy":
      return {
        _tag: "Healthy",
        builtAt: result.health.builtAt,
        freshAt: result.health.freshAt,
        sourceSnapshotHash: result.health.sourceSnapshotHash,
      };
    case "Stale":
      // Build and freshness times survive staleness. Dropping them would leave
      // an operator unable to tell a projection an hour behind from one a month
      // behind.
      return {
        _tag: "Stale",
        builtAt: result.health.builtAt,
        detail: "flowing projection is behind its source",
        freshAt: result.health.freshAt,
        sourceSnapshotHash: result.health.sourceSnapshotHash,
        staleSince: result.health.staleSince,
      };
    case "Failed":
      return {
        _tag: "Failed",
        detail: "flowing projection failed",
        failureReceiptId: result.health.failureReceiptId.startsWith("failure:")
          ? result.health.failureReceiptId
          : `failure:${result.health.failureReceiptId}`,
        ...(result.health.lastValidSnapshotHash
          ? { lastValidSnapshotHash: result.health.lastValidSnapshotHash }
          : {}),
      };
    default:
      return { _tag: "Unknown", reason: result.health.reason };
  }
}

function reflectionItems(result: FlowingMemorySearchResultV2): RecallLaneItemV1[] {
  return result.reflectionHits.map((hit) => {
    const superseded = hit.matchedClaims
      .filter((claim) => claim._tag === "Superseded")
      .map((claim) => claim.claimId);
    const matchedText = hit.reflection.claims
      .filter((claim) => hit.matchedClaims.some((matched) => matched.claimId === claim.claimId))
      .map((claim) => claim.text)
      .join(" · ");
    const card = hit.reflection.schemaVersion === 2 ? hit.reflection : undefined;
    const summary =
      card === undefined
        ? matchedText
        : `${card.memory} Consequence: ${card.consequence} Counterfactual: ${card.counterfactual}`;
    const title = card?.trigger ?? matchedText;
    return {
      evidenceIds: hit.evidence.map((reference) => reference.evidenceId),
      id: hit.reflection.reflectionId,
      kind: "reflection",
      lane: "flowing-reflections" as const,
      privacy: hit.reflection.privacy,
      // The producer's rank, never re-derived from array order.
      rank: hit.rank,
      scope: {
        _tag: "ProjectWorkstream" as const,
        project: hit.reflection.scope.project,
        workstream: hit.reflection.scope.workstream,
      },
      scopeBinding: "record-scope" as const,
      score: hit.score,
      ...(summary ? { summary: summary.slice(0, 1_000) } : {}),
      ...(superseded.length > 0 ? { supersededClaimIds: superseded } : {}),
      title: title.slice(0, 200) || hit.reflection.reflectionId,
    };
  });
}

function observationItems(result: FlowingMemorySearchResultV2): RecallLaneItemV1[] {
  return result.observationHits.map((hit) => ({
    evidenceIds: hit.evidence.map((reference) => reference.evidenceId),
    id: hit.observation.observationId,
    kind: "observation",
    lane: "flowing-observations" as const,
    privacy: hit.observation.privacy,
    rank: hit.rank,
    scope: {
      _tag: "ProjectWorkstream" as const,
      project: hit.observation.scope.project,
      workstream: hit.observation.scope.workstream,
    },
    scopeBinding: "record-scope" as const,
    score: hit.score,
    summary: hit.observation.gist.text.slice(0, 1_000),
    title: hit.observation.gist.text.slice(0, 200),
  }));
}

function lanesFromResult(
  result: FlowingMemorySearchResultV2,
): Record<RecallLaneName, RecallLaneV1> {
  const health = healthFrom(result);
  const build = (lane: RecallLaneName, items: RecallLaneItemV1[]): RecallLaneV1 => ({
    _tag: "RecallLaneAvailableV1",
    health,
    items,
    lane,
    scoreScale: "unit-interval",
    source: FLOWING_RECALL_SOURCE,
  });

  return {
    "flowing-reflections": build("flowing-reflections", reflectionItems(result)),
    "flowing-observations": build("flowing-observations", observationItems(result)),
    "curated-pages": unavailableLane(
      "curated-pages",
      FLOWING_RECALL_SOURCE,
      "not-requested",
      "the flowing port never answers for the curated lane",
    ),
  };
}

const sameInstant = (left: string, right: string) => Date.parse(left) === Date.parse(right);

const samePrivacySet = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  new Set(left).size === left.length &&
  left.every((tier) => right.includes(tier));

/**
 * The echoed query must be the query we sent, field for field.
 *
 * A read boundary that quietly widens the scope, relaxes the privacy grant,
 * changes the principal or purpose, or raises a limit has answered a different
 * question. That is a contract violation, not a result.
 */
export function echoedQueryMatchesRequest(
  result: FlowingMemorySearchResultV2,
  request: ComposedRecallRequestV1,
): boolean {
  const query = result.query;
  const scopeEqual =
    query.scope.project === request.scope.project &&
    query.scope.workstream === request.scope.workstream &&
    query.access.scope.project === request.scope.project &&
    query.access.scope.workstream === request.scope.workstream;

  return (
    scopeEqual &&
    query.text === request.text &&
    query.includeSuperseded === request.includeSuperseded &&
    query.reflectionLimit === request.limits.reflections &&
    query.observationLimit === request.limits.observations &&
    query.legacyLimit === PRIVATE_LEGACY_LIMIT &&
    query.access.principalRef === request.access.principalRef &&
    query.access.purpose === request.access.purpose &&
    sameInstant(query.access.decidedAt, request.access.decidedAt) &&
    samePrivacySet(query.access.allowedPrivacy, request.access.allowedPrivacy)
  );
}

/**
 * Every returned record, every supporting observation, and every evidence
 * reference must sit inside the requested scope and the granted privacy tiers.
 * Legacy hits are checked too, even though they are discarded.
 */
export function recordsWithinScopeAndGrant(
  result: FlowingMemorySearchResultV2,
  request: ComposedRecallRequestV1,
): boolean {
  const inScope = (scope: { readonly project: string; readonly workstream: string }) =>
    scope.project === request.scope.project && scope.workstream === request.scope.workstream;
  const allowed = new Set<string>(request.access.allowedPrivacy);
  const evidenceOk = (references: readonly FlowingEvidenceReferenceV1[]) =>
    references.every((reference) => inScope(reference.scope) && allowed.has(reference.privacy));

  return (
    result.reflectionHits.every(
      (hit) =>
        inScope(hit.reflection.scope) &&
        allowed.has(hit.reflection.privacy) &&
        evidenceOk(hit.evidence) &&
        evidenceOk(hit.reflection.evidence) &&
        hit.supportingObservations.every(
          (observation) =>
            inScope(observation.scope) &&
            allowed.has(observation.privacy) &&
            evidenceOk(observation.evidence),
        ),
    ) &&
    result.observationHits.every(
      (hit) =>
        inScope(hit.observation.scope) &&
        allowed.has(hit.observation.privacy) &&
        evidenceOk(hit.evidence) &&
        evidenceOk(hit.observation.evidence),
    ) &&
    result.legacyHits.every(
      (hit) => inScope(hit.resolvedScope) && allowed.has(hit.descriptor.privacy),
    )
  );
}

export async function readFlowingRecall(
  input: FlowingRecallReadInput,
): Promise<FlowingRecallReadOutcome> {
  const startedAt = Date.now();
  const command = [input.config.readExecutable, ...input.config.readArgs];
  const finish = (lanes: Record<RecallLaneName, RecallLaneV1>): FlowingRecallReadOutcome => ({
    lanes,
    durationMs: Date.now() - startedAt,
    invokedCommand: command,
  });

  const validated = validateRequest(input.request);
  if (validated._tag === "Left") {
    return finish(
      allFlowingLanesUnavailable(
        "invalid-input",
        "flowing recall requires an exact project/workstream scope, an explicit principal, purpose, decided-at, privacy tiers, limits, and a supersession choice",
      ),
    );
  }

  const runProcess = input.runProcess ?? bunProcessRunner;
  const leaseCredential = input.leaseCredential ?? agentSecretsCredentialLease;

  // Config resolution and this call are separate moments. Re-prove the release
  // now, before a credential exists to steal: a file swapped after verification
  // must cost a refusal, not a leased secret.
  const beforeLease = reverifyReleaseBinding(input.config.release);
  if (!beforeLease.ok) {
    return finish(allFlowingLanesUnavailable("untrusted-executable", beforeLease.message));
  }

  const lease = await leaseCredential({
    secretName: input.config.credentialSecretName,
    format: input.config.credentialFormat,
    timeoutMs: Math.min(input.config.timeoutMs, 15_000),
  });
  if (!lease.ok) {
    return finish(
      allFlowingLanesUnavailable(
        "credential-unavailable",
        "flowing recall credential lease failed",
      ),
    );
  }

  const secret = lease.value;

  // The lease is a round trip to another process and takes real time, so the
  // pre-lease proof is already stale by the time the secret exists. Re-prove
  // before the secret is placed anywhere a child could read it. Nothing below
  // this point may run if the release moved during the lease.
  const afterLease = reverifyReleaseBinding(input.config.release);
  if (!afterLease.ok) {
    return finish(
      allFlowingLanesUnavailable(
        "untrusted-executable",
        "flowing recall release changed after verification",
      ),
    );
  }

  const env = minimalChildEnv(input.parentEnv ?? process.env, {
    [CREDENTIAL_ENV_NAME]: secret,
  });

  let proc: Awaited<ReturnType<BoundaryProcessRunner>>;
  try {
    proc = await runProcess({
      command,
      stdin: JSON.stringify(buildMemorySearchQueryPayload(validated.right)),
      env,
      timeoutMs: input.config.timeoutMs,
    });
  } catch {
    return finish(
      allFlowingLanesUnavailable("process-failed", "flowing recall read process failed"),
    );
  }

  const stdout = redactSecret(proc.stdout, secret);

  if (proc.timedOut) {
    return finish(
      allFlowingLanesUnavailable(
        "timeout",
        `flowing recall read exceeded its ${input.config.timeoutMs}ms deadline`,
      ),
    );
  }

  if (proc.missingExecutable) {
    return finish(
      allFlowingLanesUnavailable(
        "not-configured",
        "flowing recall read executable is not available",
      ),
    );
  }

  if (proc.exitCode !== 0 && proc.exitCode !== 3) {
    return finish(
      allFlowingLanesUnavailable("process-failed", `flowing recall read exited ${proc.exitCode}`),
    );
  }

  const decoded = decodeFlowingEnvelopeV2(stdout);
  if (!decoded.ok) {
    return finish(
      allFlowingLanesUnavailable(decoded.code, `flowing recall response failed ${decoded.code}`),
    );
  }

  // The source assigns exit 3 to every unavailable envelope and exit 0 to every
  // success envelope. Both mismatches are contract violations.
  if (decoded.envelope._tag === "FlowingMemoryReadUnavailableV2") {
    if (proc.exitCode !== 3) {
      return finish(
        allFlowingLanesUnavailable(
          "contract-violation",
          `flowing recall read exited ${proc.exitCode} while reporting an unavailable envelope`,
        ),
      );
    }
    return finish(
      allFlowingLanesUnavailable(
        decoded.envelope.code,
        `flowing recall source unavailable: ${decoded.envelope.code}`,
      ),
    );
  }

  if (proc.exitCode !== 0) {
    return finish(
      allFlowingLanesUnavailable(
        "contract-violation",
        `flowing recall read exited ${proc.exitCode} while reporting success`,
      ),
    );
  }

  const result = decoded.envelope.result;
  if (!echoedQueryMatchesRequest(result, validated.right)) {
    return finish(
      allFlowingLanesUnavailable(
        "contract-violation",
        "flowing recall read echoed a query that is not the query that was sent",
      ),
    );
  }

  if (!recordsWithinScopeAndGrant(result, validated.right)) {
    return finish(
      allFlowingLanesUnavailable(
        "contract-violation",
        "flowing recall read returned a record, supporting observation, or evidence reference outside the requested scope or granted privacy tiers",
      ),
    );
  }

  return finish(lanesFromResult(result));
}
