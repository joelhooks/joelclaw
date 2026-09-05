import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

const MAX_RECEIPT_BYTES = 16 * 1024;
const PROCESS_IDENTITY_PATTERN = /^[a-f0-9]{64}$/u;
const LOCKF_PATH = "/usr/bin/lockf";
const MUTEX_READY = "FLOWING_MEMORY_MUTEX_READY\n";
const MUTEX_START_TIMEOUT_MS = 5_000;
const MUTEX_STOP_TIMEOUT_MS = 2_000;

export type WorkerOwnershipErrorCode =
  | "lease-contended"
  | "mutex-lost"
  | "mutex-unavailable"
  | "owner-ambiguous"
  | "owner-live"
  | "ownership-lost"
  | "process-identity-unavailable"
  | "receipt-inaccessible"
  | "receipt-malformed"
  | "receipt-unsafe";

export class WorkerOwnershipError extends Error {
  readonly code: WorkerOwnershipErrorCode;

  constructor(code: WorkerOwnershipErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkerOwnershipError";
    this.code = code;
  }
}

export type ProcessIdentityProbeResult =
  | { readonly _tag: "Alive"; readonly processStartIdentity: string }
  | { readonly _tag: "Dead" }
  | { readonly _tag: "Uncertain"; readonly reason: string };

export type ProcessIdentityProbe = (pid: number) => Promise<ProcessIdentityProbeResult>;

type ReceiptKind = "daemon" | "operation";

type VersionedOwnershipReceipt =
  | {
      readonly _tag: "FlowingMemoryWorkerOwnershipV2";
      readonly kind: "daemon";
      readonly pid: number;
      readonly processStartIdentity: string;
      readonly schemaVersion: 2;
      readonly token: string;
    }
  | {
      readonly _tag: "FlowingMemoryWorkerOwnershipV2";
      readonly kind: "operation";
      readonly operation: string;
      readonly pid: number;
      readonly processStartIdentity: string;
      readonly schemaVersion: 2;
      readonly token: string;
    };

type ParsedOwnershipReceipt =
  | VersionedOwnershipReceipt
  | {
      readonly _tag: "LegacyDaemonPidV1";
      readonly kind: "daemon";
      readonly pid: number;
    }
  | {
      readonly _tag: "LegacyOperationOwnershipV1";
      readonly kind: "operation";
      readonly operation: string;
      readonly pid: number;
      readonly token: string;
    };

interface InodeIdentity {
  readonly device: number;
  readonly inode: number;
}

interface ObservedOwnershipReceipt {
  readonly inode: InodeIdentity;
  readonly parsed: ParsedOwnershipReceipt;
  readonly path: string;
  readonly raw: string;
}

type ReceiptObservation =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Present"; readonly receipt: ObservedOwnershipReceipt };

type ExistingOwnerDisposition =
  | { readonly _tag: "Ambiguous" }
  | { readonly _tag: "Live" }
  | { readonly _tag: "Stale" };

export interface OwnedWorkerReceipt {
  readonly inode: InodeIdentity;
  readonly kind: ReceiptKind;
  readonly path: string;
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly raw: string;
  readonly token: string;
}

interface CommonOwnershipOptions {
  readonly pid?: number;
  readonly probe?: ProcessIdentityProbe;
  readonly token?: () => string;
}

export interface WorkerOperationLeaseOptions extends CommonOwnershipOptions {
  readonly lockPath: string;
  readonly operation: string;
}

export interface WorkerPidOptions extends CommonOwnershipOptions {
  readonly pidPath: string;
}

const isErrno = (error: unknown, code: string): error is NodeJS.ErrnoException =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

const inodeOf = (metadata: Stats): InodeIdentity => ({
  device: metadata.dev,
  inode: metadata.ino,
});

const sameInode = (left: InodeIdentity, right: InodeIdentity) =>
  left.device === right.device && left.inode === right.inode;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const isPositivePid = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isToken = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

