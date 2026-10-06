import { closeSync, openSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Overall budget, independent of the audit's per-source rsync deadlines.
export const AGENT_SESSION_BACKUP_TIMEOUT_MS = 2 * 60 * 60_000;

export async function runAgentSessionBackup(input: {
  command: string[];
  cwd: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = input.timeoutMs ?? AGENT_SESSION_BACKUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("Invalid agent session audit backup timeout");
  }
  if (!input.command[0]) throw new Error("Missing agent session audit backup command");

  // Same file-capture pattern as search-maintenance's private command runner.
  // Lifecycle: running -> completed | failed; deadline -> stopping -> timedOut.
  const captureDir = await mkdtemp(join(tmpdir(), "agent-session-backup-"));
  const stdoutPath = join(captureDir, "stdout.txt");
  const stderrPath = join(captureDir, "stderr.txt");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stdoutFd = openSync(stdoutPath, "wx", 0o600);
    let child;
    try {
      const stderrFd = openSync(stderrPath, "wx", 0o600);
      try {
        child = Bun.spawn(input.command, {
          cwd: input.cwd,
          env: process.env,
          // POSIX: own a process group so rsync/ssh die with the audit on timeout.
          detached: process.platform !== "win32",
          stdin: "ignore",
          stdout: stdoutFd,
          stderr: stderrFd,
        });
      } finally {
        closeSync(stderrFd);
      }
    } finally {
      closeSync(stdoutFd);
    }

    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      if (process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // Group may already have exited; fall back to the tracked child.
        }
      }
      child.kill("SIGKILL");
    }, timeoutMs);
    // Wait on exit, not pipe EOF: grandchildren can retain descriptors.
    const exitCode = await child.exited;
    clearTimeout(timer);

    const [stdout, stderr] = await Promise.all([
      readFile(stdoutPath, "utf8"),
      readFile(stderrPath, "utf8"),
    ]);
    const detail = stderr.trim() || stdout.trim();
    if (timedOut) {
      throw new Error(
        `agent session audit backup failed (timeout after ${timeoutMs}ms): ${detail}`,
      );
    }
    if (exitCode !== 0) {
      throw new Error(`agent session audit backup failed (${exitCode}): ${detail}`);
    }
  } finally {
    clearTimeout(timer);
    // Only disposable captures; never remove receipts or backup artifacts.
    await rm(captureDir, { recursive: true, force: true });
  }
}
