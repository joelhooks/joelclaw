export interface TranscriptSegment {
  text: string;
  speaker?: string | null;
  start?: number | null;
  end?: number | null;
}

export interface TranscriptChunk {
  text: string;
  speaker?: string;
  start_seconds?: number;
  end_seconds?: number;
  chunk_index: number;
}

export interface TranscriptChunkOptions {
  maxTokens?: number;
  minMergeTokens?: number;
  overlapSentences?: number;
}

type InternalTurn = {
  text: string;
  speaker?: string;
  start_seconds?: number;
  end_seconds?: number;
};

const DEFAULT_MAX_TOKENS = 500;
const DEFAULT_MIN_MERGE_TOKENS = 100;
const DEFAULT_OVERLAP_SENTENCES = 1;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSpeaker(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = normalizeWhitespace(value.replace(/:$/, ""));
  return cleaned.length > 0 ? cleaned : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  return Math.max(1, Math.round(words * 1.3));
}

function splitSentences(text: string): string[] {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];
  const matches = normalized.match(/[^.!?]+(?:[.!?]+|$)/g);
  if (!matches) return [normalized];
  return matches.map((part) => normalizeWhitespace(part)).filter(Boolean);
}

function lastSentences(text: string, count: number): string {
  if (count <= 0) return "";
  const sentences = splitSentences(text);
  if (sentences.length === 0) return "";
  return normalizeWhitespace(sentences.slice(-count).join(" "));
}

function splitLongText(text: string, maxTokens: number, overlapSentences: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [normalizeWhitespace(text)];

  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];

  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const sentence of sentences) {
    const sentenceTokens = estimateTokens(sentence);

    if (current.length > 0 && currentTokens + sentenceTokens > maxTokens) {
      chunks.push(normalizeWhitespace(current.join(" ")));
      const overlap =
        overlapSentences > 0
          ? current.slice(Math.max(0, current.length - overlapSentences))
          : [];
      current = [...overlap, sentence];
      currentTokens = estimateTokens(current.join(" "));
      continue;
    }

    if (current.length === 0 && sentenceTokens > maxTokens) {
      chunks.push(normalizeWhitespace(sentence));
      continue;
    }

    current.push(sentence);
    currentTokens += sentenceTokens;
  }

  if (current.length > 0) {
    chunks.push(normalizeWhitespace(current.join(" ")));
  }

  return chunks.filter(Boolean);
}

function chunkTurns(turns: InternalTurn[], opts: TranscriptChunkOptions = {}): TranscriptChunk[] {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const minMergeTokens = opts.minMergeTokens ?? DEFAULT_MIN_MERGE_TOKENS;
  const overlapSentences = opts.overlapSentences ?? DEFAULT_OVERLAP_SENTENCES;

  const chunks: Array<Omit<TranscriptChunk, "chunk_index">> = [];
  let carryOverlap = "";
  let parts: string[] = [];
  let partsTokens = 0;
  let chunkSpeakers = new Set<string>();
  let chunkStart: number | undefined;
  let chunkEnd: number | undefined;
  let hasActualContent = false;

  const startChunk = () => {
    parts = [];
    partsTokens = 0;
    chunkSpeakers = new Set<string>();
    chunkStart = undefined;
    chunkEnd = undefined;
    hasActualContent = false;

    if (carryOverlap.length > 0) {
      parts.push(carryOverlap);
      partsTokens += estimateTokens(carryOverlap);
    }
  };

  const flushChunk = () => {
    if (!hasActualContent) return;
    const text = normalizeWhitespace(parts.join(" "));
    if (!text) return;

    const speaker =
      chunkSpeakers.size === 1 ? Array.from(chunkSpeakers.values())[0] : undefined;
    chunks.push({
      text,
      ...(speaker ? { speaker } : {}),
      ...(chunkStart != null ? { start_seconds: chunkStart } : {}),
      ...(chunkEnd != null ? { end_seconds: chunkEnd } : {}),
    });

    carryOverlap = overlapSentences > 0 ? lastSentences(text, overlapSentences) : "";
    parts = [];
    partsTokens = 0;
    chunkSpeakers = new Set<string>();
    chunkStart = undefined;
    chunkEnd = undefined;
    hasActualContent = false;
  };

  startChunk();

  for (const turn of turns) {
    const text = normalizeWhitespace(turn.text);
    if (!text) continue;

    const turnTokens = estimateTokens(text);
    if (turnTokens > maxTokens) {
      flushChunk();
      const split = splitLongText(text, maxTokens, overlapSentences);
      for (const splitText of split) {
        chunks.push({
          text: splitText,
          ...(turn.speaker ? { speaker: turn.speaker } : {}),
          ...(turn.start_seconds != null ? { start_seconds: turn.start_seconds } : {}),
          ...(turn.end_seconds != null ? { end_seconds: turn.end_seconds } : {}),
        });
      }
      if (split.length > 0) {
        carryOverlap = overlapSentences > 0
          ? lastSentences(split[split.length - 1]!, overlapSentences)
          : "";
      }
      startChunk();
      continue;
    }

    const speakerChanged =
      hasActualContent &&
      !!turn.speaker &&
      chunkSpeakers.size > 0 &&
      !chunkSpeakers.has(turn.speaker);

    if (
      (speakerChanged && partsTokens >= minMergeTokens) ||
      (hasActualContent && partsTokens + turnTokens > maxTokens)
    ) {
      flushChunk();
      startChunk();
    }

    parts.push(text);
    partsTokens += turnTokens;
    hasActualContent = true;

    if (turn.speaker) {
      chunkSpeakers.add(turn.speaker);
    }
    if (chunkStart == null && turn.start_seconds != null) {
      chunkStart = turn.start_seconds;
    }
    if (turn.end_seconds != null) {
      chunkEnd = turn.end_seconds;
    }
  }

  flushChunk();

  return chunks.map((chunk, chunk_index) => ({ ...chunk, chunk_index }));
}

