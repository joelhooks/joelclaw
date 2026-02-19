/**
 * Session pruning — clean up old session files.
 * Extracted from heartbeat for independent retry/scheduling.
 */

import { inngest } from "../client";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function getHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

async function collectFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(rootDir, entry.name);
      if (entry.isDirectory()) files.push(...(await collectFiles(fullPath)));
      else if (entry.isFile()) files.push(fullPath);
    }
  } catch {
    // Directory doesn't exist — fine
  }
  return files;
}

async function pruneOld(paths: string[], olderThanMs: number): Promise<number> {
  const threshold = Date.now() - olderThanMs;
  let count = 0;
  for (const path of paths) {
    try {
      const s = await stat(path);
      if (s.mtimeMs < threshold) {
        await rm(path, { force: true });
        count++;
      }
    } catch {
      // best-effort
    }
  }
  return count;
}

export const checkSessions = inngest.createFunction(
  { id: "check/sessions-prune", concurrency: { limit: 1 }, retries: 1 },
  { event: "sessions/prune.requested" },
  async ({ step }) => {
    const result = await step.run("prune-old-sessions", async () => {
      const home = getHome();
      const sessionFiles = await collectFiles(join(home, ".pi", "agent", "sessions"));
      const jsonlFiles = sessionFiles.filter((f) => f.endsWith(".jsonl"));
      const debugFiles = await collectFiles(join(home, ".claude", "debug"));

      const prunedSessions = await pruneOld(jsonlFiles, THIRTY_DAYS_MS);
      const prunedDebug = await pruneOld(debugFiles, THIRTY_DAYS_MS);

      return { prunedSessions, prunedDebug, total: prunedSessions + prunedDebug };
    });

    // NOOP: no gateway notification — pruning is silent housekeeping
    return { status: "ok", ...result };
  }
);
