/**
 * Echo/Fizzle tracking — ADR-0077 Increment 3
 * 
 * After each retrieval, detect which memories were used vs ignored.
 * Boost echoes (+0.1 priority), penalize fizzles (-0.05 priority).
 * Over time, useful memories surface; irrelevant ones sink.
 */

import { QdrantClient } from "@qdrant/js-client-rest";

const QDRANT_HOST = process.env.QDRANT_HOST ?? "localhost";
const QDRANT_PORT = Number.parseInt(process.env.QDRANT_PORT ?? "6333", 10);
const QDRANT_COLLECTION = "memory_observations";

export const ECHO_BOOST = 0.1;
export const FIZZLE_PENALTY = -0.05;

interface RecalledMemory {
  id: string | number;
  observation: string;
}

/**
 * Heuristic: check if the agent response contains key phrases from the memory.
 * Extract 3+ word phrases from the observation and check if any appear in the response.
 * Also check for semantic overlap: if >30% of significant words from the observation
 * appear in the response, count it as referenced.
 */
export function wasMemoryReferenced(observation: string, agentResponse: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const normObs = normalize(observation);
  const normResp = normalize(agentResponse);
  
  // Check for 3+ word phrase overlap
  const words = normObs.split(/\s+/).filter(w => w.length > 3);
  if (words.length === 0) return false;
  
  // Check trigrams
  for (let i = 0; i <= words.length - 3; i++) {
    const trigram = words.slice(i, i + 3).join(' ');
    if (normResp.includes(trigram)) return true;
  }
  
  // Check significant word overlap (>30%)
  const significantWords = new Set(words);
  const respWords = new Set(normResp.split(/\s+/));
  let matches = 0;
  for (const w of significantWords) {
    if (respWords.has(w)) matches++;
  }
  return significantWords.size > 0 && (matches / significantWords.size) > 0.3;
}

/**
 * Update recall_count and retrieval_priority for a batch of recalled memories
 * based on whether they were echoed or fizzled.
 */
export async function trackEchoFizzle(
  recalledMemories: RecalledMemory[],
  agentResponse: string,
): Promise<{ echoes: number; fizzles: number }> {
  const qdrant = new QdrantClient({ host: QDRANT_HOST, port: QDRANT_PORT });
  let echoes = 0;
  let fizzles = 0;
  
  for (const memory of recalledMemories) {
    const isEcho = wasMemoryReferenced(memory.observation, agentResponse);
    const boost = isEcho ? ECHO_BOOST : FIZZLE_PENALTY;
    
    // Get current values
    const points = await qdrant.retrieve(QDRANT_COLLECTION, {
      ids: [memory.id],
      with_payload: true,
    });
    const point = points[0];
    const payload = (point?.payload ?? {}) as Record<string, unknown>;
    const currentPriority = typeof payload.retrieval_priority === 'number' 
      ? payload.retrieval_priority : 0;
    const currentRecallCount = typeof payload.recall_count === 'number'
      ? payload.recall_count : 0;
    
    // Update
    await qdrant.setPayload(QDRANT_COLLECTION, {
      payload: {
        retrieval_priority: Math.max(-1, Math.min(1, currentPriority + boost)),
        recall_count: currentRecallCount + 1,
        last_recalled_at: new Date().toISOString(),
        stale: false, // Referenced memory is not stale
      },
      points: [memory.id],
    });
    
    if (isEcho) echoes++;
    else fizzles++;
  }
  
  return { echoes, fizzles };
}
