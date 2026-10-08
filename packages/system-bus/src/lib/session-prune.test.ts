import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneOldSessionFiles } from "./session-prune";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test("reports old Pi JSONL and Claude debug files without deleting them", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "session-prune-test-"));
  const homeDir = join(sandbox, "home");
  const piSessions = join(homeDir, ".pi", "agent", "sessions");
  const claudeDebug = join(homeDir, ".claude", "debug");
  const nowMs = Date.now();

  try {
    await Promise.all([
      mkdir(piSessions, { recursive: true }),
      mkdir(claudeDebug, { recursive: true }),
    ]);

    const oldPiJsonl = join(piSessions, "old.jsonl");
    const recentPiJsonl = join(piSessions, "recent.jsonl");
    const oldPiOther = join(piSessions, "keep.txt");
    const oldClaudeLog = join(claudeDebug, "old.log");
    const recentClaudeLog = join(claudeDebug, "recent.log");
    const filePaths = [oldPiJsonl, recentPiJsonl, oldPiOther, oldClaudeLog, recentClaudeLog];
    await Promise.all(filePaths.map((path) => writeFile(path, "test")));

    const oldDate = new Date(nowMs - THIRTY_DAYS_MS - 1_000);
    const recentDate = new Date(nowMs - THIRTY_DAYS_MS + 1_000);
    const freshDate = new Date(nowMs - 24 * 60 * 60 * 1_000);
    await Promise.all([
      utimes(oldPiJsonl, oldDate, oldDate),
      utimes(recentPiJsonl, recentDate, recentDate),
      utimes(oldPiOther, oldDate, oldDate),
      utimes(oldClaudeLog, oldDate, oldDate),
      utimes(recentClaudeLog, freshDate, freshDate),
    ]);

    const summary = await pruneOldSessionFiles({ homeDir, nowMs });

    expect(await exists(oldPiJsonl)).toBe(true);
    expect(await exists(oldClaudeLog)).toBe(true);
    expect(summary.filesInspected).toBe(4);
    expect(summary.filesWouldPrune).toBe(2);
    expect(summary.piSessionFilesWouldPrune).toBe(1);
    expect(summary.claudeDebugFilesWouldPrune).toBe(1);
    expect(await exists(recentPiJsonl)).toBe(true);
    expect(await exists(oldPiOther)).toBe(true);
    expect(await exists(recentClaudeLog)).toBe(true);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("missing roots are a no-op", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "session-prune-missing-"));
  try {
    const summary = await pruneOldSessionFiles({ homeDir: sandbox, nowMs: Date.now() });
    expect(summary.filesInspected).toBe(0);
    expect(summary.filesWouldPrune).toBe(0);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
