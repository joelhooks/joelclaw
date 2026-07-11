import { createHash } from "node:crypto";
import { join } from "node:path";

export const MEDIA_ROOT = "/Volumes/badass-media/";
export const DEFAULT_RIG_ROOT = "/Users/joel/Code/joelhooks/transcript-rig";

export function rigRoot(): string {
  return process.env.TRANSCRIPT_RIG_ROOT ?? DEFAULT_RIG_ROOT;
}

/**
 * Mirrors transcript-rig `localWorkRoot()`: `<rigRoot>/.transcript-rig-work/<artifactId>`.
 * The rig computes this from its own cwd, so anything we spawn must run with
 * cwd = rigRoot or the two disagree about where claim checks live.
 */
export function workRoot(artifactId: string): string {
  return join(rigRoot(), ".transcript-rig-work", artifactId);
}

export function rigStatePath(artifactId: string): string {
  return join(workRoot(artifactId), "state.v1.json");
}

/** Our own orchestration state, kept beside the rig's claim checks. */
export function orchestrationRoot(artifactId: string): string {
  return join(workRoot(artifactId), "orchestration");
}

export function planPath(artifactId: string): string {
  return join(orchestrationRoot(artifactId), "plan.v1.json");
}

export function actorRoot(artifactId: string, chunkId: string): string {
  return join(orchestrationRoot(artifactId), "actors", chunkId);
}

export function actorStatusPath(artifactId: string, chunkId: string): string {
  return join(actorRoot(artifactId, chunkId), "status.v1.json");
}

export function actorLogPath(artifactId: string, chunkId: string): string {
  return join(actorRoot(artifactId, chunkId), "actor.log");
}

/**
 * Claim check produced by an ASR chunk actor. Aggregation stitches these into
 * the rig's whole-track `raw/asr/<sourceId>/asr.json`.
 */
export function asrChunkResultPath(
  artifactId: string,
  sourceId: string,
  index: number,
): string {
  return join(
    workRoot(artifactId),
    "raw",
    "chunked",
    sourceId,
    "out",
    String(index),
    "asr.json",
  );
}

export function asrChunkAudioPath(
  artifactId: string,
  sourceId: string,
  index: number,
): string {
  return join(
    workRoot(artifactId),
    "raw",
    "chunked",
    sourceId,
    "chunks",
    `${String(index).padStart(3, "0")}.wav`,
  );
}

/** The rig's own ASR claim check for a whole track. Aggregation writes this. */
export function rigAsrPath(artifactId: string, sourceId: string): string {
  return join(workRoot(artifactId), "raw", "asr", sourceId, "asr.json");
}

/** The rig's diarization claim check. A diarize actor writes this directly. */
export function rigDiarizationPath(artifactId: string, sourceId: string): string {
  return join(workRoot(artifactId), "raw", "diarization", `${sourceId}.jsonl`);
}

export function rigDiarizationWavPath(
  artifactId: string,
  sourceId: string,
): string {
  return join(
    workRoot(artifactId),
    "raw",
    "diarization",
    `${sourceId}.16khz-mono.wav`,
  );
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
