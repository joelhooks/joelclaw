import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { InngestTestEngine, mockCtx } from "@inngest/test";
import { actorStatusPath } from "../../transcription/paths";
import { writeActorStatusAtomic } from "../../transcription/status";
import type { ActorStatus } from "../../transcription/types";
import { diarizeDeps } from "./transcription-diarize";

let tempRoot = "";
const originalRigRoot = process.env.TRANSCRIPT_RIG_ROOT;

const spawnCalls: unknown[] = [];
let spawnResult = { actorId: "diarize_fixture#0", pid: 999999 };
const killCalls: unknown[] = [];
const leaseSecretCalls: unknown[] = [];

const realDiarizeDeps = { ...diarizeDeps };
diarizeDeps.spawnDetachedActor = (async (args: unknown) => {
  spawnCalls.push(args);
  return spawnResult;
}) as typeof diarizeDeps.spawnDetachedActor;
diarizeDeps.killActorGroup = (async (status: unknown) => {
  killCalls.push(status);
  return "already-dead" as const;
}) as typeof diarizeDeps.killActorGroup;
diarizeDeps.leaseSecret = async (name: string, ttl?: string) => {
  leaseSecretCalls.push({ name, ttl });
  return "fake-hf-token";
};
afterAll(() => {
  Object.assign(diarizeDeps, realDiarizeDeps);
});

