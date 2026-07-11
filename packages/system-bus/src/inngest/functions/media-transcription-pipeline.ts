/**
 * Media Transcription Pipeline v2 (00-architecture.md).
 *
 * Inngest orchestrates; inference runs in detached local actor processes
 * launched by transcription-asr-chunk-v1 / transcription-diarize-v1. No step
 * in this function ever holds a request open across inference — ASR is
 * chunked and diarization runs as a watched detached actor instead of a
 * request-bound execa call.
 *
 * runRig/leaseSecret/verifyMediaMount/recordStage moved to ../../transcription/rig
 * (slice T). This file only orchestrates.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { NonRetriableError } from "inngest";
import { aggregateChunkAsr, writeAggregatedAsr } from "../../transcription/aggregate";
import { buildPlan } from "../../transcription/chunking";
import {
  chunkJobId,
  planPath,
  rigDiarizationPath,
  rigDiarizationWavPath,
  workRoot,
} from "../../transcription/paths";
import {
  DEFAULT_RIG_ROOT,
  MEDIA_ROOT,
  recordStage,
  runRig,
  verifyMediaMount,
} from "../../transcription/rig";
import { parsePlan, type TranscriptionPlan } from "../../transcription/types";
import { inngest } from "../client";

/**
 * Injectable seam for rig-CLI side-effects. Tests stub these properties
 * directly instead of mock.module(), which patches the process-wide module
 * registry and breaks sibling test files in combined runs.
 */
export const pipelineDeps = { runRig, verifyMediaMount, recordStage };

import { transcriptionAsrChunkRun } from "./transcription-asr-chunk";
import { transcriptionDiarizeRun } from "./transcription-diarize";

async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(value, null, 2));
  await rename(tmpPath, path);
}