export function chunkBySegments(
  segments: TranscriptSegment[],
  opts: TranscriptChunkOptions = {}
): TranscriptChunk[] {
  const normalized = segments
    .map((segment) => ({
      text: normalizeWhitespace(segment.text ?? ""),
      speaker: normalizeSpeaker(segment.speaker),
      start_seconds: asFiniteNumber(segment.start),
      end_seconds: asFiniteNumber(segment.end),
    }))
    .filter((segment) => segment.text.length > 0);

  if (normalized.length === 0) return [];

  const turns: InternalTurn[] = [];
  for (const segment of normalized) {
    const prev = turns[turns.length - 1];
    if (prev && segment.speaker && prev.speaker === segment.speaker) {
      prev.text = normalizeWhitespace(`${prev.text} ${segment.text}`);
      if (prev.start_seconds == null && segment.start_seconds != null) {
        prev.start_seconds = segment.start_seconds;
      }
      if (segment.end_seconds != null) {
        prev.end_seconds = segment.end_seconds;
      }
      continue;
    }
    turns.push({ ...segment });
  }

  return chunkTurns(turns, opts);
}

function isSpeakerLabel(value: string): boolean {
  if (!value) return false;
  if (value.length > 60) return false;
  if (/https?:\/\//i.test(value)) return false;
  if (/[.!?]/.test(value)) return false;

  const words = value.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 6) return false;
  return words.every((word) => /^[A-Za-z0-9'&().-]+$/.test(word));
}

export function chunkBySpeakerTurns(
  text: string,
  opts: TranscriptChunkOptions = {}
): TranscriptChunk[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);

  if (lines.length === 0) return [];

  const turns: InternalTurn[] = [];
  let currentSpeaker: string | undefined;
  let buffer: string[] = [];
  let foundSpeaker = false;

  const flush = () => {
    const body = normalizeWhitespace(buffer.join(" "));
    if (!body) return;
    turns.push({
      text: body,
      ...(currentSpeaker ? { speaker: currentSpeaker } : {}),
    });
    buffer = [];
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const inlineMatch = line.match(/^([^:]{1,80}):\s*(.+)$/);
    if (inlineMatch) {
      const speaker = normalizeSpeaker(inlineMatch[1]);
      const utterance = normalizeWhitespace(inlineMatch[2] ?? "");
      if (speaker && isSpeakerLabel(speaker) && utterance.length > 0) {
        flush();
        currentSpeaker = speaker;
        buffer = [utterance];
        foundSpeaker = true;
        continue;
      }
    }

    const soloMatch = line.match(/^([^:]{1,80}):?$/);
    if (soloMatch) {
      const speaker = normalizeSpeaker(soloMatch[1]);
      if (speaker && isSpeakerLabel(speaker) && index + 1 < lines.length) {
        flush();
        currentSpeaker = speaker;
        buffer = [];
        foundSpeaker = true;
        continue;
      }
    }

    buffer.push(line);
  }

  flush();

  if (!foundSpeaker) {
    const fallback = normalizeWhitespace(text);
    if (!fallback) return [];
    return chunkTurns([{ text: fallback }], opts);
  }

  return chunkTurns(turns, opts);
}
