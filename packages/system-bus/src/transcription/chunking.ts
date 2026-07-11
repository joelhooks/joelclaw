import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseAsrJson } from "./asr-json";
import {
  asrChunkResultPath,
  chunkJobId,
  rigAsrPath,
  rigDiarizationPath,
  workRoot,
} from "./paths";
import { screenWithCollapse } from "./repetition";
import type { PlanChunk, PlanTrack, TranscriptionPlan } from "./types";

export type ChunkBoundary = { index: number; startMs: number; endMs: number };

/**
 * Pure chunk-boundary math. Last chunk is the remainder; a track shorter than
 * chunkSeconds yields one chunk.
 */
export function computeChunkBoundaries(
  durationMs: number,
  chunkSeconds: number,
): ChunkBoundary[] {
  if (durationMs <= 0) {
    throw new Error(`invalid_duration: durationMs must be > 0, got ${durationMs}`);
  }
  const chunkMs = chunkSeconds * 1000;
  const boundaries: ChunkBoundary[] = [];
  let start = 0;
  let index = 0;
  while (start < durationMs) {
    const end = Math.min(start + chunkMs, durationMs);
    boundaries.push({ index, startMs: start, endMs: end });
    start = end;
    index += 1;
  }
  return boundaries;
}

export type ExecResult = { stdout: string; stderr: string; code: number };
export type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

