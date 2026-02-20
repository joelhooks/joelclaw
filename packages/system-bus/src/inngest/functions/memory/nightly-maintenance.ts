import { QdrantClient } from "@qdrant/js-client-rest";
import { inngest } from "../../client";
import { DEDUP_THRESHOLD, STALENESS_DAYS } from "../../../memory/retrieval";

const QDRANT_COLLECTION = "memory_observations";
const QDRANT_HOST = process.env.QDRANT_HOST ?? "localhost";
const QDRANT_PORT = Number.parseInt(process.env.QDRANT_PORT ?? "6333", 10);
const SCROLL_LIMIT = 256;

type QdrantPointId = string | number;

type ObservationPoint = {
  id: QdrantPointId;
  payload?: Record<string, unknown>;
  vector?: unknown;
};

function getQdrantClient(): QdrantClient {
  return new QdrantClient({
    host: QDRANT_HOST,
    port: QDRANT_PORT,
  });
}

function getTodayUtcRange(now = new Date()): { startIso: string; endIso: string; date: string } {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    date: start.toISOString().slice(0, 10),
  };
}

function getStaleCutoffIso(now = new Date()): string {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - STALENESS_DAYS);
  return cutoff.toISOString();
}

function normalizeVector(input: unknown): number[] | null {
  if (Array.isArray(input) && input.every((value) => typeof value === "number")) {
    return input;
  }

  if (!input || typeof input !== "object") return null;
  const values = Object.values(input as Record<string, unknown>);
  for (const value of values) {
    if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
      return value;
    }
  }
  return null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toIsoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function chooseFresherObservationText(
  currentPayload: Record<string, unknown> | undefined,
  duplicatePayload: Record<string, unknown> | undefined
): string | null {
  const currentText =
    typeof currentPayload?.observation === "string" ? currentPayload.observation : null;
  const duplicateText =
    typeof duplicatePayload?.observation === "string" ? duplicatePayload.observation : null;
  if (!duplicateText) return null;

  const currentCreatedAt = toIsoOrNull(currentPayload?.created_at);
  const duplicateCreatedAt = toIsoOrNull(duplicatePayload?.created_at);
  if (duplicateCreatedAt && currentCreatedAt && duplicateCreatedAt > currentCreatedAt) {
    return duplicateText;
  }

  if (!currentText || duplicateText.length > currentText.length) {
    return duplicateText;
  }

  return null;
}

async function updatePayload(pointId: QdrantPointId, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(
    `http://${QDRANT_HOST}:${QDRANT_PORT}/collections/${QDRANT_COLLECTION}/points/payload`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wait: true,
        payload,
        points: [pointId],
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Qdrant payload update failed (${response.status}): ${text}`);
  }
}

async function scrollAllPoints(
  qdrant: QdrantClient,
  filter: Record<string, unknown>,
  withVector: boolean
): Promise<ObservationPoint[]> {
  const points: ObservationPoint[] = [];
  let offset: unknown = undefined;

  while (true) {
    const response = (await qdrant.scroll(QDRANT_COLLECTION, {
      limit: SCROLL_LIMIT,
      offset,
      with_payload: true,
      with_vector: withVector,
      filter,
    })) as {
      points?: ObservationPoint[];
      next_page_offset?: unknown;
    };

    const batch = Array.isArray(response.points) ? response.points : [];
    points.push(...batch);

    if (!response.next_page_offset) break;
    offset = response.next_page_offset;
  }

  return points;
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
      const qdrant = getQdrantClient();
      const { startIso, endIso, date } = getTodayUtcRange();
      const points = await scrollAllPoints(
        qdrant,
        {
          must: [
            {
              key: "created_at",
              range: { gte: startIso, lt: endIso },
            },
          ],
        },
        true
      );

      return { date, points, scanned: points.length };
    });

    const mergeResult = await step.run("merge-duplicates", async () => {
      const mergedPointIds = new Set<QdrantPointId>();
      const mergedByKeeper = new Map<
        QdrantPointId,
        { increment: number; fresherObservation?: string }
      >();
      let merged = 0;

      for (let i = 0; i < today.points.length; i += 1) {
        const keeper = today.points[i];
        if (!keeper || mergedPointIds.has(keeper.id)) continue;

        const keeperVector = normalizeVector(keeper.vector);
        if (!keeperVector) continue;

        for (let j = i + 1; j < today.points.length; j += 1) {
          const candidate = today.points[j];
          if (!candidate || mergedPointIds.has(candidate.id)) continue;

          const candidateVector = normalizeVector(candidate.vector);
          if (!candidateVector) continue;

          const similarity = cosineSimilarity(keeperVector, candidateVector);
          if (similarity <= DEDUP_THRESHOLD) continue;

          const existingMerge = mergedByKeeper.get(keeper.id) ?? { increment: 0 };
          existingMerge.increment += 1;

          const fresherText = chooseFresherObservationText(keeper.payload, candidate.payload);
          if (fresherText) {
            existingMerge.fresherObservation = fresherText;
          }
          mergedByKeeper.set(keeper.id, existingMerge);

          mergedPointIds.add(candidate.id);
          merged += 1;
        }
      }

      for (const [keeperId, data] of mergedByKeeper.entries()) {
        const keeperPoint = today.points.find((point) => point.id === keeperId);
        const keeperPayload = keeperPoint?.payload ?? {};
        const mergedCount = asFiniteNumber(keeperPayload.merged_count, 0);
        const payloadUpdate: Record<string, unknown> = {
          merged_count: mergedCount + data.increment,
          updated_at: new Date().toISOString(),
        };
        if (data.fresherObservation) {
          payloadUpdate.observation = data.fresherObservation;
        }
        await updatePayload(keeperId, payloadUpdate);
      }

      return { merged };
    });

    const staleResult = await step.run("tag-stale", async () => {
      const qdrant = getQdrantClient();
      const cutoffIso = getStaleCutoffIso();
      const candidates = await scrollAllPoints(
        qdrant,
        {
          must: [
            {
              key: "created_at",
              range: { lt: cutoffIso },
            },
          ],
        },
        false
      );

      const staleCandidates = candidates.filter((point) => {
        const payload = point.payload ?? {};
        const recallCount = payload.recall_count;
        return recallCount == null || asFiniteNumber(recallCount, 0) === 0;
      });

      for (const point of staleCandidates) {
        await updatePayload(point.id, {
          stale: true,
          stale_tagged_at: new Date().toISOString(),
        });
      }

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
