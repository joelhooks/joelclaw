/**
 * Offline recall comparison.
 *
 * Calls three retrieval paths for one exact scope and access decision, then
 * writes one private schema-versioned receipt:
 *
 * 1. the CLI SQLite-first current adapter (`recall:typesense-recall` in this package);
 * 2. the SDK in-process Typesense adapter (`recall:typesense-recall` in `@joelclaw/sdk`);
 * 3. the registered `recall:flowing-memory-recall` adapter, resolved through
 *    normal capability config so its configured settings actually reach it.
 *
 * It is offline in the sense that it is never on a request path and never
 * changes a binding. It reads production stores; it writes nothing to them.
 *
 * The receipt is written for a blind operator: someone who can judge the run
 * without ever seeing the question that was asked. It records identity,
 * ordering, health, evidence coverage, overlap, and two explicit verdicts. It
 * never records the query text, the principal or purpose bodies, transcript or
 * page bodies, backend diagnostics, file paths, endpoints, replica or host
 * names, credentials, or environment dumps.
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { typesenseRecallAdapter as sdkTypesenseRecallAdapter } from "@joelclaw/sdk";
import { Effect } from "effect";
import { FLOWING_MEMORY_RECALL_ADAPTER } from "../capabilities/adapters/flowing-memory-recall";
import { typesenseRecallAdapter as cliRecallAdapter } from "../capabilities/adapters/typesense-recall";
import { resolveCapabilitiesConfig } from "../capabilities/config";
import type { AnyCapabilityPort, CapabilityContext } from "../capabilities/contract";
import { capabilityRegistry } from "../capabilities/setup";
import {
  type ComposedRecallRequestV1,
  type ComposedRecallResultV1,
  decodeComposedRecallResult,
  LANE_FIELDS,
  LANE_LIMIT_KEY,
  LANE_SCORE_SCALE,
  type RecallLaneItemV1,
  type RecallLaneName,
} from "./contract";

export const RECALL_COMPARISON_SCHEMA_VERSION = 1 as const;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/**
 * An opaque correlation label. Short, no whitespace, no path separators, no
 * punctuation a question or a filesystem path would need. A caller that passes
 * its query here gets a hash instead of a stored body.
 */
/** What the CLI accepts on `--case-id`. Not what a receipt stores. */
export const CASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** What a receipt stores. Opaque hex, and only opaque hex. */
export const RECEIPT_CASE_ID_PATTERN = /^case-[a-f0-9]{16,64}$/u;

export function isValidCaseId(value: string): boolean {
  return CASE_ID_PATTERN.test(value);
}

/**
 * Domain separators. A supplied label and a derived-from-query key must never
 * collide, and neither hash may be reversed into the other's input space.
 */
const SUPPLIED_CASE_DOMAIN = "recall-compare/case-id:";
const REJECTED_CASE_DOMAIN = "recall-compare/rejected-case-id:";
const QUERY_CASE_DOMAIN = "recall-compare/query:";

/**
 * A stored case ID is always opaque hex. Even a caller-supplied label that the
 * CLI accepted is hashed rather than copied: `--case-id` is short free text, and
 * short free text is exactly where a question, a customer name, or a path
 * fragment gets typed. The hash is stable, so two runs of the same label still
 * correlate; the label itself never lands on disk.
 */
export function safeCaseId(supplied: string | undefined, queryText: string): string {
  const trimmed = supplied?.trim();
  if (!trimmed) return `case-${sha256(`${QUERY_CASE_DOMAIN}${queryText}`).slice(0, 32)}`;
  const domain = isValidCaseId(trimmed) ? SUPPLIED_CASE_DOMAIN : REJECTED_CASE_DOMAIN;
  return `case-${sha256(`${domain}${trimmed}`).slice(0, 32)}`;
}

/**
 * A thrown `.code` is attacker-adjacent text: it comes from whatever library
 * failed, and libraries put paths, URLs, customer names, and query fragments in
 * it. A shape rule is not enough — `RECALL_CUSTOMER_SECRET_ALPHA` looks exactly
 * like a house code. So this is an exact set of codes these paths are known to
 * emit. Every other string becomes `UNKNOWN`, which is a true statement about
 * what we know.
 */
