import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InngestTestEngine, mockCtx } from "@inngest/test";
import { pipelineDeps } from "./media-transcription-pipeline";

type RigResult = {
  artifactId?: string;
  sourceId?: string;
  stage?: string;
  claimChecks?: Record<string, string>;
  layout?: { root?: string; pointer?: string };
};

let tempRoot = "";
let manifestFixturePath = "";
const originalRigRoot = process.env.TRANSCRIPT_RIG_ROOT;

const runRigCalls: string[][] = [];
let mockVerifyMediaMount = async (
  _sourcePath: string,
): Promise<{ available: boolean; blocker?: { code: "mount_unavailable"; message: string; retryable: true } }> => ({
  available: true,
});
let mockRunRig = async (
  args: string[],
  _opts?: { needsHuggingFace?: boolean; needsTypesense?: boolean },
): Promise<RigResult> => {
  runRigCalls.push(args);
  if (args[0] === "run") {
    return { artifactId: "artifact-fixture", claimChecks: { manifest: manifestFixturePath } };
  }
  const untilIndex = args.indexOf("--until");
  return {
    artifactId: "artifact-fixture",
    stage: untilIndex >= 0 ? args[untilIndex + 1] : "complete",
    claimChecks: {},
  };
};

// Stub the orchestrator's injectable rig deps so this test never spawns
// transcript-rig or touches /Volumes/badass-media (mutable closures reset per
// test). Property assignment beats mock.module(): it stays local to this
// module instance instead of patching the process-wide registry.
const realPipelineDeps = { ...pipelineDeps };
pipelineDeps.verifyMediaMount = ((sourcePath: string) =>
  mockVerifyMediaMount(sourcePath)) as typeof pipelineDeps.verifyMediaMount;
pipelineDeps.runRig = ((args: string[], opts?: { needsHuggingFace?: boolean; needsTypesense?: boolean }) =>
  mockRunRig(args, opts)) as typeof pipelineDeps.runRig;
pipelineDeps.recordStage = async () => {};
afterAll(() => {
  Object.assign(pipelineDeps, realPipelineDeps);
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

describe("mediaTranscriptionPipeline (v2)", () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "media-transcription-pipeline-test-"));
    process.env.TRANSCRIPT_RIG_ROOT = tempRoot;
    manifestFixturePath = join(tempRoot, "manifest.v1.json");
    writeFileSync(
      manifestFixturePath,
      JSON.stringify({ schemaVersion: "transcript-rig.manifest.v1", artifactId: "artifact-fixture", media: [] }),
    );
    runRigCalls.length = 0;
    mockVerifyMediaMount = async () => ({ available: true });
    mockRunRig = async (args: string[]): Promise<RigResult> => {
      runRigCalls.push(args);
      if (args[0] === "run") {
        return { artifactId: "artifact-fixture", claimChecks: { manifest: manifestFixturePath } };
      }
      const untilIndex = args.indexOf("--until");
      return {
        artifactId: "artifact-fixture",
        stage: untilIndex >= 0 ? args[untilIndex + 1] : "complete",
        claimChecks: {},
      };
    };
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    if (originalRigRoot === undefined) delete process.env.TRANSCRIPT_RIG_ROOT;
    else process.env.TRANSCRIPT_RIG_ROOT = originalRigRoot;
  });

  test("createFunction options match the pinned v2 contract", async () => {
    const { mediaTranscriptionPipeline } = await import("./media-transcription-pipeline");
    const opts = (mediaTranscriptionPipeline as any).opts;
    expect(opts.id).toBe("media-transcription-pipeline-v2");
    expect(opts.idempotency).toBe("event.data.requestId");
    expect(opts.concurrency).toMatchObject({ key: '"media-transcription"', limit: 1 });
    expect(opts.timeouts).toMatchObject({ start: "30m", finish: "12h" });
    expect(typeof opts.onFailure).toBe("function");
  });

  test("mount unavailable emits blocked and returns blocked (v1 parity)", async () => {
    mockVerifyMediaMount = async () => ({
      available: false,
      blocker: { code: "mount_unavailable", message: "no mount", retryable: true },
    });

    const sendEventCalls: unknown[][] = [];
    const { mediaTranscriptionPipeline } = await import("./media-transcription-pipeline");
    const engine = new InngestTestEngine({
      function: mediaTranscriptionPipeline as any,
      events: [
        {
          name: "media/transcription.requested",
          data: {
            requestId: "req-blocked",
            sourcePath: "/Volumes/badass-media/meetings/example.m4a",
          },
        } as any,
      ],
      transformCtx: sendEventTransformCtx(sendEventCalls),
    });

    const execution = await engine.execute();
    expect(execution.result).toMatchObject({ status: "blocked", requestId: "req-blocked" });
    expect(
      sendEventCalls.some((call) => (call[1] as { name?: string })?.name === "media/transcription.blocked"),
    ).toBe(true);
  });

  test("happy path (empty plan): NN- step ids present in order, completed event emitted", async () => {
    const sendEventCalls: unknown[][] = [];
    const { mediaTranscriptionPipeline } = await import("./media-transcription-pipeline");
    const engine = new InngestTestEngine({
      function: mediaTranscriptionPipeline as any,
      events: [
        {
          name: "media/transcription.requested",
          data: {
            requestId: "req-happy",
            sourcePath: "/Volumes/badass-media/meetings/example.m4a",
          },
        } as any,
      ],
      transformCtx: sendEventTransformCtx(sendEventCalls),
    });

    const execution = await engine.execute();
    expect(execution.error).toBeUndefined();

    const runStepIds = (execution.ctx.step.run as any).mock.calls.map(
      (call: unknown[]) => call[0],
    ) as string[];
    for (const id of [
      "00-verify-badass-media-mount",
      "01-stage-manifest",
      "02-plan-chunks",
      "05-merge-words",
      "06-render-editorial",
      "07-index-and-publish",
    ]) {
      expect(runStepIds).toContain(id);
    }
    for (const id of runStepIds) {
      expect(id).toMatch(/^\d{2}-/);
    }

    const completedCall = sendEventCalls.find(
      (call) => (call[1] as { name?: string })?.name === "media/transcription.completed",
    );
    expect(completedCall).toBeDefined();
    expect((completedCall?.[1] as { data?: Record<string, unknown> })?.data).toMatchObject({
      requestId: "req-happy",
      artifactId: "artifact-fixture",
      published: true,
      indexed: true,
    });
  });
});
