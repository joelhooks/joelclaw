/**
 * Detect repeated-token collapse in gateway session output.
 *
 * Real incidents (2026-07-22/23) emitted "court" tens of thousands of times
 * after multi-day Opus sessions. Keep this detector cheap and boring: either
 * the known court pattern, or one token dominating a short recent window.
 */

const COURT_BURST = /(?:^|\s)(?:court\s*){5,}/i;

export type DegenerationMatch = {
  degenerated: boolean;
  reason?: "court-burst" | "repeated-token-ratio";
  token?: string;
  ratio?: number;
  sampleLength?: number;
};

/**
 * True when recent assistant/terminal text looks like a repeated-token collapse.
 */
export function detectRepeatedTokenCollapse(text: string): DegenerationMatch {
  const sample = text.trim();
  if (!sample) return { degenerated: false };

  if (COURT_BURST.test(sample)) {
    return {
      degenerated: true,
      reason: "court-burst",
      token: "court",
      sampleLength: sample.length,
    };
  }

  const tokens = sample.toLowerCase().split(/\s+/u).filter(Boolean);
  if (tokens.length < 20) return { degenerated: false, sampleLength: sample.length };

  const window = tokens.slice(-200);
  const counts = new Map<string, number>();
  for (const token of window) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  let dominantToken = "";
  let dominantCount = 0;
  for (const [token, count] of counts) {
    if (count > dominantCount) {
      dominantToken = token;
      dominantCount = count;
    }
  }

  const ratio = dominantCount / window.length;
  // One token ≥60% of a 20+ token window, and at least 15 repeats.
  if (dominantCount >= 15 && ratio >= 0.6) {
    return {
      degenerated: true,
      reason: "repeated-token-ratio",
      token: dominantToken,
      ratio,
      sampleLength: sample.length,
    };
  }

  return { degenerated: false, sampleLength: sample.length, ratio, token: dominantToken };
}

export function isRepeatedTokenCollapse(text: string): boolean {
  return detectRepeatedTokenCollapse(text).degenerated;
}
