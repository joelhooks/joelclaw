/**
 * Whole-file mlx_whisper on long AAC degenerates into a decoding loop: after
 * ~10 minutes it emits the same segment over and over for the rest of the file.
 * The words are well-formed and timestamped, so nothing downstream notices —
 * the loop only shows up as a transcript that repeats one phrase 400 times.
 *
 * Every chunk is screened here before it can be aggregated. A tripped chunk is
 * a typed failure, not a silent bad transcript.
 */

export type RepetitionThresholds = {
  /** Longest run of identical consecutive segments before a chunk is rejected. */
  maxConsecutiveRepeats: number;
  /** Share of words covered by the single most common segment. */
  maxTopPhraseShare: number;
  /** distinct segments / total segments. */
  minDistinctRatio: number;
  /** Below this many segments the ratios are too noisy to judge. */
  minSegmentsForRatios: number;
  /**
   * screenWithCollapse only: share of segments removed by collapsing
   * consecutive duplicates above which the decode itself is judged garbage —
   * if most of the output was loop padding, the decoder was hallucinating,
   * and whatever real speech was in that audio is likely missing.
   */
  maxCollapsedFraction: number;
};

export const defaultRepetitionThresholds: RepetitionThresholds = {
  maxConsecutiveRepeats: 6,
  maxTopPhraseShare: 0.5,
  minDistinctRatio: 0.25,
  minSegmentsForRatios: 12,
  maxCollapsedFraction: 0.5,
};

export type RepetitionMetrics = {
  segments: number;
  totalWords: number;
  distinctRatio: number;
  topPhrase?: string;
  topPhraseShare: number;
  maxConsecutiveRepeats: number;
};

export type RepetitionVerdict = {
  repetitive: boolean;
  reason?: string;
  metrics: RepetitionMetrics;
};

export function normalizeSegmentText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim()
    .replace(/\s+/g, " ");
}

function countWords(text: string): number {
  return text ? text.split(" ").length : 0;
}

export function detectPathologicalRepetition(
  segments: Array<{ text?: string }>,
  thresholds: Partial<RepetitionThresholds> = {},
): RepetitionVerdict {
  const limits = { ...defaultRepetitionThresholds, ...thresholds };
  const normalized = segments
    .map((segment) => normalizeSegmentText(String(segment.text ?? "")))
    .filter((text) => text.length > 0);

  const totalWords = normalized.reduce((sum, text) => sum + countWords(text), 0);

  const wordsByPhrase = new Map<string, number>();
  let maxConsecutiveRepeats = 0;
  let currentRun = 0;
  let previous: string | undefined;

  for (const text of normalized) {
    wordsByPhrase.set(text, (wordsByPhrase.get(text) ?? 0) + countWords(text));
    currentRun = text === previous ? currentRun + 1 : 1;
    if (currentRun > maxConsecutiveRepeats) maxConsecutiveRepeats = currentRun;
    previous = text;
  }

  let topPhrase: string | undefined;
  let topPhraseWords = 0;
  for (const [phrase, words] of wordsByPhrase) {
    if (words > topPhraseWords) {
      topPhrase = phrase;
      topPhraseWords = words;
    }
  }

  const metrics: RepetitionMetrics = {
    segments: normalized.length,
    totalWords,
    distinctRatio: normalized.length ? wordsByPhrase.size / normalized.length : 1,
    topPhrase,
    topPhraseShare: totalWords ? topPhraseWords / totalWords : 0,
    maxConsecutiveRepeats,
  };

  if (metrics.maxConsecutiveRepeats >= limits.maxConsecutiveRepeats) {
    return {
      repetitive: true,
      reason: `segment repeated ${metrics.maxConsecutiveRepeats}x consecutively: "${topPhrase ?? ""}"`,
      metrics,
    };
  }

  // Ratios need enough segments to mean anything. A 3-segment chunk of "yeah",
  // "yeah", "right" is not a decoding loop.
  if (metrics.segments >= limits.minSegmentsForRatios) {
    if (metrics.topPhraseShare > limits.maxTopPhraseShare) {
      return {
        repetitive: true,
        reason: `one phrase covers ${(metrics.topPhraseShare * 100).toFixed(0)}% of words: "${topPhrase ?? ""}"`,
        metrics,
      };
    }
    if (metrics.distinctRatio < limits.minDistinctRatio) {
      return {
        repetitive: true,
        reason: `only ${(metrics.distinctRatio * 100).toFixed(0)}% of segments are distinct`,
        metrics,
      };
    }
  }

  return { repetitive: false, metrics };
}

export type CollapseResult<T> = {
  segments: T[];
  removed: number;
  removedFraction: number;
};

/**
 * Collapses runs of consecutive segments with identical normalized text down
 * to their first occurrence. At whisper segment granularity (~2-5s each), a
 * run of identical segments is decoder looping, not speech — a person saying
 * "yeah, yeah" does it within one segment. Real content survives: one
 * "I'm not sure" stays; the 13 hallucinated echoes go.
 */
export function collapseConsecutiveSegments<T extends { text?: string }>(
  segments: T[],
): CollapseResult<T> {
  const kept: T[] = [];
  let previous: string | undefined;
  for (const segment of segments) {
    const normalized = normalizeSegmentText(String(segment.text ?? ""));
    if (normalized.length > 0 && normalized === previous) continue;
    kept.push(segment);
    previous = normalized.length > 0 ? normalized : undefined;
  }
  const removed = segments.length - kept.length;
  return {
    segments: kept,
    removed,
    removedFraction: segments.length ? removed / segments.length : 0,
  };
}

export type CollapsedScreenVerdict<T> = RepetitionVerdict & {
  /** Collapsed segments — what downstream should aggregate/persist. */
  segments: T[];
  removed: number;
  removedFraction: number;
};

/**
 * Collapse consecutive duplicates, then screen what remains. Deterministic
 * short loops (a 14× "im not sure" on a quiet mic stretch) collapse away and
 * the chunk passes; a decode that was MOSTLY loop padding still fails via
 * maxCollapsedFraction, because the surviving fragments cannot be trusted to
 * represent the audio (the 2,768× "thank you" whole-file collapses to almost
 * nothing — that is a failed decode, not a quiet meeting).
 */
export function screenWithCollapse<T extends { text?: string }>(
  segments: T[],
  thresholds: Partial<RepetitionThresholds> = {},
): CollapsedScreenVerdict<T> {
  const limits = { ...defaultRepetitionThresholds, ...thresholds };
  const collapsed = collapseConsecutiveSegments(segments);
  if (
    collapsed.removedFraction > limits.maxCollapsedFraction &&
    segments.length >= limits.minSegmentsForRatios
  ) {
    const verdict = detectPathologicalRepetition(segments, thresholds);
    return {
      repetitive: true,
      reason: `decode is ${(collapsed.removedFraction * 100).toFixed(0)}% consecutive-duplicate padding`,
      metrics: verdict.metrics,
      ...collapsed,
    };
  }
  const verdict = detectPathologicalRepetition(collapsed.segments, thresholds);
  return { ...verdict, ...collapsed };
}
