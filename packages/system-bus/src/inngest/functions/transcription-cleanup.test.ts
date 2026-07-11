import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InngestTestEngine, mockCtx } from "@inngest/test";
import { actorStatusPath, orchestrationRoot, planPath } from "../../transcription/paths";
import { writeActorStatusAtomic } from "../../transcription/status";
import type { ActorStatus, TranscriptionPlan } from "../../transcription/types";
import { cleanupDeps } from "./transcription-cleanup";

let tempRoot = "";
const originalRigRoot = process.env.TRANSCRIPT_RIG_ROOT;

const killCalls: ActorStatus[] = [];
let killResultByChunkId: Record<string, "killed" | "already-dead" | "identity-mismatch"> = {};
let killSideEffectByChunkId: Record<string, () => Promise<void>> = {};

const realCleanupDeps = { ...cleanupDeps };
cleanupDeps.killActorGroup = (async (status: ActorStatus) => {
  killCalls.push(status);
  const sideEffect = killSideEffectByChunkId[status.chunkId];
  if (sideEffect) await sideEffect();
  return killResultByChunkId[status.chunkId] ?? "killed";
}) as typeof cleanupDeps.killActorGroup;
afterAll(() => {
  Object.assign(cleanupDeps, realCleanupDeps);
});

function sendEventTransformCtx(sendEventCalls: unknown[][]) {
  return (rawCtx: any) => {
    const ctx = mockCtx(rawCtx);
    ctx.step.sendEvent = async (...args: unknown[]) => {
      sendEventCalls.push(args);
      return { ids: ["mock-event-id"] };
    };
    return ctx;
  };
}

function makeStatus(overrides: Partial<ActorStatus>): ActorStatus {
  return {
    schemaVersion: "joelclaw.transcription.actor-status.v1",
    actorId: "asr_fixture#0",
    chunkId: "chunk-fixture",
    kind: "asr",
    requestId: "req-1",
    artifactId: "artifact-1",
    pid: 999999,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    state: "running",
    ...overrides,
  };
}

