/**
 * Canonical fixtures for the composed recall tests.
 *
 * These are built to satisfy the full v1 contract at
 * `joelclaw-memory@601d8c518d3078859b7cdf287a6db52fa8ee9082`, not the subset the
 * adapter happens to read. Every record carries its identity fields, its
 * derivation, its evidence, and its ordered timestamps. A test that wants a
 * defect produces it by mutating a canonical fixture, so "the mirror rejects X"
 * means the mirror rejected X and nothing else.
 *
 * Every process boundary here is fake. No test in this package starts the real
 * flowing-memory service, leases a real credential, or reads the production
 * `critical.db`.
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CriticalSearchHit, CriticalSearchResult } from "../lib/critical-search";
import type { ComposedRecallRequestV1 } from "./contract";
import { FLOWING_READ_ARGS, PRIVATE_LEGACY_LIMIT } from "./flowing-port";
import {
  FLOWING_RELEASE_MANIFEST_FILENAME,
  FLOWING_RELEASE_MANIFEST_SCHEMA_VERSION,
  PINNED_MEMORY_COMMIT,
} from "./release-manifest";

export const hex = (seed: number): string => seed.toString(16).padStart(64, "0");

export const TEST_PROJECT = "joelhooks.joelclaw-memory";
export const TEST_WORKSTREAM = "main";

type Privacy = "public" | "private" | "sensitive";

export function testRequest(
  overrides: Partial<ComposedRecallRequestV1> = {},
): ComposedRecallRequestV1 {
  return {
    _tag: "ComposedRecallRequestV1",
    access: {
      _tag: "RecallAccessV1",
      allowedPrivacy: ["private"],
      decidedAt: "2026-08-22T00:00:00.000Z",
      principalRef: "operator:joel",
      purpose: "recall-adapter-comparison",
      ...overrides.access,
    },
    includeSuperseded: false,
    limits: { curated: 5, observations: 5, reflections: 5 },
    schemaVersion: 1,
    scope: {
      _tag: "ProjectWorkstream",
      project: TEST_PROJECT,
      workstream: TEST_WORKSTREAM,
      ...overrides.scope,
    },
    text: "postgres search index",
    ...overrides,
  } as ComposedRecallRequestV1;
}

const scopeWire = (scope?: { project: string; workstream: string }) => ({
  _tag: "ProjectWorkstream",
  project: scope?.project ?? TEST_PROJECT,
  workstream: scope?.workstream ?? TEST_WORKSTREAM,
});

/** The exact `MemorySearchQueryV1` the port sends, echoed back by the fixture. */
export function flowingQueryWire(
  request: ComposedRecallRequestV1 = testRequest(),
): Record<string, unknown> {
  const scope = scopeWire(request.scope);
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

const REDACTION_CLEAN = {
  _tag: "clean",
  policyHash: hex(0xc1ea),
  scannedAt: "2026-08-21T09:00:00.000Z",
  schemaVersion: 1,
};

const DERIVATION = {
  _tag: "Deterministic",
  contractHash: hex(0xc0de),
  producer: "joelclaw-memory/derive",
};

function transcriptEvidence(
  seed: number,
  privacy: Privacy,
  scope: Record<string, unknown>,
): Record<string, unknown> {
  return {
    _tag: "TranscriptWindow",
    conversationId: `conversation-${seed}`,
    evidenceId: `evidence:${hex(seed)}`,
    fromTurn: 0,
    privacy,
    redaction: REDACTION_CLEAN,
    runId: `run-${seed}`,
    scope,
    toTurn: 4,
    transcriptHash: hex(seed + 0x1000),
  };
}

function claim(seed: number, text: string): Record<string, unknown> {
  return {
    claimId: `claim:${hex(seed)}`,
    evidenceIds: [`evidence:${hex(seed)}`],
    text,
  };
}

export interface ObservationFixtureOptions {
  readonly seed: number;
  readonly privacy?: Privacy;
  readonly scope?: { project: string; workstream: string };
}

/** A complete canonical `ObservationV2`. */
export function observationWire(options: ObservationFixtureOptions): Record<string, unknown> {
  const privacy = options.privacy ?? "private";
  const scope = scopeWire(options.scope);
  const seed = options.seed;
  return {
    createdAt: "2026-08-21T09:05:00.000Z",
    decisions: [],
    derivation: DERIVATION,
    evidence: [transcriptEvidence(seed, privacy, scope)],
    gist: claim(seed, `observation gist ${seed}`),
    observationId: `observation:v2:${hex(seed)}`,
    observations: [],
    openQuestions: [],
    privacy,
    schemaVersion: 2,
    scope,
    source: {
      acceptedAt: "2026-08-21T09:00:00.000Z",
      conversationId: `conversation-${seed}`,
      fromTurn: 0,
      isFinal: true,
      observedFrom: "2026-08-21T08:00:00.000Z",
      observedThrough: "2026-08-21T08:30:00.000Z",
      redaction: REDACTION_CLEAN,
      runId: `run-${seed}`,
      toTurn: 4,
      transcriptHash: hex(seed + 0x1000),
    },
    type: "observation",
  };
}

export interface ReflectionHitFixtureOptions {
  readonly seed: number;
  readonly rank: number;
  readonly score?: number;
  readonly privacy?: Privacy;
  readonly scope?: { project: string; workstream: string };
  readonly evidencePrivacy?: Privacy;
  readonly evidenceScope?: { project: string; workstream: string };
}

/** A complete canonical `ReflectionSearchHitV1`, supporting observations included. */
export function reflectionHitWire(options: ReflectionHitFixtureOptions): Record<string, unknown> {
  const privacy = options.privacy ?? "private";
  const scope = scopeWire(options.scope);
  const seed = options.seed;
  const supportSeed = seed + 0x100;
  const support = observationWire({
    seed: supportSeed,
    privacy,
    ...(options.scope ? { scope: options.scope } : {}),
  });

  return {
    evidence: [
      transcriptEvidence(
        seed,
        options.evidencePrivacy ?? privacy,
        scopeWire(options.evidenceScope ?? options.scope),
      ),
    ],
    matchedClaims: [{ _tag: "Active", claimId: `claim:${hex(seed)}` }],
    rank: options.rank,
    reflection: {
      claims: [claim(seed, `reflection claim ${seed}`)],
      derivation: DERIVATION,
      evidence: [transcriptEvidence(seed, privacy, scope)],
      observedAt: "2026-08-21T10:00:00.000Z",
      privacy,
      reflectionId: `reflection:v1:${hex(seed)}`,
      relations: [],
      schemaVersion: 1,
      scope,
      sourceObservationIds: [`observation:v2:${hex(supportSeed)}`],
      type: "reflection",
      validFrom: "2026-08-21T09:10:00.000Z",
      validThrough: "2026-08-21T09:20:00.000Z",
    },
    score: options.score ?? 0.9,
    supportingObservations: [support],
  };
}

export function cardReflectionHitWire(seed: number, rank: number): Record<string, unknown> {
  const scope = scopeWire();
  const supportSeed = seed + 0x100;
  const support = observationWire({ seed: supportSeed, privacy: "private" });
  const trigger = "When a Herdr pane ID is used as dispatch authority.";
  const memory = "Kernel peer identity is bound at JSON API accept.";
  const consequence = "Fail closed when Windows named-pipe PID proof is unavailable.";
  const counterfactual =
    "Without this card, an agent may dispatch through an unverified pane identity.";
  const texts = [trigger, memory, consequence, counterfactual];
  const claims = texts.map((text, index) => claim(seed + index, text));
  return {
    evidence: [transcriptEvidence(seed, "private", scope)],
    matchedClaims: [{ _tag: "Active", claimId: claims[0]?.claimId }],
    rank,
    reflection: {
      cardId: hex(seed + 0x5000),
      cardSchemaVersion: 1,
      claims,
      consequence,
      counterfactual,
      derivation: DERIVATION,
      evidence: [transcriptEvidence(seed, "private", scope)],
      kind: "Constraint",
      memory,
      observedAt: "2026-08-21T10:00:00.000Z",
      privacy: "private",
      reflectionId: `reflection:v2:${hex(seed)}`,
      relations: [],
      reviewAttestationId: hex(seed + 0x6000),
      rubricDigest: hex(seed + 0x7000),
      schemaVersion: 2,
      scope,
      sourceObservationIds: [`observation:v2:${hex(supportSeed)}`],
      status: "active",
      trigger,
      type: "reflection",
      validFrom: "2026-08-21T09:10:00.000Z",
      validThrough: "2026-08-21T09:20:00.000Z",
    },
    score: 0.9,
    supportingObservations: [support],
  };
}

export interface ObservationHitFixtureOptions {
  readonly seed: number;
  readonly rank: number;
  readonly score?: number;
  readonly privacy?: Privacy;
  readonly scope?: { project: string; workstream: string };
}

export function observationHitWire(options: ObservationHitFixtureOptions): Record<string, unknown> {
  const privacy = options.privacy ?? "private";
  return {
    evidence: [transcriptEvidence(options.seed, privacy, scopeWire(options.scope))],
    observation: observationWire({
      seed: options.seed,
      privacy,
      ...(options.scope ? { scope: options.scope } : {}),
    }),
    rank: options.rank,
    score: options.score ?? 0.5,
  };
}

/** A complete canonical migration-only legacy hit. It must never reach a lane. */
export function legacyHitWire(seed: number, rank: number): Record<string, unknown> {
  return {
    descriptor: {
      _tag: "SessionEpoch",
      bodyHash: hex(seed + 0x2000),
      endedAt: "2026-08-20T12:00:00.000Z",
      privacy: "private",
      projectHints: [TEST_PROJECT],
      schemaVersion: 1,
      sessionId: `session-${seed}`,
      sourceHash: hex(seed + 0x3000),
      sourceRef: `legacy-source-${seed}`,
      startedAt: "2026-08-20T11:00:00.000Z",
      type: "observation",
    },
    payloadHash: hex(seed + 0x4000),
    rank,
    redaction: REDACTION_CLEAN,
    resolvedScope: scopeWire(),
    score: 0.4,
    snippet: `legacy snippet ${seed}`,
    title: `legacy title ${seed}`,
  };
}

export interface FlowingSuccessOptions {
  readonly request?: ComposedRecallRequestV1;
  readonly cardCount?: number;
  readonly reflectionCount?: number;
  readonly observationCount?: number;
  readonly legacyCount?: number;
  readonly health?: Record<string, unknown>;
  readonly privacy?: Privacy;
  readonly scope?: { project: string; workstream: string };
  readonly evidencePrivacy?: Privacy;
  readonly evidenceScope?: { project: string; workstream: string };
  readonly query?: Record<string, unknown>;
}

export const HEALTHY_WIRE = {
  _tag: "Healthy",
  builtAt: "2026-08-22T00:00:00.000Z",
  freshAt: "2026-08-22T00:05:00.000Z",
  sourceSnapshotHash: hex(0xabc),
};

/** One encoded `FlowingMemoryReadSuccessV2` exactly as the read boundary emits it. */
export function flowingSuccessEnvelope(
  options: FlowingSuccessOptions = {},
): Record<string, unknown> {
  const request = options.request ?? testRequest();
  const shared = {
    ...(options.privacy ? { privacy: options.privacy } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
  };

  const cards = Array.from({ length: options.cardCount ?? 0 }, (_unused, index) =>
    cardReflectionHitWire(index + 0x80, index + 1),
  );
  const reflectionHits = [
    ...cards,
    ...Array.from({ length: options.reflectionCount ?? 2 }, (_unused, index) =>
      reflectionHitWire({
        seed: index + 1,
        rank: cards.length + index + 1,
        score: 0.9 - index * 0.1,
        ...shared,
        ...(options.evidencePrivacy ? { evidencePrivacy: options.evidencePrivacy } : {}),
        ...(options.evidenceScope ? { evidenceScope: options.evidenceScope } : {}),
      }),
    ),
  ];

  const observationHits = Array.from({ length: options.observationCount ?? 1 }, (_unused, index) =>
    observationHitWire({ seed: index + 0x20, rank: index + 1, ...shared }),
  );

  const legacyHits = Array.from({ length: options.legacyCount ?? 0 }, (_unused, index) =>
    legacyHitWire(index + 0x40, index + 1),
  );

  return {
    _tag: "FlowingMemoryReadSuccessV2",
    result: {
      _tag: "MemorySearchResultV2",
      health: options.health ?? HEALTHY_WIRE,
      legacyHits,
      observationHits,
      query: options.query ?? flowingQueryWire(request),
      reflectionHits,
      schemaVersion: 2,
    },
    schemaVersion: 2,
  };
}

export function flowingUnavailableEnvelope(
  code: "invalid-input" | "store-unavailable" | "contract-violation",
  message: string,
): Record<string, unknown> {
  return { _tag: "FlowingMemoryReadUnavailableV2", code, message, schemaVersion: 2 };
}

function curatedHit(overrides: Partial<CriticalSearchHit> = {}): CriticalSearchHit {
  return {
    id: "brain-1",
    collection: "brain_pages",
    type: "brain",
    title: "Postgres search index",
    content: "body text that must never reach a receipt",
    source: "brain",
    sourceKey: "brain",
    path: "/Users/joel/Code/joelhooks/joelclaw-memory/.brain/x.svx",
    privacy: "private",
    createdAt: 1_700_000_000,
    rank: -3.2,
    score: 3.2,
    snippet: "postgres <mark>search</mark> index",
    sourceFreshness: {
      sourceKey: "brain",
      highWaterAt: null,
      ageSeconds: null,
      status: "ok",
      documentAgeSeconds: null,
    },
    ...overrides,
  } as CriticalSearchHit;
}

export function curatedSearchResult(hits: Partial<CriticalSearchHit>[]): CriticalSearchResult {
  return {
    dbPath: "/tmp/fake-critical.db",
    hits: hits.map((hit) => curatedHit(hit)),
    found: hits.length,
    freshness: {
      builtAt: "2026-08-22T00:00:00.000Z",
      ageSeconds: 60,
      newestSourceAt: null,
      sourceAgeSeconds: null,
      documentCount: hits.length,
      status: "ok",
      sources: {},
      coverageGaps: [],
    },
    durationMs: 1.5,
    servedBy: {
      name: "test-local",
      kind: "local",
      endpoint: "/tmp/fake-critical.db",
      checkedAt: "2026-08-22T00:00:00.000Z",
      syncCheckAgeSeconds: 0,
      replicaLagSeconds: 0,
    },
  };
}

export const TEST_SECRET = "postgres://reader:super-secret-token@example.invalid/flowing";

export interface TestRelease {
  readonly root: string;
  readonly releaseDir: string;
  readonly executable: string;
  readonly manifestPath: string;
  readonly sha256: string;
}

export interface TestReleaseOptions {
  /** Defaults to the pinned commit. Pass another to build a wrong-commit release. */
  readonly memoryCommit?: string;
  /** Defaults to the artifact's real digest. Pass another to break the binding. */
  readonly declaredSha256?: string;
  readonly artifactKind?: "standalone" | "script" | "library";
  /** Omit the artifact from the manifest entirely. */
  readonly unmanifested?: boolean;
  readonly executableMode?: number;
  readonly releaseDirMode?: number;
  readonly manifestMode?: number;
  readonly body?: string;
  readonly releaseName?: string;
}

/**
 * Builds a temporary release directory with a manifest beside it. Nothing here
 * is executed; the tests that use it stub the process boundary. It exists so a
 * test can prove the manifest binding without a real 100 MB standalone build.
 */
export function testRelease(options: TestReleaseOptions = {}): TestRelease {
  const root = mkdtempSync(join(tmpdir(), "flowing-releases-"));
  // The directory name holds a space on purpose: a config reader that splits a
  // path on whitespace fails loudly here instead of in production.
  const releaseDir = join(root, options.releaseName ?? "2026-08-22 build");
  mkdirSync(releaseDir, { recursive: true });

  const executable = join(releaseDir, "joelclaw-memory");
  const body = options.body ?? "#!/bin/sh\nexit 0\n";
  writeFileSync(executable, body);
  chmodSync(executable, options.executableMode ?? 0o555);
  const sha256 = createHash("sha256").update(body).digest("hex");

  const manifestPath = join(releaseDir, FLOWING_RELEASE_MANIFEST_FILENAME);
  writeFileSync(
    manifestPath,
    JSON.stringify({
      _tag: "FlowingMemoryReleaseManifestV2",
      artifacts: options.unmanifested
        ? [{ kind: "library", path: "unrelated.js", sha256: hex(9) }]
        : [
            {
              kind: options.artifactKind ?? "standalone",
              path: "joelclaw-memory",
              sha256: options.declaredSha256 ?? sha256,
            },
          ],
      memoryCommit: options.memoryCommit ?? PINNED_MEMORY_COMMIT,
      releasedAt: "2026-08-22T00:00:00.000Z",
      schemaVersion: FLOWING_RELEASE_MANIFEST_SCHEMA_VERSION,
    }),
  );
  chmodSync(manifestPath, options.manifestMode ?? 0o444);
  // Last: the directory is sealed once its contents exist.
  chmodSync(releaseDir, options.releaseDirMode ?? 0o555);

  return { root, releaseDir, executable, manifestPath, sha256 };
}

function identityOf(path: string) {
  const stat = statSync(path);
  return { dev: stat.dev, ino: stat.ino };
}

/**
 * Opens a sealed release directory, runs a mutation, and seals it again — the
 * way anyone with write access to the parent would.
 */
export function withUnsealedRelease<T>(releaseDir: string, mutate: () => T): T {
  chmodSync(releaseDir, 0o755);
  try {
    return mutate();
  } finally {
    chmodSync(releaseDir, 0o555);
  }
}

/** A resolved port config bound to a real temporary signed release. */
export function testFlowingConfig(release: TestRelease) {
  return {
    readExecutable: release.executable,
    readArgs: FLOWING_READ_ARGS,
    credentialSecretName: "flowing-runtime-url",
    credentialFormat: "raw" as const,
    timeoutMs: 1_000,
    release: {
      manifestPath: release.manifestPath,
      releaseDir: release.releaseDir,
      artifactPath: release.executable,
      memoryCommit: PINNED_MEMORY_COMMIT,
      artifactIdentity: identityOf(release.executable),
      manifestIdentity: identityOf(release.manifestPath),
      releaseDirIdentity: identityOf(release.releaseDir),
      sha256: release.sha256,
      expectedSha256: release.sha256,
    },
  };
}

/**
 * The two test-only seams every fixture release needs. A temporary release can
 * never carry the anchored production digest, so tests state the digest they
 * built and production keeps the anchored one.
 */
export function testReleaseSeams(release: TestRelease) {
  return {
    trustedReleaseRoot: release.root,
    expectedArtifactSha256: release.sha256,
  };
}

/** One shared signed release for tests that only need a valid, trusted config. */
export const TEST_RELEASE = testRelease();
export const TEST_FLOWING_CONFIG = testFlowingConfig(TEST_RELEASE);
