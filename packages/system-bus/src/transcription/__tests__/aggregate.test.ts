import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateChunkAsr, type WhisperAsr, writeAggregatedAsr } from "../aggregate";
import type { PlanChunk } from "../types";

function makeChunk(overrides: Partial<PlanChunk>): PlanChunk {
  return {
    index: 0,
    chunkId: "asr_chunk0",
    startMs: 0,
    endMs: 600_000,
    wavPath: "/chunks/000.wav",
    resultPath: "/chunks/out/0/asr.json",
    ...overrides,
  };
}

describe("aggregateChunkAsr", () => {
  test("offsets segment and word timestamps and renumbers ids", async () => {
    const chunk0 = makeChunk({ index: 0, chunkId: "asr_c0", startMs: 0, resultPath: "/c0.json" });
    const chunk1 = makeChunk({
      index: 1,
      chunkId: "asr_c1",
      startMs: 600_000,
      resultPath: "/c1.json",
    });

    const results: Record<string, WhisperAsr> = {
      "/c0.json": {
        text: "hello world",
        language: "en",
        segments: [
          {
            id: 0,
            start: 0,
            end: 2,
            text: "hello world",
            words: [
              { start: 0, end: 1, word: "hello" },
              { start: 1, end: 2, word: "world" },
            ],
          },
        ],
      },
      "/c1.json": {
        text: "goodbye",
        language: "en",
        segments: [
          {
            id: 0,
            start: 0,
            end: 1,
            text: "goodbye",
            words: [{ start: 0, end: 1, word: "goodbye" }],
          },
        ],
      },
    };

    const { asr, screened } = await aggregateChunkAsr({
      artifactId: "art-1",
      sourceId: "src-a",
      chunks: [chunk1, chunk0], // deliberately out of order — aggregate sorts by index
      readJson: async (path) => results[path],
    });

    expect(screened.repetitive).toBe(false);
    expect(asr.segments.map((segment) => segment.id)).toEqual([0, 1]);
    expect(asr.segments[0]?.start).toBe(0);
    expect(asr.segments[0]?.end).toBe(2);
    expect(asr.segments[1]?.start).toBe(600);
    expect(asr.segments[1]?.end).toBe(601);
    expect(asr.segments[1]?.words?.[0]?.start).toBe(600);
    expect(asr.segments[1]?.words?.[0]?.end).toBe(601);
    expect(asr.segments[0]?.words?.[0]?.start).toBe(0);
    expect(asr.text).toBe("hello world goodbye");
    expect(asr.language).toBe("en");
  });

  test("throws chunk_result_missing when a chunk result cannot be read", async () => {
    const chunk = makeChunk({ resultPath: "/missing.json" });
    await expect(
      aggregateChunkAsr({
        artifactId: "art-1",
        sourceId: "src-a",
        chunks: [chunk],
        readJson: async () => undefined,
      }),
    ).rejects.toThrow(/chunk_result_missing: asr_chunk0/);
  });

  test("throws chunk_repetitive when a chunk trips the repetition screen", async () => {
    const chunk = makeChunk({ resultPath: "/rep.json" });
    const segments = Array.from({ length: 20 }, () => ({
      start: 0,
      end: 1,
      text: "same phrase repeated forever",
    }));
    await expect(
      aggregateChunkAsr({
        artifactId: "art-1",
        sourceId: "src-a",
        chunks: [chunk],
        readJson: async () => ({ text: "x", segments }),
      }),
    ).rejects.toThrow(/chunk_repetitive: asr_chunk0/);
  });
});

describe("writeAggregatedAsr", () => {
  test("atomically writes the aggregate to rigAsrPath", async () => {
    const original = process.env.TRANSCRIPT_RIG_ROOT;
    const tempRoot = await mkdtemp(join(tmpdir(), "transcription-aggregate-"));
    process.env.TRANSCRIPT_RIG_ROOT = tempRoot;
    try {
      const asr: WhisperAsr = { text: "hi", segments: [] };
      await writeAggregatedAsr("art-1", "src-a", asr);
      const path = join(
        tempRoot,
        ".transcript-rig-work",
        "art-1",
        "raw",
        "asr",
        "src-a",
        "asr.json",
      );
      const written = JSON.parse(await readFile(path, "utf8"));
      expect(written.text).toBe("hi");
    } finally {
      if (original === undefined) delete process.env.TRANSCRIPT_RIG_ROOT;
      else process.env.TRANSCRIPT_RIG_ROOT = original;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
