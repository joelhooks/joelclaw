import { randomUUID } from "node:crypto";
import { inngest } from "../client";
import * as typesense from "../../lib/typesense";
import { pushContentResource } from "../../lib/convex";
import { TAXONOMY_VERSION, classifyObservationCategory, normalizeCategoryId } from "../../memory/taxonomy-v1";
import { WRITE_GATE_VERSION } from "../../memory/write-gate";
import { emitMeasuredOtelEvent } from "../../observability/emit";

type NotedObservationInput = {
  category?: unknown;
  summary?: unknown;
  metadata?: unknown;
};

type MemoryObservationDoc = {
  id: string;
  session_id: string;
  observation: string;
  observation_type: string;
  source: string;
  timestamp: number;
  merged_count: number;
  updated_at: string;
  superseded_by: null;
  supersedes: null;
  write_verdict: "allow";
  write_confidence: number;
  write_reason: string;
  write_gate_version: string;
  write_gate_fallback: boolean;
  category_id: string;
  category_confidence: number;
  category_source: string;
  taxonomy_version: string;
};

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return {};
}

function toUnixSeconds(value: unknown): number | null {
  const numeric = asFiniteNumber(value);
  if (numeric != null) {
    if (numeric > 1_000_000_000_000) return Math.floor(numeric / 1000);
    if (numeric > 1_000_000_000) return Math.floor(numeric);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) {
      return Math.floor(parsed.getTime() / 1000);
    }
  }

  return null;
}

function normalizeObservations(
  items: NotedObservationInput[],
  eventId: string
): MemoryObservationDoc[] {
  const nowIso = new Date().toISOString();
  const nowUnix = Math.floor(Date.now() / 1000);
  const docs: MemoryObservationDoc[] = [];

  for (const input of items) {
    const summary = typeof input.summary === "string" ? input.summary.trim() : "";
    if (!summary) continue;

    const metadata = asRecord(input.metadata);
    const sessionId =
      typeof metadata.sessionId === "string" && metadata.sessionId.trim().length > 0
        ? metadata.sessionId.trim()
        : typeof metadata.dedupKey === "string" && metadata.dedupKey.trim().length > 0
          ? `dedup:${metadata.dedupKey.trim()}`
          : typeof metadata.eventId === "string" && metadata.eventId.trim().length > 0
            ? `otel:${metadata.eventId.trim()}`
            : `session-noted:${eventId}`;

    const source =
      typeof metadata.source === "string" && metadata.source.trim().length > 0
        ? metadata.source.trim()
        : "session_observation_noted";
    const observationType =
      typeof input.category === "string" && input.category.trim().length > 0
        ? input.category.trim()
        : "observation_text";

    const hintedCategory = normalizeCategoryId(
      typeof input.category === "string" ? input.category : null
    );
    const classifiedCategory = hintedCategory
      ? {
          categoryId: hintedCategory,
          categoryConfidence: 0.75,
          categorySource: "external",
          taxonomyVersion: TAXONOMY_VERSION,
        }
      : classifyObservationCategory(summary);

    docs.push({
      id: randomUUID(),
      session_id: sessionId,
      observation: summary,
      observation_type: observationType,
      source,
      timestamp: toUnixSeconds(metadata.timestamp) ?? nowUnix,
      merged_count: 1,
      updated_at: nowIso,
      superseded_by: null,
      supersedes: null,
      write_verdict: "allow",
      write_confidence: 0.5,
      write_reason: "session_observation_noted",
      write_gate_version: WRITE_GATE_VERSION,
      write_gate_fallback: false,
      category_id: classifiedCategory.categoryId,
      category_confidence: classifiedCategory.categoryConfidence,
      category_source: classifiedCategory.categorySource,
      taxonomy_version: classifiedCategory.taxonomyVersion,
    });
  }

  return docs;
}

export const observeSessionNoted = inngest.createFunction(
  {
    id: "observe-session-noted",
    name: "Observe Session Noted",
    concurrency: { limit: 1 },
    retries: 2,
  },
  { event: "session/observation.noted" },
  async ({ event, step }) => {
    const docs = await step.run("normalize-observations", async () => {
      const observations = Array.isArray(event.data?.observations)
        ? (event.data.observations as NotedObservationInput[])
        : [];
      return normalizeObservations(observations, event.id ?? "session-observation-noted");
    });

    if (docs.length === 0) {
      return { stored: false, count: 0, reason: "no_observations" };
    }

    const result = await step.run("store-observations", async () =>
      emitMeasuredOtelEvent(
        {
          level: "info",
          source: "worker",
          component: "observe-session-noted",
          action: "memory.observations.stored",
          metadata: {
            eventId: event.id,
            observationCount: docs.length,
          },
        },
        async () => {
          const importResult = await typesense.bulkImport("memory_observations", docs);
          let convexSuccess = 0;
          let convexErrors = 0;

          for (const doc of docs) {
            try {
              const category = doc.observation_type || "general";
              await pushContentResource(
                `obs:${doc.id}`,
                "memory_observation",
                {
                  observationId: doc.id,
                  observation: doc.observation,
                  category,
                  source: doc.source,
                  sessionId: doc.session_id,
                  superseded: false,
                  timestamp: doc.timestamp,
                },
                [doc.observation, category, doc.source].filter(Boolean).join(" ")
              );
              convexSuccess += 1;
            } catch {
              convexErrors += 1;
            }
          }

          return {
            stored: true,
            typesenseSuccess: importResult.success,
            typesenseErrors: importResult.errors,
            convexSuccess,
            convexErrors,
          };
        }
      )
    );

    return result;
  }
);