const KNOWN_FAILURE_CODES: ReadonlySet<string> = new Set([
  // Composed recall adapter.
  "COMPOSED_RECALL_FAILED",
  "COMPOSED_RECALL_INVALID_ARGS",
  "COMPOSED_RECALL_SCOPE_REQUIRED",
  // Capability registry and the old recall adapters.
  "CAPABILITY_ADAPTER_UNKNOWN",
  "CAPABILITY_UNKNOWN",
  "RECALL_BACKEND_UNAVAILABLE",
  "RECALL_CATEGORY_UNSUPPORTED",
  "RECALL_INVALID_ARGS",
  "RECALL_SUBCOMMAND_UNSUPPORTED",
  "TYPESENSE_UNREACHABLE",
  // Node and SQLite failures these paths actually surface.
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOENT",
  "ENOTFOUND",
  "EACCES",
  "EPERM",
  "ETIMEDOUT",
  "SQLITE_BUSY",
  "SQLITE_CANTOPEN",
  "SQLITE_CORRUPT",
  "SQLITE_NOTADB",
  "SQLITE_READONLY",
  // Process boundary outcomes.
  "SIGKILL",
  "SIGTERM",
]);

export const UNKNOWN_CODE = "UNKNOWN";

export function safeFailureCode(value: unknown): string {
  if (typeof value !== "string") return UNKNOWN_CODE;
  return KNOWN_FAILURE_CODES.has(value.trim()) ? value.trim() : UNKNOWN_CODE;
}

/** The freshness vocabulary the old recall adapters actually emit. */
export const FRESHNESS_STATUSES = [
  "ok",
  "fresh",
  "degraded",
  "stale",
  "unavailable",
  "unknown",
] as const;

export function safeFreshnessStatus(value: unknown): string {
  if (typeof value !== "string") return UNKNOWN_CODE;
  const normalised = value.trim().toLowerCase();
  return (FRESHNESS_STATUSES as readonly string[]).includes(normalised)
    ? normalised
    : UNKNOWN_CODE;
}

/**
 * Backend names can carry a host, a replica label, or a URL. The receipt keeps
 * only the kind of store that answered.
 */
export type BackendKind = "sqlite" | "typesense" | "memory" | "unavailable" | "other";

export function backendKindOf(value: unknown): BackendKind {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (!text) return "other";
  if (text.includes("unavailable")) return "unavailable";
  if (text.includes("sqlite") || text.includes("fts")) return "sqlite";
  if (text.includes("typesense")) return "typesense";
  if (text.includes("memory")) return "memory";
  return "other";
}

export interface OldBackendHitRecord {
  readonly rank: number;
  readonly id: string;
  readonly kind: string;
  readonly score: number;
  readonly privacy: string;
  /**
   * A heuristic, and labelled as one. Old recall carries no project/workstream,
   * so scope is inferred from the document path. `unknown` is a real answer.
   * The path itself is never recorded.
   */
  readonly scopeAssessment: "in-scope" | "out-of-scope" | "unknown";
}

export interface OldBackendRecord {
  readonly caller: "cli-sqlite-first" | "sdk-in-process-typesense";
  readonly adapter: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly backendKind: BackendKind;
  /** Typed code only. Backend messages can carry private filesystem paths. */
  readonly failureCode?: string;
  readonly freshnessStatus?: string;
  readonly hits: readonly OldBackendHitRecord[];
  readonly duplicateIdCount: number;
  readonly outOfScopeHitCount: number;
  readonly unknownScopeHitCount: number;
}

export interface ComposedLaneHealthRecord {
  readonly status: string;
  readonly builtAt?: string;
  readonly freshAt?: string;
  readonly staleSince?: string;
  readonly sourceSnapshotHash?: string;
  /** Opaque producer receipt for a failed projection. Content-free by contract. */
  readonly failureReceiptId?: string;
  readonly lastValidSnapshotHash?: string;
}

export interface ComposedLaneRecord {
  readonly lane: RecallLaneName;
  readonly available: boolean;
  readonly source: string;
  readonly scoreScale?: string;
  readonly health?: ComposedLaneHealthRecord;
  /** Typed code only. The lane's human message is deliberately not stored. */
  readonly unavailableCode?: string;
  readonly items: ReadonlyArray<{
    readonly rank: number;
    readonly id: string;
    readonly kind: string;
    readonly score: number;
    readonly privacy: string;
    readonly scopeBinding: string;
    readonly project: string;
    readonly workstream: string;
    readonly evidenceIds: readonly string[];
  }>;
  readonly duplicateIdCount: number;
  readonly evidenceIdCount: number;
  readonly itemsMissingEvidence: number;
}

