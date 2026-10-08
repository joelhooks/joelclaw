import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSafeLoopId,
  cleanLoopRootArtifacts,
  cleanupExistingLoopWorktree,
  isCancelled,
} from "./utils";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-loop-path-test-")));
  temporaryRoots.push(root);
  return root;
}

test("agent-loop cleanup rejects traversal and protected harness symlinks", () => {
  const home = makeTempRoot();
  const loopRoot = makeTempRoot();
  const protectedPiDir = join(home, ".pi");
  mkdirSync(protectedPiDir, { recursive: true });
  symlinkSync(protectedPiDir, join(loopRoot, "escape"), "dir");

  expect(() => assertSafeLoopId("loop-safe", loopRoot, home)).not.toThrow();
  expect(() => assertSafeLoopId("loop-safe", protectedPiDir, home)).toThrow();
  expect(() => assertSafeLoopId("../.pi", loopRoot, home)).toThrow();
  expect(() => assertSafeLoopId("escape", loopRoot, home)).toThrow();
  expect(lstatSync(protectedPiDir).isDirectory()).toBe(true);
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

function makeRepoWithLoopWorktree(): { repo: string; loopRoot: string; worktree: string } {
  const root = makeTempRoot();
  const repo = join(root, "repo");
  const loopRoot = join(root, "agent-loop");
  const worktree = join(loopRoot, "loop-safe");
  mkdirSync(loopRoot);
  git(root, "init", "-b", "main", repo);
  git(repo, "config", "user.name", "Pi Test");
  git(repo, "config", "user.email", "pi-test@example.invalid");
  writeFileSync(join(repo, "tracked.txt"), "clean\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-m", "test base");
  git(repo, "worktree", "add", "-b", "agent-loop/loop-safe", worktree);
  return { repo, loopRoot, worktree };
}

test("checking cancellation does not create a loop directory", () => {
  const loopRoot = makeTempRoot();
  expect(isCancelled("loop-safe", loopRoot)).toBe(false);
  expect(existsSync(join(loopRoot, "loop-safe"))).toBe(false);
});

test("artifact cleanup removes only root artifacts and preserves tests", async () => {
  const root = makeTempRoot();
  const loopRoot = join(root, "agent-loop");
  const worktree = join(loopRoot, "loop-safe");
  mkdirSync(join(worktree, "__tests__"), { recursive: true });
  mkdirSync(join(worktree, "nested"), { recursive: true });
  for (const file of [
    "fixture.out",
    "prd.json",
    "progress.txt",
    "notes.txt",
    "spec.acceptance.test.ts",
  ]) {
    writeFileSync(join(worktree, file), file);
  }
  writeFileSync(join(worktree, "__tests__", "keep.test.ts"), "test");
  writeFileSync(join(worktree, "nested", "keep.out"), "nested");

  expect(await cleanLoopRootArtifacts("loop-safe", loopRoot)).toBe(true);
  for (const file of ["fixture.out", "prd.json", "progress.txt"]) {
    expect(existsSync(join(worktree, file))).toBe(false);
  }
  for (const file of [
    "notes.txt",
    "spec.acceptance.test.ts",
    "__tests__/keep.test.ts",
    "nested/keep.out",
  ]) {
    expect(existsSync(join(worktree, file))).toBe(true);
  }
});

test("stale loop cleanup preserves a dirty worktree and its branch", async () => {
  const { repo, loopRoot, worktree } = makeRepoWithLoopWorktree();
  writeFileSync(join(worktree, "tracked.txt"), "dirty\n");

  await expect(cleanupExistingLoopWorktree(repo, "loop-safe", loopRoot)).rejects.toThrow(
    "Refusing to force-remove",
  );
  expect(readFileSync(join(worktree, "tracked.txt"), "utf8")).toBe("dirty\n");
  expect(existsSync(worktree)).toBe(true);
  expect(git(repo, "branch", "--list", "agent-loop/loop-safe").trim()).not.toBe("");
});

test("stale loop cleanup removes a clean worktree and only a merged branch", async () => {
  const { repo, loopRoot, worktree } = makeRepoWithLoopWorktree();

  await cleanupExistingLoopWorktree(repo, "loop-safe", loopRoot);
  expect(existsSync(worktree)).toBe(false);
  expect(git(repo, "branch", "--list", "agent-loop/loop-safe").trim()).toBe("");
});
