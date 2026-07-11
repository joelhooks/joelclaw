import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  actorId,
  asrChunkResultPath,
  chunkJobId,
  rigDiarizationPath,
  rigDiarizationWavPath,
} from "../../paths";
import { readActorStatus } from "../../status";
import type { ActorFinishedEventData, RunActorArgs } from "../run-actor";
import { runActor } from "../run-actor";

let originalRigRoot: string | undefined;
let originalOverride: string | undefined;
let originalHeartbeatMs: string | undefined;
let tempRigRoot: string;
let scriptsDir: string;

beforeEach(async () => {
  originalRigRoot = process.env.TRANSCRIPT_RIG_ROOT;
  originalOverride = process.env.TRANSCRIPTION_ACTOR_CMD_OVERRIDE;
  originalHeartbeatMs = process.env.TRANSCRIPTION_ACTOR_HEARTBEAT_MS;
  tempRigRoot = await mkdtemp(join(tmpdir(), "run-actor-"));
  process.env.TRANSCRIPT_RIG_ROOT = tempRigRoot;
  scriptsDir = join(tempRigRoot, "scripts");
  await mkdir(scriptsDir, { recursive: true });
});

afterEach(async () => {
  if (originalRigRoot === undefined) delete process.env.TRANSCRIPT_RIG_ROOT;
  else process.env.TRANSCRIPT_RIG_ROOT = originalRigRoot;
  if (originalOverride === undefined) delete process.env.TRANSCRIPTION_ACTOR_CMD_OVERRIDE;
  else process.env.TRANSCRIPTION_ACTOR_CMD_OVERRIDE = originalOverride;
  if (originalHeartbeatMs === undefined) delete process.env.TRANSCRIPTION_ACTOR_HEARTBEAT_MS;
  else process.env.TRANSCRIPTION_ACTOR_HEARTBEAT_MS = originalHeartbeatMs;
  delete process.env.TEST_SENTINEL_PATH;
  await rm(tempRigRoot, { recursive: true, force: true });
});

async function writeScript(name: string, source: string): Promise<string> {
  const path = join(scriptsDir, name);
  await writeFile(path, source);
  return path;
}

function setOverride(cmd: string[]): void {
  process.env.TRANSCRIPTION_ACTOR_CMD_OVERRIDE = JSON.stringify(cmd);
}

function baseAsrArgs(overrides: Partial<RunActorArgs> = {}): RunActorArgs {
  const artifactId = overrides.artifactId ?? "artifact-1";
  const sourceId = overrides.sourceId ?? "src-1";
  const index = overrides.index ?? 0;
  const attempt = overrides.attempt ?? 1;
  const chunkId = chunkJobId({ artifactId, kind: "asr", sourceId, index });
  return {
    kind: "asr",
    artifactId,
    requestId: "req-1",
    sourceId,
    index,
    attempt,
    rigRoot: tempRigRoot,
    actorTag: actorId(chunkId, attempt),
    ...overrides,
  };
}

function recordEvents(): {
  events: ActorFinishedEventData[];
  sendEvent: (data: ActorFinishedEventData) => Promise<void>;
} {
  const events: ActorFinishedEventData[] = [];
  return {
    events,
    sendEvent: async (data) => {
      events.push(data);
    },
  };
}

describe("runActor — asr happy path", () => {
  test("override cmd writes a valid asr.json => succeeded, event recorded, return 0", async () => {
    const scriptPath = await writeScript(
      "happy.ts",
      `
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const resultPath = process.env.TRANSCRIPTION_ACTOR_RESULT_PATH;
if (!resultPath) throw new Error("missing TRANSCRIPTION_ACTOR_RESULT_PATH");
mkdirSync(dirname(resultPath), { recursive: true });
writeFileSync(resultPath, JSON.stringify({
  text: "hello world",
  segments: [{ id: 0, start: 0, end: 1, text: "hello world" }],
  language: "en",
}));
`,
    );
    setOverride(["bun", scriptPath]);

    const args = baseAsrArgs();
    const { events, sendEvent } = recordEvents();
    const code = await runActor(args, { sendEvent });

    expect(code).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("succeeded");

    const chunkId = chunkJobId({
      artifactId: args.artifactId,
      kind: "asr",
      sourceId: args.sourceId,
      index: args.index,
    });
    const status = await readActorStatus(args.artifactId, chunkId);
    expect(status?.state).toBe("succeeded");
    expect(status?.resultPath).toBe(asrChunkResultPath(args.artifactId, args.sourceId, args.index));
  });
});

