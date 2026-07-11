import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseAsrJson } from "./asr-json";
import { rigAsrPath } from "./paths";
import { detectPathologicalRepetition, type RepetitionVerdict } from "./repetition";
import type { PlanChunk } from "./types";

export type WhisperWord = {
  start: number;
  end: number;
  word?: string;
  text?: string;
  [key: string]: unknown;
};

export type WhisperSegment = {
  id?: number;
  start: number;
  end: number;
  text: string;
  words?: WhisperWord[];
  [key: string]: unknown;
};

export type WhisperAsr = {
  text: string;
  segments: WhisperSegment[];
  language?: string;
  [key: string]: unknown;
};

export type ReadJsonFn = (path: string) => Promise<unknown | undefined>;

async function defaultReadJson(path: string): Promise<unknown | undefined> {
  try {
    const text = await Bun.file(path).text();
    return parseAsrJson(text);
  } catch {
    return undefined;
  }
}

function isWhisperAsr(value: unknown): value is WhisperAsr {
  if (typeof value !== "object" || value === null) return false;
  return Array.isArray((value as Record<string, unknown>).segments);
}

/**
 * Stitches chunk ASR results into one whole-track transcript. Offsets every
 * segment/word timestamp by the chunk's startMs, renumbers segment ids
 * sequentially, and screens each chunk plus the aggregate for the pathological
 * repetition loop that killed the original whole-file run.
 */
export async function aggregateChunkAsr(args: {
  artifactId: string;
  sourceId: string;
  chunks: PlanChunk[];
  readJson?: ReadJsonFn;
}): Promise<{ asr: WhisperAsr; screened: RepetitionVerdict }> {
  const readJson = args.readJson ?? defaultReadJson;
  const orderedChunks = [...args.chunks].sort((a, b) => a.index - b.index);

  const allSegments: WhisperSegment[] = [];
  const textParts: string[] = [];
  let language: string | undefined;

  for (const chunk of orderedChunks) {
    const raw = await readJson(chunk.resultPath);
    if (!isWhisperAsr(raw)) {
      throw new Error(`chunk_result_missing: ${chunk.chunkId}`);
    }
    const verdict = detectPathologicalRepetition(raw.segments);
    if (verdict.repetitive) {
      throw new Error(`chunk_repetitive: ${chunk.chunkId}: ${verdict.reason}`);
    }
    if (language === undefined) language = raw.language;

    const offsetSeconds = chunk.startMs / 1000;
    for (const segment of raw.segments) {
      const offsetSegment: WhisperSegment = {
        ...segment,
        start: segment.start + offsetSeconds,
        end: segment.end + offsetSeconds,
        words: segment.words?.map((word) => ({
          ...word,
          start: word.start + offsetSeconds,
          end: word.end + offsetSeconds,
        })),
      };
      allSegments.push(offsetSegment);
      if (segment.text) textParts.push(segment.text);
    }
  }

  const renumbered = allSegments.map((segment, index) => ({ ...segment, id: index }));

  const asr: WhisperAsr = {
    text: textParts.join(" "),
    segments: renumbered,
    language,
  };

  const screened = detectPathologicalRepetition(asr.segments);
  if (screened.repetitive) {
    throw new Error(`aggregate_repetitive: ${screened.reason}`);
  }

  return { asr, screened };
}

/** Atomic write (tmp + rename) to the rig's whole-track ASR claim check. */
export async function writeAggregatedAsr(
  artifactId: string,
  sourceId: string,
  asr: WhisperAsr,
): Promise<void> {
  const path = rigAsrPath(artifactId, sourceId);
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(asr, null, 2));
  await rename(tmpPath, path);
}
