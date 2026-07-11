/**
 * Detached actor runner. One process per ASR chunk or per whole-track
 * diarization job: spawned by spawn.ts (own process group, unref'd), reads/
 * writes claim checks and status files, and exits — Inngest never holds a
 * request open across the inference it launches.
 *
 * Callable two ways:
 *   - `bun run-actor.ts --kind ... --artifact ... ...` (real detached actor)
 *   - `runActor(args, deps)` in-process, for hermetic tests.
 */
import { appendFileSync, closeSync, openSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Subprocess } from "bun";
import { inngest } from "../../inngest/client";
import {
  actorLogPath,
  actorStatusPath,
  asrChunkAudioPath,
  asrChunkResultPath,
  actorId as buildActorId,
  chunkJobId,
  planPath,
  rigDiarizationPath,
  rigDiarizationWavPath,
} from "../paths";
import { detectPathologicalRepetition } from "../repetition";
import { writeActorStatusAtomic } from "../status";
import type { ActorKind, ActorState, ActorStatus } from "../types";
import { parsePlan } from "../types";

type ActorChild = Subprocess<"ignore", number, number>;

export type RunActorArgs = {
  kind: ActorKind;
  artifactId: string;
  requestId: string;
  sourceId: string;
  index: number;
  attempt: number;
  rigRoot: string;
  /** Identity string for ps-based kill verification; must equal actorId(chunkId, attempt). */
  actorTag: string;
};

export type ActorFinishedEventData = {
  requestId: string;
  artifactId: string;
  actorId: string;
  chunkId: string;
  kind: ActorKind;
  status: "succeeded" | "failed";
  error?: string;
  resultPath?: string;
};

export type RunActorDeps = {
  /** Best-effort finished-event sender. Default: real inngest client. */
  sendEvent?: (data: ActorFinishedEventData) => Promise<void>;
  now?: () => Date;
  /**
   * Resolves the source media path (and expected speaker count) for a
   * diarize track. Not pinned by an explicit CLI flag — the actor derives it
   * from `orchestration/plan.v1.json`, which system-bus owns and writes
   * before any chunk/diarize actor is spawned.
   */
  readTrackMediaPath?: (
    artifactId: string,
    sourceId: string,
  ) => Promise<{ mediaPath: string; expectedSpeakers?: number } | undefined>;
};

async function defaultSendEvent(data: ActorFinishedEventData): Promise<void> {
  await inngest.send({ name: "media/transcription.actor.finished", data });
}

async function defaultReadTrackMediaPath(
  artifactId: string,
  sourceId: string,
): Promise<{ mediaPath: string; expectedSpeakers?: number } | undefined> {
  try {
    const text = await readFile(planPath(artifactId), "utf8");
    const plan = parsePlan(JSON.parse(text));
    const track = plan.tracks.find((candidate) => candidate.sourceId === sourceId);
    if (!track) return undefined;
    return { mediaPath: track.mediaPath, expectedSpeakers: track.expectedSpeakers };
  } catch {
    return undefined;
  }
}

type ResultCheck = { valid: boolean; repetitive?: boolean; reason?: string };