describe("runActor — repetition screen", () => {
  test("repeated segment trips the screen => failed, repetitive_output, result quarantined", async () => {
    const scriptPath = await writeScript(
      "repetitive.ts",
      `
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const resultPath = process.env.TRANSCRIPTION_ACTOR_RESULT_PATH;
if (!resultPath) throw new Error("missing TRANSCRIPTION_ACTOR_RESULT_PATH");
mkdirSync(dirname(resultPath), { recursive: true });
const segments = [];
for (let i = 0; i < 50; i++) {
  segments.push({ id: i, start: i, end: i + 1, text: "same phrase over and over" });
}
writeFileSync(resultPath, JSON.stringify({ text: "x", segments, language: "en" }));
`,
    );
    setOverride(["bun", scriptPath]);

    const args = baseAsrArgs({ sourceId: "src-repetitive" });
    const { events, sendEvent } = recordEvents();
    const code = await runActor(args, { sendEvent });

    expect(code).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("failed");
    expect(events[0]?.error).toMatch(/^repetitive_output/);

    const chunkId = chunkJobId({
      artifactId: args.artifactId,
      kind: "asr",
      sourceId: args.sourceId,
      index: args.index,
    });
    const status = await readActorStatus(args.artifactId, chunkId);
    expect(status?.state).toBe("failed");
    expect(status?.error).toMatch(/^repetitive_output/);

    const resultPath = asrChunkResultPath(args.artifactId, args.sourceId, args.index);
    const resultExists = await Bun.file(resultPath).exists();
    expect(resultExists).toBe(false);

    const siblings = await readdir(dirname(resultPath));
    expect(siblings.some((name) => name.startsWith("asr.json.rejected-"))).toBe(true);
  });
});

describe("runActor — idempotent short-circuit", () => {
  test("valid pre-existing asr result skips inference entirely", async () => {
    const args = baseAsrArgs({ sourceId: "src-idempotent" });
    const resultPath = asrChunkResultPath(args.artifactId, args.sourceId, args.index);
    await mkdir(dirname(resultPath), { recursive: true });
    await writeFile(
      resultPath,
      JSON.stringify({
        text: "already done",
        segments: [{ id: 0, start: 0, end: 1, text: "already done" }],
        language: "en",
      }),
    );

    const sentinelPath = join(tempRigRoot, "sentinel");
    const scriptPath = await writeScript(
      "sentinel.ts",
      `
import { writeFileSync } from "node:fs";
const sentinel = process.env.TEST_SENTINEL_PATH;
if (!sentinel) throw new Error("missing TEST_SENTINEL_PATH");
writeFileSync(sentinel, "ran");
`,
    );
    setOverride(["bun", scriptPath]);
    process.env.TEST_SENTINEL_PATH = sentinelPath;

    const { events, sendEvent } = recordEvents();
    const code = await runActor(args, { sendEvent });

    expect(code).toBe(0);
    expect(events[0]?.status).toBe("succeeded");
    const sentinelExists = await Bun.file(sentinelPath).exists();
    expect(sentinelExists).toBe(false);
  });

  test("valid pre-existing diarize jsonl skips inference entirely", async () => {
    const artifactId = "artifact-diarize";
    const sourceId = "src-diarize";
    const jsonlPath = rigDiarizationPath(artifactId, sourceId);
    await mkdir(dirname(jsonlPath), { recursive: true });
    await writeFile(jsonlPath, `${JSON.stringify({ start: 0, end: 1, speaker: "A" })}\n`);

    const sentinelPath = join(tempRigRoot, "diarize-sentinel");
    const scriptPath = await writeScript(
      "diarize-sentinel.ts",
      `
import { writeFileSync } from "node:fs";
const sentinel = process.env.TEST_SENTINEL_PATH;
if (!sentinel) throw new Error("missing TEST_SENTINEL_PATH");
writeFileSync(sentinel, "ran");
`,
    );
    setOverride(["bun", scriptPath]);
    process.env.TEST_SENTINEL_PATH = sentinelPath;

    const chunkId = chunkJobId({ artifactId, kind: "diarize", sourceId, index: 0 });
    const args: RunActorArgs = {
      kind: "diarize",
      artifactId,
      requestId: "req-1",
      sourceId,
      index: 0,
      attempt: 1,
      rigRoot: tempRigRoot,
      actorTag: actorId(chunkId, 1),
    };

    const { events, sendEvent } = recordEvents();
    const code = await runActor(args, { sendEvent });

    expect(code).toBe(0);
    expect(events[0]?.status).toBe("succeeded");
    const sentinelExists = await Bun.file(sentinelPath).exists();
    expect(sentinelExists).toBe(false);
  });
});

