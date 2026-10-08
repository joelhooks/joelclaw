import { randomUUID } from "node:crypto";
import { closeSync, openSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Overall budget, independent of the audit's per-source rsync deadlines.
export const AGENT_SESSION_BACKUP_TIMEOUT_MS = 2 * 60 * 60_000;
const LOCK_POLL_MS = 5_000;
// A lock file is briefly empty between its exclusive create and first write.
const UNREADABLE_LOCK_GRACE_MS = 10_000;

// Single-flight lock. The audit owns its own process group and outlives a dead
// worker, so a retry must not start a second copy while the first still runs.
type BackupLock = {
  token: string;
  ownerPid: number; // worker that took the lock
  pid: number | null; // audit leader, also its process group on POSIX
  startedAt: number;
  deadlineAt: number;
};

export async function runAgentSessionBackup(input: {
  command: string[];
  cwd: string;
  lockPath: string;
  timeoutMs?: number;
  lockPollMs?: number;
}): Promise<void> {
  const timeoutMs = input.timeoutMs ?? AGENT_SESSION_BACKUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("Invalid agent session audit backup timeout");
  }
  if (!input.command[0]) throw new Error("Missing agent session audit backup command");

  // Lifecycle: waiting (live earlier group) -> locked -> running -> completed | failed;
  // deadline -> stopping -> timedOut. Every exit path releases the lock it owns.
  const lock = await acquireBackupLock(input.lockPath, timeoutMs, input.lockPollMs ?? LOCK_POLL_MS);
  try {
    await runLocked(input, timeoutMs, (pid) => {
      lock.pid = pid;
      writeLockFile(input.lockPath, lock);
    });
  } finally {
    await reclaimLock(input.lockPath, lock.token);
  }
}

async function runLocked(
  input: { command: string[]; cwd: string },
  timeoutMs: number,
  onSpawn: (pid: number) => void,
): Promise<void> {
  // Same file-capture pattern as search-maintenance's private command runner.
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
      if (!killGroup(child.pid)) child.kill("SIGKILL");
    }, timeoutMs);
    try {
      onSpawn(child.pid);
    } catch (error) {
      // An unrecorded group could escape the next run's orphan check.
      killGroup(child.pid);
      await child.exited;
      throw error;
    }
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

async function acquireBackupLock(
  lockPath: string,
  timeoutMs: number,
  pollMs: number,
): Promise<BackupLock> {
  await mkdir(dirname(lockPath), { recursive: true });
  for (;;) {
    const now = Date.now();
    const lock: BackupLock = {
      token: randomUUID(),
      ownerPid: process.pid,
      pid: null,
      startedAt: now,
      deadlineAt: now + timeoutMs,
    };
    try {
      writeFileSync(lockPath, JSON.stringify(lock), { flag: "wx", mode: 0o600 });
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const held = await readLock(lockPath);
    if (!held) {
      const modifiedAt = await stat(lockPath).then(
        (s) => s.mtimeMs,
        () => null,
      );
      if (modifiedAt !== null && Date.now() - modifiedAt >= UNREADABLE_LOCK_GRACE_MS) {
        await unlink(lockPath).catch(() => {});
      } else if (modifiedAt !== null) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, 250)));
      }
      continue;
    }
    if (!isLockLive(held)) {
      await reclaimLock(lockPath, held.token);
      continue;
    }
    if (Date.now() >= held.deadlineAt) {
      // Earlier audit outlived its own deadline: stop it like its runner would have.
      if (held.pid !== null) killGroup(held.pid);
      await reclaimLock(lockPath, held.token);
      continue;
    }
    // Wait for the earlier audit; its recorded deadline bounds the wait.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollMs, Math.max(1, held.deadlineAt - Date.now()))),
    );
  }
}

// Remove the lock only while it still carries the token we observed.
async function reclaimLock(lockPath: string, token: string): Promise<void> {
  const current = await readLock(lockPath);
  if (current?.token === token) await unlink(lockPath).catch(() => {});
}

async function readLock(lockPath: string): Promise<BackupLock | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Partial<BackupLock>;
    if (
      typeof parsed.token !== "string" ||
      typeof parsed.ownerPid !== "number" ||
      typeof parsed.startedAt !== "number" ||
      typeof parsed.deadlineAt !== "number" ||
      (parsed.pid !== null && typeof parsed.pid !== "number")
    ) {
      return null;
    }
    return parsed as BackupLock;
  } catch {
    return null;
  }
}

function writeLockFile(lockPath: string, lock: BackupLock): void {
  const temp = `${lockPath}.${lock.token}.tmp`;
  writeFileSync(temp, JSON.stringify(lock), { mode: 0o600 });
  // Atomic replace: readers never see a half-written record.
  renameSync(temp, lockPath);
}

// Live when the audit group still has members, or before spawn, when the
// worker that took the lock is still alive.
function isLockLive(lock: BackupLock): boolean {
  if (lock.pid !== null) return isGroupAlive(lock.pid);
  return isProcessAlive(lock.ownerPid);
}

function isGroupAlive(pid: number): boolean {
  return process.platform === "win32" ? isProcessAlive(pid) : signalExists(-pid);
}

function isProcessAlive(pid: number): boolean {
  return signalExists(pid);
}

function signalExists(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    // EPERM: exists but owned by someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killGroup(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    // Group may already have exited.
    return false;
  }
}