function writeJsonlFixture(path: string, firstLineObj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(firstLineObj)}\n`);
}

function baseEventData(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    requestId: "req-1",
    artifactId: "artifact-1",
    sourcePath: "/Volumes/badass-media/meetings/example.m4a",
    rigRoot: tempRoot,
    sourceId: "src-1",
    chunkId: "diarize-chunk-1",
    total: 1,
    wavPath: join(tempRoot, "downmix.wav"),
    resultPath: join(tempRoot, "diarize.jsonl"),
    expectedSpeakers: 2,
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

describe("transcriptionDiarizeRun", () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "transcription-diarize-test-"));
    process.env.TRANSCRIPT_RIG_ROOT = tempRoot;
    spawnCalls.length = 0;
    killCalls.length = 0;
    leaseSecretCalls.length = 0;
    spawnResult = { actorId: "diarize_fixture#0", pid: 999999 };
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    if (originalRigRoot === undefined) delete process.env.TRANSCRIPT_RIG_ROOT;
    else process.env.TRANSCRIPT_RIG_ROOT = originalRigRoot;
  });

  test("createFunction options match the pinned contract", async () => {
    const { transcriptionDiarizeRun } = await import("./transcription-diarize");
    const opts = (transcriptionDiarizeRun as any).opts;
    expect(opts.id).toBe("transcription-diarize-v1");
    expect(opts.concurrency).toMatchObject({ key: '"transcription-diarize"', limit: 1 });
    expect(opts.retries).toBe(2);
    expect(typeof opts.onFailure).toBe("function");
  });

  test("cached jsonl completes without spawning, emits chunk.completed{cached:true}", async () => {
    const eventData = baseEventData();
    writeJsonlFixture(eventData.resultPath, { start: 0, end: 1, speaker: "SPEAKER_00" });

    const sendEventCalls: unknown[][] = [];
    const { transcriptionDiarizeRun } = await import("./transcription-diarize");
    const engine = new InngestTestEngine({
      function: transcriptionDiarizeRun as any,
      events: [{ name: "media/transcription.diarize.requested", data: eventData } as any],
      transformCtx: sendEventTransformCtx(sendEventCalls),
    });

    const execution = await engine.execute();
    expect(execution.error).toBeUndefined();
    expect(execution.result).toMatchObject({ chunkId: "diarize-chunk-1", cached: true });
    expect(spawnCalls).toHaveLength(0);
    expect(leaseSecretCalls).toHaveLength(0);
    const completedCall = sendEventCalls.find(
      (call) => (call[1] as { name?: string })?.name === "media/transcription.chunk.completed",
    );
    expect((completedCall?.[1] as { data?: Record<string, unknown> })?.data).toMatchObject({
      cached: true,
      kind: "diarize",
    });
  });

  test("waitForEvent timeout + status file says succeeded completes (event-loss tolerance)", async () => {
    const eventData = baseEventData({ chunkId: "diarize-chunk-c" });
    // Nothing exists yet at 00-check-claim time — the actor "finishes"
    // (writes its jsonl + status) only once the wait loop is reached,
    // modelling the real timeline where the spawn happens first.
    const sendEventCalls: unknown[][] = [];
    const { transcriptionDiarizeRun } = await import("./transcription-diarize");
    const engine = new InngestTestEngine({
      function: transcriptionDiarizeRun as any,
      events: [{ name: "media/transcription.diarize.requested", data: eventData } as any],
      steps: [
        {
          id: "03-wait-actor-0-0",
          handler: async () => {
            writeJsonlFixture(eventData.resultPath, { start: 0, end: 1, speaker: "SPEAKER_00" });
            const status: ActorStatus = {
              schemaVersion: "joelclaw.transcription.actor-status.v1",
              actorId: "diarize_fixture#0",
              chunkId: "diarize-chunk-c",
              kind: "diarize",
              requestId: "req-1",
              artifactId: "artifact-1",
              pid: 999999,
              startedAt: new Date().toISOString(),
              heartbeatAt: new Date().toISOString(),
              state: "succeeded",
            };
            await writeActorStatusAtomic(actorStatusPath("artifact-1", "diarize-chunk-c"), status);
            return null;
          },
        },
      ],
      transformCtx: sendEventTransformCtx(sendEventCalls),
    });

    const execution = await engine.execute();
    expect(execution.error).toBeUndefined();
    expect(execution.result).toMatchObject({ chunkId: "diarize-chunk-c", cached: false });
    expect(leaseSecretCalls).toHaveLength(1);
  });

  test("a genuine Inngest retry (attempt=1) re-executes reap+spawn and produces a NEW actorId", async () => {
    // See transcription-asr-chunk.test.ts (e) for the full rationale: static
    // step ids would let Inngest replay attempt=0's memoized (failed) outcome
    // forever; attempt-parameterized ids force a fresh reap+spawn.
    const eventData = baseEventData({ chunkId: "diarize-chunk-e" });
    spawnResult = { actorId: "diarize_fixture#1", pid: 222222 };

    const sendEventCalls: unknown[][] = [];
    const { transcriptionDiarizeRun } = await import("./transcription-diarize");
    const engine = new InngestTestEngine({
      function: transcriptionDiarizeRun as any,
      events: [{ name: "media/transcription.diarize.requested", data: eventData } as any],
      steps: [
        { id: "00-check-claim", handler: () => ({ cached: false }) },
        { id: "01-reap-stale-actor-0", handler: () => undefined },
        { id: "02-spawn-actor-0", handler: () => ({ actorId: "diarize_fixture#0", pid: 111111 }) },
        { id: "03-wait-actor-0-0", handler: () => null },
        {
          id: "03-check-status-0-0",
          handler: () => ({ verdict: "failed", error: "diarize.py exited 1 (attempt 0)" }),
        },
        {
          id: "03-wait-actor-1-0",
          handler: async () => {
            writeJsonlFixture(eventData.resultPath, { start: 0, end: 1, speaker: "SPEAKER_00" });
            return { data: { status: "succeeded", actorId: "diarize_fixture#1" } };
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
    expect(execution.result).toMatchObject({ chunkId: "diarize-chunk-e", cached: false });

    expect(spawnCalls).toHaveLength(1);
    expect((spawnCalls[0] as { attempt?: number })?.attempt).toBe(1);

    const completedCall = sendEventCalls.find(
      (call) => (call[1] as { name?: string })?.name === "media/transcription.chunk.completed",
    );
    expect((completedCall?.[1] as { data?: Record<string, unknown> })?.data).toMatchObject({
      cached: false,
      kind: "diarize",
    });
  });
});