export interface ContractVerdict {
  readonly status: "pass" | "fail" | "unjudged";
  /** Stable reason codes, never free-form backend text. */
  readonly reasons: readonly string[];
}

export interface UsefulnessVerdict {
  /**
   * Always `unjudged`. Whether one lane answered a question better than another
   * is a human call. The metrics below are what that human needs.
   */
  readonly status: "unjudged";
  readonly metrics: {
    readonly composedItemCount: number;
    readonly composedLanesAvailable: number;
    readonly composedLanesUnavailable: number;
    readonly composedDistinctIds: number;
    readonly flowingItemCount: number;
    readonly flowingItemsWithEvidence: number;
    readonly flowingItemsMissingEvidence: number;
    readonly distinctEvidenceIds: number;
    readonly curatedItemCount: number;
    readonly cliHitCount: number;
    readonly sdkHitCount: number;
    readonly oldOutOfScopeHitCount: number;
    readonly oldUnknownScopeHitCount: number;
    readonly oldDuplicateIdCount: number;
  };
}

export interface RecallComparisonReceipt {
  readonly _tag: "RecallComparisonReceiptV1";
  readonly schemaVersion: typeof RECALL_COMPARISON_SCHEMA_VERSION;
  readonly createdAt: string;
  /** Correlates this receipt with the case that motivated it. Never the query. */
  readonly caseId: string;
  readonly request: {
    readonly querySha256: string;
    readonly queryLength: number;
    readonly scope: { readonly project: string; readonly workstream: string };
    readonly access: {
      readonly principalRefSha256: string;
      readonly purposeSha256: string;
      readonly decidedAt: string;
      readonly allowedPrivacy: readonly string[];
    };
    readonly includeSuperseded: boolean;
    readonly limits: ComposedRecallRequestV1["limits"];
  };
  readonly old: readonly OldBackendRecord[];
  readonly composed: {
    readonly ok: boolean;
    readonly adapter: string;
    readonly failureCode?: string;
    readonly timings?: {
      readonly flowingMs: number;
      readonly curatedMs: number;
      readonly totalMs: number;
    };
    readonly curatedBackendKind?: BackendKind;
    readonly lanes: readonly ComposedLaneRecord[];
    readonly unavailableLanes: readonly string[];
  };
  readonly overlap: {
    readonly cliVsSdkSharedIds: number;
    readonly cliOnlyIds: number;
    readonly sdkOnlyIds: number;
    readonly composedVsCliSharedIds: number;
    readonly composedVsSdkSharedIds: number;
    readonly composedOnlyIds: number;
  };
  readonly contractCorrect: ContractVerdict;
  readonly useful: UsefulnessVerdict;
}

type OldRecallArgs = {
  query: string;
  limit: number;
  minScore: number;
  raw: boolean;
  includeHold: boolean;
  includeDiscard: boolean;
  budget: string;
  category: string;
};

/** Old recall vocabulary lives here and nowhere else. The new contract never sees it. */
function oldArgsFor(request: ComposedRecallRequestV1): OldRecallArgs {
  return {
    query: request.text,
    limit: Math.max(request.limits.curated, request.limits.reflections),
    minScore: 0,
    raw: false,
    includeHold: false,
    includeDiscard: false,
    budget: "auto",
    category: "",
  };
}

