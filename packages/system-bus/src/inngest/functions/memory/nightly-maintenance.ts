import { inngest } from "../../client";
import { DEDUP_THRESHOLD, STALENESS_DAYS } from "../../../memory/retrieval";
import * as typesense from "../../../lib/typesense";

const OBSERVATIONS_COLLECTION = "memory_observations";
const PAGE_SIZE = 250;
const SEMANTIC_K = 10;
const SEMANTIC_DISTANCE_THRESHOLD = 0.5;

type ObservationDoc = {
  id: string;
  observation: string;
  timestamp: number;
  merged_count?: number;
  recall_count?: number;
  superseded_by?: string | null;
  updated_at?: string;
};

function getTodayUtcRange(now = new Date()): { startUnix: number; endUnix: number; date: string } {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    startUnix: Math.floor(start.getTime() / 1000),
    endUnix: Math.floor(end.getTime() / 1000),
    date: start.toISOString().slice(0, 10),
  };
}

function getStaleCutoffUnix(now = new Date()): number {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - STALENESS_DAYS);
  return Math.floor(cutoff.getTime() / 1000);
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function normalizeObservationDoc(input: Record<string, unknown>): ObservationDoc | null {
  const id = typeof input.id === "string" ? input.id : null;
  const observation =
    typeof input.observation === "string" ? input.observation.trim() : "";
  const timestamp = asFiniteNumber(input.timestamp, Number.NaN);

  if (!id || !observation || !Number.isFinite(timestamp)) {
    return null;
  }

  const supersededRaw = input.superseded_by;
  const supersededBy =
    typeof supersededRaw === "string"
      ? supersededRaw
      : supersededRaw === null
        ? null
        : undefined;

  return {
    id,
    observation,
    timestamp,
    merged_count: asFiniteNumber(input.merged_count, 1),
    recall_count: asFiniteNumber(input.recall_count, 0),
    superseded_by: supersededBy,
    updated_at: typeof input.updated_at === "string" ? input.updated_at : undefined,
  };
}

async function queryAllObservations(filterBy: string): Promise<ObservationDoc[]> {
  const points: ObservationDoc[] = [];
  let page = 1;

  for (;;) {
    const response = await typesense.search({
      collection: OBSERVATIONS_COLLECTION,
      q: "*",
      query_by: "observation",
      filter_by: filterBy,
      per_page: PAGE_SIZE,
      page,
      include_fields: "id,observation,timestamp,merged_count,recall_count,superseded_by,updated_at",
    });

    const hits = Array.isArray(response.hits) ? response.hits : [];
    for (const hit of hits) {
      const normalized = normalizeObservationDoc((hit.document ?? {}) as Record<string, unknown>);
      if (normalized) points.push(normalized);
    }

    if (hits.length < PAGE_SIZE) break;
    page += 1;
  }

  return points;
}

function normalizeTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/gu, " ")
      .split(/\s+/u)
      .filter((token) => token.length >= 3)
  );
}

function textSimilarity(a: string, b: string): number {
  const left = normalizeTokens(a);
  const right = normalizeTokens(b);
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }

  const union = left.size + right.size - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

function chooseFresherObservationText(current: ObservationDoc, candidate: ObservationDoc): string | null {
  if (candidate.timestamp > current.timestamp) {
    return candidate.observation;
  }
  if (candidate.observation.length > current.observation.length) {
    return candidate.observation;
  }
  return null;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function bulkUpdateDocs(docs: Array<Record<string, unknown>>): Promise<void> {
  if (docs.length === 0) return;
  for (const chunk of chunkArray(docs, 100)) {
    await typesense.bulkImport(OBSERVATIONS_COLLECTION, chunk, "update");
  }
}

export const nightlyMaintenance = inngest.createFunction(
  {
    id: "system/memory-nightly-maintenance",
    name: "Memory Nightly Maintenance",
    concurrency: 1,
  },
  { cron: "0 10 * * *" },
  async ({ step }) => {
    const today = await step.run("scan-today", async () => {
      const { startUnix, endUnix, date } = getTodayUtcRange();
      const points = await queryAllObservations(`timestamp:>=${startUnix} && timestamp:<${endUnix}`);
      return { date, points, scanned: points.length, startUnix, endUnix };
    });

    const mergeResult = await step.run("merge-duplicates", async () => {
      const mergedPointIds = new Set<string>();
      const keeperUpdates: Array<Record<string, unknown>> = [];
      const duplicateUpdates: Array<Record<string, unknown>> = [];
      let merged = 0;

      for (const keeper of today.points) {
        if (mergedPointIds.has(keeper.id)) continue;
        if (keeper.superseded_by) continue;

        const similar = await typesense.search({
          collection: OBSERVATIONS_COLLECTION,
          q: keeper.observation,
          query_by: "observation",
          vector_query: `embedding:([], k:${SEMANTIC_K}, distance_threshold: ${SEMANTIC_DISTANCE_THRESHOLD})`,
          filter_by: `timestamp:>=${today.startUnix} && timestamp:<${today.endUnix}`,
          per_page: SEMANTIC_K,
          include_fields: "id,observation,timestamp,merged_count,recall_count,superseded_by",
        });

        const hits = Array.isArray(similar.hits) ? similar.hits : [];
        let keeperMergeIncrement = 0;
        let fresherObservation: string | null = null;

        for (const hit of hits) {
          const candidate = normalizeObservationDoc((hit.document ?? {}) as Record<string, unknown>);
          if (!candidate) continue;
          if (candidate.id === keeper.id) continue;
          if (mergedPointIds.has(candidate.id)) continue;
          if (candidate.superseded_by) continue;

          const similarity = textSimilarity(keeper.observation, candidate.observation);
          if (similarity < DEDUP_THRESHOLD) continue;

          mergedPointIds.add(candidate.id);
          keeperMergeIncrement += 1;
          merged += 1;

          const fresher = chooseFresherObservationText(keeper, candidate);
          if (fresher) {
            fresherObservation = fresher;
          }

          duplicateUpdates.push({
            id: candidate.id,
            superseded_by: keeper.id,
            updated_at: new Date().toISOString(),
          });
        }

        if (keeperMergeIncrement > 0) {
          keeperUpdates.push({
            id: keeper.id,
            merged_count: asFiniteNumber(keeper.merged_count, 1) + keeperMergeIncrement,
            ...(fresherObservation ? { observation: fresherObservation } : {}),
            updated_at: new Date().toISOString(),
          });
        }
      }

      await bulkUpdateDocs([...keeperUpdates, ...duplicateUpdates]);
      return { merged };
    });

    const staleResult = await step.run("tag-stale", async () => {
      const cutoffUnix = getStaleCutoffUnix();
      const candidates = await queryAllObservations(`timestamp:<${cutoffUnix}`);

      const staleCandidates = candidates.filter((point) => {
        const recallCount = asFiniteNumber(point.recall_count, 0);
        return recallCount === 0;
      });

      await bulkUpdateDocs(
        staleCandidates.map((point) => ({
          id: point.id,
          stale: true,
          stale_tagged_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }))
      );

      return { staleTagged: staleCandidates.length };
    });

    const stats = await step.run("log-stats", async () => {
      const payload = {
        date: today.date,
        scanned: today.scanned,
        merged: mergeResult.merged,
        staleTagged: staleResult.staleTagged,
      };
      console.log(JSON.stringify(payload));
      return payload;
    });

    return {
      status: "ok",
      ...stats,
    };
  }
);
