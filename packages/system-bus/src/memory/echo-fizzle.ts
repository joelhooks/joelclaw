/**
 * Echo/Fizzle tracking — ADR-0077 Increment 3
 *
 * After each retrieval, detect which memories were used vs ignored.
 * Boost echoes (+0.1 priority), penalize fizzles (-0.05 priority).
 * Over time, useful memories surface; irrelevant ones sink.
 */

import { inngest } from "../inngest/client";
import * as typesense from "../lib/typesense";

const OBSERVATIONS_COLLECTION = "memory_observations";

export const ECHO_BOOST = 0.1;
export const FIZZLE_PENALTY = -0.05;

interface RecalledMemory {
  id: string;
  observation: string;
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * Heuristic: check if the agent response contains key phrases from the memory.
 * Extract 3+ word phrases from the observation and check if any appear in the response.
 * Also check for semantic overlap: if >30% of significant words from the observation
 * appear in the response, count it as referenced.
 */
export function wasMemoryReferenced(observation: string, agentResponse: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "");
  const normObs = normalize(observation);
  const normResp = normalize(agentResponse);

  // Check for 3+ word phrase overlap
  const words = normObs.split(/\s+/).filter((w) => w.length > 3);
  if (words.length === 0) return false;

  // Check trigrams
  for (let i = 0; i <= words.length - 3; i++) {
    const trigram = words.slice(i, i + 3).join(" ");
    if (normResp.includes(trigram)) return true;
  }

  // Check significant word overlap (>30%)
  const significantWords = new Set(words);
  const respWords = new Set(normResp.split(/\s+/));
  let matches = 0;
  for (const w of significantWords) {
    if (respWords.has(w)) matches++;
  }
  return significantWords.size > 0 && matches / significantWords.size > 0.3;
}

/**
 * Update recall_count and retrieval_priority for a batch of recalled memories
 * based on whether they were echoed or fizzled.
 */
export async function trackEchoFizzle(
  recalledMemories: RecalledMemory[],
  agentResponse: string
): Promise<{ echoes: number; fizzles: number }> {
  let echoes = 0;
  let fizzles = 0;

  for (const memory of recalledMemories) {
    const isEcho = wasMemoryReferenced(memory.observation, agentResponse);
    const boost = isEcho ? ECHO_BOOST : FIZZLE_PENALTY;

    const response = await typesense.search({
      collection: OBSERVATIONS_COLLECTION,
      q: "*",
      query_by: "observation",
      filter_by: `id:=${memory.id}`,
      per_page: 1,
      include_fields: "id,retrieval_priority,recall_count",
    });

    const hit = Array.isArray(response.hits) ? response.hits[0] : undefined;
    const doc = (hit?.document ?? {}) as Record<string, unknown>;
    const currentPriority = asFiniteNumber(doc.retrieval_priority, 0);
    const currentRecallCount = asFiniteNumber(doc.recall_count, 0);

    await typesense.bulkImport(
      OBSERVATIONS_COLLECTION,
      [
        {
          id: memory.id,
          retrieval_priority: Math.max(-1, Math.min(1, currentPriority + boost)),
          recall_count: currentRecallCount + 1,
          last_recalled_at: new Date().toISOString(),
          stale: false, // Referenced memory is not stale
        },
      ],
      "update"
    );

    if (isEcho) echoes++;
    else fizzles++;
  }

  return { echoes, fizzles };
}

export const echoFizzle = inngest.createFunction(
  {
    id: "memory/echo-fizzle",
    name: "Track Memory Echo/Fizzle",
  },
  { event: "memory/echo-fizzle.requested" },
  async ({ event }) => {
    const recalledMemories = Array.isArray(event.data.recalledMemories)
      ? event.data.recalledMemories
      : [];
    const agentResponse =
      typeof event.data.agentResponse === "string" ? event.data.agentResponse : "";

    if (recalledMemories.length === 0 || agentResponse.length === 0) {
      return { status: "skipped", reason: "missing-input" };
    }

    const result = await trackEchoFizzle(recalledMemories, agentResponse);
    return {
      status: "ok",
      ...result,
      total: recalledMemories.length,
    };
  }
);
