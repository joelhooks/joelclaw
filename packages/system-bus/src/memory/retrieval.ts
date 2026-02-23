/**
 * Memory retrieval utilities — ADR-0077 Increment 1
 * Score decay and inject cap for semantic search results.
 */
import { createHash } from "node:crypto";
import { cacheWrap } from "../lib/cache";
import type { TypesenseSearchParams, TypesenseSearchResult } from "../lib/typesense";
import { typesenseRequest } from "../lib/typesense";

/** Decay constant: 0.01 means a fact from 70 days ago gets ~50% weight */
export const DECAY_CONSTANT = 0.01;

/** Maximum memories injected per retrieval */
export const MAX_INJECT = 10;

/** Staleness threshold in days */
export const STALENESS_DAYS = 90;

/** Dedup cosine similarity threshold */
export const DEDUP_THRESHOLD = 0.85;

interface ScoredResult {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
}

/**
 * Apply time-based decay to search results.
 * final_score = raw_score × exp(-DECAY_CONSTANT × days_since_created)
 * Stale results (stale: true in payload) get an additional 0.5 multiplier.
 */
export function applyScoreDecay<T extends ScoredResult>(
  results: T[],
  decayConstant: number = DECAY_CONSTANT,
  now: Date = new Date(),
): (T & { decayedScore: number })[] {
  return results.map((r) => {
    // Memory observations store ISO timestamp in `timestamp` field (set by observe.ts)
    const createdAt = r.payload?.timestamp
      ? new Date(r.payload.timestamp as string)
      : now;
    const daysSince = Math.max(0, (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
    let decayed = r.score * Math.exp(-decayConstant * daysSince);
    if (r.payload?.stale === true) {
      decayed *= 0.5;
    }
    return { ...r, decayedScore: decayed };
  });
}

/**
 * Apply decay, sort by decayed score, and cap at MAX_INJECT.
 */
export function rankAndCap<T extends ScoredResult>(
  results: T[],
  maxInject: number = MAX_INJECT,
  decayConstant: number = DECAY_CONSTANT,
): (T & { decayedScore: number })[] {
  const decayed = applyScoreDecay(results, decayConstant);
  decayed.sort((a, b) => b.decayedScore - a.decayedScore);
  return decayed.slice(0, maxInject);
}

type MultiSearchResponse = {
  results?: Array<{
    found?: unknown;
    hits?: unknown;
    facet_counts?: unknown;
  }>;
};

function normalizeSearchParams(params: TypesenseSearchParams): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    collection: params.collection,
    q: params.q,
    query_by: params.query_by,
    per_page: params.per_page ?? 10,
    exclude_fields: params.exclude_fields ?? "embedding",
  };

  if (params.page != null) normalized.page = params.page;
  if (params.filter_by) normalized.filter_by = params.filter_by;
  if (params.sort_by) normalized.sort_by = params.sort_by;
  if (params.include_fields) normalized.include_fields = params.include_fields;
  if (params.vector_query) normalized.vector_query = params.vector_query;
  if (params.facet_by) normalized.facet_by = params.facet_by;
  if (params.max_facet_values != null) normalized.max_facet_values = params.max_facet_values;

  return normalized;
}

/**
 * Cached Typesense search for memory retrieval.
 * Uses /multi_search so one cache key can represent the full search payload.
 */
export async function searchTypesenseWithCache(
  params: TypesenseSearchParams,
): Promise<TypesenseSearchResult> {
  const search = normalizeSearchParams(params);
  const payload = { searches: [search] };
  const searchJson = JSON.stringify(search);
  const payloadJson = JSON.stringify(payload);
  const cacheKey = createHash("sha256").update(searchJson).digest("hex");

  return cacheWrap<TypesenseSearchResult>(
    cacheKey,
    {
      namespace: "typesense",
      tier: "hot",
      hotTtlSeconds: 300,
    },
    async () => {
      const response = await typesenseRequest("/multi_search", {
        method: "POST",
        body: payloadJson,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Typesense multi_search failed (${response.status}): ${text}`);
      }

      const body = (await response.json()) as MultiSearchResponse;
      const result = Array.isArray(body.results) ? body.results[0] : undefined;
      const found = typeof result?.found === "number" ? result.found : 0;
      const hits = Array.isArray(result?.hits) ? result.hits : [];
      const facetCounts = Array.isArray(result?.facet_counts) ? result.facet_counts : undefined;

      return {
        found,
        hits: hits as TypesenseSearchResult["hits"],
        ...(facetCounts
          ? { facet_counts: facetCounts as TypesenseSearchResult["facet_counts"] }
          : {}),
      };
    },
  );
}
