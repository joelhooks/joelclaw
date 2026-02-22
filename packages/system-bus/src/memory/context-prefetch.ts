import { DECAY_CONSTANT } from "./retrieval";
import * as typesense from "../lib/typesense";

const OBSERVATIONS_COLLECTION = "memory_observations";
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

type PrefetchDoc = {
  id?: unknown;
  observation?: unknown;
  observation_type?: unknown;
  source?: unknown;
  timestamp?: unknown;
  updated_at?: unknown;
};

type RankedMemory = {
  id: string;
  observation: string;
  observationType: string;
  source: string;
  rawScore: number;
  finalScore: number;
};

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toUnixSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) {
      return Math.floor(value / 1000);
    }
    if (value > 1_000_000_000) {
      return Math.floor(value);
    }
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number.parseFloat(value);
    if (Number.isFinite(numeric)) {
      if (numeric > 1_000_000_000_000) {
        return Math.floor(numeric / 1000);
      }
      if (numeric > 1_000_000_000) {
        return Math.floor(numeric);
      }
    }

    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) {
      return Math.floor(parsed.getTime() / 1000);
    }
  }

  return null;
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(value), 1), MAX_LIMIT);
}

function normalizedObservation(doc: PrefetchDoc): string {
  return typeof doc.observation === "string" ? doc.observation.trim() : "";
}

function extractRawScore(hit: typesense.TypesenseHit, rank: number): number {
  const fusionScore = asFiniteNumber(hit.hybrid_search_info?.rank_fusion_score);
  if (fusionScore != null && fusionScore > 0) return fusionScore;

  const textScore = asFiniteNumber(hit.text_match_info?.score);
  if (textScore != null && textScore > 0) {
    return textScore;
  }

  return 1 / (rank + 1);
}

export async function prefetchMemoryContext(
  query: string,
  options?: { limit?: number }
): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) return "";

  const limit = normalizeLimit(options?.limit);
  const perPage = Math.max(limit * 3, limit);
  const includeFields = "id,observation,observation_type,source,timestamp,updated_at";

  try {
    let response: typesense.TypesenseSearchResult;
    try {
      response = await typesense.search({
        collection: OBSERVATIONS_COLLECTION,
        q: trimmed,
        query_by: "embedding,observation",
        vector_query: `embedding:([], k:${perPage}, distance_threshold: 0.5)`,
        per_page: perPage,
        include_fields: includeFields,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/embedded fields|vector query/iu.test(message)) {
        throw error;
      }
      response = await typesense.search({
        collection: OBSERVATIONS_COLLECTION,
        q: trimmed,
        query_by: "observation",
        per_page: perPage,
        include_fields: includeFields,
      });
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const hits = Array.isArray(response.hits) ? response.hits : [];
    const scored: RankedMemory[] = [];

    for (const [index, hit] of hits.entries()) {
      const doc = (hit.document ?? {}) as PrefetchDoc;
      const observation = normalizedObservation(doc);
      if (observation.length === 0) continue;

      const timestamp =
        toUnixSeconds(doc.timestamp) ??
        toUnixSeconds(doc.updated_at) ??
        nowSeconds;
      const daysSinceCreated = Math.max(0, (nowSeconds - timestamp) / 86_400);
      const rawScore = extractRawScore(hit, index);
      const finalScore = rawScore * Math.exp(-DECAY_CONSTANT * daysSinceCreated);

      scored.push({
        id: typeof doc.id === "string" ? doc.id : `idx-${index}`,
        observation,
        observationType:
          typeof doc.observation_type === "string" && doc.observation_type.trim().length > 0
            ? doc.observation_type.trim()
            : "observation_text",
        source:
          typeof doc.source === "string" && doc.source.trim().length > 0
            ? doc.source.trim()
            : "unknown",
        rawScore,
        finalScore,
      });
    }

    if (scored.length === 0) return "";

    scored.sort((a, b) => b.finalScore - a.finalScore);

    const seen = new Set<string>();
    const top: RankedMemory[] = [];
    for (const item of scored) {
      const dedupeKey = item.observation.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      top.push(item);
      if (top.length >= limit) break;
    }

    if (top.length === 0) return "";

    const lines = top.map(
      (item, index) =>
        `${index + 1}. (${item.finalScore.toFixed(3)}) [${item.observationType} | ${item.source}] ${item.observation}`
    );

    return lines.join("\n");
  } catch {
    return "";
  }
}
