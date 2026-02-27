import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── AC-1: getStoryDiff is exported from utils.ts ────────────────────────
describe("AC-1: getStoryDiff is exported from utils.ts", () => {
  test("getStoryDiff is a named export", async () => {
    const utils = await import("./utils.ts");
    expect(utils.getStoryDiff).toBeDefined();
    expect(typeof utils.getStoryDiff).toBe("function");
  });
});

import { getStoryDiff } from "./utils.ts";

// ── Helpers ─────────────────────────────────────────────────────────────
// Create a temporary git repo with commits for testing
let tempDir: string;

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "getStoryDiff-test-"));

  // Initialize a git repo with two commits so HEAD~1 exists
  await git(["init"], tempDir);
  await git(["config", "user.email", "test@test.com"], tempDir);
  await git(["config", "user.name", "Test"], tempDir);

  // First commit
  await Bun.write(join(tempDir, "file.txt"), "initial content\n");
  await git(["add", "."], tempDir);
  await git(["commit", "-m", "initial commit"], tempDir);

  // Second commit with a change
  await Bun.write(join(tempDir, "file.txt"), "modified content\n");
  await git(["add", "."], tempDir);
  await git(["commit", "-m", "second commit"], tempDir);
});

afterAll(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ── AC-2: Returns the git diff of the most recent commit ────────────────
describe("AC-2: Returns the git diff of the most recent commit", () => {
  test("returns a non-empty string for a repo with commits", async () => {
    const diff = await getStoryDiff(tempDir);
    expect(typeof diff).toBe("string");
    expect(diff.length).toBeGreaterThan(0);
  });

  test("diff contains the actual changes between commits", async () => {
    const diff = await getStoryDiff(tempDir);
    // The diff should show the change from "initial content" to "modified content"
    expect(diff).toContain("initial content");
    expect(diff).toContain("modified content");
  });

  test("diff includes diff markers (--- and +++)", async () => {
    const diff = await getStoryDiff(tempDir);
    expect(diff).toContain("---");
    expect(diff).toContain("+++");
  });

  test("return type is a string (Promise<string>)", async () => {
    const result = getStoryDiff(tempDir);
    // Should return a promise
    expect(result).toBeInstanceOf(Promise);
    const diff = await result;
    expect(typeof diff).toBe("string");
  });
});

// ── AC-3: Returns empty string on failure (does not throw) ──────────────
describe("AC-3: Returns empty string on failure", () => {
  test("returns empty string for a non-existent directory", async () => {
    const diff = await getStoryDiff("/tmp/nonexistent-repo-path-xyz-12345");
    expect(diff).toBe("");
  });

  test("returns empty string for a directory that is not a git repo", async () => {
    const nonGitDir = await mkdtemp(join(tmpdir(), "not-a-git-repo-"));
    try {
      const diff = await getStoryDiff(nonGitDir);
      expect(diff).toBe("");
    } finally {
      await rm(nonGitDir, { recursive: true, force: true });
    }
  });

  test("returns empty string for a repo with only one commit (no HEAD~1)", async () => {
    const singleCommitDir = await mkdtemp(
      join(tmpdir(), "single-commit-repo-")
    );
    try {
      await git(["init"], singleCommitDir);
      await git(["config", "user.email", "test@test.com"], singleCommitDir);
      await git(["config", "user.name", "Test"], singleCommitDir);
      await Bun.write(join(singleCommitDir, "file.txt"), "only commit\n");
      await git(["add", "."], singleCommitDir);
      await git(["commit", "-m", "only commit"], singleCommitDir);

      const diff = await getStoryDiff(singleCommitDir);
      expect(diff).toBe("");
    } finally {
      await rm(singleCommitDir, { recursive: true, force: true });
    }
  });

  test("does not throw on any failure scenario", async () => {
    // This should resolve without throwing, even with garbage input
    const diff = await getStoryDiff("");
    expect(typeof diff).toBe("string");
  });
});

// ── AC-4: TypeScript compiles cleanly ───────────────────────────────────
// This criterion is verified by `bunx tsc --noEmit` in CI.
// The fact that this file imports and type-checks getStoryDiff with
// (project: string) => Promise<string> is itself a compile-time verification.