function assessScope(path: unknown, project: string): OldBackendHitRecord["scopeAssessment"] {
  if (typeof path !== "string" || path.length === 0) return "unknown";
  const segments = project.split(".").filter(Boolean);
  const repository = segments[segments.length - 1];
  if (!repository) return "unknown";
  return path.toLowerCase().includes(repository.toLowerCase()) ? "in-scope" : "out-of-scope";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function readOldHits(payload: Record<string, unknown>, project: string): OldBackendHitRecord[] {
  const hits = Array.isArray(payload.hits) ? payload.hits : [];
  return hits.map((raw, index) => {
    const hit = asRecord(raw);
    return {
      rank: index + 1,
      id: typeof hit.id === "string" ? hit.id : `unknown-${index + 1}`,
      kind:
        typeof hit.collection === "string"
          ? hit.collection
          : typeof hit.type === "string"
            ? hit.type
            : "unknown",
      score: typeof hit.score === "number" ? hit.score : 0,
      privacy: typeof hit.privacy === "string" ? hit.privacy : "unknown",
      scopeAssessment: assessScope(hit.path, project),
    };
  });
}

function duplicateCount(ids: readonly string[]): number {
  return ids.length - new Set(ids).size;
}

export interface OldBackendCaller {
  readonly caller: OldBackendRecord["caller"];
  readonly adapter: string;
  readonly run: (args: OldRecallArgs, context: CapabilityContext) => Promise<unknown>;
}

/** Production wiring: the two adapters that actually serve recall today. */
export function productionOldBackends(): readonly OldBackendCaller[] {
  const cli = cliRecallAdapter as AnyCapabilityPort;
  const sdk = sdkTypesenseRecallAdapter as unknown as AnyCapabilityPort;
  return [
    {
      caller: "cli-sqlite-first",
      adapter: cli.adapter,
      run: (args, context) => Effect.runPromise(cli.execute("query", args, context)),
    },
    {
      caller: "sdk-in-process-typesense",
      adapter: sdk.adapter,
      run: (args, context) => Effect.runPromise(sdk.execute("query", args, context)),
    },
  ];
}

async function runOldBackend(
  caller: OldBackendCaller,
  request: ComposedRecallRequestV1,
  context: CapabilityContext,
): Promise<OldBackendRecord> {
  const startedAt = Date.now();
  try {
    const raw = await caller.run(oldArgsFor(request), context);
    const payload = asRecord(asRecord(raw).payload);
    const hits = readOldHits(payload, request.scope.project);
    const freshness = asRecord(payload.freshness);
    return {
      caller: caller.caller,
      adapter: caller.adapter,
      ok: true,
      durationMs: Date.now() - startedAt,
      backendKind: backendKindOf(payload.backend),
      ...(freshness.status === undefined
        ? {}
        : { freshnessStatus: safeFreshnessStatus(freshness.status) }),
      hits,
      duplicateIdCount: duplicateCount(hits.map((hit) => hit.id)),
      outOfScopeHitCount: hits.filter((hit) => hit.scopeAssessment === "out-of-scope").length,
      unknownScopeHitCount: hits.filter((hit) => hit.scopeAssessment === "unknown").length,
    };
  } catch (error) {
    const failure = asRecord(error);
    return {
      caller: caller.caller,
      adapter: caller.adapter,
      ok: false,
      durationMs: Date.now() - startedAt,
      backendKind: "unavailable",
      failureCode: safeFailureCode(failure.code),
      hits: [],
      duplicateIdCount: 0,
      outOfScopeHitCount: 0,
      unknownScopeHitCount: 0,
    };
  }
}

export interface ComposedRunOutcome {
  readonly result: ComposedRecallResultV1;
  readonly timings: {
    readonly flowingMs: number;
    readonly curatedMs: number;
    readonly totalMs: number;
  };
  readonly curatedBackend: string;
}

export type ComposedRunner = (request: ComposedRecallRequestV1) => Promise<ComposedRunOutcome>;

export interface RegisteredComposedRunnerOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly now?: Date;
  /** Test seam: an adapter instance built with fake process boundaries. */
  readonly port?: AnyCapabilityPort;
}

/**
 * The production path. It resolves normal capability config — defaults, user
 * TOML, project TOML, environment, in the usual precedence — and hands that
 * config to the registered `flowing-memory-recall` port, so whatever is
 * configured for that adapter is what runs. Nothing here constructs a composer
 * directly.
 */