describe("runActor — child failure", () => {
  test("nonzero exit => failed, child_exit_<code>", async () => {
    const scriptPath = await writeScript("fail.ts", "process.exit(3);\n");
    setOverride(["bun", scriptPath]);

    const args = baseAsrArgs({ sourceId: "src-fail" });
    const { events, sendEvent } = recordEvents();
    const code = await runActor(args, { sendEvent });

    expect(code).toBe(1);
    expect(events[0]?.status).toBe("failed");
    expect(events[0]?.error).toBe("child_exit_3");

    const chunkId = chunkJobId({
      artifactId: args.artifactId,
      kind: "asr",
      sourceId: args.sourceId,
      index: args.index,
    });
    const status = await readActorStatus(args.artifactId, chunkId);
    expect(status?.state).toBe("failed");
    expect(status?.error).toBe("child_exit_3");
  });
});

describe("runActor — cancellation guard immediately before spawn", () => {
  test("signal received in the diarize wav-exists shortcut still blocks the inference spawn (critical fix)", async () => {
    // This is exactly the previously-unguarded path: an already-downmixed wav
    // means the whole `if (!wavExists)` sub-branch (the only place that used
    // to check `cancelled`) is skipped entirely, going straight from the
    // idempotency check to argv-building/spawn.
    const artifactId = "artifact-cancel-guard";
    const sourceId = "src-cancel-guard";
    const wavPath = rigDiarizationWavPath(artifactId, sourceId);
    await mkdir(dirname(wavPath), { recursive: true });
    await writeFile(wavPath, "fake-downmixed-wav-bytes");

    const sentinelPath = join(tempRigRoot, "cancel-guard-sentinel");
    const scriptPath = await writeScript(
      "cancel-guard.ts",
      `
import { writeFileSync } from "node:fs";
const sentinel = process.env.TEST_SENTINEL_PATH;
if (!sentinel) throw new Error("missing TEST_SENTINEL_PATH");
writeFileSync(sentinel, "ran");
`,
    );
    setOverride(["bun", scriptPath]);
    process.env.TEST_SENTINEL_PATH = sentinelPath;

    const chunkId = chunkJobId({ artifactId, kind: "diarize", sourceId, index: 0 });
    const args: RunActorArgs = {
      kind: "diarize",
      artifactId,
      requestId: "req-1",
      sourceId,
      index: 0,
      attempt: 1,
      rigRoot: tempRigRoot,
      actorTag: actorId(chunkId, 1),
    };

    const { events, sendEvent } = recordEvents();
    // readTrackMediaPath is the actor's only injectable seam on this path —
    // use it to simulate a SIGTERM arriving in the async gap between the
    // idempotency check and the inference spawn, exactly the window the
    // critical fix closes.
    const readTrackMediaPath = async () => {
      process.emit("SIGTERM", "SIGTERM");
      return { mediaPath: "/media/whatever.aac", expectedSpeakers: 2 };
    };

    const code = await runActor(args, { sendEvent, readTrackMediaPath });

    expect(code).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("failed");
    expect(events[0]?.error).toBe("cancelled_by_signal");

    const status = await readActorStatus(artifactId, chunkId);
    expect(status?.state).toBe("cancelled");

    // The whole point: inference must never have been launched.
    const sentinelExists = await Bun.file(sentinelPath).exists();
    expect(sentinelExists).toBe(false);
  }, 10_000);
});

describe("runActor — actor tag identity", () => {
  test("mismatched --actor-tag throws before anything runs", async () => {
    const args = baseAsrArgs({ sourceId: "src-mismatch", actorTag: "not-the-right-tag" });
    await expect(runActor(args)).rejects.toThrow(/actor_tag_mismatch/);
  });
});

describe("runActor — heartbeat", () => {
  test("heartbeatAt advances while the child runs", async () => {
    process.env.TRANSCRIPTION_ACTOR_HEARTBEAT_MS = "100";
    const scriptPath = await writeScript("slow.ts", "await Bun.sleep(1500);\n");
    setOverride(["bun", scriptPath]);

    const args = baseAsrArgs({ sourceId: "src-heartbeat" });
    const chunkId = chunkJobId({
      artifactId: args.artifactId,
      kind: "asr",
      sourceId: args.sourceId,
      index: args.index,
    });
    const { sendEvent } = recordEvents();
    const runPromise = runActor(args, { sendEvent });

    await Bun.sleep(300);
    const first = await readActorStatus(args.artifactId, chunkId);
    expect(first?.state).toBe("running");

    await Bun.sleep(400);
    const second = await readActorStatus(args.artifactId, chunkId);
    expect(second?.state).toBe("running");

    expect(first?.heartbeatAt).toBeDefined();
    expect(second?.heartbeatAt).toBeDefined();
    expect(Date.parse(second?.heartbeatAt ?? "")).toBeGreaterThan(Date.parse(first?.heartbeatAt ?? ""));

    await runPromise;
  });
});
