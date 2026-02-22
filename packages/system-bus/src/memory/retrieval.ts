/**
 * Memory retrieval utilities — ADR-0077 Increment 1
 * Score decay and inject cap for semantic search results.
 */

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
