import { createHash } from "node:crypto";
import { join } from "node:path";
import { isProtectedHarnessPath } from "../lib/protected-harness-paths";

export const MEDIA_ROOT = "/Volumes/badass-media/";
export const DEFAULT_RIG_ROOT = "/Users/joel/Code/joelhooks/transcript-rig";

export function rigRoot(): string {
  const root = process.env.TRANSCRIPT_RIG_ROOT ?? DEFAULT_RIG_ROOT;
  if (isProtectedHarnessPath(root)) {
    throw new Error("transcript rig root cannot be inside a protected agent harness");
  }
  return root;
}

function assertSafePathSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error(`unsafe transcription ${label}`);
  }
}

/**
 * Mirrors transcript-rig `localWorkRoot()`: `<rigRoot>/.transcript-rig-work/<artifactId>`.
 * The rig computes this from its own cwd, so anything we spawn must run with
 * cwd = rigRoot or the two disagree about where claim checks live.
 */
function safeWorkPath(artifactId: string, ...segments: string[]): string {
  const path = join(workRoot(artifactId), ...segments);
  if (isProtectedHarnessPath(path)) {
    throw new Error("transcription work path cannot resolve inside a protected agent harness");
  }
  return path;
}

export function workRoot(artifactId: string): string {
  assertSafePathSegment(artifactId, "artifactId");
  const path = join(rigRoot(), ".transcript-rig-work", artifactId);
  if (isProtectedHarnessPath(path)) {
    throw new Error("transcription work root cannot resolve inside a protected agent harness");
  }
  return path;
}

export function rigStatePath(artifactId: string): string {
  return safeWorkPath(artifactId, "state.v1.json");
}

/** Our own orchestration state, kept beside the rig's claim checks. */
export function orchestrationRoot(artifactId: string): string {
  return safeWorkPath(artifactId, "orchestration");
}

export function planPath(artifactId: string): string {
  return safeWorkPath(artifactId, "orchestration", "plan.v1.json");
}

export function actorRoot(artifactId: string, chunkId: string): string {
  assertSafePathSegment(chunkId, "chunkId");
  return safeWorkPath(artifactId, "orchestration", "actors", chunkId);
}

export function actorStatusPath(artifactId: string, chunkId: string): string {
  return safeWorkPath(artifactId, "orchestration", "actors", chunkId, "status.v1.json");
}

export function actorLogPath(artifactId: string, chunkId: string): string {
  return safeWorkPath(artifactId, "orchestration", "actors", chunkId, "actor.log");
}

/**
 * Claim check produced by an ASR chunk actor. Aggregation stitches these into
 * the rig's whole-track `raw/asr/<sourceId>/asr.json`.
 */
export function asrChunkResultPath(artifactId: string, sourceId: string, index: number): string {
  assertSafePathSegment(sourceId, "sourceId");
  return safeWorkPath(artifactId, "raw", "chunked", sourceId, "out", String(index), "asr.json");
}

export function asrChunkAudioPath(artifactId: string, sourceId: string, index: number): string {
  assertSafePathSegment(sourceId, "sourceId");
  return safeWorkPath(
    artifactId,
    "raw",
    "chunked",
    sourceId,
    "chunks",
    `${String(index).padStart(3, "0")}.wav`,
  );
}

/** The rig's own ASR claim check for a whole track. Aggregation writes this. */
export function rigAsrPath(artifactId: string, sourceId: string): string {
  assertSafePathSegment(sourceId, "sourceId");
  return safeWorkPath(artifactId, "raw", "asr", sourceId, "asr.json");
}

/** The rig's diarization claim check. A diarize actor writes this directly. */
export function rigDiarizationPath(artifactId: string, sourceId: string): string {
  assertSafePathSegment(sourceId, "sourceId");
  return safeWorkPath(artifactId, "raw", "diarization", `${sourceId}.jsonl`);
}

export function rigDiarizationWavPath(artifactId: string, sourceId: string): string {
  assertSafePathSegment(sourceId, "sourceId");
  return safeWorkPath(artifactId, "raw", "diarization", `${sourceId}.16khz-mono.wav`);
}

function shortHash(text: string, length = 20): string {
  return createHash("sha256").update(text).digest("hex").slice(0, length);
}

/**
 * Deterministic chunk id. Same plan inputs always produce the same id, which is
 * what makes retries idempotent and duplicate dispatch detectable.
 */
export function chunkJobId(args: {
  artifactId: string;
  kind: "asr" | "diarize";
  sourceId: string;
  index: number;
}): string {
  return `${args.kind}_${shortHash(
    `${args.artifactId}:${args.kind}:${args.sourceId}:${args.index}`,
  )}`;
}

/**
 * Actor id is chunk id + attempt: a retry gets a distinct actor, so a stale
 * actor's callback can never be mistaken for the current one.
 */
export function actorId(chunkId: string, attempt: number): string {
  return `${chunkId}#${attempt}`;
}
