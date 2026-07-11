import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPlan,
  chunkOffsetsFromFiles,
  chunkTrackAudio,
  computeChunkBoundaries,
  probeDurationMs,
} from "../chunking";
import { chunkJobId, rigDiarizationPath } from "../paths";

let originalRigRoot: string | undefined;
let tempRigRoot: string;

beforeEach(async () => {
  originalRigRoot = process.env.TRANSCRIPT_RIG_ROOT;
  tempRigRoot = await mkdtemp(join(tmpdir(), "transcription-chunking-"));
  process.env.TRANSCRIPT_RIG_ROOT = tempRigRoot;
});

afterEach(async () => {
  if (originalRigRoot === undefined) delete process.env.TRANSCRIPT_RIG_ROOT;
  else process.env.TRANSCRIPT_RIG_ROOT = originalRigRoot;
  await rm(tempRigRoot, { recursive: true, force: true });
});

describe("computeChunkBoundaries", () => {
  test("exact math including remainder", () => {
    expect(computeChunkBoundaries(1_450_000, 600)).toEqual([
      { index: 0, startMs: 0, endMs: 600_000 },
      { index: 1, startMs: 600_000, endMs: 1_200_000 },
      { index: 2, startMs: 1_200_000, endMs: 1_450_000 },
    ]);
  });

  test("a track shorter than chunkSeconds yields one chunk", () => {
    expect(computeChunkBoundaries(30_000, 600)).toEqual([
      { index: 0, startMs: 0, endMs: 30_000 },
    ]);
  });

  test("rejects zero/negative duration", () => {
    expect(() => computeChunkBoundaries(0, 600)).toThrow();
    expect(() => computeChunkBoundaries(-5, 600)).toThrow();
  });
});

describe("probeDurationMs", () => {
  test("parses ffprobe json duration into milliseconds", async () => {
    const exec = async () => ({
      stdout: JSON.stringify({ format: { duration: "12.5" } }),
      stderr: "",
      code: 0,
    });
    await expect(probeDurationMs("/media/x.wav", exec)).resolves.toBe(12_500);
  });

  test("throws on nonzero exit", async () => {
    const exec = async () => ({ stdout: "", stderr: "boom", code: 1 });
    await expect(probeDurationMs("/media/x.wav", exec)).rejects.toThrow(/ffprobe_failed/);
  });
});

describe("chunkOffsetsFromFiles", () => {
  test("cumulative offsets from a fake probe with varying durations", async () => {
    const durations = new Map([
      ["/a/000.wav", 600_000],
      ["/a/001.wav", 450_000],
      ["/a/002.wav", 100_000],
    ]);
    const probe = async (path: string) => durations.get(path) ?? 0;
    const offsets = await chunkOffsetsFromFiles(
      ["/a/000.wav", "/a/001.wav", "/a/002.wav"],
      probe,
    );
    expect(offsets).toEqual([
      { index: 0, startMs: 0, endMs: 600_000, wavPath: "/a/000.wav" },
      { index: 1, startMs: 600_000, endMs: 1_050_000, wavPath: "/a/001.wav" },
      { index: 2, startMs: 1_050_000, endMs: 1_150_000, wavPath: "/a/002.wav" },
    ]);
  });

  test("preserves each file's embedded ordinal (not array position) across a gap — adopted foreign layout", async () => {
    // 001.wav is missing (e.g. a partially-completed prior run). The adopted
    // layout is [000.wav, 002.wav]; array position would compact this to
    // indices [0, 1], but paths.ts reconstructs chunk audio/result paths from
    // `index` alone (asrChunkAudioPath(artifactId, sourceId, index)), so the
    // returned index MUST be each file's own embedded ordinal (0, 2) or a
    // later actor for plan-index 1 would look for a 001.wav that was never
    // adopted instead of the real 002.wav.
    const durations = new Map([
      ["/a/000.wav", 600_000],
      ["/a/002.wav", 100_000],
    ]);
    const probe = async (path: string) => durations.get(path) ?? 0;
    const offsets = await chunkOffsetsFromFiles(["/a/000.wav", "/a/002.wav"], probe);
    expect(offsets).toEqual([
      { index: 0, startMs: 0, endMs: 600_000, wavPath: "/a/000.wav" },
      { index: 2, startMs: 600_000, endMs: 700_000, wavPath: "/a/002.wav" },
    ]);
  });

  test("throws on a chunk filename that isn't NNN.wav", async () => {
    await expect(chunkOffsetsFromFiles(["/a/not-a-chunk.wav"])).rejects.toThrow(
      /invalid_chunk_filename/,
    );
  });
});

