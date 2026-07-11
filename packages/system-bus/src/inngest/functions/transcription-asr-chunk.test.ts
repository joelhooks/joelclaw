import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { InngestTestEngine, mockCtx } from "@inngest/test";
import { actorStatusPath } from "../../transcription/paths";
import { writeActorStatusAtomic } from "../../transcription/status";
import type { ActorStatus } from "../../transcription/types";
import { asrChunkDeps } from "./transcription-asr-chunk";

let tempRoot = "";
const originalRigRoot = process.env.TRANSCRIPT_RIG_ROOT;

const spawnCalls: unknown[] = [];
let spawnResult = { actorId: "asr_fixture#0", pid: 999999 };

const killCalls: unknown[] = [];

// Never spawn a real detached actor process or touch a real process group in
// these tests — stub the function module's injectable deps seam (both real
// impls are unit-tested in slice A/T) and just assert this function's
// supervisor logic calls them correctly. Property assignment on the exported
// deps object stays local to this module instance; mock.module() would patch
// the process-wide registry and break spawn.test.ts in combined runs.
const realAsrChunkDeps = { ...asrChunkDeps };
asrChunkDeps.spawnDetachedActor = (async (args: unknown) => {
  spawnCalls.push(args);
  return spawnResult;
}) as typeof asrChunkDeps.spawnDetachedActor;
asrChunkDeps.killActorGroup = (async (status: unknown) => {
  killCalls.push(status);
  return "already-dead" as const;
}) as typeof asrChunkDeps.killActorGroup;
afterAll(() => {
  Object.assign(asrChunkDeps, realAsrChunkDeps);
});

function writeJsonFixture(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

const validAsrResult = {
  text: "hello there friend",
  segments: [
    { id: 0, start: 0, end: 1, text: "hello" },
    { id: 1, start: 1, end: 2, text: "there" },
    { id: 2, start: 2, end: 3, text: "friend" },
  ],
  language: "en",
};

function baseEventData(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    requestId: "req-1",
    artifactId: "artifact-1",
    sourcePath: "/Volumes/badass-media/meetings/example.m4a",
    rigRoot: tempRoot,
    sourceId: "src-1",
    chunkId: "chunk-1",
    index: 0,
    total: 1,
    wavPath: join(tempRoot, "chunk.wav"),
    resultPath: join(tempRoot, "chunk-asr.json"),
    chunkSeconds: 600,
    ...overrides,
  };
}

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

