import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { actorLogPath, chunkJobId, orchestrationRoot } from "../../paths";
import { readActorStatus } from "../../status";
import { spawnDetachedActor } from "../spawn";

let originalRigRoot: string | undefined;
let originalOverride: string | undefined;
let tempRigRoot: string;
/** pids we spawned ourselves in this file — never pattern-kill, only these. */
const spawnedPids: number[] = [];

beforeEach(async () => {
  originalRigRoot = process.env.TRANSCRIPT_RIG_ROOT;
  originalOverride = process.env.TRANSCRIPTION_ACTOR_CMD_OVERRIDE;
  tempRigRoot = await mkdtemp(join(tmpdir(), "spawn-actor-"));
  process.env.TRANSCRIPT_RIG_ROOT = tempRigRoot;
});

afterEach(async () => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  if (originalRigRoot === undefined) delete process.env.TRANSCRIPT_RIG_ROOT;
  else process.env.TRANSCRIPT_RIG_ROOT = originalRigRoot;
  if (originalOverride === undefined) delete process.env.TRANSCRIPTION_ACTOR_CMD_OVERRIDE;
  else process.env.TRANSCRIPTION_ACTOR_CMD_OVERRIDE = originalOverride;
  await rm(tempRigRoot, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  diagnose?: () => Promise<string>,
  stepMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(stepMs);
  }
  const detail = diagnose ? `\n${await diagnose().catch((e) => String(e))}` : "";
  throw new Error(`waitUntil: condition not met within ${timeoutMs}ms${detail}`);
}

/** Failure forensics: actual status file, actor log tail, and live process state. */
function diagnoseActor(artifactId: string, chunkId: string, pid: number): () => Promise<string> {
  return async () => {
    const status = await readActorStatus(artifactId, chunkId);
    const logPath = actorLogPath(artifactId, chunkId);
    const logTail = await Bun.file(logPath)
      .text()
      .then((t) => t.split("\n").slice(-12).join("\n"))
      .catch(() => "<no actor.log>");
    const ps = Bun.spawnSync(["ps", "-o", "pid,pgid,stat,command", "-p", String(pid)]);
    return [
      `status: ${JSON.stringify(status)}`,
      `actor.log tail:\n${logTail}`,
      `ps: ${ps.stdout.toString().trim() || ps.stderr.toString().trim()}`,
    ].join("\n");
  };
}

describe("spawnDetachedActor — cancellation flag", () => {
  test("refuses to spawn when cancelled.v1.json exists", async () => {
    const artifactId = "artifact-cancelled";
    const cancelledPath = join(orchestrationRoot(artifactId), "cancelled.v1.json");
    await mkdir(dirname(cancelledPath), { recursive: true });
    await writeFile(cancelledPath, JSON.stringify({ cancelledAt: new Date().toISOString() }));

    await expect(
      spawnDetachedActor({
        kind: "asr",
        artifactId,
        requestId: "req-1",
        sourceId: "src-1",
        index: 0,
        attempt: 1,
        rigRoot: tempRigRoot,
      }),
    ).rejects.toThrow(/cancelled/);
  });
});

describe("spawnDetachedActor — real detached actor + group kill", () => {
  test(
    "SIGTERM to -pid cancels a running actor and its sleeping child",
    async () => {
      const artifactId = "artifact-cancel-live";
      const sourceId = "src-cancel-live";
      process.env.TRANSCRIPTION_ACTOR_CMD_OVERRIDE = JSON.stringify(["/bin/sleep", "30"]);

      const { actorId: tag, pid } = await spawnDetachedActor({
        kind: "asr",
        artifactId,
        requestId: "req-1",
        sourceId,
        index: 0,
        attempt: 1,
        rigRoot: tempRigRoot,
      });
      spawnedPids.push(pid);

      const chunkId = chunkJobId({ artifactId, kind: "asr", sourceId, index: 0 });
      expect(tag).toBe(`${chunkId}#1`);

      await waitUntil(
        async () => {
          const status = await readActorStatus(artifactId, chunkId);
          return status?.state === "running";
        },
        20_000,
        diagnoseActor(artifactId, chunkId, pid),
      );

      expect(isAlive(pid)).toBe(true);

      process.kill(-pid, "SIGTERM");

      await waitUntil(
        async () => {
          const status = await readActorStatus(artifactId, chunkId);
          return status?.state === "cancelled";
        },
        30_000,
        diagnoseActor(artifactId, chunkId, pid),
      );

      const finalStatus = await readActorStatus(artifactId, chunkId);
      expect(finalStatus?.error).toBe("cancelled_by_signal");

      await waitUntil(() => !isAlive(pid), 10_000);
      expect(isAlive(pid)).toBe(false);
    },
    // Generous budget: real subprocess scheduling under a loaded combined
    // test run flaked the old 15s/20s windows.
    70_000,
  );
});
