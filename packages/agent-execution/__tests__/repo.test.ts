/**
 * Tests for repo materialization helpers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  getTouchedFiles,
  materializeRepo,
  RepoMaterializationError,
  verifyRepoState,
} from "../src/repo.js";

describe("repo materialization", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "agent-execution-test-"));
  });

  afterEach(async () => {
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test("materializeRepo clones fresh repo at baseSha", async () => {
    const repoPath = join(testDir, "test-repo");
    const remoteUrl = "https://github.com/joelhooks/joelclaw.git";
    
    // Get a recent commit SHA from the remote (use main branch head)
    const shaResult = await $`git ls-remote ${remoteUrl} HEAD`.text();
    const baseSha = shaResult.split("\t")[0].trim();

    const result = await materializeRepo(repoPath, baseSha, {
      remoteUrl,
      branch: "main",
      depth: 1,
      timeoutSeconds: 120,
    });

    expect(result.path).toBe(repoPath);
    expect(result.sha).toBe(baseSha);
    expect(result.freshClone).toBe(true);
    expect(result.durationMs).toBeGreaterThan(0);

    // Verify repo exists and is at correct SHA
    const actualSha = await $`git -C ${repoPath} rev-parse HEAD`.text();
    expect(actualSha.trim()).toBe(baseSha);
  });

  test("materializeRepo fails without remoteUrl for fresh clone", async () => {
    const repoPath = join(testDir, "test-repo");
    const baseSha = "abc123";

    await expect(
      materializeRepo(repoPath, baseSha, {})
    ).rejects.toThrow(RepoMaterializationError);
  });

  test("getTouchedFiles returns empty array for clean repo", async () => {
    // Create a simple git repo
    const repoPath = join(testDir, "test-repo");
    await $`git init ${repoPath}`.quiet();
    await $`git -C ${repoPath} config user.email "test@example.com"`.quiet();
    await $`git -C ${repoPath} config user.name "Test User"`.quiet();
    await $`echo "test" > ${repoPath}/test.txt`.quiet();
    await $`git -C ${repoPath} add test.txt`.quiet();
    await $`git -C ${repoPath} commit -m "Initial commit"`.quiet();

    const touchedFiles = await getTouchedFiles(repoPath);
    expect(touchedFiles).toEqual([]);
  });

  test("getTouchedFiles detects modified files", async () => {
    // Create a simple git repo
    const repoPath = join(testDir, "test-repo");
    await $`git init ${repoPath}`.quiet();
    await $`git -C ${repoPath} config user.email "test@example.com"`.quiet();
    await $`git -C ${repoPath} config user.name "Test User"`.quiet();
    await $`echo "test" > ${repoPath}/test.txt`.quiet();
    await $`git -C ${repoPath} add test.txt`.quiet();
    await $`git -C ${repoPath} commit -m "Initial commit"`.quiet();

    // Modify the file
    await $`echo "modified" > ${repoPath}/test.txt`.quiet();

    const touchedFiles = await getTouchedFiles(repoPath);
    expect(touchedFiles).toContain("test.txt");
  });

  test("getTouchedFiles detects untracked files", async () => {
    // Create a simple git repo
    const repoPath = join(testDir, "test-repo");
    await $`git init ${repoPath}`.quiet();
    await $`git -C ${repoPath} config user.email "test@example.com"`.quiet();
    await $`git -C ${repoPath} config user.name "Test User"`.quiet();
    await $`echo "test" > ${repoPath}/test.txt`.quiet();
    await $`git -C ${repoPath} add test.txt`.quiet();
    await $`git -C ${repoPath} commit -m "Initial commit"`.quiet();

    // Add untracked file
    await $`echo "untracked" > ${repoPath}/new.txt`.quiet();

    const touchedFiles = await getTouchedFiles(repoPath);
    expect(touchedFiles).toContain("new.txt");
  });

  test("verifyRepoState returns true for correct SHA", async () => {
    // Create a simple git repo
    const repoPath = join(testDir, "test-repo");
    await $`git init ${repoPath}`.quiet();
    await $`git -C ${repoPath} config user.email "test@example.com"`.quiet();
    await $`git -C ${repoPath} config user.name "Test User"`.quiet();
    await $`echo "test" > ${repoPath}/test.txt`.quiet();
    await $`git -C ${repoPath} add test.txt`.quiet();
    await $`git -C ${repoPath} commit -m "Initial commit"`.quiet();

    const sha = await $`git -C ${repoPath} rev-parse HEAD`.text();
    const expectedSha = sha.trim();

    const isValid = await verifyRepoState(repoPath, expectedSha);
    expect(isValid).toBe(true);
  });

  test("verifyRepoState returns false for incorrect SHA", async () => {
    // Create a simple git repo
    const repoPath = join(testDir, "test-repo");
    await $`git init ${repoPath}`.quiet();
    await $`git -C ${repoPath} config user.email "test@example.com"`.quiet();
    await $`git -C ${repoPath} config user.name "Test User"`.quiet();
    await $`echo "test" > ${repoPath}/test.txt`.quiet();
    await $`git -C ${repoPath} add test.txt`.quiet();
    await $`git -C ${repoPath} commit -m "Initial commit"`.quiet();

    const wrongSha = "0000000000000000000000000000000000000000";

    const isValid = await verifyRepoState(repoPath, wrongSha);
    expect(isValid).toBe(false);
  });
});