export function registeredComposedRunner(
  options: RegisteredComposedRunnerOptions = {},
): ComposedRunner {
  return async (request) => {
    const cwd = options.cwd ?? process.cwd();
    const config = resolveCapabilitiesConfig({
      cwd,
      ...(options.env ? { env: options.env } : {}),
    });
    const port =
      options.port ?? capabilityRegistry.get("recall", FLOWING_MEMORY_RECALL_ADAPTER);
    if (!port) {
      throw new Error(`capability adapter recall:${FLOWING_MEMORY_RECALL_ADAPTER} is not registered`);
    }

    const raw = await Effect.runPromise(
      port.execute(
        "query",
        {
          allowedPrivacy: [...request.access.allowedPrivacy],
          curatedLimit: request.limits.curated,
          decidedAt: request.access.decidedAt,
          includeSuperseded: request.includeSuperseded,
          observationLimit: request.limits.observations,
          principalRef: request.access.principalRef,
          project: request.scope.project,
          purpose: request.access.purpose,
          query: request.text,
          reflectionLimit: request.limits.reflections,
          workstream: request.scope.workstream,
        },
        { cwd, now: options.now ?? new Date(), config },
      ),
    );

    const payload = asRecord(asRecord(raw).payload);
    const timings = asRecord(payload.timings);
    return {
      result: decodeComposedRecallResult(payload.composed),
      timings: {
        flowingMs: typeof timings.flowingMs === "number" ? timings.flowingMs : 0,
        curatedMs: typeof timings.curatedMs === "number" ? timings.curatedMs : 0,
        totalMs: typeof timings.totalMs === "number" ? timings.totalMs : 0,
      },
      curatedBackend: typeof payload.curatedBackend === "string" ? payload.curatedBackend : "",
    };
  };
}

function healthRecord(
  health: Extract<
    ComposedRecallResultV1["lanes"]["curatedPages"],
    { _tag: "RecallLaneAvailableV1" }
  >["health"],
): ComposedLaneHealthRecord {
  switch (health._tag) {
    case "Healthy":
      return {
        status: "Healthy",
        builtAt: health.builtAt,
        ...(health.freshAt ? { freshAt: health.freshAt } : {}),
        ...(health.sourceSnapshotHash ? { sourceSnapshotHash: health.sourceSnapshotHash } : {}),
      };
    case "Stale":
      return {
        status: "Stale",
        ...(health.builtAt ? { builtAt: health.builtAt } : {}),
        ...(health.freshAt ? { freshAt: health.freshAt } : {}),
        ...(health.staleSince ? { staleSince: health.staleSince } : {}),
        ...(health.sourceSnapshotHash ? { sourceSnapshotHash: health.sourceSnapshotHash } : {}),
      };
    case "Failed":
      return {
        status: "Failed",
        ...(health.failureReceiptId ? { failureReceiptId: health.failureReceiptId } : {}),
        ...(health.lastValidSnapshotHash
          ? { lastValidSnapshotHash: health.lastValidSnapshotHash }
          : {}),
      };
    default:
      return { status: "Unknown" };
  }
}

function laneRecords(result: ComposedRecallResultV1): ComposedLaneRecord[] {
  return LANE_FIELDS.map(([field, lane]) => {
    const value = result.lanes[field];
    if (value._tag === "RecallLaneUnavailableV1") {
      return {
        lane,
        available: false,
        source: value.source,
        unavailableCode: value.code,
        items: [],
        duplicateIdCount: 0,
        evidenceIdCount: 0,
        itemsMissingEvidence: 0,
      };
    }
    const items = value.items.map((item: RecallLaneItemV1) => ({
      rank: item.rank,
      id: item.id,
      kind: item.kind,
      score: item.score,
      privacy: item.privacy,
      scopeBinding: item.scopeBinding,
      project: item.scope.project,
      workstream: item.scope.workstream,
      evidenceIds: item.evidenceIds,
    }));
    return {
      lane,
      available: true,
      source: value.source,
      scoreScale: value.scoreScale,
      health: healthRecord(value.health),
      items,
      duplicateIdCount: duplicateCount(items.map((item) => item.id)),
      evidenceIdCount: items.reduce((total, item) => total + item.evidenceIds.length, 0),
      itemsMissingEvidence: items.filter((item) => item.evidenceIds.length === 0).length,
    };
  });
}

/**
 * A structural verdict a blind operator can trust: every check reads IDs, ranks,
 * counts, scopes, and privacy tiers, and every failure is a stable code.
 */