describe("chunkTrackAudio", () => {
  test("adopts pre-existing chunk wavs without calling exec", async () => {
    const chunksDir = join(tempRigRoot, "chunks");
    await Bun.write(join(chunksDir, "000.wav"), "fake-wav-0");
    await Bun.write(join(chunksDir, "001.wav"), "fake-wav-1");

    let execCalled = false;
    const exec = async () => {
      execCalled = true;
      return { stdout: "", stderr: "", code: 0 };
    };

    const wavPaths = await chunkTrackAudio({
      mediaPath: "/media/source.aac",
      chunksDir,
      chunkSeconds: 600,
      exec,
    });

    expect(execCalled).toBe(false);
    expect(wavPaths).toEqual([join(chunksDir, "000.wav"), join(chunksDir, "001.wav")]);
  });

  test("runs ffmpeg exactly once when no chunks exist yet", async () => {
    const chunksDir = join(tempRigRoot, "fresh-chunks");
    let calls = 0;
    const exec = async (cmd: string) => {
      calls += 1;
      expect(cmd).toBe("ffmpeg");
      await Bun.write(join(chunksDir, "000.wav"), "chunk0");
      await Bun.write(join(chunksDir, "001.wav"), "chunk1");
      return { stdout: "", stderr: "", code: 0 };
    };

    const wavPaths = await chunkTrackAudio({
      mediaPath: "/media/source.aac",
      chunksDir,
      chunkSeconds: 600,
      exec,
    });

    expect(calls).toBe(1);
    expect(wavPaths).toEqual([join(chunksDir, "000.wav"), join(chunksDir, "001.wav")]);
  });
});