async function checkAsrResult(resultPath: string): Promise<ResultCheck> {
  let text: string;
  try {
    text = await readFile(resultPath, "utf8");
  } catch {
    return { valid: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { valid: false };
  }
  const segments = (parsed as { segments?: unknown }).segments;
  if (!Array.isArray(segments) || segments.length === 0) return { valid: false };
  const verdict = detectPathologicalRepetition(segments as Array<{ text?: string }>);
  if (verdict.repetitive) return { valid: false, repetitive: true, reason: verdict.reason };
  return { valid: true };
}

async function checkDiarizeResult(jsonlPath: string): Promise<ResultCheck> {
  let text: string;
  try {
    text = await readFile(jsonlPath, "utf8");
  } catch {
    return { valid: false };
  }
  if (text.trim().length === 0) return { valid: false };
  const firstLine = text.split("\n")[0] ?? "";
  try {
    JSON.parse(firstLine);
  } catch {
    return { valid: false, reason: "diarize_invalid_first_line" };
  }
  return { valid: true };
}

async function checkExistingResult(kind: ActorKind, resultPath: string): Promise<ResultCheck> {
  return kind === "asr" ? checkAsrResult(resultPath) : checkDiarizeResult(resultPath);
}

function parseOverrideCommand(): string[] | undefined {
  const raw = process.env.TRANSCRIPTION_ACTOR_CMD_OVERRIDE;
  if (!raw) return undefined;
  let argv: unknown;
  try {
    argv = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid_override: TRANSCRIPTION_ACTOR_CMD_OVERRIDE is not JSON: ${String(error)}`);
  }
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== "string") {
    throw new Error("invalid_override: TRANSCRIPTION_ACTOR_CMD_OVERRIDE must be a non-empty JSON array of strings");
  }
  return argv as string[];
}

function buildAsrCommand(wavPath: string, outputDir: string): string[] {
  return [
    "mlx_whisper",
    wavPath,
    "--model",
    "mlx-community/whisper-large-v3-mlx",
    "--word-timestamps",
    "True",
    "--language",
    "en",
    "--output-format",
    "json",
    "--output-dir",
    outputDir,
    "--output-name",
    "asr",
  ];
}

function buildDiarizeCommand(
  wavPath: string,
  jsonlPath: string,
  expectedSpeakers: number | undefined,
): string[] {
  const speakers = String(expectedSpeakers ?? 2);
  return [
    "uv",
    "run",
    "python",
    "python/transcript_rig/diarize.py",
    wavPath,
    "--output",
    jsonlPath,
    "--min-speakers",
    speakers,
    "--max-speakers",
    speakers,
  ];
}

function buildDownmixCommand(mediaPath: string, preparedWavPath: string): string[] {
  return ["ffmpeg", "-v", "error", "-i", mediaPath, "-ac", "1", "-ar", "16000", preparedWavPath];
}

async function waitForExit(child: ActorChild): Promise<number> {
  try {
    return await child.exited;
  } catch {
    return -1;
  }
}

/**
 * Runs one actor to completion (or until signalled) and returns an
 * exit-code-equivalent number: 0 on success, 1 otherwise. Terminal ordering
 * is always: write final status atomically, THEN best-effort send the
 * finished event.
 */
export async function runActor(args: RunActorArgs, deps: RunActorDeps = {}): Promise<number> {
  // paths.ts derives everything from process.env.TRANSCRIPT_RIG_ROOT; align
  // it with the --rig-root this actor was launched with before touching any
  // path helper.
  process.env.TRANSCRIPT_RIG_ROOT = args.rigRoot;

  const now = deps.now ?? (() => new Date());
  const sendEvent = deps.sendEvent ?? defaultSendEvent;
  const readTrackMediaPath = deps.readTrackMediaPath ?? defaultReadTrackMediaPath;

  const chunkId = chunkJobId({
    artifactId: args.artifactId,
    kind: args.kind,
    sourceId: args.sourceId,
    index: args.index,
  });
  const expectedTag = buildActorId(chunkId, args.attempt);
  if (args.actorTag !== expectedTag) {
    throw new Error(`actor_tag_mismatch: expected ${expectedTag}, got ${args.actorTag}`);
  }

  const logPath = actorLogPath(args.artifactId, chunkId);
  await mkdir(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");
  const log = (line: string): void => {
    try {
      appendFileSync(logFd, `${line}\n`);
    } catch {
      // best-effort logging only
    }
  };

  const statusPath = actorStatusPath(args.artifactId, chunkId);
  const startedAt = now().toISOString();

  const makeStatus = (overrides: Partial<ActorStatus>): ActorStatus => ({
    schemaVersion: "joelclaw.transcription.actor-status.v1",
    actorId: expectedTag,
    chunkId,
    kind: args.kind,
    requestId: args.requestId,
    artifactId: args.artifactId,
    pid: process.pid,
    startedAt,
    heartbeatAt: now().toISOString(),
    state: "running",
    ...overrides,
  });

  await writeActorStatusAtomic(statusPath, makeStatus({}));

  const wavPath =
    args.kind === "asr"
      ? asrChunkAudioPath(args.artifactId, args.sourceId, args.index)
      : rigDiarizationWavPath(args.artifactId, args.sourceId);
  const resultPath =
    args.kind === "asr"
      ? asrChunkResultPath(args.artifactId, args.sourceId, args.index)
      : rigDiarizationPath(args.artifactId, args.sourceId);

  let activeChild: ActorChild | undefined;
  let cancelled = false;
  let escalationTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;

  const onSignal = (signal: NodeJS.Signals): void => {
    cancelled = true;
    log(`received ${signal}; terminating child`);
    try {
      activeChild?.kill("SIGTERM");
    } catch {
      // already gone
    }
    escalationTimer = setTimeout(() => {
      try {
        activeChild?.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 10_000);
    escalationTimer.unref();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const cleanup = (): void => {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (escalationTimer) clearTimeout(escalationTimer);
  };

  const finish = async (state: ActorState, extra: Partial<ActorStatus> = {}): Promise<number> => {
    cleanup();
    const finalStatus = makeStatus({ state, ...extra });
    await writeActorStatusAtomic(statusPath, finalStatus);
    const eventStatus: "succeeded" | "failed" = state === "succeeded" ? "succeeded" : "failed";
    try {
      await sendEvent({
        requestId: args.requestId,
        artifactId: args.artifactId,
        actorId: expectedTag,
        chunkId,
        kind: args.kind,
        status: eventStatus,
        error: finalStatus.error,
        resultPath: finalStatus.resultPath,
      });
    } catch (error) {
      log(`failed to send actor.finished event: ${String(error)}`);
    }
    closeSync(logFd);
    return state === "succeeded" ? 0 : 1;
  };

  try {
    // Idempotency check: a valid existing result means no inference needed.
    const initialCheck = await checkExistingResult(args.kind, resultPath);
    if (initialCheck.valid) {
      return await finish("succeeded", { exitCode: 0, resultPath });
    }
    if (initialCheck.repetitive) {
      log(`existing result repetitive (${initialCheck.reason}); deleting and re-running`);
      await rm(resultPath, { force: true }).catch(() => {});
    }

    let expectedSpeakers: number | undefined;
    if (args.kind === "diarize") {
      const wavExists = await Bun.file(wavPath).exists();
      const track = await readTrackMediaPath(args.artifactId, args.sourceId);
      expectedSpeakers = track?.expectedSpeakers;
      if (!wavExists) {
        if (!track) {
          return await finish("failed", { error: `missing_plan_track: ${args.sourceId}` });
        }
        await mkdir(dirname(wavPath), { recursive: true });
        const downmixArgv = buildDownmixCommand(track.mediaPath, wavPath);
        log(`downmix: ${downmixArgv.join(" ")}`);
        activeChild = Bun.spawn(downmixArgv, { stdio: ["ignore", logFd, logFd] }) as ActorChild;
        const downmixCode = await waitForExit(activeChild);
        activeChild = undefined;
        if (cancelled) {
          return await finish("cancelled", { error: "cancelled_by_signal" });
        }
        if (downmixCode !== 0) {
          return await finish("failed", { error: `downmix_failed_exit_${downmixCode}` });
        }
      }
    } else {
      await mkdir(dirname(resultPath), { recursive: true });
    }

    // Guard the actual inference spawn regardless of which branch above ran
    // (ASR never enters the diarize block at all; diarize-with-existing-wav
    // skips the whole downmix sub-branch) — this is the only place a
    // cancellation received during idempotency-check/mkdir/downmix I/O can
    // still be observed before we'd otherwise launch mlx_whisper/diarize.py
    // unmonitored. No `await` separates this check from the spawn below, so
    // a signal arriving after this line is still caught by onSignal killing
    // `activeChild` directly once it's assigned.
    if (cancelled) {
      return await finish("cancelled", { error: "cancelled_by_signal" });
    }

    const override = parseOverrideCommand();
    const argv =
      override ??
      (args.kind === "asr"
        ? buildAsrCommand(wavPath, dirname(resultPath))
        : buildDiarizeCommand(wavPath, resultPath, expectedSpeakers));

    log(`spawning inference: ${argv.join(" ")}`);
    activeChild = Bun.spawn(argv, {
      cwd: args.kind === "diarize" ? args.rigRoot : undefined,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        TRANSCRIPTION_ACTOR_WAV_PATH: wavPath,
        TRANSCRIPTION_ACTOR_RESULT_PATH: resultPath,
      },
    }) as ActorChild;

    const heartbeatMs = Number(process.env.TRANSCRIPTION_ACTOR_HEARTBEAT_MS ?? 15_000);
    heartbeatTimer = setInterval(() => {
      writeActorStatusAtomic(statusPath, makeStatus({})).catch((error) =>
        log(`heartbeat write failed: ${String(error)}`),
      );
    }, heartbeatMs);
    heartbeatTimer.unref();

    const exitCode = await waitForExit(activeChild);
    activeChild = undefined;

    if (cancelled) {
      return await finish("cancelled", {
        exitCode,
        error: "cancelled_by_signal",
      });
    }

    // Group kills (killActorGroup, cleanup, an operator's kill -TERM -pgid)
    // race Bun's in-process signal dispatch: the child reliably dies with the
    // signal's exit code while this process's own SIGTERM handler sometimes
    // never fires. The only legitimate senders of SIGTERM/SIGINT/SIGKILL at
    // the inference child are those group kills — a signal death we did not
    // initiate (cancelled would be true if we had) is a cancellation, not an
    // inference failure, and must not burn an Inngest retry.
    if (exitCode === 130 || exitCode === 137 || exitCode === 143) {
      return await finish("cancelled", {
        exitCode,
        error: "cancelled_by_signal",
      });
    }

    if (exitCode !== 0) {
      return await finish("failed", {
        exitCode,
        error: `child_exit_${exitCode}`,
      });
    }

    const finalCheck = await checkExistingResult(args.kind, resultPath);
    if (!finalCheck.valid) {
      if (args.kind === "asr" && finalCheck.repetitive) {
        const rejectedPath = `${resultPath}.rejected-${now().toISOString()}`;
        await rename(resultPath, rejectedPath).catch((error) =>
          log(`quarantine rename failed: ${String(error)}`),
        );
        return await finish("failed", { exitCode: 0, error: `repetitive_output: ${finalCheck.reason}` });
      }
      return await finish("failed", {
        exitCode: 0,
        error: finalCheck.reason ?? `${args.kind}_invalid_output`,
      });
    }

    return await finish("succeeded", { exitCode: 0, resultPath });
  } catch (error) {
    log(`unexpected error: ${String(error)}`);
    return await finish("failed", { error: `actor_error: ${String(error)}` });
  }
}

function parseArgv(argv: string[]): RunActorArgs {
  const get = (flag: string): string | undefined => {
    const flagIndex = argv.indexOf(flag);
    if (flagIndex === -1) return undefined;
    return argv[flagIndex + 1];
  };

  const kind = get("--kind");
  const artifactId = get("--artifact");
  const requestId = get("--request");
  const sourceId = get("--source");
  const indexRaw = get("--index");
  const attemptRaw = get("--attempt");
  const rigRoot = get("--rig-root");
  const actorTag = get("--actor-tag");

  if (kind !== "asr" && kind !== "diarize") throw new Error("run-actor: --kind must be asr or diarize");
  if (!artifactId) throw new Error("run-actor: --artifact is required");
  if (!requestId) throw new Error("run-actor: --request is required");
  if (!sourceId) throw new Error("run-actor: --source is required");
  if (indexRaw === undefined) throw new Error("run-actor: --index is required");
  if (attemptRaw === undefined) throw new Error("run-actor: --attempt is required");
  if (!rigRoot) throw new Error("run-actor: --rig-root is required");
  if (!actorTag) throw new Error("run-actor: --actor-tag is required");

  return {
    kind,
    artifactId,
    requestId,
    sourceId,
    index: Number(indexRaw),
    attempt: Number(attemptRaw),
    rigRoot,
    actorTag,
  };
}

if (import.meta.main) {
  const args = parseArgv(process.argv.slice(2));
  runActor(args)
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