export function evaluateContractCorrectness(
  result: ComposedRecallResultV1,
  request: ComposedRecallRequestV1,
): ContractVerdict {
  const reasons: string[] = [];
  const allowed = new Set<string>(request.access.allowedPrivacy);

  if (
    result.resolvedScope.project !== request.scope.project ||
    result.resolvedScope.workstream !== request.scope.workstream
  ) {
    reasons.push("resolved-scope-differs-from-request");
  }
  if (
    result.resolvedAccess.principalRef !== request.access.principalRef ||
    result.resolvedAccess.purpose !== request.access.purpose ||
    result.resolvedAccess.decidedAt !== request.access.decidedAt
  ) {
    reasons.push("resolved-access-differs-from-request");
  }

  let availableLanes = 0;
  for (const [field, lane] of LANE_FIELDS) {
    const value = result.lanes[field];
    if (value._tag !== "RecallLaneAvailableV1") continue;
    availableLanes += 1;

    const items = value.items;
    if (items.length > request.limits[LANE_LIMIT_KEY[lane]]) {
      reasons.push(`${lane}:over-requested-limit`);
    }
    if (!items.every((item, index) => item.rank === index + 1)) {
      reasons.push(`${lane}:rank-not-sequential-from-one`);
    }
    if (duplicateCount(items.map((item) => item.id)) > 0) {
      reasons.push(`${lane}:duplicate-id`);
    }
    if (!items.every((item) => allowed.has(item.privacy))) {
      reasons.push(`${lane}:privacy-outside-grant`);
    }
    if (
      !items.every(
        (item) =>
          item.scope.project === request.scope.project &&
          item.scope.workstream === request.scope.workstream,
      )
    ) {
      reasons.push(`${lane}:record-scope-outside-request`);
    }
    if (value.scoreScale !== LANE_SCORE_SCALE[lane]) {
      reasons.push(`${lane}:wrong-score-scale`);
    }
    if (lane !== "curated-pages" && items.some((item) => item.evidenceIds.length === 0)) {
      reasons.push(`${lane}:item-without-evidence`);
    }
  }

  if (availableLanes === 0) {
    return { status: "unjudged", reasons: ["no-lane-available"] };
  }
  return { status: reasons.length === 0 ? "pass" : "fail", reasons };
}

function overlapOf(old: readonly OldBackendRecord[], composedIds: readonly string[]) {
  const cli = new Set(
    old.find((entry) => entry.caller === "cli-sqlite-first")?.hits.map((hit) => hit.id) ?? [],
  );
  const sdk = new Set(
    old.find((entry) => entry.caller === "sdk-in-process-typesense")?.hits.map((hit) => hit.id) ??
      [],
  );
  const composed = new Set(composedIds);
  const shared = (left: Set<string>, right: Set<string>) =>
    [...left].filter((id) => right.has(id)).length;
  return {
    cliVsSdkSharedIds: shared(cli, sdk),
    cliOnlyIds: [...cli].filter((id) => !sdk.has(id)).length,
    sdkOnlyIds: [...sdk].filter((id) => !cli.has(id)).length,
    composedVsCliSharedIds: shared(composed, cli),
    composedVsSdkSharedIds: shared(composed, sdk),
    composedOnlyIds: [...composed].filter((id) => !cli.has(id) && !sdk.has(id)).length,
  };
}

function usefulnessOf(
  lanes: readonly ComposedLaneRecord[],
  old: readonly OldBackendRecord[],
): UsefulnessVerdict {
  const flowing = lanes.filter((lane) => lane.lane !== "curated-pages");
  const curated = lanes.filter((lane) => lane.lane === "curated-pages");
  const allItems = lanes.flatMap((lane) => lane.items);
  const evidence = new Set(allItems.flatMap((item) => item.evidenceIds));
  const flowingItems = flowing.flatMap((lane) => lane.items);
  const hitsFor = (caller: OldBackendRecord["caller"]) =>
    old.find((entry) => entry.caller === caller)?.hits.length ?? 0;

  return {
    status: "unjudged",
    metrics: {
      composedItemCount: allItems.length,
      composedLanesAvailable: lanes.filter((lane) => lane.available).length,
      composedLanesUnavailable: lanes.filter((lane) => !lane.available).length,
      composedDistinctIds: new Set(allItems.map((item) => item.id)).size,
      flowingItemCount: flowingItems.length,
      flowingItemsWithEvidence: flowingItems.filter((item) => item.evidenceIds.length > 0).length,
      flowingItemsMissingEvidence: flowingItems.filter((item) => item.evidenceIds.length === 0)
        .length,
      distinctEvidenceIds: evidence.size,
      curatedItemCount: curated.flatMap((lane) => lane.items).length,
      cliHitCount: hitsFor("cli-sqlite-first"),
      sdkHitCount: hitsFor("sdk-in-process-typesense"),
      oldOutOfScopeHitCount: old.reduce((total, entry) => total + entry.outOfScopeHitCount, 0),
      oldUnknownScopeHitCount: old.reduce((total, entry) => total + entry.unknownScopeHitCount, 0),
      oldDuplicateIdCount: old.reduce((total, entry) => total + entry.duplicateIdCount, 0),
    },
  };
}

