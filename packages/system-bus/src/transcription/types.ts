/**
 * Pinned interface contracts shared across the transcription slices (see
 * 00-architecture.md). Plain TS types, no Zod — the repo convention for
 * event/plan-shaped data. Runtime guards are defensive field checks only.
 */

export type PlanChunk = {
  index: number;
  /** chunkJobId({artifactId, kind: "asr", sourceId, index}) */
  chunkId: string;
  /** offset of chunk start within the track (cumulative ffprobe durations). */
  startMs: number;
  endMs: number;
  /** absolute path */
  wavPath: string;
  /** absolute path, .../out/<i>/asr.json */
  resultPath: string;
};

export type PlanTrack = {
  sourceId: string;
  /** absolute source media path (immutable, read-only) */
  mediaPath: string;
  /** rig MediaFile role ("diarize" means also diarized) */
  role: string;
  expectedSpeakers?: number;
  /** known-speaker label if any */
  speaker?: string;
  /** 600 default */
  chunkSeconds: number;
  /** whole-track asr.json existed & passed screen at plan time */
  asrDone: boolean;
  /** empty when asrDone */
  chunks: PlanChunk[];
};

export type TranscriptionPlan = {
  schemaVersion: "joelclaw.transcription.plan.v1";
  requestId: string;
  artifactId: string;
  sourcePath: string;
  createdAt: string;
  tracks: PlanTrack[];
  /** sourceIds needing diarization (and lacking a valid jsonl) */
  diarizeTracks: string[];
};

export type ActorKind = "asr" | "diarize";

export type ActorState = "running" | "succeeded" | "failed" | "cancelled";

export type ActorStatus = {
  schemaVersion: "joelclaw.transcription.actor-status.v1";
  /** `${chunkId}#${attempt}` */
  actorId: string;
  chunkId: string;
  kind: ActorKind;
  requestId: string;
  artifactId: string;
  /** actor process pid == pgid (group leader) */
  pid: number;
  startedAt: string;
  /** refreshed every 15s while child runs */
  heartbeatAt: string;
  state: ActorState;
  exitCode?: number;
  /** typed reason, e.g. "repetitive_output: ..." */
  error?: string;
  resultPath?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function invalidPlan(reason: string): never {
  throw new Error(`invalid_plan: ${reason}`);
}

function parseChunk(value: unknown, path: string): PlanChunk {
  if (!isRecord(value)) invalidPlan(`${path} is not an object`);
  if (typeof value.index !== "number") invalidPlan(`${path}.index missing`);
  if (typeof value.chunkId !== "string") invalidPlan(`${path}.chunkId missing`);
  if (typeof value.startMs !== "number") invalidPlan(`${path}.startMs missing`);
  if (typeof value.endMs !== "number") invalidPlan(`${path}.endMs missing`);
  if (typeof value.wavPath !== "string") invalidPlan(`${path}.wavPath missing`);
  if (typeof value.resultPath !== "string") invalidPlan(`${path}.resultPath missing`);
  return value as PlanChunk;
}

function parseTrack(value: unknown, path: string): PlanTrack {
  if (!isRecord(value)) invalidPlan(`${path} is not an object`);
  if (typeof value.sourceId !== "string") invalidPlan(`${path}.sourceId missing`);
  if (typeof value.mediaPath !== "string") invalidPlan(`${path}.mediaPath missing`);
  if (typeof value.role !== "string") invalidPlan(`${path}.role missing`);
  if (typeof value.chunkSeconds !== "number") invalidPlan(`${path}.chunkSeconds missing`);
  if (typeof value.asrDone !== "boolean") invalidPlan(`${path}.asrDone missing`);
  if (!Array.isArray(value.chunks)) invalidPlan(`${path}.chunks missing`);
  value.chunks.forEach((chunk, index) => parseChunk(chunk, `${path}.chunks[${index}]`));
  return value as PlanTrack;
}

/** Throws a typed Error on mismatch. */
export function parsePlan(json: unknown): TranscriptionPlan {
  if (!isRecord(json)) invalidPlan("not an object");
  if (json.schemaVersion !== "joelclaw.transcription.plan.v1") {
    invalidPlan(`unexpected schemaVersion ${JSON.stringify(json.schemaVersion)}`);
  }
  if (typeof json.requestId !== "string") invalidPlan("requestId missing");
  if (typeof json.artifactId !== "string") invalidPlan("artifactId missing");
  if (typeof json.sourcePath !== "string") invalidPlan("sourcePath missing");
  if (typeof json.createdAt !== "string") invalidPlan("createdAt missing");
  if (!Array.isArray(json.tracks)) invalidPlan("tracks missing");
  if (!Array.isArray(json.diarizeTracks)) invalidPlan("diarizeTracks missing");
  json.tracks.forEach((track, index) => parseTrack(track, `tracks[${index}]`));
  json.diarizeTracks.forEach((sourceId, index) => {
    if (typeof sourceId !== "string") invalidPlan(`diarizeTracks[${index}] is not a string`);
  });
  return json as TranscriptionPlan;
}

const ACTOR_KINDS: ActorKind[] = ["asr", "diarize"];
const ACTOR_STATES: ActorState[] = ["running", "succeeded", "failed", "cancelled"];

/** Returns undefined (never throws) on mismatch. */
export function parseActorStatus(json: unknown): ActorStatus | undefined {
  if (!isRecord(json)) return undefined;
  if (json.schemaVersion !== "joelclaw.transcription.actor-status.v1") return undefined;
  if (typeof json.actorId !== "string") return undefined;
  if (typeof json.chunkId !== "string") return undefined;
  if (typeof json.kind !== "string" || !ACTOR_KINDS.includes(json.kind as ActorKind)) return undefined;
  if (typeof json.requestId !== "string") return undefined;
  if (typeof json.artifactId !== "string") return undefined;
  if (typeof json.pid !== "number") return undefined;
  if (typeof json.startedAt !== "string") return undefined;
  if (typeof json.heartbeatAt !== "string") return undefined;
  if (typeof json.state !== "string" || !ACTOR_STATES.includes(json.state as ActorState)) return undefined;
  if (json.exitCode !== undefined && typeof json.exitCode !== "number") return undefined;
  if (json.error !== undefined && typeof json.error !== "string") return undefined;
  if (json.resultPath !== undefined && typeof json.resultPath !== "string") return undefined;
  return json as ActorStatus;
}
