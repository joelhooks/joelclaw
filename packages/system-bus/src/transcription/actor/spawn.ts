/**
 * Spawns a detached actor process for one ASR chunk or diarize job. The
 * spawned process owns its own process group (`detached: true`) so a
 * SIGTERM/SIGKILL to `-pid` reaches every descendant it launches, and
 * `unref()`s the child so the parent (an Inngest step handler) can exit
 * without waiting on it.
 */
import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  actorLogPath,
  actorId as buildActorId,
  chunkJobId,
  orchestrationRoot,
} from "../paths";
import type { ActorKind } from "../types";

export type SpawnDetachedActorArgs = {
  kind: ActorKind;
  artifactId: string;
  requestId: string;
  sourceId: string;
  index: number;
  attempt: number;
  rigRoot: string;
  env?: Record<string, string | undefined>;
};

export type SpawnDetachedActorResult = {
  actorId: string;
  pid: number;
};

function cancelledFlagPath(artifactId: string): string {
  return join(orchestrationRoot(artifactId), "cancelled.v1.json");
}

export async function spawnDetachedActor(
  args: SpawnDetachedActorArgs,
): Promise<SpawnDetachedActorResult> {
  const cancelledPath = cancelledFlagPath(args.artifactId);
  if (await Bun.file(cancelledPath).exists()) {
    throw new Error("cancelled: refusing to spawn");
  }

  const chunkId = chunkJobId({
    artifactId: args.artifactId,
    kind: args.kind,
    sourceId: args.sourceId,
    index: args.index,
  });
  const actorId = buildActorId(chunkId, args.attempt);

  const logPath = actorLogPath(args.artifactId, chunkId);
  await mkdir(dirname(logPath), { recursive: true });
  const outFd = openSync(logPath, "a");
  const errFd = openSync(logPath, "a");

  const runActorPath = new URL("./run-actor.ts", import.meta.url).pathname;

  let pid: number | undefined;
  try {
    const child = Bun.spawn(
      [
        "bun",
        runActorPath,
        "--kind",
        args.kind,
        "--artifact",
        args.artifactId,
        "--request",
        args.requestId,
        "--source",
        args.sourceId,
        "--index",
        String(args.index),
        "--attempt",
        String(args.attempt),
        "--rig-root",
        args.rigRoot,
        "--actor-tag",
        actorId,
      ],
      {
        detached: true,
        stdio: ["ignore", outFd, errFd],
        env: { ...process.env, ...args.env, TRANSCRIPT_RIG_ROOT: args.rigRoot },
      },
    );
    pid = child.pid;
    child.unref();
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }

  if (pid === undefined) {
    throw new Error(`spawn_failed: no pid assigned for actor ${actorId}`);
  }

  return { actorId, pid };
}