const parseVersionedReceipt = (
  value: Readonly<Record<string, unknown>>,
  expectedKind: ReceiptKind,
): VersionedOwnershipReceipt | undefined => {
  if (
    value._tag !== "FlowingMemoryWorkerOwnershipV2" ||
    value.schemaVersion !== 2 ||
    value.kind !== expectedKind ||
    !isPositivePid(value.pid) ||
    !isToken(value.token) ||
    typeof value.processStartIdentity !== "string" ||
    !PROCESS_IDENTITY_PATTERN.test(value.processStartIdentity)
  ) {
    return undefined;
  }
  if (expectedKind === "daemon") {
    return {
      _tag: "FlowingMemoryWorkerOwnershipV2",
      kind: "daemon",
      pid: value.pid,
      processStartIdentity: value.processStartIdentity,
      schemaVersion: 2,
      token: value.token,
    };
  }
  if (typeof value.operation !== "string" || value.operation.length === 0) return undefined;
  return {
    _tag: "FlowingMemoryWorkerOwnershipV2",
    kind: "operation",
    operation: value.operation,
    pid: value.pid,
    processStartIdentity: value.processStartIdentity,
    schemaVersion: 2,
    token: value.token,
  };
};

const parseOwnershipReceipt = (
  raw: string,
  expectedKind: ReceiptKind,
): ParsedOwnershipReceipt => {
  if (expectedKind === "daemon" && /^\s*[1-9]\d*\s*$/u.test(raw)) {
    const pid = Number.parseInt(raw.trim(), 10);
    if (isPositivePid(pid)) return { _tag: "LegacyDaemonPidV1", kind: "daemon", pid };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new WorkerOwnershipError("receipt-malformed", "worker ownership receipt is malformed", {
      cause: error,
    });
  }
  if (!isRecord(value)) {
    throw new WorkerOwnershipError("receipt-malformed", "worker ownership receipt is malformed");
  }

  const versioned = parseVersionedReceipt(value, expectedKind);
  if (versioned !== undefined) return versioned;

  if (
    expectedKind === "operation" &&
    value.schemaVersion === 1 &&
    typeof value.operation === "string" &&
    value.operation.length > 0 &&
    isPositivePid(value.pid) &&
    isToken(value.token)
  ) {
    return {
      _tag: "LegacyOperationOwnershipV1",
      kind: "operation",
      operation: value.operation,
      pid: value.pid,
      token: value.token,
    };
  }

  throw new WorkerOwnershipError("receipt-malformed", "worker ownership receipt is malformed");
};

const assertPrivateRegularFile = (metadata: Stats) => {
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new WorkerOwnershipError(
      "receipt-unsafe",
      "worker ownership receipt must be a private regular file",
    );
  }
  if (metadata.size > MAX_RECEIPT_BYTES) {
    throw new WorkerOwnershipError("receipt-malformed", "worker ownership receipt is too large");
  }
};

const inspectOwnershipReceipt = async (
  receiptPath: string,
  expectedKind: ReceiptKind,
): Promise<ReceiptObservation> => {
  let pathMetadata: Stats;
  try {
    pathMetadata = await lstat(receiptPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { _tag: "Absent" };
    throw new WorkerOwnershipError(
      "receipt-inaccessible",
      "worker ownership receipt cannot be inspected",
      { cause: error },
    );
  }
  assertPrivateRegularFile(pathMetadata);

  let handle;
  try {
    handle = await open(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, "ELOOP")) {
      throw new WorkerOwnershipError(
        "receipt-unsafe",
        "worker ownership receipt must not be a symlink",
        { cause: error },
      );
    }
    throw new WorkerOwnershipError(
      "receipt-inaccessible",
      "worker ownership receipt cannot be opened safely",
      { cause: error },
    );
  }

  try {
    const openedMetadata = await handle.stat();
    assertPrivateRegularFile(openedMetadata);
    if (!sameInode(inodeOf(pathMetadata), inodeOf(openedMetadata))) {
      throw new WorkerOwnershipError(
        "owner-ambiguous",
        "worker ownership receipt changed while it was inspected",
      );
    }
    const raw = await handle.readFile({ encoding: "utf8" });
    return {
      _tag: "Present",
      receipt: {
        inode: inodeOf(openedMetadata),
        parsed: parseOwnershipReceipt(raw, expectedKind),
        path: receiptPath,
        raw,
      },
    };
  } finally {
    await handle.close();
  }
};

const verifySelfIdentity = async (pid: number, probe: ProcessIdentityProbe) => {
  const result = await probe(pid);
  if (result._tag !== "Alive") {
    throw new WorkerOwnershipError(
      "process-identity-unavailable",
      "current worker process identity cannot be proven",
    );
  }
  return result.processStartIdentity;
};