describe("transcriptionAsrChunkRun", () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "transcription-asr-chunk-test-"));
    process.env.TRANSCRIPT_RIG_ROOT = tempRoot;
    spawnCalls.length = 0;
    killCalls.length = 0;
    spawnResult = { actorId: "asr_fixture#0", pid: 999999 };
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    if (originalRigRoot === undefined) delete process.env.TRANSCRIPT_RIG_ROOT;
    else process.env.TRANSCRIPT_RIG_ROOT = originalRigRoot;
  });

  test("createFunction options match the pinned contract", async () => {
    const { transcriptionAsrChunkRun } = await import("./transcription-asr-chunk");
    const opts = (transcriptionAsrChunkRun as any).opts;
    expect(opts.id).toBe("transcription-asr-chunk-v1");
    expect(opts.concurrency).toMatchObject({ key: '"transcription-gpu"', limit: 1 });
    expect(opts.retries).toBe(3);
    expect(typeof opts.onFailure).toBe("function");
  });

  test("(a) cached claim completes without spawning, emits chunk.completed{cached:true}", async () => {
    const eventData = baseEventData();
    writeJsonFixture(eventData.resultPath, validAsrResult);

    const sendEventCalls: unknown[][] = [];
    const { transcriptionAsrChunkRun } = await import("./transcription-asr-chunk");
    const engine = new InngestTestEngine({
      function: transcriptionAsrChunkRun as any,
      events: [{ name: "media/transcription.asr-chunk.requested", data: eventData } as any],
      transformCtx: sendEventTransformCtx(sendEventCalls),
    });

    const execution = await engine.execute();
    expect(execution.error).toBeUndefined();
    expect(execution.result).toMatchObject({ chunkId: "chunk-1", cached: true });
    expect(spawnCalls).toHaveLength(0);
    const completedCall = sendEventCalls.find(
      (call) => (call[1] as { name?: string })?.name === "media/transcription.chunk.completed",
    );
    expect((completedCall?.[1] as { data?: Record<string, unknown> })?.data).toMatchObject({
      cached: true,
      kind: "asr",
    });
  });

  test("(b) actor.finished{status:failed} makes the function throw (retryable)", async () => {
    const eventData = baseEventData();
    // no resultPath fixture -> claim check misses, falls through to spawn+wait

    const { transcriptionAsrChunkRun } = await import("./transcription-asr-chunk");
    const engine = new InngestTestEngine({
      function: transcriptionAsrChunkRun as any,
      events: [{ name: "media/transcription.asr-chunk.requested", data: eventData } as any],
      steps: [
        {
          id: "03-wait-actor-0-0",
          handler: () => ({
            data: { status: "failed", error: "mlx_whisper exited 1" },
          }),
        },
      ],
    });

    const execution = await engine.execute();
    expect(spawnCalls).toHaveLength(1);
    expect(execution.error).toBeDefined();
    expect(String((execution.error as { message?: string })?.message ?? execution.error)).toContain(
      "mlx_whisper exited 1",
    );
  });

  test("(c) waitForEvent timeout + status file says succeeded completes (event-loss tolerance)", async () => {
    const eventData = baseEventData({ chunkId: "chunk-c" });
    // Nothing exists yet at 00-check-claim / 01-reap-stale-actor time — the
    // actor "finishes" (writes its result + status) only once the wait loop
    // is reached, modelling the real timeline where the spawn happens first.
    const sendEventCalls: unknown[][] = [];
    const { transcriptionAsrChunkRun } = await import("./transcription-asr-chunk");
    const engine = new InngestTestEngine({
      function: transcriptionAsrChunkRun as any,
      events: [{ name: "media/transcription.asr-chunk.requested", data: eventData } as any],
      steps: [
        {
          id: "03-wait-actor-0-0",
          handler: async () => {
            writeJsonFixture(eventData.resultPath, validAsrResult);
            const status: ActorStatus = {
              schemaVersion: "joelclaw.transcription.actor-status.v1",
              actorId: "asr_fixture#0",
              chunkId: "chunk-c",
              kind: "asr",
              requestId: "req-1",
              artifactId: "artifact-1",
              pid: 999999,
              startedAt: new Date().toISOString(),
              heartbeatAt: new Date().toISOString(),
              state: "succeeded",
            };
            await writeActorStatusAtomic(actorStatusPath("artifact-1", "chunk-c"), status);
            return null;
          },
        },
      ],
      transformCtx: sendEventTransformCtx(sendEventCalls),
    });

    const execution = await engine.execute();
    expect(execution.error).toBeUndefined();
    expect(execution.result).toMatchObject({ chunkId: "chunk-c", cached: false });
    expect(
      sendEventCalls.some(
        (call) => (call[1] as { name?: string })?.name === "media/transcription.chunk.completed",
      ),
    ).toBe(true);
  });

  test("(d) waitForEvent timeout + stale heartbeat throws 'actor stalled' and calls killActorGroup", async () => {
    const eventData = baseEventData({ chunkId: "chunk-d" });
    // Same timeline note as (c): the stale "running" status only appears once
    // the (mocked) actor has actually spawned, so 01-reap-stale-actor (which
    // runs before spawn) must not see it.
    const sendEventCalls: unknown[][] = [];
    const { transcriptionAsrChunkRun } = await import("./transcription-asr-chunk");
    const engine = new InngestTestEngine({
      function: transcriptionAsrChunkRun as any,
      events: [{ name: "media/transcription.asr-chunk.requested", data: eventData } as any],
      steps: [
        {
          id: "03-wait-actor-0-0",
          handler: async () => {
            const status: ActorStatus = {
              schemaVersion: "joelclaw.transcription.actor-status.v1",
              actorId: "asr_fixture#0",
              chunkId: "chunk-d",
              kind: "asr",
              requestId: "req-1",
              artifactId: "artifact-1",
              pid: 999999,
              startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
              // 10 minutes old — well past the 3-minute freshness window.
              heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString(),
              state: "running",
            };
            await writeActorStatusAtomic(actorStatusPath("artifact-1", "chunk-d"), status);
            return null;
          },
        },
      ],
      transformCtx: sendEventTransformCtx(sendEventCalls),
    });

    const execution = await engine.execute();
    expect(execution.error).toBeDefined();
    expect(String((execution.error as { message?: string })?.message ?? execution.error)).toContain(
      "actor stalled",
    );
    expect(killCalls).toHaveLength(1);
  });

  test("(e) a genuine Inngest retry (attempt=1) re-executes reap+spawn and produces a NEW actorId", async () => {
    // Model a run whose attempt=0 already completed 00/01/02/03-*-0-* and
    // then failed (memoized by Inngest for the life of the run). A real
    // retry re-enters this same function body with attempt=1: because
    // 01-reap-stale-actor-${attempt} / 02-spawn-actor-${attempt} / the wait
    // loop's 03-*-${attempt}-${i} ids are parameterized by attempt, none of
    // the attempt=1 ids collide with the seeded attempt=0 state below, so
    // they must execute fresh — spawning a genuinely new actor rather than
    // replaying the first attempt's cached (failed) outcome forever.
    const eventData = baseEventData({ chunkId: "chunk-e" });
    spawnResult = { actorId: "asr_fixture#1", pid: 222222 };

    const sendEventCalls: unknown[][] = [];
    const { transcriptionAsrChunkRun } = await import("./transcription-asr-chunk");
    const engine = new InngestTestEngine({
      function: transcriptionAsrChunkRun as any,
      events: [{ name: "media/transcription.asr-chunk.requested", data: eventData } as any],
      steps: [
        { id: "00-check-claim", handler: () => ({ cached: false }) },
        { id: "01-reap-stale-actor-0", handler: () => undefined },
        { id: "02-spawn-actor-0", handler: () => ({ actorId: "asr_fixture#0", pid: 111111 }) },
        { id: "03-wait-actor-0-0", handler: () => null },
        {
          id: "03-check-status-0-0",
          handler: () => ({ verdict: "failed", error: "mlx_whisper exited 1 (attempt 0)" }),
        },
        {
          id: "03-wait-actor-1-0",
          handler: async () => {
            // The (re-spawned, attempt=1) actor now actually finishes.
            writeJsonFixture(eventData.resultPath, validAsrResult);
            return { data: { status: "succeeded", actorId: "asr_fixture#1" } };
          },
        },
      ],
      transformCtx: (rawCtx: any) => {
        const ctx = mockCtx(rawCtx);
        ctx.step.sendEvent = async (...args: unknown[]) => {
          sendEventCalls.push(args);
          return { ids: ["mock-event-id"] };
        };
        return { ...ctx, attempt: 1 };
      },
    });

    const execution = await engine.execute();
    expect(execution.error).toBeUndefined();
    expect(execution.result).toMatchObject({ chunkId: "chunk-e", cached: false });

    // Exactly one real spawn call happened in THIS execution (attempt=1's
    // 02-spawn-actor-1); attempt=0's spawn is only present as seeded state,
    // never re-invoked.
    expect(spawnCalls).toHaveLength(1);
    expect((spawnCalls[0] as { attempt?: number })?.attempt).toBe(1);

    const completedCall = sendEventCalls.find(
      (call) => (call[1] as { name?: string })?.name === "media/transcription.chunk.completed",
    );
    expect((completedCall?.[1] as { data?: Record<string, unknown> })?.data).toMatchObject({
      cached: false,
      kind: "asr",
    });
  });
});