describe("buildPlan", () => {
  test("adopts a valid whole-track asr as asrDone with no chunks", async () => {
    const artifactId = "art-1";
    const plan = await buildPlan({
      requestId: "req-1",
      artifactId,
      sourcePath: "/media/source.aac",
      rigRoot: tempRigRoot,
      media: [{ sourceId: "src-a", path: "/media/source.aac", role: "diarize" }],
      deps: {
        readJson: async () => ({
          segments: Array.from({ length: 20 }, (_, i) => ({
            text: `distinct segment number ${i}`,
          })),
        }),
        chunkAudio: async () => {
          throw new Error("chunkAudio should not be called when asrDone");
        },
        diarizationValid: async () => true,
      },
    });

    expect(plan.tracks[0]?.asrDone).toBe(true);
    expect(plan.tracks[0]?.chunks).toEqual([]);
    expect(plan.diarizeTracks).toEqual([]);
  });

  test("quarantines a repetitive whole-track asr then chunks the track", async () => {
    const artifactId = "art-2";
    const renamed: Array<{ from: string; to: string }> = [];
    const repetitiveSegments = Array.from({ length: 20 }, () => ({
      text: "same phrase over and over",
    }));

    const plan = await buildPlan({
      requestId: "req-2",
      artifactId,
      sourcePath: "/media/source.aac",
      rigRoot: tempRigRoot,
      media: [{ sourceId: "src-b", path: "/media/source.aac", role: "media" }],
      deps: {
        readJson: async () => ({ segments: repetitiveSegments }),
        renameFile: async (from, to) => {
          renamed.push({ from, to });
        },
        chunkAudio: async () => ["/chunks/000.wav", "/chunks/001.wav"],
        offsetsFromFiles: async (wavPaths) =>
          wavPaths.map((wavPath, index) => ({
            index,
            startMs: index * 600_000,
            endMs: (index + 1) * 600_000,
            wavPath,
          })),
      },
    });

    expect(renamed.length).toBe(1);
    expect(renamed[0]?.to).toMatch(/\.rejected-/);
    expect(plan.tracks[0]?.asrDone).toBe(false);
    expect(plan.tracks[0]?.chunks.length).toBe(2);
  });

  test("mints deterministic chunkIds for a fresh track", async () => {
    const artifactId = "art-3";
    const plan = await buildPlan({
      requestId: "req-3",
      artifactId,
      sourcePath: "/media/source.aac",
      rigRoot: tempRigRoot,
      media: [{ sourceId: "src-c", path: "/media/source.aac", role: "media" }],
      deps: {
        readJson: async () => undefined,
        chunkAudio: async () => ["/chunks/000.wav", "/chunks/001.wav"],
        offsetsFromFiles: async (wavPaths) =>
          wavPaths.map((wavPath, index) => ({
            index,
            startMs: index * 600_000,
            endMs: (index + 1) * 600_000,
            wavPath,
          })),
      },
    });

    expect(plan.tracks[0]?.chunks[0]?.chunkId).toBe(
      chunkJobId({ artifactId, kind: "asr", sourceId: "src-c", index: 0 }),
    );
    expect(plan.tracks[0]?.chunks[1]?.chunkId).toBe(
      chunkJobId({ artifactId, kind: "asr", sourceId: "src-c", index: 1 }),
    );
  });

  test("selects diarizeTracks lacking a valid jsonl", async () => {
    const artifactId = "art-4";
    const plan = await buildPlan({
      requestId: "req-4",
      artifactId,
      sourcePath: "/media/source.aac",
      rigRoot: tempRigRoot,
      media: [
        { sourceId: "src-diarize-missing", path: "/media/a.aac", role: "diarize" },
        { sourceId: "src-diarize-present", path: "/media/b.aac", role: "diarize" },
        { sourceId: "src-known", path: "/media/c.aac", role: "known-speaker" },
      ],
      deps: {
        readJson: async () => undefined,
        chunkAudio: async () => ["/chunks/000.wav"],
        offsetsFromFiles: async (wavPaths) =>
          wavPaths.map((wavPath, index) => ({ index, startMs: 0, endMs: 600_000, wavPath })),
        diarizationValid: async (path) => path.includes("src-diarize-present"),
      },
    });

    expect(plan.diarizeTracks).toEqual(["src-diarize-missing"]);
  });

  test("default diarization validity check requires first-line JSON parse, matching runtime idempotency checks — a nonzero-size-but-corrupt jsonl is NOT adopted as done", async () => {
    const artifactId = "art-corrupt-diarization";
    const sourceId = "src-corrupt";
    const diarizationPath = rigDiarizationPath(artifactId, sourceId);
    // Nonzero size, but not valid JSON on the first line (e.g. an
    // interrupted write mid-flight from a concurrent tactical recovery).
    await Bun.write(diarizationPath, "{not valid json\nmore garbage\n");

    const plan = await buildPlan({
      requestId: "req-corrupt",
      artifactId,
      sourcePath: "/media/source.aac",
      rigRoot: tempRigRoot,
      media: [{ sourceId, path: "/media/source.aac", role: "diarize" }],
      deps: {
        readJson: async () => undefined,
        chunkAudio: async () => ["/chunks/000.wav"],
        offsetsFromFiles: async (wavPaths) =>
          wavPaths.map((wavPath, index) => ({ index, startMs: 0, endMs: 600_000, wavPath })),
        // no diarizationValid override — exercises the real default, which
        // must use the same first-line-parse rule as run-actor.ts /
        // transcription-diarize.ts, not just exists()+size>0.
      },
    });

    expect(plan.diarizeTracks).toEqual([sourceId]);
  });

  test("default diarization validity check accepts a genuinely valid jsonl (first line parses)", async () => {
    const artifactId = "art-valid-diarization";
    const sourceId = "src-valid";
    const diarizationPath = rigDiarizationPath(artifactId, sourceId);
    await Bun.write(diarizationPath, `${JSON.stringify({ start: 0, end: 1, speaker: "A" })}\n`);

    const plan = await buildPlan({
      requestId: "req-valid",
      artifactId,
      sourcePath: "/media/source.aac",
      rigRoot: tempRigRoot,
      media: [{ sourceId, path: "/media/source.aac", role: "diarize" }],
      deps: {
        readJson: async () => undefined,
        chunkAudio: async () => ["/chunks/000.wav"],
        offsetsFromFiles: async (wavPaths) =>
          wavPaths.map((wavPath, index) => ({ index, startMs: 0, endMs: 600_000, wavPath })),
      },
    });

    expect(plan.diarizeTracks).toEqual([]);
  });

  test("skips ignored tracks entirely", async () => {
    const artifactId = "art-5";
    const plan = await buildPlan({
      requestId: "req-5",
      artifactId,
      sourcePath: "/media/source.aac",
      rigRoot: tempRigRoot,
      media: [{ sourceId: "src-ignored", path: "/media/ignored.aac", role: "ignored" }],
      deps: {
        readJson: async () => {
          throw new Error("should never read claim checks for an ignored track");
        },
      },
    });

    expect(plan.tracks).toEqual([]);
  });
});
