import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actorStatusPath } from "../paths";
import { heartbeatFresh, readActorStatus, writeActorStatusAtomic } from "../status";
import type { ActorStatus } from "../types";

function makeStatus(overrides: Partial<ActorStatus> = {}): ActorStatus {
  return {
    schemaVersion: "joelclaw.transcription.actor-status.v1",
    actorId: "asr_abc#1",
    chunkId: "asr_abc",
    kind: "asr",
    requestId: "req-1",
    artifactId: "art-1",
    pid: 12_345,
    startedAt: new Date(0).toISOString(),
    heartbeatAt: new Date(0).toISOString(),
    state: "running",
    ...overrides,
  };
}

async function withTempRigRoot<T>(fn: (tempRoot: string) => Promise<T>): Promise<T> {
  const original = process.env.TRANSCRIPT_RIG_ROOT;
  const tempRoot = await mkdtemp(join(tmpdir(), "transcription-status-"));
  process.env.TRANSCRIPT_RIG_ROOT = tempRoot;
  try {
    return await fn(tempRoot);
  } finally {
    if (original === undefined) delete process.env.TRANSCRIPT_RIG_ROOT;
    else process.env.TRANSCRIPT_RIG_ROOT = original;
    await rm(tempRoot, { recursive: true, force: true });
  }
}

describe("actor status round trip", () => {
  test("write then read returns an equivalent status", async () => {
    await withTempRigRoot(async () => {
      const status = makeStatus();
      const path = actorStatusPath("art-1", "asr_abc");
      await writeActorStatusAtomic(path, status);
      const read = await readActorStatus("art-1", "asr_abc");
      expect(read).toEqual(status);
    });
  });

  test("corrupt file returns undefined", async () => {
    await withTempRigRoot(async () => {
      const path = actorStatusPath("art-1", "asr_abc");
      await Bun.write(path, "not json{{{");
      const read = await readActorStatus("art-1", "asr_abc");
      expect(read).toBeUndefined();
    });
  });

  test("missing file returns undefined", async () => {
    await withTempRigRoot(async () => {
      const read = await readActorStatus("art-1", "does-not-exist");
      expect(read).toBeUndefined();
    });
  });

  test("well-formed JSON with the wrong shape returns undefined", async () => {
    await withTempRigRoot(async () => {
      const path = actorStatusPath("art-1", "asr_abc");
      await Bun.write(path, JSON.stringify({ hello: "world" }));
      const read = await readActorStatus("art-1", "asr_abc");
      expect(read).toBeUndefined();
    });
  });
});

describe("heartbeatFresh", () => {
  test("fresh boundary: exactly at staleMs counts as fresh", () => {
    const status = makeStatus({ heartbeatAt: new Date(1000).toISOString() });
    expect(heartbeatFresh(status, 1000 + 180_000, 180_000)).toBe(true);
  });

  test("stale boundary: one ms past staleMs is stale", () => {
    const status = makeStatus({ heartbeatAt: new Date(1000).toISOString() });
    expect(heartbeatFresh(status, 1000 + 180_001, 180_000)).toBe(false);
  });

  test("default staleMs is 180000ms", () => {
    const status = makeStatus({ heartbeatAt: new Date(1000).toISOString() });
    expect(heartbeatFresh(status, 1000 + 179_000)).toBe(true);
    expect(heartbeatFresh(status, 1000 + 181_000)).toBe(false);
  });

  test("invalid heartbeatAt is never fresh", () => {
    const status = makeStatus({ heartbeatAt: "not-a-date" });
    expect(heartbeatFresh(status, Date.now())).toBe(false);
  });
});
