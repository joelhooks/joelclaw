/**
 * media/transcription.cancelled cleanup (00-architecture.md, slice F).
 *
 * Runs alongside the orchestrator's own cancelOn (which cancels the Inngest
 * runs). This function's job is the part cancelOn can't do: kill any live
 * detached actor process groups and write a cancelled flag that blocks new
 * spawns (spawnDetachedActor refuses when it sees this file).
 */
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { killActorGroup } from "../../transcription/actor/kill";
import { orchestrationRoot } from "../../transcription/paths";
import { DEFAULT_RIG_ROOT } from "../../transcription/rig";
import { readActorStatus, writeActorStatusAtomic } from "../../transcription/status";
import { parsePlan } from "../../transcription/types";
import { inngest } from "../client";

/**
 * Injectable seam for process side-effects. Tests stub these properties
 * directly instead of mock.module(), which patches the process-wide module
 * registry and breaks sibling test files in combined runs.
 */
export const cleanupDeps = { killActorGroup };

async function readJsonSafe(path: string): Promise<unknown | undefined> {
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

async function findArtifactIdByRequestId(
  rigRoot: string,
  requestId: string,
): Promise<string | undefined> {
  const workDirRoot = join(rigRoot, ".transcript-rig-work");
  let entries: string[] = [];
  try {
    entries = await readdir(workDirRoot);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const planFile = join(workDirRoot, entry, "orchestration", "plan.v1.json");
    const raw = await readJsonSafe(planFile);
    if (!raw) continue;
    try {
      const plan = parsePlan(raw);
      if (plan.requestId === requestId) return plan.artifactId;
    } catch {
      continue;
    }
  }
  return undefined;
}

export const transcriptionCleanup = inngest.createFunction(
  {
    id: "transcription-cleanup-v1",
    name: "Transcription Cleanup",
    retries: 1,
  },
  { event: "media/transcription.cancelled" },
  async ({ event, step }) => {
    const { requestId, artifactId: eventArtifactId } = event.data;
    const rigRoot = process.env.TRANSCRIPT_RIG_ROOT ?? DEFAULT_RIG_ROOT;

    const artifactId = await step.run("00-resolve-artifact", async () => {
      if (eventArtifactId) return eventArtifactId;
      return (await findArtifactIdByRequestId(rigRoot, requestId)) ?? null;
    });

    if (!artifactId) {
      await step.sendEvent("emit-cleanup-completed", {
        name: "media/transcription.cleanup.completed",
        data: { requestId, killedActors: 0 },
      });
      return { requestId, killedActors: 0 };
    }

    await step.run("01-write-cancelled-flag", async () => {
      await writeJsonAtomic(join(orchestrationRoot(artifactId), "cancelled.v1.json"), {
        schemaVersion: "joelclaw.transcription.cancelled.v1",
        requestId,
        cancelledAt: new Date().toISOString(),
      });
    });

    const killedActors = await step.run("02-kill-live-actors", async () => {
      const actorsRoot = join(orchestrationRoot(artifactId), "actors");
      let chunkIds: string[] = [];
      try {
        chunkIds = await readdir(actorsRoot);
      } catch {
        return 0;
      }
      // Kill each candidate's process group concurrently rather than
      // serially — killActorGroup's default grace period is 10s, and
      // serializing N live actors would block this single step for ~N x 10s.
      const outcomes = await Promise.all(
        chunkIds.map(async (chunkId): Promise<boolean> => {
          const status = await readActorStatus(artifactId, chunkId);
          if (!status || status.state !== "running") return false;
          const result = await cleanupDeps.killActorGroup(status);
          if (result === "identity-mismatch") {
            // Either genuine pid reuse or a `ps` invocation failure — either
            // way we sent NO signal to whatever is actually running at this
            // pid. Do not blindly stamp the actor as cancelled; that would
            // falsely record a live, un-killed process as dead. Log for
            // follow-up instead of silently declaring success.
            console.error(
              `transcription-cleanup: identity-mismatch killing actor ${status.actorId} (pid ${status.pid}); leaving status untouched`,
            );
            return false;
          }
          // Re-read the status file immediately before writing rather than
          // reusing the pre-kill snapshot: the actor may have written its own
          // real terminal state (succeeded/failed/cancelled) during the kill
          // grace window, and this cleanup must not clobber that.
          const current = await readActorStatus(artifactId, chunkId);
          if (current && current.state === "running") {
            await writeActorStatusAtomic(join(actorsRoot, chunkId, "status.v1.json"), {
              ...current,
              state: "cancelled",
            });
          }
          return result === "killed";
        }),
      );
      return outcomes.filter(Boolean).length;
    });

    await step.sendEvent("emit-cleanup-completed", {
      name: "media/transcription.cleanup.completed",
      data: { requestId, artifactId, killedActors },
    });

    return { requestId, artifactId, killedActors };
  },
);
