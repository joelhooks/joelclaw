/**
 * Curated recall port.
 *
 * Reads only the curated projections in the local `critical.db`: `brain_pages`,
 * `system_knowledge`, and `vault_notes`. It passes an explicit collection list
 * and the exact privacy grant to the existing local search function, so
 * `CRITICAL_COLLECTIONS`, the production database, and current recall behavior
 * stay exactly as they are.
 *
 * This port calls `searchCriticalDb` directly rather than
 * `searchCriticalProjection`. A recall answer under an explicit access decision
 * must not silently come from a remote replica whose staleness and privacy
 * handling this port cannot see.
 *
 * Curated ranking is BM25 from SQLite FTS5. Those scores are meaningless next to
 * the flowing unit-interval scores, which is why the lane declares its own scale.
 */

import {
  type CriticalCollection,
  type CriticalSearchResult,
  searchCriticalDb,
} from "../lib/critical-search";
import {
  type ComposedRecallRequestV1,
  PRIVACY_TIERS,
  type PrivacyTier,
  type RecallLaneHealthV1,
  type RecallLaneItemV1,
  type RecallLaneV1,
  unavailableLane,
} from "./contract";

export const CURATED_RECALL_SOURCE = "critical-db-curated";
export const CURATED_RECALL_BACKEND = "sqlite-fts5";

/** Fixed. The curated lane never widens into operational observation collections. */
export const CURATED_RECALL_COLLECTIONS: readonly CriticalCollection[] = [
  "brain_pages",
  "system_knowledge",
  "vault_notes",
];

export type CuratedSearch = (input: {
  query: string;
  limit?: number;
  collections?: CriticalCollection[];
  privacy?: readonly string[];
  dbPath?: string;
  now?: Date;
}) => CriticalSearchResult;

export interface CuratedRecallReadInput {
  readonly request: ComposedRecallRequestV1;
  readonly search?: CuratedSearch;
}

export interface CuratedRecallReadOutcome {
  readonly lane: RecallLaneV1;
  readonly durationMs: number;
  readonly backend: string;
}

function curatedHealth(result: CriticalSearchResult): RecallLaneHealthV1 {
  switch (result.freshness.status) {
    case "ok":
      return { _tag: "Healthy", builtAt: result.freshness.builtAt };
    case "degraded":
      return {
        _tag: "Stale",
        detail: `curated projection is degraded across ${result.freshness.coverageGaps.length} source gaps`,
      };
    default:
      return {
        _tag: "Stale",
        detail: `curated projection is stale by ${result.freshness.ageSeconds}s`,
      };
  }
}

function normalizePrivacy(
  value: string | undefined,
  allowed: readonly PrivacyTier[],
): PrivacyTier | undefined {
  const candidate = (value ?? "private").trim().toLowerCase();
  const tier = PRIVACY_TIERS.find((entry) => entry === candidate);
  if (!tier) return undefined;
  return allowed.includes(tier) ? tier : undefined;
}

export async function readCuratedRecall(
  input: CuratedRecallReadInput,
): Promise<CuratedRecallReadOutcome> {
  const startedAt = Date.now();
  const search = input.search ?? searchCriticalDb;
  const limit = input.request.limits.curated;

  let result: CriticalSearchResult;
  try {
    result = await search({
      query: input.request.text,
      limit,
      collections: [...CURATED_RECALL_COLLECTIONS],
      privacy: [...input.request.access.allowedPrivacy],
    });
  } catch (error) {
    return {
      lane: unavailableLane(
        "curated-pages",
        CURATED_RECALL_SOURCE,
        "store-unavailable",
        // Typed, bounded, and free of the filesystem paths the underlying
        // error carries. The receipt records the code, never this text.
        error instanceof Error ? error.name : "curated search failed",
      ),
      durationMs: Date.now() - startedAt,
      backend: "unavailable",
    };
  }

  // The SQL predicate already excluded disallowed collections and privacy
  // tiers. This second pass is defense: a projection that ever returns a row
  // outside the grant is dropped here rather than trusted.
  const allowedCollections = new Set<string>(CURATED_RECALL_COLLECTIONS);
  const items: RecallLaneItemV1[] = [];

  for (const hit of result.hits) {
    if (items.length >= limit) break;
    if (!allowedCollections.has(hit.collection)) continue;
    const privacy = normalizePrivacy(hit.privacy, input.request.access.allowedPrivacy);
    if (!privacy) continue;

    items.push({
      evidenceIds: [],
      id: hit.id,
      kind: hit.collection,
      lane: "curated-pages",
      privacy,
      rank: items.length + 1,
      scope: {
        _tag: "ProjectWorkstream",
        project: input.request.scope.project,
        workstream: input.request.scope.workstream,
      },
      // Curated pages carry no project/workstream of their own. The scope on
      // these items is the retrieval scope, not a record property.
      scopeBinding: "retrieval-scope",
      score: hit.score,
      summary: hit.snippet.slice(0, 1_000),
      title: (hit.title || hit.id).slice(0, 200),
    });
  }

  return {
    lane: {
      _tag: "RecallLaneAvailableV1",
      health: curatedHealth(result),
      items,
      lane: "curated-pages",
      scoreScale: "bm25-negated",
      source: CURATED_RECALL_SOURCE,
    },
    durationMs: Date.now() - startedAt,
    backend: CURATED_RECALL_BACKEND,
  };
}
