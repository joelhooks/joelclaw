import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProtectedHarnessPath, resolveSafeTemporaryPath } from "./protected-harness-paths";

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("protects agent sessions, Run stores, and capture outboxes from cleanup", () => {
  const home = "/Users/fixture";

  for (const path of [
    join(home, ".pi", "agent", "sessions", "run.jsonl"),
    join(home, ".claude", "projects", "run.jsonl"),
    join(home, ".codex", "sessions", "run.jsonl"),
    join(home, ".cursor", "sessions", "run.jsonl"),
    join(home, ".grok", "sessions", "run.jsonl"),
    join(home, ".opencode", "sessions", "run.jsonl"),
    join(home, ".joelclaw", "runs-dev", "run.jsonl"),
    join(home, ".joelclaw", "capture", "flagg", "claude-code", "outbox", "run.json"),
    "~/.pi/agent/sessions/run.jsonl",
  ]) {
    expect(isProtectedHarnessPath(path, home)).toBe(true);
  }

  expect(isProtectedHarnessPath(join(home, "Vault", "books", "book.pdf"), home)).toBe(false);
});

test("resolves scratch targets through real paths and rejects harness symlinks", () => {
  const fixture = mkdtempSync(join(tmpdir(), "protected-path-test-"));
  fixtures.push(fixture);
  const tempRoot = join(fixture, "tmp");
  const home = join(fixture, "home");
  const protectedRoot = join(home, ".pi", "agent", "sessions");
  mkdirSync(tempRoot, { recursive: true });
  mkdirSync(protectedRoot, { recursive: true });
  const homePiAlias = join(fixture, "home-pi-alias");
  symlinkSync(join(home, ".pi"), homePiAlias, "dir");
  expect(isProtectedHarnessPath(join(homePiAlias, "agent", "sessions", "run.jsonl"), home)).toBe(
    true,
  );

  const missingTarget = join(tempRoot, "new", "nested");
  expect(resolveSafeTemporaryPath(missingTarget, { tmpRoot: tempRoot, homeDir: home })).toBe(
    join(realpathSync(tempRoot), "new", "nested"),
  );
  expect(
    resolveSafeTemporaryPath(join(protectedRoot, "run.jsonl"), { tmpRoot: home, homeDir: home }),
  ).toBeNull();

  const tempAlias = join(fixture, "tmp-alias");
  symlinkSync(protectedRoot, tempAlias, "dir");
  expect(
    resolveSafeTemporaryPath(join(tempAlias, "run.jsonl"), { tmpRoot: tempRoot, homeDir: home }),
  ).toBeNull();
  expect(
    resolveSafeTemporaryPath(join(tempAlias, "run.jsonl"), { tmpRoot: tempAlias, homeDir: home }),
  ).toBeNull();

  const scratchDir = join(tempRoot, "scratch");
  const scratchAlias = join(tempRoot, "scratch-alias");
  mkdirSync(scratchDir);
  symlinkSync(scratchDir, scratchAlias, "dir");
  expect(resolveSafeTemporaryPath(scratchAlias, { tmpRoot: tempRoot, homeDir: home })).toBeNull();
});