describe("transcriptionCleanup", () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "transcription-cleanup-test-"));
    process.env.TRANSCRIPT_RIG_ROOT = tempRoot;
    killCalls.length = 0;
    killResultByChunkId = {};
    killSideEffectByChunkId = {};
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    if (originalRigRoot === undefined) delete process.env.TRANSCRIPT_RIG_ROOT;
    else process.env.TRANSCRIPT_RIG_ROOT = originalRigRoot;
  });

  test("createFunction options match the pinned contract", async () => {
    const { transcriptionCleanup } = await import("./transcription-cleanup");
    const opts = (transcriptionCleanup as any).opts;
    expect(opts.id).toBe("transcription-cleanup-v1");
  });

  test("kills exactly the running actor, writes cancelled flag, emits cleanup.completed{killedActors:1}", async () => {
    const artifactId = "artifact-1";
    const runningStatus = makeStatus({ chunkId: "chunk-running", state: "running" });
    const succeededStatus = makeStatus({ chunkId: "chunk-succeeded", state: "succeeded" });
    await writeActorStatusAtomic(actorStatusPath(artifactId, "chunk-running"), runningStatus);
    await writeActorStatusAtomic(actorStatusPath(artifactId, "chunk-succeeded"), succeededStatus);

    // No explicit artifactId in the event -> exercises the plan.v1.json scan
    // fallback (findArtifactIdByRequestId).
    const plan: TranscriptionPlan = {
      schemaVersion: "joelclaw.transcription.plan.v1",
      requestId: "req-1",
      artifactId,
      sourcePath: "/Volumes/badass-media/meetings/example.m4a",
      createdAt: new Date().toISOString(),
      tracks: [],
      diarizeTracks: [],
    };
    await Bun.write(planPath(artifactId), JSON.stringify(plan));

    const sendEventCalls: unknown[][] = [];
    const { transcriptionCleanup } = await import("./transcription-cleanup");
    const engine = new InngestTestEngine({
      function: transcriptionCleanup as any,
      events: [{ name: "media/transcription.cancelled", data: { requestId: "req-1" } } as any],
      transformCtx: sendEventTransformCtx(sendEventCalls),
    });

    const execution = await engine.execute();
    expect(execution.error).toBeUndefined();
    expect(execution.result).toMatchObject({ requestId: "req-1", artifactId, killedActors: 1 });

    expect(killCalls).toHaveLength(1);
    expect(killCalls[0]?.chunkId).toBe("chunk-running");

    expect(existsSync(join(orchestrationRoot(artifactId), "cancelled.v1.json"))).toBe(true);

    const rewritten = JSON.parse(
      readFileSync(actorStatusPath(artifactId, "chunk-running"), "utf8"),
    ) as ActorStatus;
    expect(rewritten.state).toBe("cancelled");

    const completedCall = sendEventCalls.find(
      (call) => (call[1] as { name?: string })?.name === "media/transcription.cleanup.completed",
    );
    expect((completedCall?.[1] as { data?: Record<string, unknown> })?.data).toMatchObject({
      requestId: "req-1",
      artifactId,
      killedActors: 1,
    });
  });

  test("identity-mismatch is NOT recorded as cancelled — a live un-killed actor must not be falsely stamped cancelled", async () => {
    const artifactId = "artifact-mismatch";
    const runningStatus = makeStatus({ chunkId: "chunk-mismatch", state: "running" });
    await writeActorStatusAtomic(actorStatusPath(artifactId, "chunk-mismatch"), runningStatus);
    killResultByChunkId["chunk-mismatch"] = "identity-mismatch";

    const plan: TranscriptionPlan = {
      schemaVersion: "joelclaw.transcription.plan.v1",
      requestId: "req-mismatch",
      artifactId,
      sourcePath: "/Volumes/badass-media/meetings/example.m4a",
      createdAt: new Date().toISOString(),
      tracks: [],
      diarizeTracks: [],
    };
    await Bun.write(planPath(artifactId), JSON.stringify(plan));

    const sendEventCalls: unknown[][] = [];
    const { transcriptionCleanup } = await import("./transcription-cleanup");
    const engine = new InngestTestEngine({
      function: transcriptionCleanup as any,
      events: [{ name: "media/transcription.cancelled", data: { requestId: "req-mismatch" } } as any],
      transformCtx: sendEventTransformCtx(sendEventCalls),
    });

    const execution = await engine.execute();
    expect(execution.error).toBeUndefined();
    // Not counted as killed.
    expect(execution.result).toMatchObject({ requestId: "req-mismatch", artifactId, killedActors: 0 });

    // The stale pre-kill snapshot must NOT be blindly stamped "cancelled" —
    // no signal was ever actually delivered to whatever is running at that pid.
    const rewritten = JSON.parse(
      readFileSync(actorStatusPath(artifactId, "chunk-mismatch"), "utf8"),
    ) as ActorStatus;
    expect(rewritten.state).toBe("running");
  });

  test("kills multiple live actors concurrently and only overwrites actors that are still running at write time", async () => {
    const artifactId = "artifact-concurrent";
    const runningA = makeStatus({ chunkId: "chunk-a", state: "running" });
    const runningB = makeStatus({ chunkId: "chunk-b", state: "running" });
    await writeActorStatusAtomic(actorStatusPath(artifactId, "chunk-a"), runningA);
    await writeActorStatusAtomic(actorStatusPath(artifactId, "chunk-b"), runningB);

    // chunk-b finishes on its own (writes its own real terminal state) during
    // the kill/grace window — cleanup must not clobber that with "cancelled".
    // The side effect fires from inside the mocked killActorGroup call itself
    // so it lands between cleanup's initial "is it running" read and its
    // re-read-immediately-before-write, exactly the race the fix closes.
    killResultByChunkId["chunk-b"] = "already-dead";
    killSideEffectByChunkId["chunk-b"] = async () => {
      await writeActorStatusAtomic(actorStatusPath(artifactId, "chunk-b"), {
        ...runningB,
        state: "succeeded",
      });
    };

    const plan: TranscriptionPlan = {
      schemaVersion: "joelclaw.transcription.plan.v1",
      requestId: "req-concurrent",
      artifactId,
      sourcePath: "/Volumes/badass-media/meetings/example.m4a",
      createdAt: new Date().toISOString(),
      tracks: [],
      diarizeTracks: [],
    };
    await Bun.write(planPath(artifactId), JSON.stringify(plan));

    const sendEventCalls: unknown[][] = [];
    const { transcriptionCleanup } = await import("./transcription-cleanup");
    const engine = new InngestTestEngine({
      function: transcriptionCleanup as any,
      events: [{ name: "media/transcription.cancelled", data: { requestId: "req-concurrent" } } as any],
      transformCtx: sendEventTransformCtx(sendEventCalls),
    });

    const execution = await engine.execute();
    expect(execution.error).toBeUndefined();
    expect(killCalls.map((s) => s.chunkId).sort()).toEqual(["chunk-a", "chunk-b"]);

    const chunkA = JSON.parse(
      readFileSync(actorStatusPath(artifactId, "chunk-a"), "utf8"),
    ) as ActorStatus;
    expect(chunkA.state).toBe("cancelled");

    // chunk-b already finished for real -> not clobbered.
    const chunkB = JSON.parse(
      readFileSync(actorStatusPath(artifactId, "chunk-b"), "utf8"),
    ) as ActorStatus;
    expect(chunkB.state).toBe("succeeded");
  });

  test("no matching artifact -> emits cleanup.completed{killedActors:0}", async () => {
    const sendEventCalls: unknown[][] = [];
    const { transcriptionCleanup } = await import("./transcription-cleanup");
    const engine = new InngestTestEngine({
      function: transcriptionCleanup as any,
      events: [{ name: "media/transcription.cancelled", data: { requestId: "req-unknown" } } as any],
      transformCtx: sendEventTransformCtx(sendEventCalls),
    });

    const execution = await engine.execute();
    expect(execution.error).toBeUndefined();
    expect(execution.result).toMatchObject({ requestId: "req-unknown", killedActors: 0 });
  });
});
