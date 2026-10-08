import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  normalizeTranscriptSlug,
  resolveSafeTemporaryDirectory,
  resolveSafeVideoIngestTempDir,
} from "./transcript-paths";

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "transcript-paths-test-"));
  fixtures.push(root);
  return root;
}

describe("transcript temp path boundaries", () => {
  test("normalizes event slugs before using them in filesystem paths", () => {
    expect(normalizeTranscriptSlug("../../.pi/agent/sessions")).toBe("pi-agent-sessions");
    expect(normalizeTranscriptSlug("Safe title 123")).toBe("safe-title-123");
    expect(normalizeTranscriptSlug("../../")).toBe("transcript");
  });

  test("accepts only a UUID child of the video-ingest temp root", () => {
    const root = makeFixture();
    const tempRoot = join(root, "tmp");
    const videoRoot = join(tempRoot, "video-ingest");
    const home = join(root, "home");
    const candidate = join(videoRoot, randomUUID());
    mkdirSync(candidate, { recursive: true });

    expect(
      resolveSafeVideoIngestTempDir(candidate, {
        tmpRoot: tempRoot,
        videoIngestRoot: videoRoot,
        homeDir: home,
      }),
    ).toBe(realpathSync(candidate));
    expect(
      resolveSafeVideoIngestTempDir(join(home, ".pi", "agent", "sessions"), {
        tmpRoot: tempRoot,
        videoIngestRoot: videoRoot,
        homeDir: home,
      }),
    ).toBeNull();
    expect(
      resolveSafeVideoIngestTempDir(join(videoRoot, "..", "outside"), {
        tmpRoot: tempRoot,
        videoIngestRoot: videoRoot,
        homeDir: home,
      }),
    ).toBeNull();
  });

  test("rejects temp roots or candidate symlinks that resolve into a protected harness", () => {
    const root = makeFixture();
    const tempRoot = join(root, "tmp");
    const home = join(root, "home");
    const protectedRoot = join(home, ".pi", "agent", "sessions");
    const protectedCandidate = join(protectedRoot, randomUUID());
    const videoRoot = join(tempRoot, "video-ingest");
    const candidate = join(videoRoot, randomUUID());
    mkdirSync(protectedCandidate, { recursive: true });
    mkdirSync(videoRoot, { recursive: true });
    symlinkSync(protectedCandidate, candidate, "dir");

    expect(
      resolveSafeTemporaryDirectory(protectedCandidate, { tmpRoot: tempRoot, homeDir: home }),
    ).toBeNull();
    expect(
      resolveSafeVideoIngestTempDir(candidate, {
        tmpRoot: tempRoot,
        videoIngestRoot: videoRoot,
        homeDir: home,
      }),
    ).toBeNull();

    const sibling = join(videoRoot, randomUUID());
    const siblingAlias = join(videoRoot, randomUUID());
    mkdirSync(sibling);
    symlinkSync(sibling, siblingAlias, "dir");
    expect(
      resolveSafeVideoIngestTempDir(siblingAlias, {
        tmpRoot: tempRoot,
        videoIngestRoot: videoRoot,
        homeDir: home,
      }),
    ).toBeNull();
  });
});
