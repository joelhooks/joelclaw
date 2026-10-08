import { opendir, stat } from "node:fs/promises";
import { join } from "node:path";

type SessionPruneOptions = {
  homeDir?: string;
  nowMs?: number;
};

export type SessionPruneSummary = {
  mode: "report_only";
  directoriesOpened: number;
  filesInspected: number;
  filesWouldPrune: number;
  piSessionFilesWouldPrune: number;
  claudeDebugFilesWouldPrune: number;
  directoryErrors: number;
  fileErrors: number;
  durationMs: number;
};

type SessionPruneCounters = Omit<SessionPruneSummary, "mode" | "durationMs">;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function isMissingPath(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

async function* listFilesRecursive(
  root: string,
  counters: SessionPruneCounters,
): AsyncGenerator<string> {
  const pendingDirectories = [root];

  while (pendingDirectories.length > 0) {
    const directoryPath = pendingDirectories.pop();
    if (!directoryPath) continue;

    let directory;
    try {
      directory = await opendir(directoryPath);
      counters.directoriesOpened += 1;
    } catch (error) {
      if (!isMissingPath(error)) counters.directoryErrors += 1;
      continue;
    }

    try {
      for await (const entry of directory) {
        const path = join(directoryPath, entry.name);
        if (entry.isDirectory()) pendingDirectories.push(path);
        else if (entry.isFile()) yield path;
      }
    } catch {
      counters.directoryErrors += 1;
    }
  }
}

/**
 * Count files older than 30 days in the existing local-session retention
 * targets. This function is report-only: it never removes or rewrites files.
 */
export async function pruneOldSessionFiles(
  options: SessionPruneOptions = {},
): Promise<SessionPruneSummary> {
  const startedAt = Date.now();
  const nowMs = options.nowMs ?? startedAt;
  const homeDir = options.homeDir ?? (process.env.HOME || process.env.USERPROFILE || "/Users/joel");
  const cutoffMs = nowMs - 30 * 24 * 60 * 60 * 1000;
  const counters: SessionPruneCounters = {
    directoriesOpened: 0,
    filesInspected: 0,
    filesWouldPrune: 0,
    piSessionFilesWouldPrune: 0,
    claudeDebugFilesWouldPrune: 0,
    directoryErrors: 0,
    fileErrors: 0,
  };
  const targets = [
    {
      root: join(homeDir, ".pi", "agent", "sessions"),
      extension: ".jsonl",
      counter: "piSessionFilesWouldPrune" as const,
    },
    {
      root: join(homeDir, ".claude", "debug"),
      extension: undefined,
      counter: "claudeDebugFilesWouldPrune" as const,
    },
  ];

  for (const target of targets) {
    for await (const path of listFilesRecursive(target.root, counters)) {
      if (target.extension && !path.endsWith(target.extension)) continue;
      counters.filesInspected += 1;
      try {
        const fileStats = await stat(path);
        if (fileStats.mtimeMs < cutoffMs) {
          counters.filesWouldPrune += 1;
          counters[target.counter] += 1;
        }
      } catch (error) {
        if (!isMissingPath(error)) counters.fileErrors += 1;
      }
    }
  }

  return { mode: "report_only", ...counters, durationMs: Date.now() - startedAt };
}
