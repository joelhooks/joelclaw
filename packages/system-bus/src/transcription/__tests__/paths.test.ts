import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { actorRoot, asrChunkResultPath, rigRoot, workRoot } from "../paths";

test("transcription path builders reject traversal ids and protected rig roots", () => {
  const originalRoot = process.env.TRANSCRIPT_RIG_ROOT;
  try {
    const safeRoot = "/tmp/transcription-paths-test";
    process.env.TRANSCRIPT_RIG_ROOT = safeRoot;
    expect(workRoot("artifact-123")).toBe(join(safeRoot, ".transcript-rig-work", "artifact-123"));
    expect(() => workRoot("../../.pi/agent/sessions")).toThrow("unsafe transcription artifactId");
    expect(() => asrChunkResultPath("artifact-123", "../../.pi/agent/sessions", 0)).toThrow(
      "unsafe transcription sourceId",
    );
    expect(() => actorRoot("artifact-123", "../../.pi/agent/sessions")).toThrow(
      "unsafe transcription chunkId",
    );

    process.env.TRANSCRIPT_RIG_ROOT = join(
      process.env.HOME ?? "/Users/joel",
      ".pi",
      "agent",
      "sessions",
    );
    expect(() => rigRoot()).toThrow(
      "transcript rig root cannot be inside a protected agent harness",
    );
  } finally {
    if (originalRoot === undefined) delete process.env.TRANSCRIPT_RIG_ROOT;
    else process.env.TRANSCRIPT_RIG_ROOT = originalRoot;
  }
});

test("transcription output paths reject symlinks into protected harnesses", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "transcription-path-symlink-test-")));
  const rig = join(root, "rig");
  const sourceParent = join(rig, ".transcript-rig-work", "artifact-123", "raw", "chunked");
  const protectedSessions = join(homedir(), ".pi", "agent", "sessions");
  mkdirSync(sourceParent, { recursive: true });
  symlinkSync(protectedSessions, join(sourceParent, "source-1"), "dir");

  const originalRoot = process.env.TRANSCRIPT_RIG_ROOT;
  try {
    process.env.TRANSCRIPT_RIG_ROOT = rig;
    expect(() => asrChunkResultPath("artifact-123", "source-1", 0)).toThrow(
      "protected agent harness",
    );
  } finally {
    if (originalRoot === undefined) delete process.env.TRANSCRIPT_RIG_ROOT;
    else process.env.TRANSCRIPT_RIG_ROOT = originalRoot;
    rmSync(root, { recursive: true, force: true });
  }
});
