/**
 * Invoke-only diarization actor supervisor (00-architecture.md, slice F).
 *
 * Diarization stays whole-file (cross-chunk speaker re-clustering is out of
 * scope) but runs as a detached actor with heartbeats and a watchdog
 * wait-loop instead of a request-bound execa call, so the 2h execa timeout
 * that killed the original run can never recur here.
 */
import { readFile, stat } from "node:fs/promises";
import { killActorGroup } from "../../transcription/actor/kill";
import { spawnDetachedActor } from "../../transcription/actor/spawn";
import { leaseSecret } from "../../transcription/rig";
import { heartbeatFresh, readActorStatus } from "../../transcription/status";
import { inngest } from "../client";

/**
 * Injectable seam for process side-effects. Tests stub these properties
 * directly instead of mock.module(), which patches the process-wide module
 * registry and breaks sibling test files in combined runs.
 */
export const diarizeDeps = { spawnDetachedActor, killActorGroup, leaseSecret };

const MAX_WAIT_ITERATIONS = 32;
const WAIT_TIMEOUT = "15m";

async function readFirstLine(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, "utf8");
    const line = text.split("\n").find((candidate) => candidate.trim().length > 0);
    return line;
  } catch {
    return undefined;
  }
}

async function isValidDiarizationResult(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) return false;
  } catch {
    return false;
  }
  const firstLine = await readFirstLine(path);
  if (!firstLine) return false;
  try {
    JSON.parse(firstLine);
    return true;
  } catch {
    return false;
  }
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

export const transcriptionDiarizeRun = inngest.createFunction(
  {
    id: "transcription-diarize-v1",
    name: "Transcription Diarize",
    concurrency: { key: '"transcription-diarize"', limit: 1 },
    retries: 2,
    cancelOn: [
      {
        event: "media/transcription.cancelled",
        if: "event.data.requestId == async.data.requestId",
      },
    ],
    onFailure: async ({ event, error, step }) => {
      const data = (
        event as unknown as {
          data?: { requestId?: string; artifactId?: string; chunkId?: string };
        }
      ).data;
      const requestId = data?.requestId ?? "unknown";
      const artifactId = data?.artifactId ?? "unknown";
      const chunkId = data?.chunkId ?? "unknown";

      await step.run("reap-live-actor", async () => {
        const status = await readActorStatus(artifactId, chunkId);
        if (status && status.state === "running") {
          await diarizeDeps.killActorGroup(status);
        }
      });

      await step.sendEvent("emit-chunk-failed", {
        name: "media/transcription.chunk.failed",
        data: {
          requestId,
          artifactId,
          chunkId,
          kind: "diarize",
          index: 0,
          error: stringifyError(error),
        },
      });
    },
  },
  { event: "media/transcription.diarize.requested" },
  async ({ event, step, attempt }) => {
    const { requestId, artifactId, rigRoot, sourceId, chunkId, total, resultPath } = event.data;

    const claim = await step.run("00-check-claim", async () => ({
      cached: await isValidDiarizationResult(resultPath),
    }));

    if (claim.cached) {
      await step.sendEvent("05-emit-chunk-completed", {
        name: "media/transcription.chunk.completed",
        data: {
          requestId,
          artifactId,
          chunkId,
          kind: "diarize",
          index: 0,
          total,
          cached: true,
        },
      });
      return { chunkId, cached: true };
    }

    // Step ids from here through the wait loop are parameterized by `attempt`
    // — see transcription-asr-chunk.ts for the full rationale. Without this,
    // Inngest memoizes reap/spawn/wait/check results for the life of the run
    // and a function-level retry never actually reaps+respawns a new actor.
    await step.run(`01-reap-stale-actor-${attempt}`, async () => {
      const status = await readActorStatus(artifactId, chunkId);
      if (status && status.state === "running") {
        await diarizeDeps.killActorGroup(status);
      }
    });

    const spawned = await step.run(`02-spawn-actor-${attempt}`, async () => {
      const hfToken = await diarizeDeps.leaseSecret("huggingface_read_token", "12h");
      return diarizeDeps.spawnDetachedActor({
        kind: "diarize",
        artifactId,
        requestId,
        sourceId,
        index: 0,
        attempt,
        rigRoot,
        env: { HF_TOKEN: hfToken },
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
          if (status) await diarizeDeps.killActorGroup(status);
        });
        throw new Error(`actor stalled: ${chunkId}`);
      }
    }

    if (!succeeded) {
      await step.run(`03-reap-exhausted-${attempt}`, async () => {
        const status = await readActorStatus(artifactId, chunkId);
        if (status) await diarizeDeps.killActorGroup(status);
      });
      throw new Error(`actor_wait_exhausted: ${chunkId} did not finish within wait budget`);
    }

    await step.run("04-validate-result", async () => {
      const valid = await isValidDiarizationResult(resultPath);
      if (!valid) throw new Error(`diarization_result_invalid: ${chunkId}`);
    });

    await step.sendEvent("05-emit-chunk-completed", {
      name: "media/transcription.chunk.completed",
      data: {
        requestId,
        artifactId,
        chunkId,
        kind: "diarize",
        index: 0,
        total,
        cached: false,
      },
    });

    return { chunkId, cached: false };
  },
);