const classifyExistingOwner = async (
  receipt: ObservedOwnershipReceipt,
  probe: ProcessIdentityProbe,
): Promise<ExistingOwnerDisposition> => {
  const result = await probe(receipt.parsed.pid);
  switch (result._tag) {
    case "Dead":
      return { _tag: "Stale" };
    case "Uncertain":
      return { _tag: "Ambiguous" };
    case "Alive":
      if (receipt.parsed._tag !== "FlowingMemoryWorkerOwnershipV2") {
        return { _tag: "Ambiguous" };
      }
      return receipt.parsed.processStartIdentity === result.processStartIdentity
        ? { _tag: "Live" }
        : { _tag: "Stale" };
  }
};

const throwForDisposition = (disposition: ExistingOwnerDisposition): never => {
  switch (disposition._tag) {
    case "Live":
      throw new WorkerOwnershipError("owner-live", "another worker owner is live");
    case "Ambiguous":
      throw new WorkerOwnershipError(
        "owner-ambiguous",
        "worker owner liveness or identity is ambiguous",
      );
    case "Stale":
      throw new Error("stale ownership must be recovered before continuing");
  }
};

const syncParentDirectory = async (target: string) => {
  const directory = await open(path.dirname(target), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};

const writeCandidate = async (target: string, raw: string) => {
  const temporaryPath = `${target}.candidate-${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(raw, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return temporaryPath;
};

const ownedFromPublished = async (
  receiptPath: string,
  expected: VersionedOwnershipReceipt,
  raw: string,
): Promise<OwnedWorkerReceipt> => {
  const observation = await inspectOwnershipReceipt(receiptPath, expected.kind);
  if (
    observation._tag !== "Present" ||
    observation.receipt.parsed._tag !== "FlowingMemoryWorkerOwnershipV2" ||
    observation.receipt.parsed.token !== expected.token ||
    observation.receipt.parsed.pid !== expected.pid ||
    observation.receipt.parsed.processStartIdentity !== expected.processStartIdentity ||
    observation.receipt.raw !== raw
  ) {
    throw new WorkerOwnershipError(
      "ownership-lost",
      "published worker ownership could not be verified",
    );
  }
  return {
    inode: observation.receipt.inode,
    kind: expected.kind,
    path: receiptPath,
    pid: expected.pid,
    processStartIdentity: expected.processStartIdentity,
    raw,
    token: expected.token,
  };
};

const publishAbsent = async (
  receiptPath: string,
  expected: VersionedOwnershipReceipt,
  raw: string,
): Promise<OwnedWorkerReceipt | undefined> => {
  const candidatePath = await writeCandidate(receiptPath, raw);
  try {
    await link(candidatePath, receiptPath);
    await unlink(candidatePath);
    await syncParentDirectory(receiptPath);
    return await ownedFromPublished(receiptPath, expected, raw);
  } catch (error) {
    await unlink(candidatePath).catch(() => undefined);
    if (isErrno(error, "EEXIST")) return undefined;
    throw error;
  }
};

const stalePreimagePath = (receipt: ObservedOwnershipReceipt) =>
  `${receipt.path}.stale-${sha256(receipt.raw).slice(0, 16)}-${randomUUID()}.preimage`;

const preserveStaleReceipt = async (receipt: ObservedOwnershipReceipt) => {
  const preimagePath = stalePreimagePath(receipt);
  await link(receipt.path, preimagePath);
  const preimage = await inspectOwnershipReceipt(preimagePath, receipt.parsed.kind);
  if (
    preimage._tag !== "Present" ||
    !sameInode(preimage.receipt.inode, receipt.inode) ||
    preimage.receipt.raw !== receipt.raw
  ) {
    throw new WorkerOwnershipError(
      "owner-ambiguous",
      "stale worker ownership changed before its preimage was preserved",
    );
  }
  await syncParentDirectory(receipt.path);
  return preimagePath;
};

const replaceStaleReceipt = async (
  receipt: ObservedOwnershipReceipt,
  expected: VersionedOwnershipReceipt,
  raw: string,
): Promise<OwnedWorkerReceipt> => {
  await preserveStaleReceipt(receipt);
  const candidatePath = await writeCandidate(receipt.path, raw);
  try {
    const current = await inspectOwnershipReceipt(receipt.path, receipt.parsed.kind);
    if (
      current._tag !== "Present" ||
      !sameInode(current.receipt.inode, receipt.inode) ||
      current.receipt.raw !== receipt.raw
    ) {
      throw new WorkerOwnershipError(
        "owner-ambiguous",
        "stale worker ownership changed before replacement",
      );
    }
    await rename(candidatePath, receipt.path);
    await syncParentDirectory(receipt.path);
    return await ownedFromPublished(receipt.path, expected, raw);
  } catch (error) {
    await unlink(candidatePath).catch(() => undefined);
    throw error;
  }
};

const removeStaleReceipt = async (receipt: ObservedOwnershipReceipt) => {
  const preimagePath = stalePreimagePath(receipt);
  try {
    await rename(receipt.path, preimagePath);
  } catch (error) {
    throw new WorkerOwnershipError(
      "owner-ambiguous",
      "stale worker ownership changed before recovery",
      { cause: error },
    );
  }
  try {
    const moved = await inspectOwnershipReceipt(preimagePath, receipt.parsed.kind);
    if (
      moved._tag !== "Present" ||
      !sameInode(moved.receipt.inode, receipt.inode) ||
      moved.receipt.raw !== receipt.raw
    ) {
      throw new WorkerOwnershipError(
        "owner-ambiguous",
        "stale worker ownership changed during recovery",
      );
    }
    await syncParentDirectory(receipt.path);
  } catch (error) {
    await link(preimagePath, receipt.path)
      .then(() => unlink(preimagePath))
      .catch(() => undefined);
    throw error;
  }
};

const makeVersionedReceipt = (input: {
  readonly kind: ReceiptKind;
  readonly operation?: string;
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly token: string;
}): VersionedOwnershipReceipt => {
  if (input.kind === "daemon") {
    return {
      _tag: "FlowingMemoryWorkerOwnershipV2",
      kind: "daemon",
      pid: input.pid,
      processStartIdentity: input.processStartIdentity,
      schemaVersion: 2,
      token: input.token,
    };
  }
  if (input.operation === undefined || input.operation.length === 0) {
    throw new WorkerOwnershipError("receipt-malformed", "worker operation is required");
  }
  return {
    _tag: "FlowingMemoryWorkerOwnershipV2",
    kind: "operation",
    operation: input.operation,
    pid: input.pid,
    processStartIdentity: input.processStartIdentity,
    schemaVersion: 2,
    token: input.token,
  };
};

const acquireVersionedReceipt = async (
  receiptPath: string,
  expected: VersionedOwnershipReceipt,
  probe: ProcessIdentityProbe,
): Promise<OwnedWorkerReceipt> => {
  const raw = `${JSON.stringify(expected)}\n`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observation = await inspectOwnershipReceipt(receiptPath, expected.kind);
    if (observation._tag === "Absent") {
      const owned = await publishAbsent(receiptPath, expected, raw);
      if (owned !== undefined) return owned;
      continue;
    }
    const disposition = await classifyExistingOwner(observation.receipt, probe);
    if (disposition._tag !== "Stale") throwForDisposition(disposition);
    return await replaceStaleReceipt(observation.receipt, expected, raw);
  }
  throw new WorkerOwnershipError(
    "owner-ambiguous",
    "worker ownership changed repeatedly during acquisition",
  );
};

const ensureMutexFile = async (mutexPath: string) => {
  try {
    const handle = await open(mutexPath, "wx", 0o600);
    await handle.close();
    await syncParentDirectory(mutexPath);
    return;
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      throw new WorkerOwnershipError("mutex-unavailable", "host mutex file cannot be created", {
        cause: error,
      });
    }
  }
  let metadata: Stats;
  try {
    metadata = await lstat(mutexPath);
  } catch (error) {
    throw new WorkerOwnershipError("mutex-unavailable", "host mutex file cannot be inspected", {
      cause: error,
    });
  }
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new WorkerOwnershipError(
      "mutex-unavailable",
      "host mutex file must be a private regular file",
    );
  }
};

type HostMutexState = "held" | "lost" | "released" | "releasing";

interface HostMutexExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

class HeldHostMutex {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #exit: Promise<HostMutexExit>;
  #state: HostMutexState = "held";

  constructor(child: ChildProcessWithoutNullStreams, exit: Promise<HostMutexExit>) {
    this.#child = child;
    this.#exit = exit;
  }

  state() {
    return this.#state;
  }

  waitForLoss(): Promise<never> {
    return this.#exit.then((result) => {
      if (this.#state === "held") {
        this.#state = "lost";
        throw new WorkerOwnershipError(
          "mutex-lost",
          "host ownership mutex exited while work was active",
          { cause: result },
        );
      }
      return new Promise<never>(() => undefined);
    });
  }

  async release() {
    if (this.#state === "released") return;
    if (this.#state === "lost") {
      throw new WorkerOwnershipError("mutex-lost", "host ownership mutex was already lost");
    }
    this.#state = "releasing";
    this.#child.stdin.end();
    const result = await Promise.race([
      this.#exit,
      new Promise<"timeout">((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), MUTEX_STOP_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
    if (result === "timeout") {
      this.#child.kill("SIGTERM");
      this.#state = "lost";
      throw new WorkerOwnershipError("mutex-lost", "host ownership mutex did not stop cleanly");
    }
    if (result.code !== 0) {
      this.#state = "lost";
      throw new WorkerOwnershipError("mutex-lost", "host ownership mutex stopped unexpectedly", {
        cause: result,
      });
    }
    this.#state = "released";
  }
}

const acquireHostMutex = async (lockPath: string): Promise<HeldHostMutex> => {
  const mutexPath = `${lockPath}.guard`;
  await ensureMutexFile(mutexPath);
  const holderScript = `process.stdout.write(${JSON.stringify(MUTEX_READY)});process.stdin.resume();`;
  const child = spawn(
    LOCKF_PATH,
    ["-k", "-n", "-t", "0", mutexPath, process.execPath, "-e", holderScript],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let standardOutput = "";
  let standardError = "";
  const ready = new Promise<"ready">((resolve) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      standardOutput = `${standardOutput}${chunk}`.slice(-4_096);
      if (standardOutput.includes(MUTEX_READY)) resolve("ready");
    });
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    standardError = `${standardError}${chunk}`.slice(-4_096);
  });
  const exit = new Promise<HostMutexExit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const spawnFailure = new Promise<{ readonly _tag: "spawn-error"; readonly error: Error }>(
    (resolve) => {
      child.once("error", (error) => resolve({ _tag: "spawn-error", error }));
    },
  );
  const start = await Promise.race([
    ready,
    exit.then((result) => ({ _tag: "exit" as const, result })),
    spawnFailure,
    new Promise<{ readonly _tag: "timeout" }>((resolve) => {
      const timer = setTimeout(() => resolve({ _tag: "timeout" }), MUTEX_START_TIMEOUT_MS);
      timer.unref();
    }),
  ]);
  if (start === "ready") return new HeldHostMutex(child, exit);
  child.kill("SIGTERM");
  if (start._tag === "exit" && start.result.code === 75) {
    throw new WorkerOwnershipError("lease-contended", "another worker operation holds the host mutex");
  }
  throw new WorkerOwnershipError(
    "mutex-unavailable",
    standardError.trim().length > 0
      ? "host ownership mutex could not be acquired"
      : "host ownership mutex did not become ready",
    { cause: start._tag === "spawn-error" ? start.error : start },
  );
};

const restoreMovedReceipt = async (movedPath: string, receiptPath: string) => {
  try {
    await link(movedPath, receiptPath);
    await unlink(movedPath);
    await syncParentDirectory(receiptPath);
  } catch {
    // A conflicting canonical path is never overwritten. The moved inode remains as evidence.
  }
};

export const releaseOwnedReceipt = async (owned: OwnedWorkerReceipt) => {
  const movedPath = `${owned.path}.release-${owned.token}-${randomUUID()}.tmp`;
  try {
    await rename(owned.path, movedPath);
  } catch (error) {
    throw new WorkerOwnershipError("ownership-lost", "owned worker receipt is no longer present", {
      cause: error,
    });
  }

  try {
    const moved = await inspectOwnershipReceipt(movedPath, owned.kind);
    if (
      moved._tag !== "Present" ||
      moved.receipt.parsed._tag !== "FlowingMemoryWorkerOwnershipV2" ||
      !sameInode(moved.receipt.inode, owned.inode) ||
      moved.receipt.parsed.token !== owned.token ||
      moved.receipt.parsed.pid !== owned.pid ||
      moved.receipt.parsed.processStartIdentity !== owned.processStartIdentity ||
      moved.receipt.raw !== owned.raw
    ) {
      throw new WorkerOwnershipError(
        "ownership-lost",
        "worker receipt cleanup no longer owns the inode and token",
      );
    }
    await unlink(movedPath);
    await syncParentDirectory(owned.path);
  } catch (error) {
    await restoreMovedReceipt(movedPath, owned.path);
    if (error instanceof WorkerOwnershipError && error.code === "ownership-lost") throw error;
    throw new WorkerOwnershipError(
      "ownership-lost",
      "worker receipt cleanup could not verify ownership",
      { cause: error },
    );
  }
};

export const assertWorkerPidAvailable = async (options: WorkerPidOptions) => {
  const probe = options.probe ?? probeProcessIdentity;
  const observation = await inspectOwnershipReceipt(options.pidPath, "daemon");
  if (observation._tag === "Absent") return;
  const disposition = await classifyExistingOwner(observation.receipt, probe);
  if (disposition._tag !== "Stale") throwForDisposition(disposition);
  await removeStaleReceipt(observation.receipt);
};

export const acquireWorkerPidReceipt = async (
  options: WorkerPidOptions,
): Promise<OwnedWorkerReceipt> => {
  const pid = options.pid ?? process.pid;
  const probe = options.probe ?? probeProcessIdentity;
  const processStartIdentity = await verifySelfIdentity(pid, probe);
  await assertWorkerPidAvailable({ pidPath: options.pidPath, probe });
  const expected = makeVersionedReceipt({
    kind: "daemon",
    pid,
    processStartIdentity,
    token: (options.token ?? randomUUID)(),
  });
  return await acquireVersionedReceipt(options.pidPath, expected, probe);
};

type ExecutionOutcome<A> =
  | { readonly _tag: "Failed"; readonly error: unknown }
  | { readonly _tag: "Succeeded"; readonly value: A };

export const withWorkerOperationLease = async <A,>(
  options: WorkerOperationLeaseOptions,
  run: () => Promise<A>,
): Promise<A> => {
  const mutex = await acquireHostMutex(options.lockPath);
  let owned: OwnedWorkerReceipt | undefined;
  let outcome: ExecutionOutcome<A>;
  try {
    const pid = options.pid ?? process.pid;
    const probe = options.probe ?? probeProcessIdentity;
    const processStartIdentity = await verifySelfIdentity(pid, probe);
    const expected = makeVersionedReceipt({
      kind: "operation",
      operation: options.operation,
      pid,
      processStartIdentity,
      token: (options.token ?? randomUUID)(),
    });
    owned = await acquireVersionedReceipt(options.lockPath, expected, probe);
    outcome = {
      _tag: "Succeeded",
      value: await Promise.race([Promise.resolve().then(run), mutex.waitForLoss()]),
    };
  } catch (error) {
    outcome = { _tag: "Failed", error };
  }

  let cleanupError: unknown;
  if (owned !== undefined && mutex.state() === "held") {
    try {
      await releaseOwnedReceipt(owned);
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    await mutex.release();
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError !== undefined) throw cleanupError;
  if (outcome._tag === "Failed") throw outcome.error;
  return outcome.value;
};

const processExists = (pid: number): "exists" | "missing" | "uncertain" => {
  try {
    process.kill(pid, 0);
    return "exists";
  } catch (error) {
    if (isErrno(error, "ESRCH")) return "missing";
    if (isErrno(error, "EPERM")) return "exists";
    return "uncertain";
  }
};

const readProcessStart = async (pid: number) =>
  await new Promise<{ readonly _tag: "Read"; readonly value: string } | { readonly _tag: "Failed" }>(
    (resolve) => {
      execFile(
        "/bin/ps",
        ["-p", String(pid), "-o", "lstart="],
        { maxBuffer: 4_096, timeout: 2_000 },
        (error, stdout) => {
          if (error !== null) {
            resolve({ _tag: "Failed" });
            return;
          }
          resolve({ _tag: "Read", value: stdout.trim().replace(/\s+/gu, " ") });
        },
      );
    },
  );

export const probeProcessIdentity: ProcessIdentityProbe = async (pid) => {
  if (!isPositivePid(pid)) {
    return { _tag: "Uncertain", reason: "invalid-pid" };
  }
  const before = processExists(pid);
  if (before === "missing") return { _tag: "Dead" };
  if (before === "uncertain") return { _tag: "Uncertain", reason: "process-probe-failed" };

  const started = await readProcessStart(pid);
  if (started._tag === "Read" && started.value.length > 0) {
    return {
      _tag: "Alive",
      processStartIdentity: sha256(`process-start\0${started.value}`),
    };
  }

  const after = processExists(pid);
  return after === "missing"
    ? { _tag: "Dead" }
    : { _tag: "Uncertain", reason: "process-start-identity-unavailable" };
};
