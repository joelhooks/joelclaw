/**
 * Invoke-only ASR chunk actor supervisor (00-architecture.md, slice F).
 *
 * Never runs mlx_whisper in-process. Spawns a detached actor (slice A) and
 * watches for completion via step.waitForEvent + a status-file watchdog, so
 * an event loss (or actor crash before it can emit) never wedges the run.
 */
import { readFile } from "node:fs/promises";
import { killActorGroup } from "../../transcription/actor/kill";
import { spawnDetachedActor } from "../../transcription/actor/spawn";
import { detectPathologicalRepetition } from "../../transcription/repetition";
import { heartbeatFresh, readActorStatus } from "../../transcription/status";
import { inngest } from "../client";

/**
 * Injectable seam for process side-effects. Tests stub these properties
 * directly instead of mock.module(), which patches the process-wide module
 * registry and breaks sibling test files (spawn.test.ts) in combined runs.
 */
export const asrChunkDeps = { spawnDetachedActor, killActorGroup };

const MAX_WAIT_ITERATIONS = 6;
const WAIT_TIMEOUT = "10m";

async function readJsonSafe(path: string): Promise<unknown | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isValidAsrResult(value: unknown): value is { segments: Array<{ text?: string }> } {
  if (typeof value !== "object" || value === null) return false;
  const segments = (value as Record<string, unknown>).segments;
  return Array.isArray(segments) && segments.length > 0;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export const transcriptionAsrChunkRun = inngest.createFunction(
  {
    id: "transcription-asr-chunk-v1",
    name: "Transcription ASR Chunk",
    concurrency: { key: '"transcription-gpu"', limit: 1 },
    retries: 3,
    cancelOn: [
      {
        event: "media/transcription.cancelled",
        if: "event.data.requestId == async.data.requestId",
      },
    ],
    onFailure: async ({ event, error, step }) => {
      const data = (
        event as unknown as {
          data?: {
            requestId?: string;
            artifactId?: string;
            chunkId?: string;
            index?: number;
          };
        }
      ).data;
      const requestId = data?.requestId ?? "unknown";
      const artifactId = data?.artifactId ?? "unknown";
      const chunkId = data?.chunkId ?? "unknown";
      const index = data?.index ?? 0;

      await step.run("reap-live-actor", async () => {
        const status = await readActorStatus(artifactId, chunkId);
        if (status && status.state === "running") {
          await asrChunkDeps.killActorGroup(status);
        }
      });

      await step.sendEvent("emit-chunk-failed", {
        name: "media/transcription.chunk.failed",
        data: {
          requestId,
          artifactId,
          chunkId,
          kind: "asr",
          index,
          error: stringifyError(error),
        },
      });
    },
  },
  { event: "media/transcription.asr-chunk.requested" },
  async ({ event, step, attempt }) => {
    const { requestId, artifactId, rigRoot, sourceId, chunkId, index, total, resultPath } =
      event.data;
    const chunkIndex = index ?? 0;

    const claim = await step.run("00-check-claim", async () => {
      const raw = await readJsonSafe(resultPath);
      if (!isValidAsrResult(raw)) return { cached: false };
      const verdict = detectPathologicalRepetition(raw.segments);
      return { cached: !verdict.repetitive };
    });

    if (claim.cached) {
      await step.sendEvent("05-emit-chunk-completed", {
        name: "media/transcription.chunk.completed",
        data: {
          requestId,
          artifactId,
          chunkId,
          kind: "asr",
          index: chunkIndex,
          total,
          cached: true,
        },
      });
      return { chunkId, cached: true };
    }

    // Step ids from here through the wait loop are parameterized by `attempt`.
    // Inngest memoizes step.run/step.waitForEvent results for the life of the
    // run: a static id would replay the FIRST attempt's cached result on every
    // retry (same actorId, same wait/check verdicts, same throw) and never
    // actually reap+respawn — reproducing the exact stuck-run failure mode
    // this rewrite exists to fix. Parameterizing by attempt forces each
    // Inngest-level retry to genuinely reap the previous attempt's actor and
    // spawn a fresh `chunkId#attempt` actor, and to observe real events/status
    // for that new actor instead of replaying stale memoized verdicts.
    await step.run(`01-reap-stale-actor-${attempt}`, async () => {
      const status = await readActorStatus(artifactId, chunkId);
      if (status && status.state === "running") {
        await asrChunkDeps.killActorGroup(status);
      }
    });

    const spawned = await step.run(`02-spawn-actor-${attempt}`, async () => {
      // mlx_whisper never needs Hugging Face credentials (only diarize.py
      // does) — don't widen HF_TOKEN's blast radius into a process tree that
      // has no use for it.
      return asrChunkDeps.spawnDetachedActor({
        kind: "asr",
        artifactId,
        requestId,
        sourceId,
        index: chunkIndex,
        attempt,
        rigRoot,
      });
    });

    let succeeded = false;
    for (let i = 0; i < MAX_WAIT_ITERATIONS; i += 1) {
      const finished = await step.waitForEvent(`03-wait-actor-${attempt}-${i}`, {
        event: "media/transcription.actor.finished",
        timeout: WAIT_TIMEOUT,
        if: `async.data.actorId == "${spawned.actorId}"`,
      });

      if (finished) {
        if (finished.data.status === "succeeded") {
          succeeded = true;
          break;
        }
        throw new Error(finished.data.error ?? `actor_failed: ${chunkId}`);
      }

      const check = await step.run(`03-check-status-${attempt}-${i}`, async () => {
        const status = await readActorStatus(artifactId, chunkId);
        if (!status) return { verdict: "continue" as const };
        if (status.state === "succeeded") return { verdict: "succeeded" as const };
        if (status.state === "failed") {
          return { verdict: "failed" as const, error: status.error };
        }
        if (status.state === "running" && heartbeatFresh(status, Date.now())) {
          return { verdict: "continue" as const };
        }
        return { verdict: "stale" as const };
      });

      if (check.verdict === "succeeded") {
        succeeded = true;
        break;
      }
      if (check.verdict === "failed") {
        throw new Error(check.error ?? `actor_failed: ${chunkId}`);
      }
      if (check.verdict === "stale") {
        await step.run(`03-kill-stalled-${attempt}-${i}`, async () => {
          const status = await readActorStatus(artifactId, chunkId);
          if (status) await asrChunkDeps.killActorGroup(status);
        });
        throw new Error(`actor stalled: ${chunkId}`);
      }
    }

    if (!succeeded) {
      // Reap here too: a still-healthy actor that merely outlives the wait
      // budget shouldn't be left running to be killed later by onFailure
      // after retries have already burned through.
      await step.run(`03-reap-exhausted-${attempt}`, async () => {
        const status = await readActorStatus(artifactId, chunkId);
        if (status) await asrChunkDeps.killActorGroup(status);
      });
      throw new Error(`actor_wait_exhausted: ${chunkId} did not finish within wait budget`);
    }

    await step.run("04-validate-result", async () => {
      const raw = await readJsonSafe(resultPath);
      if (!isValidAsrResult(raw)) throw new Error(`chunk_result_missing: ${chunkId}`);
      const verdict = detectPathologicalRepetition(raw.segments);
      if (verdict.repetitive) throw new Error(`repetitive_output: ${verdict.reason}`);
    });

    await step.sendEvent("05-emit-chunk-completed", {
      name: "media/transcription.chunk.completed",
      data: {
        requestId,
        artifactId,
        chunkId,
        kind: "asr",
        index: chunkIndex,
        total,
        cached: false,
      },
    });

    return { chunkId, cached: false };
  },
);