function emptyContext(cwd: string, now: Date): CapabilityContext {
  return {
    cwd,
    now,
    config: { capabilities: {}, paths: { projectConfig: "", userConfig: "" } },
  };
}

export interface RunRecallComparisonInput {
  readonly request: ComposedRecallRequestV1;
  readonly caseId?: string;
  readonly cwd?: string;
  readonly now?: Date;
  readonly oldBackends?: readonly OldBackendCaller[];
  /** Defaults to the registered adapter, resolved through normal config. */
  readonly composed?: ComposedRunner;
}

export async function runRecallComparison(
  input: RunRecallComparisonInput,
): Promise<RecallComparisonReceipt> {
  const now = input.now ?? new Date();
  const cwd = input.cwd ?? process.cwd();
  const context = emptyContext(cwd, now);
  const backends = input.oldBackends ?? productionOldBackends();
  const composedRunner =
    input.composed ?? registeredComposedRunner({ cwd, now });

  const old: OldBackendRecord[] = [];
  for (const backend of backends) {
    old.push(await runOldBackend(backend, input.request, context));
  }

  let composedSection: RecallComparisonReceipt["composed"];
  let lanes: ComposedLaneRecord[] = [];
  let contractCorrect: ContractVerdict = {
    status: "unjudged",
    reasons: ["composed-adapter-failed"],
  };

  try {
    const outcome = await composedRunner(input.request);
    lanes = laneRecords(outcome.result);
    contractCorrect = evaluateContractCorrectness(outcome.result, input.request);
    composedSection = {
      ok: true,
      adapter: FLOWING_MEMORY_RECALL_ADAPTER,
      timings: outcome.timings,
      curatedBackendKind: backendKindOf(outcome.curatedBackend),
      lanes,
      unavailableLanes: outcome.result.unavailable.map((entry) => entry.lane),
    };
  } catch (error) {
    const failure = asRecord(error);
    composedSection = {
      ok: false,
      adapter: FLOWING_MEMORY_RECALL_ADAPTER,
      failureCode: safeFailureCode(failure.code),
      lanes: [],
      unavailableLanes: [...LANE_FIELDS.map(([, lane]) => lane)],
    };
  }

  const composedIds = lanes.flatMap((lane) => lane.items.map((item) => item.id));

  return {
    _tag: "RecallComparisonReceiptV1",
    schemaVersion: RECALL_COMPARISON_SCHEMA_VERSION,
    createdAt: now.toISOString(),
    caseId: safeCaseId(input.caseId, input.request.text),
    request: {
      querySha256: sha256(input.request.text),
      queryLength: input.request.text.length,
      scope: {
        project: input.request.scope.project,
        workstream: input.request.scope.workstream,
      },
      access: {
        principalRefSha256: sha256(input.request.access.principalRef),
        purposeSha256: sha256(input.request.access.purpose),
        decidedAt: input.request.access.decidedAt,
        allowedPrivacy: input.request.access.allowedPrivacy,
      },
      includeSuperseded: input.request.includeSuperseded,
      limits: input.request.limits,
    },
    old,
    composed: composedSection,
    overlap: overlapOf(old, composedIds),
    contractCorrect,
    useful: usefulnessOf(lanes, old),
  };
}

/**
 * A comparison that could not reach a lane or a backend proves nothing, so it
 * must not look like a clean run. The receipt is written either way; the exit
 * code is what tells a script the run was incomplete.
 */
export function comparisonIsComplete(receipt: RecallComparisonReceipt): boolean {
  return (
    receipt.composed.ok &&
    receipt.composed.unavailableLanes.length === 0 &&
    receipt.contractCorrect.status === "pass" &&
    receipt.old.every((entry) => entry.ok)
  );
}

/**
 * Writes the receipt at mode 0600, creating the parent directory at 0700.
 * The write is create-exclusive: an existing receipt is never overwritten and
 * a symlink planted at the path is never followed.
 */
export async function writeRecallComparisonReceipt(
  path: string,
  receipt: RecallComparisonReceipt,
): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
  return path;
}
