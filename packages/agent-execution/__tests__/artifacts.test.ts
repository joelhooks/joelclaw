/**
 * Tests for artifact generation helpers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  ArtifactGenerationError,
  generatePatchArtifact,
  readArtifactBundle,
  writeArtifactBundle,
} from "../src/artifacts.js";

describe("artifact generation", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "agent-execution-test-"));
  });

  afterEach(async () => {
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test("generatePatchArtifact creates artifact with patch for committed changes", async () => {
    // Create a simple git repo
    const repoPath = join(testDir, "test-repo");
    await $`git init ${repoPath}`.quiet();
    await $`git -C ${repoPath} config user.email "test@example.com"`.quiet();
    await $`git -C ${repoPath} config user.name "Test User"`.quiet();
    await $`echo "initial" > ${repoPath}/test.txt`.quiet();
    await $`git -C ${repoPath} add test.txt`.quiet();
    await $`git -C ${repoPath} commit -m "Initial commit"`.quiet();

    const baseSha = await $`git -C ${repoPath} rev-parse HEAD`.text();
    const baseShaClean = baseSha.trim();

    // Make a change and commit
    await $`echo "modified" > ${repoPath}/test.txt`.quiet();
    await $`git -C ${repoPath} add test.txt`.quiet();
    await $`git -C ${repoPath} commit -m "Modify file"`.quiet();

    const headSha = await $`git -C ${repoPath} rev-parse HEAD`.text();
    const headShaClean = headSha.trim();

    const artifact = await generatePatchArtifact({
      repoPath,
      baseSha: baseShaClean,
      headSha: headShaClean,
    });

    expect(artifact.headSha).toBe(headShaClean);
    expect(artifact.touchedFiles).toEqual([]);
    expect(artifact.patch).toBeTruthy();
    expect(artifact.patch).toContain("test.txt");
    expect(artifact.patch).toContain("modified");
  });

  test("generatePatchArtifact creates artifact with empty patch when no changes", async () => {
    // Create a simple git repo
    const repoPath = join(testDir, "test-repo");
    await $`git init ${repoPath}`.quiet();
    await $`git -C ${repoPath} config user.email "test@example.com"`.quiet();
    await $`git -C ${repoPath} config user.name "Test User"`.quiet();
    await $`echo "initial" > ${repoPath}/test.txt`.quiet();
    await $`git -C ${repoPath} add test.txt`.quiet();
    await $`git -C ${repoPath} commit -m "Initial commit"`.quiet();

    const baseSha = await $`git -C ${repoPath} rev-parse HEAD`.text();
    const baseShaClean = baseSha.trim();

    const artifact = await generatePatchArtifact({
      repoPath,
      baseSha: baseShaClean,
      headSha: baseShaClean,
    });

    expect(artifact.headSha).toBe(baseShaClean);
    expect(artifact.touchedFiles).toEqual([]);
    expect(artifact.patch).toBe("");
  });

  test("generatePatchArtifact includes touched files for uncommitted changes", async () => {
    // Create a simple git repo
    const repoPath = join(testDir, "test-repo");
    await $`git init ${repoPath}`.quiet();
    await $`git -C ${repoPath} config user.email "test@example.com"`.quiet();
    await $`git -C ${repoPath} config user.name "Test User"`.quiet();
    await $`echo "initial" > ${repoPath}/test.txt`.quiet();
    await $`git -C ${repoPath} add test.txt`.quiet();
    await $`git -C ${repoPath} commit -m "Initial commit"`.quiet();

    const baseSha = await $`git -C ${repoPath} rev-parse HEAD`.text();
    const baseShaClean = baseSha.trim();

    // Make a change without committing
    await $`echo "modified" > ${repoPath}/test.txt`.quiet();

    const artifact = await generatePatchArtifact({
      repoPath,
      baseSha: baseShaClean,
    });

    expect(artifact.headSha).toBe(baseShaClean);
    expect(artifact.touchedFiles).toContain("test.txt");
    expect(artifact.patch).toBeTruthy();
  });

  test("generatePatchArtifact includes verification data when provided", async () => {
    // Create a simple git repo
    const repoPath = join(testDir, "test-repo");
    await $`git init ${repoPath}`.quiet();
    await $`git -C ${repoPath} config user.email "test@example.com"`.quiet();
    await $`git -C ${repoPath} config user.name "Test User"`.quiet();
    await $`echo "initial" > ${repoPath}/test.txt`.quiet();
    await $`git -C ${repoPath} add test.txt`.quiet();
    await $`git -C ${repoPath} commit -m "Initial commit"`.quiet();

    const baseSha = await $`git -C ${repoPath} rev-parse HEAD`.text();
    const baseShaClean = baseSha.trim();

    const artifact = await generatePatchArtifact({
      repoPath,
      baseSha: baseShaClean,
      verificationCommands: ["bun test", "bunx tsc --noEmit"],
      verificationSuccess: true,
      verificationOutput: "All tests passed",
    });

    expect(artifact.verification).toBeDefined();
    expect(artifact.verification?.commands).toEqual(["bun test", "bunx tsc --noEmit"]);
    expect(artifact.verification?.success).toBe(true);
    expect(artifact.verification?.output).toBe("All tests passed");
  });

  test("generatePatchArtifact includes log references when provided", async () => {
    // Create a simple git repo
    const repoPath = join(testDir, "test-repo");
    await $`git init ${repoPath}`.quiet();
    await $`git -C ${repoPath} config user.email "test@example.com"`.quiet();
    await $`git -C ${repoPath} config user.name "Test User"`.quiet();
    await $`echo "initial" > ${repoPath}/test.txt`.quiet();
    await $`git -C ${repoPath} add test.txt`.quiet();
    await $`git -C ${repoPath} commit -m "Initial commit"`.quiet();

    const baseSha = await $`git -C ${repoPath} rev-parse HEAD`.text();
    const baseShaClean = baseSha.trim();

    const artifact = await generatePatchArtifact({
      repoPath,
      baseSha: baseShaClean,
      executionLogPath: "/tmp/execution.log",
      verificationLogPath: "/tmp/verification.log",
    });

    expect(artifact.logs).toBeDefined();
    expect(artifact.logs?.executionLog).toBe("/tmp/execution.log");
    expect(artifact.logs?.verificationLog).toBe("/tmp/verification.log");
  });

  test("writeArtifactBundle writes JSON to disk", async () => {
    const artifact = {
      headSha: "abc123",
      touchedFiles: ["file1.ts", "file2.ts"],
      patch: "diff content",
    };

    const outputPath = join(testDir, "artifacts.json");
    const written = await writeArtifactBundle(artifact, outputPath);

    expect(written).toBe(outputPath);

    // Verify file exists and contains correct data
    const file = Bun.file(outputPath);
    const content = await file.text();
    const parsed = JSON.parse(content);

    expect(parsed).toEqual(artifact);
  });

  test("readArtifactBundle reads JSON from disk", async () => {
    const artifact = {
      headSha: "abc123",
      touchedFiles: ["file1.ts", "file2.ts"],
      patch: "diff content",
    };

    const filePath = join(testDir, "artifacts.json");
    await Bun.write(filePath, JSON.stringify(artifact, null, 2));

    const read = await readArtifactBundle(filePath);

    expect(read).toEqual(artifact);
  });

  test("readArtifactBundle throws on invalid JSON", async () => {
    const filePath = join(testDir, "invalid.json");
    await Bun.write(filePath, "not valid json");

    await expect(readArtifactBundle(filePath)).rejects.toThrow(ArtifactGenerationError);
  });
});