type ManifestMediaEntry = {
  sourceId?: string;
  path?: string;
  role?: string;
  expectedSpeakers?: number;
  speaker?: string;
};

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export const mediaTranscriptionPipeline = inngest.createFunction(
  {
    id: "media-transcription-pipeline-v2",
    name: "Media Transcription Pipeline v2",
    idempotency: "event.data.requestId",
    concurrency: { key: '"media-transcription"', limit: 1 },
    timeouts: { start: "30m", finish: "12h" },
    cancelOn: [
      {
        event: "media/transcription.cancelled",
        if: "event.data.requestId == async.data.requestId",
      },
    ],
    onFailure: async ({ event, error, step }) => {
      const failureData = (
        event as unknown as { data?: { requestId?: string; sourcePath?: string } }
      ).data;
      const requestId = failureData?.requestId ?? "unknown";
      const sourcePath = failureData?.sourcePath ?? "unknown";
      await step.sendEvent("emit-transcription-failed", {
        name: "media/transcription.failed",
        data: {
          requestId,
          sourcePath,
          error: stringifyError(error),
        },
      });
    },
  },
  { event: "media/transcription.requested" },
  async ({ event, step }) => {
    const { requestId, sourcePath, publish = true, index = true } = event.data;
    const absoluteSource = resolve(sourcePath);
    if (!absoluteSource.startsWith(MEDIA_ROOT)) {
      throw new NonRetriableError(
        `sourcePath must be under mounted ${MEDIA_ROOT}; got ${sourcePath}`,
      );
    }
    const rigRoot = process.env.TRANSCRIPT_RIG_ROOT ?? DEFAULT_RIG_ROOT;

    const mount = await step.run("00-verify-badass-media-mount", async () =>
      pipelineDeps.verifyMediaMount(absoluteSource),
    );
    if (!mount.available && mount.blocker) {
      await step.sendEvent("emit-transcription-blocked", {
        name: "media/transcription.blocked",
        data: {
          requestId,
          sourcePath: absoluteSource,
          blocker: mount.blocker,
        },
      });
      return {
        requestId,
        sourcePath: absoluteSource,
        status: "blocked" as const,
        blocker: mount.blocker,
      };
    }

    const staged = await step.run("01-stage-manifest", async () => {
      const result = await pipelineDeps.runRig(["run", absoluteSource, "--until", "staged"]);
      await pipelineDeps.recordStage(requestId, absoluteSource, "staged", result);
      const manifestPath = result.claimChecks?.manifest;
      if (!manifestPath) {
        throw new Error(
          `stage_manifest_missing: rig result had no claimChecks.manifest for ${absoluteSource}`,
        );
      }
      const manifestJson = await readJsonIfExists(manifestPath);
      const rawMedia = (manifestJson as { media?: ManifestMediaEntry[] } | undefined)
        ?.media;
      if (!Array.isArray(rawMedia)) {
        throw new Error(`stage_manifest_invalid: no media[] in ${manifestPath}`);
      }
      const media = rawMedia
        .filter(
          (entry): entry is Required<Pick<ManifestMediaEntry, "sourceId" | "path" | "role">> &
            ManifestMediaEntry =>
            typeof entry.sourceId === "string" &&
            typeof entry.path === "string" &&
            typeof entry.role === "string",
        )
        .map((entry) => ({
          sourceId: entry.sourceId,
          path: entry.path,
          role: entry.role,
          expectedSpeakers: entry.expectedSpeakers,
          speaker: entry.speaker,
        }));
      const artifactId =
        result.artifactId ??
        (manifestJson as { artifactId?: string } | undefined)?.artifactId;
      if (!artifactId) {
        throw new Error(`stage_manifest_missing_artifact_id: ${absoluteSource}`);
      }
      return { artifactId, media };
    });

    const plan = await step.run("02-plan-chunks", async () => {
      const existingRaw = await readJsonIfExists(planPath(staged.artifactId));
      if (existingRaw) {
        try {
          const existingPlan = parsePlan(existingRaw);
          if (existingPlan.requestId === requestId) return existingPlan;
        } catch {
          // fall through and rebuild — a corrupt/foreign plan file is not
          // trustworthy for this requestId.
        }
      }
      const builtPlan = await buildPlan({
        requestId,
        artifactId: staged.artifactId,
        sourcePath: absoluteSource,
        rigRoot,
        media: staged.media,
      });
      await writeJsonAtomic(planPath(staged.artifactId), builtPlan);
      return builtPlan;
    });

    const invokes: Promise<unknown>[] = [];
    for (const track of plan.tracks) {
      for (const chunk of track.chunks) {
        invokes.push(
          step.invoke(`03-asr-chunk-${chunk.chunkId}`, {
            function: transcriptionAsrChunkRun,
            data: {
              requestId,
              artifactId: plan.artifactId,
              sourcePath: absoluteSource,
              rigRoot,
              sourceId: track.sourceId,
              chunkId: chunk.chunkId,
              index: chunk.index,
              total: track.chunks.length,
              wavPath: chunk.wavPath,
              resultPath: chunk.resultPath,
              chunkSeconds: track.chunkSeconds,
            },
            // Invoke timeouts include queue time: chunks serialize behind the
            // single-GPU concurrency key, so a long meeting's tail chunks can
            // sit queued for hours before their own few-minute run.
            timeout: "6h",
          }),
        );
      }
    }
    for (const sourceId of plan.diarizeTracks) {
      const track = plan.tracks.find((candidate) => candidate.sourceId === sourceId);
      const diarizeChunkId = chunkJobId({
        artifactId: plan.artifactId,
        kind: "diarize",
        sourceId,
        index: 0,
      });
      invokes.push(
        step.invoke(`03-diarize-${sourceId}`, {
          function: transcriptionDiarizeRun,
          data: {
            requestId,
            artifactId: plan.artifactId,
            sourcePath: absoluteSource,
            rigRoot,
            sourceId,
            chunkId: diarizeChunkId,
            total: 1,
            wavPath: rigDiarizationWavPath(plan.artifactId, sourceId),
            resultPath: rigDiarizationPath(plan.artifactId, sourceId),
            expectedSpeakers: track?.expectedSpeakers,
          },
          timeout: "10h",
        }),
      );
    }
    await Promise.all(invokes);

    for (const track of plan.tracks) {
      if (track.asrDone) continue;
      await step.run(`04-aggregate-asr-${track.sourceId}`, async () => {
        const { asr } = await aggregateChunkAsr({
          artifactId: plan.artifactId,
          sourceId: track.sourceId,
          chunks: track.chunks,
        });
        await writeAggregatedAsr(plan.artifactId, track.sourceId, asr);
        return { sourceId: track.sourceId, segments: asr.segments.length };
      });
    }

    const merged = await step.run("05-merge-words", async () => {
      const result = await pipelineDeps.runRig([
        "resume",
        absoluteSource,
        "--until",
        "merged",
        "--no-inference",
      ]);
      await pipelineDeps.recordStage(requestId, absoluteSource, "merged", result);
      return result;
    });

    const exported = await step.run("06-render-editorial", async () => {
      const result = await pipelineDeps.runRig([
        "resume",
        absoluteSource,
        "--until",
        "exported",
        "--no-inference",
      ]);
      await pipelineDeps.recordStage(requestId, absoluteSource, "exported", result);
      return result;
    });

    const completed = await step.run("07-index-and-publish", async () => {
      const args = ["resume", absoluteSource, "--no-inference"];
      if (index) args.push("--index");
      if (publish) args.push("--publish");
      const result = await pipelineDeps.runRig(args, { needsTypesense: index });
      await pipelineDeps.recordStage(requestId, absoluteSource, "complete", result);
      return result;
    });

    const outputRoot = workRoot(plan.artifactId);

    await step.sendEvent("08-emit-completed", {
      name: "media/transcription.completed",
      data: {
        requestId,
        sourcePath: absoluteSource,
        artifactId: completed.artifactId ?? plan.artifactId,
        outputRoot,
        published: publish,
        indexed: index,
      },
    });

    return {
      requestId,
      sourcePath: absoluteSource,
      artifactId: completed.artifactId ?? plan.artifactId,
      published: publish,
      indexed: index,
      tracks: plan.tracks.length,
      chunksProcessed: plan.tracks.reduce((sum, track) => sum + track.chunks.length, 0),
      diarizeTracks: plan.diarizeTracks.length,
      checkpoints: {
        merged: merged.stage,
        exported: exported.stage,
      },
    };
  },
);

export type { TranscriptionPlan };
