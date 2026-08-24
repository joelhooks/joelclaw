import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

export const SLIM_TRANSPORT_LOCK_FILE = "/tmp/joelclaw/gateway.transport.lock";
const SHLOCK_BINARY = "/usr/bin/shlock";

export class SlimTransportOwnerConflictError extends Error {
  readonly _tag = "SlimTransportOwnerConflictError";

  constructor(
    readonly ownerPid: number,
    readonly evidence: "lock" | "pid",
  ) {
    super(`Slim gateway transport already owned by live PID ${ownerPid} (${evidence})`);
  }
}

export interface AtomicSlimTransportLockClaimInput {
  readonly lockFile: string;
  readonly pid: number;
}

export interface AtomicSlimTransportLockClaimResult {
  readonly acquired: boolean;
  readonly detail?: string;
}

export type AtomicSlimTransportLockClaim = (
  input: AtomicSlimTransportLockClaimInput,
) => Promise<AtomicSlimTransportLockClaimResult>;

export interface SlimTransportOwnershipOptions {
  readonly currentPid?: number;
  readonly pidFile: string;
  readonly lockFile?: string;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly atomicLockClaim?: AtomicSlimTransportLockClaim;
}

export interface SlimTransportOwnershipLease {
  readonly pid: number;
  clearStaleEvidence(paths: readonly string[]): Promise<void>;
  release(): Promise<void>;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(
      error
      && typeof error === "object"
      && "code" in error
      && error.code === "EPERM",
    );
  }
}

async function readPid(path: string): Promise<number | undefined> {
  const raw = await readFile(path, "utf8").catch(() => "");
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function claimAtomicSlimTransportLockWithShlock(
  input: AtomicSlimTransportLockClaimInput,
): Promise<AtomicSlimTransportLockClaimResult> {
  return new Promise((resolve, reject) => {
    execFile(
      SHLOCK_BINARY,
      ["-p", String(input.pid), "-f", input.lockFile],
      { shell: false },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve({ acquired: true });
          return;
        }
        if (typeof error.code === "number") {
          resolve({ acquired: false, detail: stderr.trim() || error.message });
          return;
        }
        reject(error);
      },
    );
  });
}

export async function assertNoLiveSlimTransportOwner(
  options: SlimTransportOwnershipOptions,
): Promise<void> {
  const currentPid = options.currentPid ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const ownerPid = await readPid(options.pidFile);
  if (ownerPid && ownerPid !== currentPid && isProcessAlive(ownerPid)) {
    throw new SlimTransportOwnerConflictError(ownerPid, "pid");
  }
}

export async function claimSlimTransportOwnership(
  options: SlimTransportOwnershipOptions,
): Promise<SlimTransportOwnershipLease> {
  const currentPid = options.currentPid ?? process.pid;
  const lockFile = options.lockFile ?? SLIM_TRANSPORT_LOCK_FILE;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const atomicLockClaim = options.atomicLockClaim ?? claimAtomicSlimTransportLockWithShlock;

  await assertNoLiveSlimTransportOwner({ ...options, currentPid, isProcessAlive });
  await mkdir(dirname(lockFile), { recursive: true });

  const claim = await atomicLockClaim({ lockFile, pid: currentPid });
  if (!claim.acquired) {
    const lockPid = await readPid(lockFile);
    if (lockPid && isProcessAlive(lockPid)) {
      throw new SlimTransportOwnerConflictError(lockPid, "lock");
    }
    const detail = claim.detail ? `: ${claim.detail}` : "";
    throw new Error(`Atomic slim gateway transport lock claim failed${detail}`);
  }

  const releaseOwnedLock = async () => {
    const lockPid = await readPid(lockFile);
    if (lockPid === currentPid) {
      await rm(lockFile, { force: true });
    }
  };

  try {
    await assertNoLiveSlimTransportOwner({ ...options, currentPid, isProcessAlive });
  } catch (error) {
    await releaseOwnedLock();
    throw error;
  }

  return {
    pid: currentPid,
    async clearStaleEvidence(paths) {
      await Promise.all(paths.map((path) => rm(path, { force: true })));
    },
    release: releaseOwnedLock,
  };
}