async function defaultExec(cmd: string, args: string[]): Promise<ExecResult> {
  const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

/** ffprobe wrapper; returns duration in milliseconds. Injectable exec for tests. */
export async function probeDurationMs(
  mediaPath: string,
  exec: ExecFn = defaultExec,
): Promise<number> {
  const { stdout, stderr, code } = await exec("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    mediaPath,
  ]);
  if (code !== 0) {
    throw new Error(`ffprobe_failed: ${mediaPath}: ${stderr.trim() || `exit ${code}`}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`ffprobe_invalid_output: ${mediaPath}: ${stdout.slice(-500)}`);
  }
  const duration = (parsed as { format?: { duration?: string } })?.format?.duration;
  const seconds = Number(duration);
  if (!Number.isFinite(seconds)) {
    throw new Error(`ffprobe_invalid_duration: ${mediaPath}: ${JSON.stringify(duration)}`);
  }
  return Math.round(seconds * 1000);
}

const WAV_NAME_RE = /^\d{3}\.wav$/;

async function listExistingWavs(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => WAV_NAME_RE.test(name))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => join(dir, name));
}

/**
 * If the expected chunk WAVs already exist, adopt them (never re-run ffmpeg —
 * this is what lets the pipeline resume onto the tactical recovery's foreign
 * layout without re-chunking). Otherwise segment the source with one ffmpeg
 * call. Returns absolute wav paths sorted by index.
 */
export async function chunkTrackAudio(args: {
  mediaPath: string;
  chunksDir: string;
  chunkSeconds: number;
  exec?: ExecFn;
}): Promise<string[]> {
  const exec = args.exec ?? defaultExec;

  const existing = await listExistingWavs(args.chunksDir);
  if (existing.length > 0) return existing;

  await mkdir(args.chunksDir, { recursive: true });
  const { code, stderr } = await exec("ffmpeg", [
    "-v",
    "error",
    "-i",
    args.mediaPath,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "segment",
    "-segment_time",
    String(args.chunkSeconds),
    join(args.chunksDir, "%03d.wav"),
  ]);
  if (code !== 0) {
    throw new Error(`ffmpeg_chunk_failed: ${args.mediaPath}: ${stderr.trim() || `exit ${code}`}`);
  }
  const created = await listExistingWavs(args.chunksDir);
  if (created.length === 0) {
    throw new Error(`ffmpeg_produced_no_chunks: ${args.mediaPath}`);
  }
  return created;
}

export type ChunkFileOffset = {
  index: number;
  startMs: number;
  endMs: number;
  wavPath: string;
};

/**
 * The chunk's own embedded ordinal (`NNN.wav` -> N), NOT its array position.
 * Foreign/gapped adopted layouts (e.g. 000.wav + 002.wav, 001.wav missing)
 * must keep their real ordinal so paths.ts's deterministic reconstruction
 * (`asrChunkAudioPath(artifactId, sourceId, index)`) still resolves to the
 * same file the plan pointed at — compacting to array position would send
 * the actor for plan-index 1 looking for a 001.wav that was never adopted.
 */
function ordinalFromWavPath(wavPath: string): number {
  const match = basename(wavPath).match(/^(\d{3})\.wav$/);
  if (!match) {
    throw new Error(`invalid_chunk_filename: expected NNN.wav, got ${wavPath}`);
  }
  return Number(match[1]);
}

/**
 * Offsets = cumulative ffprobe durations of the actual chunk files, in file
 * order. `index` is each file's own embedded ordinal (see
 * `ordinalFromWavPath`), not its position in the array — this is what makes
 * adopted foreign/gapped layouts exact.
 */
export async function chunkOffsetsFromFiles(
  wavPaths: string[],
  probe: (path: string) => Promise<number> = (path) => probeDurationMs(path),
): Promise<ChunkFileOffset[]> {
  const results: ChunkFileOffset[] = [];
  let cursor = 0;
  for (const wavPath of wavPaths) {
    const index = ordinalFromWavPath(wavPath);
    const durationMs = await probe(wavPath);
    const startMs = cursor;
    const endMs = cursor + durationMs;
    results.push({ index, startMs, endMs, wavPath });
    cursor = endMs;
  }
  return results;
}

export type BuildPlanMediaItem = {
  sourceId: string;
  path: string;
  role: string;
  expectedSpeakers?: number;
  speaker?: string;
};

export type BuildPlanDeps = {
  /** Reads and JSON.parses a claim-check file; undefined on missing/corrupt. */
  readJson?: (path: string) => Promise<unknown | undefined>;
  renameFile?: (from: string, to: string) => Promise<void>;
  /** Atomic JSON writer used to persist a collapsed adopted whole-track ASR. */
  writeJson?: (path: string, value: unknown) => Promise<void>;
  chunkAudio?: (args: {
    mediaPath: string;
    chunksDir: string;
    chunkSeconds: number;
  }) => Promise<string[]>;
  offsetsFromFiles?: (wavPaths: string[]) => Promise<ChunkFileOffset[]>;
  /** Whether the diarization claim check exists AND is non-empty. */
  diarizationValid?: (path: string) => Promise<boolean>;
  now?: () => Date;
};

async function defaultReadJson(path: string): Promise<unknown | undefined> {
  try {
    const text = await Bun.file(path).text();
    return parseAsrJson(text);
  } catch {
    return undefined;
  }
}

async function readFirstNonEmptyLine(path: string): Promise<string | undefined> {
  try {
    const text = await Bun.file(path).text();
    return text.split("\n").find((line) => line.trim().length > 0);
  } catch {
    return undefined;
  }
}

/**
 * Matches the pinned validity definition used everywhere else a diarization
 * claim check is read (run-actor.ts checkDiarizeResult, transcription-diarize.ts
 * isValidDiarizationResult, 00-architecture.md line 117): jsonl exists,
 * non-empty, AND its first line parses as JSON. A nonzero-size-but-corrupt/
 * partial jsonl (e.g. an interrupted write from a concurrent tactical
 * recovery) must NOT be adopted as "diarization already done" — that would
 * silently starve the track of a diarize actor forever.
 */
async function defaultDiarizationValid(path: string): Promise<boolean> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists()) || file.size === 0) return false;
  } catch {
    return false;
  }
  const firstLine = await readFirstNonEmptyLine(path);
  if (!firstLine) return false;
  try {
    JSON.parse(firstLine);
    return true;
  } catch {
    return false;
  }
}

function isValidAsrJson(value: unknown): value is { segments: Array<{ text?: string }> } {
  if (typeof value !== "object" || value === null) return false;
  const segments = (value as Record<string, unknown>).segments;
  return Array.isArray(segments) && segments.length > 0;
}

/**
 * Builds (or adopts) a TranscriptionPlan. All side effects (probe/ffmpeg/
 * rename/read) go through the injectable `deps` so tests run hermetic.
 */
export async function buildPlan(args: {
  requestId: string;
  artifactId: string;
  sourcePath: string;
  rigRoot: string;
  media: BuildPlanMediaItem[];
  chunkSeconds?: number;
  deps?: BuildPlanDeps;
}): Promise<TranscriptionPlan> {
  const chunkSeconds = args.chunkSeconds ?? 600;
  const deps = args.deps ?? {};
  const readJson = deps.readJson ?? defaultReadJson;
  const renameFile = deps.renameFile ?? ((from, to) => rename(from, to));
  const writeJson =
    deps.writeJson ??
    (async (path: string, value: unknown) => {
      const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmpPath, JSON.stringify(value));
      await rename(tmpPath, path);
    });
  const chunkAudio = deps.chunkAudio ?? ((chunkArgs) => chunkTrackAudio(chunkArgs));
  const offsetsFromFiles = deps.offsetsFromFiles ?? ((wavPaths) => chunkOffsetsFromFiles(wavPaths));
  const diarizationValid = deps.diarizationValid ?? defaultDiarizationValid;
  const now = deps.now ?? (() => new Date());

  const tracks: PlanTrack[] = [];
  const diarizeTracks: string[] = [];

  for (const item of args.media) {
    if (item.role === "ignored") continue;

    let asrDone = false;
    let chunks: PlanChunk[] = [];

    const asrPath = rigAsrPath(args.artifactId, item.sourceId);
    const existingAsr = await readJson(asrPath);
    if (isValidAsrJson(existingAsr)) {
      const verdict = screenWithCollapse(existingAsr.segments);
      if (!verdict.repetitive) {
        asrDone = true;
        // asrDone tracks skip aggregation entirely — the rig merges this file
        // as-is — so persist the collapsed segments here or decoder-loop
        // padding rides straight into the transcript.
        if (verdict.removed > 0) {
          await writeJson(asrPath, {
            ...existingAsr,
            segments: verdict.segments.map((segment, index) => ({ ...segment, id: index })),
          });
        }
      } else {
        const rejectedPath = `${asrPath}.rejected-${now().toISOString()}`;
        await renameFile(asrPath, rejectedPath);
      }
    }

    if (!asrDone) {
      const chunksDir = join(workRoot(args.artifactId), "raw", "chunked", item.sourceId, "chunks");
      const wavPaths = await chunkAudio({ mediaPath: item.path, chunksDir, chunkSeconds });
      const offsets = await offsetsFromFiles(wavPaths);
      chunks = offsets.map((offset) => ({
        index: offset.index,
        chunkId: chunkJobId({
          artifactId: args.artifactId,
          kind: "asr",
          sourceId: item.sourceId,
          index: offset.index,
        }),
        startMs: offset.startMs,
        endMs: offset.endMs,
        wavPath: offset.wavPath,
        resultPath: asrChunkResultPath(args.artifactId, item.sourceId, offset.index),
      }));
    }

    tracks.push({
      sourceId: item.sourceId,
      mediaPath: item.path,
      role: item.role,
      expectedSpeakers: item.expectedSpeakers,
      speaker: item.speaker,
      chunkSeconds,
      asrDone,
      chunks,
    });

    if (item.role === "diarize") {
      const diarizationPath = rigDiarizationPath(args.artifactId, item.sourceId);
      const valid = await diarizationValid(diarizationPath);
      if (!valid) diarizeTracks.push(item.sourceId);
    }
  }

  return {
    schemaVersion: "joelclaw.transcription.plan.v1",
    requestId: args.requestId,
    artifactId: args.artifactId,
    sourcePath: args.sourcePath,
    createdAt: now().toISOString(),
    tracks,
    diarizeTracks,
  };
}
