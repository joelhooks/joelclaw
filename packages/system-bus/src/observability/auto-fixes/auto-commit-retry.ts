import type { AutoFixHandler } from "./index";

const REPO_ROOT = "/Users/joel/Code/joelhooks/joelclaw";
const AUTO_COMMIT_MESSAGE = "chore: auto-commit from o11y triage";
const TEMP_DEBUG_FILE_PATTERNS = [
  /(^|\/)\.DS_Store$/iu,
  /(^|\/)\.env\..+/iu,
  /(^|\/)(tmp|temp|debug|scratch|sandbox)(\/|$)/iu,
  /(^|\/).+\.tmp$/iu,
  /(^|\/).+\.swp$/iu,
  /(^|\/).+\.log$/iu,
];

function trimOutput(output: unknown): string {
  if (typeof output === "string") return output.trim();
  if (output == null) return "";
  return String(output).trim();
}

function parseStatusLines(status: string): string[] {
  return status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function isUntrackedLine(line: string): boolean {
  return line.startsWith("?? ");
}

function untrackedPath(line: string): string {
  return line.slice(3).trim();
}

function hasMergeConflict(line: string): boolean {
  const code = line.slice(0, 2);
  return code.includes("U") || code === "AA" || code === "DD";
}

function isTempDebugPath(path: string): boolean {
  return TEMP_DEBUG_FILE_PATTERNS.some((pattern) => pattern.test(path));
}

function preview(paths: string[]): string {
  if (paths.length === 0) return "";
  const max = 3;
  const sample = paths.slice(0, max).join(", ");
  if (paths.length <= max) return sample;
  return `${sample}, +${paths.length - max} more`;
}

export const autoCommitAndRetry: AutoFixHandler = async () => {
  try {
    const statusResult = await Bun.$`git status --porcelain`.cwd(REPO_ROOT).quiet().nothrow();
    if (statusResult.exitCode !== 0) {
      const stderr = trimOutput(statusResult.stderr);
      return {
        fixed: false,
        detail: stderr.length > 0 ? `git status failed: ${stderr}` : `git status failed (exit ${statusResult.exitCode})`,
      };
    }

    const status = trimOutput(statusResult.stdout);
    if (status.length === 0) {
      return {
        fixed: true,
        detail: "working tree already clean",
      };
    }

    const lines = parseStatusLines(status);
    const conflicts = lines.filter(hasMergeConflict);
    if (conflicts.length > 0) {
      return {
        fixed: false,
        detail: `merge conflicts detected (${conflicts.length})`,
      };
    }

    const suspiciousUntracked = lines
      .filter(isUntrackedLine)
      .map(untrackedPath)
      .filter(isTempDebugPath);
    if (suspiciousUntracked.length > 0) {
      return {
        fixed: false,
        detail: `unsafe untracked temp/debug files detected: ${preview(suspiciousUntracked)}`,
      };
    }

    const addResult = await Bun.$`git add -A`.cwd(REPO_ROOT).quiet().nothrow();
    if (addResult.exitCode !== 0) {
      const stderr = trimOutput(addResult.stderr);
      return {
        fixed: false,
        detail: stderr.length > 0 ? `git add failed: ${stderr}` : `git add failed (exit ${addResult.exitCode})`,
      };
    }

    const stagedResult = await Bun.$`git diff --cached --name-only`.cwd(REPO_ROOT).quiet().nothrow();
    if (stagedResult.exitCode !== 0) {
      const stderr = trimOutput(stagedResult.stderr);
      return {
        fixed: false,
        detail: stderr.length > 0
          ? `unable to inspect staged files: ${stderr}`
          : `unable to inspect staged files (exit ${stagedResult.exitCode})`,
      };
    }

    const stagedFiles = trimOutput(stagedResult.stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (stagedFiles.length === 0) {
      return {
        fixed: true,
        detail: "working tree already clean",
      };
    }

    const commitResult = await Bun.$`git commit -m ${AUTO_COMMIT_MESSAGE}`.cwd(REPO_ROOT).quiet().nothrow();
    if (commitResult.exitCode !== 0) {
      const stderr = trimOutput(commitResult.stderr);
      const stdout = trimOutput(commitResult.stdout);
      const combined = [stderr, stdout].filter((value) => value.length > 0).join(" | ");
      if (/nothing to commit/iu.test(combined)) {
        return {
          fixed: true,
          detail: "working tree already clean",
        };
      }
      return {
        fixed: false,
        detail: combined.length > 0 ? `commit failed: ${combined}` : `commit failed (exit ${commitResult.exitCode})`,
      };
    }

    return {
      fixed: true,
      detail: `committed ${stagedFiles.length} files; push skipped by policy`,
    };
  } catch (error) {
    return {
      fixed: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
};
