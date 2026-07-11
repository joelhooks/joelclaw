import type { ActorStatus } from "../types";

export type KillActorGroupResult = "killed" | "already-dead" | "identity-mismatch";

export type KillActorGroupOpts = {
  graceMs?: number;
  ps?: (pid: number) => Promise<string | undefined>;
  kill?: (pid: number, signal: NodeJS.Signals | number) => void;
  sleep?: (ms: number) => Promise<void>;
};

function isESRCH(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ESRCH";
}

async function defaultPs(pid: number): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "command="], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return undefined;
    return stdout;
  } catch {
    return undefined;
  }
}

function defaultKill(pid: number, signal: NodeJS.Signals | number): void {
  process.kill(pid, signal);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Kills an actor's whole process group, but only after confirming the pid
 * still belongs to the actor we think it is (PID reuse guard). Never throws
 * on ESRCH — a process that's already gone is a success, not an error.
 */
export async function killActorGroup(
  status: ActorStatus,
  opts: KillActorGroupOpts = {},
): Promise<KillActorGroupResult> {
  const graceMs = opts.graceMs ?? 10_000;
  const ps = opts.ps ?? defaultPs;
  const kill = opts.kill ?? defaultKill;
  const sleep = opts.sleep ?? defaultSleep;

  const isAlive = (): boolean => {
    try {
      kill(status.pid, 0);
      return true;
    } catch (error) {
      if (isESRCH(error)) return false;
      // Any other error (e.g. EPERM) means the process exists but we can't
      // signal it; treat as alive rather than silently giving up.
      return true;
    }
  };

  if (!isAlive()) return "already-dead";

  const command = await ps(status.pid);
  if (!command || !command.includes(status.actorId)) {
    return "identity-mismatch";
  }

  try {
    kill(-status.pid, "SIGTERM");
  } catch (error) {
    if (isESRCH(error)) return "already-dead";
    throw error;
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive()) return "killed";
    await sleep(500);
  }

  if (isAlive()) {
    try {
      kill(-status.pid, "SIGKILL");
    } catch (error) {
      if (!isESRCH(error)) throw error;
    }
  }

  return "killed";
}
