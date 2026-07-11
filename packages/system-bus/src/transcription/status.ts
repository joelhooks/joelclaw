import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { actorStatusPath } from "./paths";
import { type ActorStatus, parseActorStatus } from "./types";

/** mkdir -p the parent, write to a per-writer tmp path, then rename over the target. */
export async function writeActorStatusAtomic(path: string, status: ActorStatus): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(status, null, 2));
  await rename(tmpPath, path);
}

/** undefined on missing/corrupt — never throws. */
export async function readActorStatus(
  artifactId: string,
  chunkId: string,
): Promise<ActorStatus | undefined> {
  const path = actorStatusPath(artifactId, chunkId);
  try {
    const text = await readFile(path, "utf8");
    const json: unknown = JSON.parse(text);
    return parseActorStatus(json);
  } catch {
    return undefined;
  }
}

export function heartbeatFresh(
  status: ActorStatus,
  nowMs: number,
  staleMs = 180_000,
): boolean {
  const heartbeatMs = Date.parse(status.heartbeatAt);
  if (Number.isNaN(heartbeatMs)) return false;
  return nowMs - heartbeatMs <= staleMs;
}
