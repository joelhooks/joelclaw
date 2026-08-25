import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  type FileHandle,
  link,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import path from "node:path";

import {
  type NativeRuntime,
  type NativeWakeV1,
  verifyNativeSource,
  withIncarnation,
} from "./adapters.js";

export interface NativeAdmissionInputV1 {
  readonly fromByte: number;
  readonly immutableStreamPath?: string;
  readonly prefixBytes: Uint8Array;
  readonly priorTurnCount?: number;
  readonly previousTranscriptHash?: string;
  readonly segmentBytes: Uint8Array;
  readonly toByteExclusive: number;
  readonly vendorFromByte?: number;
  readonly vendorToByteExclusive?: number;
  readonly wake: NativeWakeV1;
}

export interface NativeAdmissionResultV1 {
  readonly acceptedToTurn?: number;
  readonly acceptedTranscriptHash?: string;
  readonly disposition:
    | "admitted"
    | "deferred"
    | "excluded"
    | "finalized"
    | "quarantined"
    | "replay";
}

export interface NativeAdmissionPort {
  readonly admit: (input: NativeAdmissionInputV1) => Promise<NativeAdmissionResultV1>;
}

interface CollectorStateEntry {
  readonly acceptedEventIds: readonly string[];
  readonly closed?: boolean;
  readonly incarnationId?: string;
  readonly nextTurn?: number;
  readonly offset: number;
  readonly prefixHash?: string;
  readonly runtime?: NativeWakeV1["runtime"];
  readonly sessionId?: string;
  readonly sourcePathHash?: string;
  readonly streamPath?: string;
  readonly transcriptHash?: string;
  readonly vendorOffset?: number;
  readonly vendorPrefixHash?: string;
}

interface CollectorStateV1 {
  excludedSessions?: readonly string[];
  readonly schemaVersion: 1;
  readonly streams: Record<string, CollectorStateEntry>;
}

interface ImmutableStreamReceiptV1 {
  readonly acceptedEventId: string;
  readonly acceptedEventIds?: readonly string[];
  readonly closed: boolean;
  readonly fromByte?: number;
  readonly incarnationId: string;
  readonly nextTurn: number;
  readonly offset: number;
  readonly prefixHash: string;
  readonly previousTranscriptHash?: string;
  readonly priorTurnCount?: number;
  readonly runtime: NativeRuntime;
  readonly sessionId: string;
  readonly sourcePathHash: string;
  readonly status?: "checkpointed" | "committed" | "pending";
  readonly streamPath: string;
  readonly transcriptHash?: string;
  readonly vendorFromByte?: number;
  readonly vendorOffset: number;
  readonly vendorPrefixHash: string;
  readonly schemaVersion: 1;
}

export interface CollectorReceiptV1 {
  readonly admitted: number;
  readonly deferred: number;
  readonly excluded: number;
  readonly processed: number;
  readonly quarantined: number;
  readonly replayed: number;
  readonly schemaVersion: 1;
}

export interface CollectorDrainHealthReceiptV1 extends CollectorReceiptV1 {
  readonly compacted: number;
  readonly drainId: string;
  readonly elapsedMs: number;
  readonly errorClass?: "collector" | "filesystem" | "unknown";
  readonly phase: "batch" | "failed" | "finished" | "service-failure" | "started";
  readonly processingLines: number;
  readonly queuedLines: number;
  readonly requeued: number;
  readonly untouched: number;
}

export interface CollectorDrainOptions {
  readonly admission: NativeAdmissionPort;
  readonly afterAdmission?: (
    input: NativeAdmissionInputV1,
    result: NativeAdmissionResultV1,
  ) => Promise<void>;
  readonly closeMaxMs?: number;
  readonly closeStableMs?: number;
  readonly compactedWakePath?: string;
  readonly drainNow?: () => number;
  readonly drainReceiptPath?: string;
  readonly lockPath: string;
  readonly maxBootstrapBytes?: number;
  readonly maxElapsedMs?: number;
  readonly maxLines?: number;
  readonly now?: () => number;
  readonly persistDrainReceipt?: (receipt: CollectorDrainHealthReceiptV1) => Promise<void>;
  readonly persistState?: (statePath: string, state: CollectorStateV1) => Promise<void>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly sourceRoot?: string;
  readonly spoolPath: string;
  readonly statePath: string;
  readonly streamRoot?: string;
  readonly verifySource?: boolean;
}

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

const streamKey = (wake: NativeWakeV1) =>
  hash(
    JSON.stringify([wake.runtime, wake.sessionId, wake.incarnationId, hash(wake.transcriptPath)]),
  );

const emptyState = (): CollectorStateV1 => ({
  excludedSessions: [],
  schemaVersion: 1,
  streams: {},
});

const readState = async (statePath: string): Promise<CollectorStateV1> => {
  try {
    const value: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("schemaVersion" in value) ||
      value.schemaVersion !== 1 ||
      !("streams" in value) ||
      typeof value.streams !== "object" ||
      value.streams === null
    ) {
      throw new Error("invalid collector state");
    }
    return value as CollectorStateV1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyState();
    }
    throw error;
  }
};

const atomicWrite = async (target: string, bytes: Uint8Array | string) => {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, target);
};

const persistStateDefault = (statePath: string, state: CollectorStateV1) =>
  atomicWrite(statePath, `${JSON.stringify(state)}\n`);

const appendDurableLine = async (target: string, line: string): Promise<void> => {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const handle = await open(target, "a", 0o600);
  try {
    await handle.writeFile(`${line}\n`, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export const appendNativeWake = async (spoolPath: string, wake: NativeWakeV1): Promise<void> =>
  appendDurableLine(spoolPath, JSON.stringify(wake));

export type NativeCollectorPresenceV1 = "absent" | "active" | "stale";

const ownerLockPathFor = (socketPath: string) => `${socketPath}.lock`;

const processIsAlive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readOwnerPid = async (lockPath: string): Promise<number | undefined> => {
  try {
    const value: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (typeof value !== "object" || value === null || !("pid" in value)) {
      return undefined;
    }
    return typeof value.pid === "number" ? value.pid : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
};

interface ProcessLockMetadataV1 {
  readonly lockPath: string;
  readonly observedToken?: string;
  readonly pid: number;
  readonly schemaVersion: 1;
  readonly token: string;
}

interface OwnedProcessLock {
  readonly handle: FileHandle;
  readonly token: string;
}

const processLockReclaimPath = (lockPath: string) => `${lockPath}.reclaim`;

const parseProcessLockMetadata = (value: unknown): ProcessLockMetadataV1 | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("lockPath" in value) ||
    typeof value.lockPath !== "string" ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("token" in value) ||
    typeof value.token !== "string" ||
    ("observedToken" in value &&
      value.observedToken !== undefined &&
      typeof value.observedToken !== "string")
  ) {
    return undefined;
  }
  return value as ProcessLockMetadataV1;
};

const readProcessLockMetadata = async (
  lockPath: string,
): Promise<ProcessLockMetadataV1 | undefined> => {
  try {
    const value: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    return parseProcessLockMetadata(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
};

const readProcessLockMetadataFromHandle = async (
  lock: FileHandle,
): Promise<ProcessLockMetadataV1 | undefined> => {
  try {
    const value: unknown = JSON.parse(await lock.readFile("utf8"));
    return parseProcessLockMetadata(value);
  } catch {
    return undefined;
  }
};

const processLockMetadataBytes = (metadata: ProcessLockMetadataV1) =>
  Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8");

const writeProcessLockMetadata = async (lock: FileHandle, metadata: ProcessLockMetadataV1) => {
  const bytes = processLockMetadataBytes(metadata);
  await lock.truncate(0);
  await lock.write(bytes, 0, bytes.byteLength, 0);
  await lock.sync();
};

const publishProcessLockMetadata = async (
  lockPath: string,
  metadata: ProcessLockMetadataV1,
): Promise<FileHandle> => {
  const temporaryPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  let temporary: FileHandle | undefined;
  try {
    temporary = await open(temporaryPath, "wx", 0o600);
    await writeProcessLockMetadata(temporary, metadata);
    await temporary.close();
    temporary = undefined;
    await rename(temporaryPath, lockPath);
    return await open(lockPath, "r");
  } catch (error) {
    await temporary?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

interface ReclaimMarker {
  readonly handle: FileHandle;
  readonly malformed?: boolean;
  readonly path: string;
  readonly pid: number;
  readonly token: string;
}

const unlinkProcessLockIfMatches = async (input: {
  readonly lockPath: string;
  readonly pid: number;
  readonly token: string;
}) => {
  const current = await open(input.lockPath, "r").catch(() => undefined);
  if (current === undefined) return;
  try {
    const metadata = await readProcessLockMetadataFromHandle(current);
    if (metadata?.token === input.token && metadata.pid === input.pid) {
      await unlink(input.lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  } finally {
    await current.close();
  }
};

const unlinkOwnedProcessLock = async (lockPath: string, token: string) =>
  unlinkProcessLockIfMatches({ lockPath, pid: process.pid, token });

const createReclaimMarker = async (input: {
  readonly lockPath: string;
  readonly staleToken: string;
  readonly token: string;
}): Promise<ReclaimMarker | undefined> => {
  const reclaimPath = processLockReclaimPath(input.lockPath);
  const temporaryPath = `${reclaimPath}.${input.token}.tmp`;
  let marker: FileHandle | undefined;
  try {
    marker = await open(temporaryPath, "wx", 0o600);
    await writeProcessLockMetadata(marker, {
      lockPath: input.lockPath,
      observedToken: input.staleToken,
      pid: process.pid,
      schemaVersion: 1,
      token: input.token,
    });
    await link(temporaryPath, reclaimPath);
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return { handle: marker, path: reclaimPath, pid: process.pid, token: input.token };
  } catch (error) {
    await marker?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
};

const openExistingReclaimMarker = async (lockPath: string): Promise<ReclaimMarker | undefined> => {
  const reclaimPath = processLockReclaimPath(lockPath);
  const marker = await open(reclaimPath, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (marker === undefined) return undefined;
  const metadata = await readProcessLockMetadataFromHandle(marker);
  if (metadata === undefined) {
    return { handle: marker, malformed: true, path: reclaimPath, pid: 0, token: "" };
  }
  if (processIsAlive(metadata.pid)) {
    await marker.close();
    throw new Error("collector-already-running");
  }
  return { handle: marker, path: reclaimPath, pid: metadata.pid, token: metadata.token };
};

const adoptReclaimMarker = async (input: {
  readonly lockPath: string;
  readonly marker: ReclaimMarker;
  readonly ownerToken: string;
}): Promise<OwnedProcessLock | undefined> => {
  const takeoverPath = `${input.marker.path}.${input.ownerToken}.takeover`;
  let guard: ReclaimMarker | undefined;
  let lock: FileHandle | undefined;
  let markerClosed = false;
  let published = false;
  let adopted = false;
  try {
    const current = await open(input.lockPath, "r").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (current === undefined) {
      if (input.marker.malformed) {
        await unlink(input.marker.path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      } else {
        await unlinkProcessLockIfMatches({
          lockPath: input.marker.path,
          pid: input.marker.pid,
          token: input.marker.token,
        });
      }
      return undefined;
    }
    const currentMetadata = await readProcessLockMetadataFromHandle(current);
    await current.close();
    if (currentMetadata === undefined) {
      throw new Error("collector-already-running");
    }
    if (processIsAlive(currentMetadata.pid)) {
      if (!input.marker.malformed) {
        await unlinkProcessLockIfMatches({
          lockPath: input.marker.path,
          pid: input.marker.pid,
          token: input.marker.token,
        });
      }
      throw new Error("collector-already-running");
    }

    // The published marker is immutable. Claim its inode before any owner transition.
    try {
      await rename(input.marker.path, takeoverPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    await input.marker.handle.close();
    markerClosed = true;

    guard = await createReclaimMarker({
      lockPath: input.lockPath,
      staleToken: currentMetadata.token,
      token: input.ownerToken,
    });
    if (guard === undefined) return undefined;

    const guardedCurrent = await readProcessLockMetadata(input.lockPath);
    if (
      guardedCurrent === undefined ||
      guardedCurrent.pid !== currentMetadata.pid ||
      guardedCurrent.token !== currentMetadata.token
    ) {
      return undefined;
    }
    if (processIsAlive(guardedCurrent.pid)) {
      throw new Error("collector-already-running");
    }

    // The guard protects the stale lock while this fully-written successor is published.
    published = true;
    lock = await publishProcessLockMetadata(input.lockPath, {
      lockPath: input.lockPath,
      pid: process.pid,
      schemaVersion: 1,
      token: input.ownerToken,
    });
    await unlinkProcessLockIfMatches({
      lockPath: guard.path,
      pid: process.pid,
      token: input.ownerToken,
    });
    await guard.handle.close();
    guard = undefined;
    await unlink(takeoverPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    adopted = true;
    return { handle: lock, token: input.ownerToken };
  } finally {
    if (!adopted) {
      if (published) {
        await unlinkOwnedProcessLock(input.lockPath, input.ownerToken).catch(() => undefined);
      }
      await lock?.close().catch(() => undefined);
      if (guard !== undefined) {
        await unlinkProcessLockIfMatches({
          lockPath: guard.path,
          pid: process.pid,
          token: input.ownerToken,
        }).catch(() => undefined);
        await guard.handle.close().catch(() => undefined);
      }
      await unlink(takeoverPath).catch(() => undefined);
    }
    if (!markerClosed) await input.marker.handle.close().catch(() => undefined);
  }
};

const acquireProcessLock = async (lockPath: string): Promise<OwnedProcessLock> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let lock: FileHandle | undefined;
    const token = randomUUID();
    try {
      lock = await open(lockPath, "wx", 0o600);
      await writeProcessLockMetadata(lock, {
        lockPath,
        pid: process.pid,
        schemaVersion: 1,
        token,
      });
      return { handle: lock, token };
    } catch (error) {
      if (lock !== undefined) await lock.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stale = await readProcessLockMetadata(lockPath);
      if (stale === undefined || processIsAlive(stale.pid)) {
        throw new Error("collector-already-running");
      }
      const marker =
        (await createReclaimMarker({
          lockPath,
          staleToken: stale.token,
          token,
        })) ?? (await openExistingReclaimMarker(lockPath));
      if (marker === undefined) continue;
      const adopted = await adoptReclaimMarker({ lockPath, marker, ownerToken: token });
      if (adopted !== undefined) return adopted;
    }
  }
  throw new Error("collector-already-running");
};

const socketProbe = async (socketPath: string): Promise<"active" | "stale"> => {
  const metadata = await stat(socketPath).catch(() => undefined);
  if (metadata !== undefined && !metadata.isSocket()) return "stale";
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("active");
    }, 100);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve("active");
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      const code = (error as NodeJS.ErrnoException).code;
      resolve(
        code === "ENOENT" || code === "ECONNREFUSED" || code === "ENOTSOCK" ? "stale" : "active",
      );
    });
  });
};

export const inspectNativeCollector = async (
  socketPath: string,
): Promise<NativeCollectorPresenceV1> => {
  const socketExists = await stat(socketPath)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  const lockPath = ownerLockPathFor(socketPath);
  const lockExists = await stat(lockPath)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  if (!socketExists && !lockExists) return "absent";
  if (lockExists) {
    const pid = await readOwnerPid(lockPath);
    if (pid !== undefined && processIsAlive(pid)) return "active";
    return socketExists ? socketProbe(socketPath) : "stale";
  }
  return socketProbe(socketPath);
};

const socketAcknowledgement = (value: unknown): value is { readonly ok: boolean } =>
  typeof value === "object" && value !== null && "ok" in value && typeof value.ok === "boolean";

export const submitNativeWake = async (input: {
  readonly socketPath?: string;
  readonly spoolPath: string;
  readonly wake: NativeWakeV1;
}): Promise<void> => {
  if (input.socketPath !== undefined) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(input.socketPath!);
        let response = "";
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          if (error === undefined) resolve();
          else reject(error);
        };
        const timer = setTimeout(() => finish(new Error("collector-socket-timeout")), 5_000);
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          response += chunk;
          const line = response.split("\n")[0];
          if (line === undefined || line.length === 0) return;
          try {
            const acknowledgement: unknown = JSON.parse(line);
            if (!socketAcknowledgement(acknowledgement) || acknowledgement.ok !== true) {
              finish(new Error("collector-socket-rejected"));
            } else {
              finish();
            }
          } catch {
            finish(new Error("collector-socket-invalid-ack"));
          }
        });
        socket.once("error", (error) => finish(error));
        socket.once("close", () => {
          if (!settled) finish(new Error("collector-socket-closed-before-ack"));
        });
        socket.once("connect", () => socket.end(`${JSON.stringify(input.wake)}\n`));
      });
      return;
    } catch {
      // The spool is the durable fallback when the collector is restarting.
    }
  }
  await appendNativeWake(input.spoolPath, input.wake);
};

const decodeWake = (line: string): NativeWakeV1 => {
  const value: unknown = JSON.parse(line);
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("eventId" in value) ||
    typeof value.eventId !== "string" ||
    !("runtime" in value) ||
    typeof value.runtime !== "string" ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    !("transcriptPath" in value) ||
    typeof value.transcriptPath !== "string"
  ) {
    throw new Error("invalid native wake");
  }
  const record = value as Record<string, unknown>;
  const sessionId = record.sessionId as string;
  const incarnationId =
    typeof record.incarnationId === "string"
      ? record.incarnationId
      : `legacy-${record.runtime}-${hash(sessionId)}`;
  return { ...record, incarnationId } as unknown as NativeWakeV1;
};

const isStartEvent = (wake: NativeWakeV1) =>
  ["SessionStart", "session_start", "sessionStart"].includes(wake.eventName);

const exclusionKey = (wake: NativeWakeV1) => `${wake.runtime}:${wake.sessionId}`;

const isCloseEvent = (wake: NativeWakeV1) => wake.close;

const incarnationForWake = (state: CollectorStateV1, wake: NativeWakeV1): NativeWakeV1 => {
  const sourcePathHash = hash(wake.transcriptPath);
  const candidates = Object.values(state.streams)
    .filter(
      (entry) =>
        entry.runtime === wake.runtime &&
        entry.sessionId === wake.sessionId &&
        entry.sourcePathHash === sourcePathHash,
    )
    .sort((left, right) => {
      const offsetOrder = (right.vendorOffset ?? right.offset) - (left.vendorOffset ?? left.offset);
      return offsetOrder !== 0
        ? offsetOrder
        : Number(left.closed === true) - Number(right.closed === true);
    });
  const latest = candidates[0];
  const suppliedIsExplicit = !wake.incarnationId.startsWith("legacy-");
  let incarnationId = suppliedIsExplicit
    ? wake.incarnationId
    : (latest?.incarnationId ?? wake.incarnationId);
  if (!suppliedIsExplicit && (isStartEvent(wake) || latest?.closed === true)) {
    incarnationId = hash(
      JSON.stringify(["incarnation:v1", wake.runtime, wake.sessionId, wake.eventId]),
    );
  }
  return withIncarnation(wake, incarnationId);
};

const streamRootFor = (input: CollectorDrainOptions) =>
  input.streamRoot ??
  process.env.JOELCLAW_FLOWING_MEMORY_STREAM_ROOT ??
  path.join(process.env.HOME ?? "/tmp", ".joelclaw", "flowing-memory", "streams");

const streamReceiptRootFor = (input: CollectorDrainOptions) => `${input.statePath}.stream-receipts`;

const streamReceiptPathFor = (input: CollectorDrainOptions, key: string) =>
  path.join(streamReceiptRootFor(input), `${key}.json`);

const readStreamReceipt = async (
  input: CollectorDrainOptions,
  key: string,
): Promise<ImmutableStreamReceiptV1 | undefined> => {
  try {
    const value: unknown = JSON.parse(await readFile(streamReceiptPathFor(input, key), "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("schemaVersion" in value) ||
      value.schemaVersion !== 1 ||
      !("acceptedEventId" in value) ||
      typeof value.acceptedEventId !== "string" ||
      !("offset" in value) ||
      typeof value.offset !== "number" ||
      ("status" in value &&
        value.status !== "pending" &&
        value.status !== "committed" &&
        value.status !== "checkpointed")
    ) {
      throw new Error("invalid immutable stream receipt");
    }
    return value as ImmutableStreamReceiptV1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const persistStreamReceipt = async (
  input: CollectorDrainOptions,
  key: string,
  receipt: ImmutableStreamReceiptV1,
) => atomicWrite(streamReceiptPathFor(input, key), `${JSON.stringify(receipt)}\n`);

const growthWakeFor = (
  wake: NativeWakeV1,
  fromByte: number,
  toByteExclusive: number,
  prefixHash: string,
): NativeWakeV1 => ({
  ...wake,
  eventId: hash(
    JSON.stringify([
      "native-growth:v1",
      wake.eventId,
      wake.incarnationId,
      fromByte,
      toByteExclusive,
      prefixHash,
    ]),
  ),
});

const stateEntryFromReceipt = (receipt: ImmutableStreamReceiptV1): CollectorStateEntry => ({
  acceptedEventIds: receipt.acceptedEventIds ?? [receipt.acceptedEventId],
  closed: receipt.closed,
  incarnationId: receipt.incarnationId,
  nextTurn: receipt.nextTurn,
  offset: receipt.offset,
  prefixHash: receipt.prefixHash,
  runtime: receipt.runtime,
  sessionId: receipt.sessionId,
  sourcePathHash: receipt.sourcePathHash,
  streamPath: receipt.streamPath,
  ...(receipt.transcriptHash === undefined ? {} : { transcriptHash: receipt.transcriptHash }),
  vendorOffset: receipt.vendorOffset,
  vendorPrefixHash: receipt.vendorPrefixHash,
});

const quarantinePathFor = (spoolPath: string) => `${spoolPath}.quarantine.jsonl`;

const appendQuarantine = async (
  spoolPath: string,
  wake: NativeWakeV1 | undefined,
  reason: string,
) =>
  appendDurableLine(
    quarantinePathFor(spoolPath),
    JSON.stringify({ reason, schemaVersion: 1, wake }),
  );

const completeSizeFor = (bytes: Uint8Array) => {
  const lastLineFeed = bytes.lastIndexOf(10);
  return lastLineFeed < 0 ? 0 : lastLineFeed + 1;
};

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const countNonEmptyLines = (value: string) =>
  value.split("\n").reduce((count, line) => count + (line.length === 0 ? 0 : 1), 0);

const compactWakeLines = (
  lines: readonly string[],
): { readonly compacted: readonly string[]; readonly retained: readonly string[] } => {
  const epochs = new Map<string, number>();
  const groups = new Map<string, Array<{ readonly index: number; readonly wake: NativeWakeV1 }>>();
  const retainedIndexes = new Set<number>();
  const retainedEventIds = new Set<string>();

  for (const [index, line] of lines.entries()) {
    let wake: NativeWakeV1;
    try {
      wake = decodeWake(line);
    } catch {
      retainedIndexes.add(index);
      continue;
    }
    const base = hash(
      JSON.stringify([
        wake.runtime,
        wake.sessionId,
        wake.transcriptPath,
        wake.incarnationId ?? null,
      ]),
    );
    let epoch = epochs.get(base) ?? 0;
    const priorGroup = groups.get(`${base}:${epoch}`);
    if (isStartEvent(wake) && priorGroup !== undefined && priorGroup.length > 0) epoch += 1;
    const key = `${base}:${epoch}`;
    const group = groups.get(key) ?? [];
    group.push({ index, wake });
    groups.set(key, group);
    epochs.set(base, wake.close ? epoch + 1 : epoch);
  }

  const retain = (item: { readonly index: number; readonly wake: NativeWakeV1 } | undefined) => {
    if (item === undefined || retainedEventIds.has(item.wake.eventId)) return;
    retainedEventIds.add(item.wake.eventId);
    retainedIndexes.add(item.index);
  };
  for (const group of groups.values()) {
    retain(group.find((item) => isStartEvent(item.wake)));
    retain(group.findLast((item) => item.wake.exclusion === "inference-session"));
    retain(group.findLast((item) => item.wake.close) ?? group.at(-1));
  }

  const retained: string[] = [];
  const compacted: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (retainedIndexes.has(index)) retained.push(line);
    else compacted.push(line);
  }
  return { compacted, retained };
};

const collectorErrorClass = (error: unknown): "collector" | "filesystem" | "unknown" => {
  if (typeof error === "object" && error !== null && "code" in error) return "filesystem";
  if (error instanceof Error) return "collector";
  return "unknown";
};

const readSource = async (input: {
  readonly close: boolean;
  readonly maxMs: number;
  readonly path: string;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly stableMs: number;
  readonly now: () => number;
}) => {
  if (!input.close) {
    return new Uint8Array(await readFile(input.path));
  }
  const startedAt = input.now();
  let stableSince: number | undefined;
  let previousSignature: string | undefined;
  while (input.now() - startedAt <= input.maxMs) {
    const [bytes, metadata] = await Promise.all([readFile(input.path), stat(input.path)]);
    const completeSize = completeSizeFor(bytes);
    const signature = `${bytes.byteLength}:${metadata.mtimeMs}`;
    if (completeSize === bytes.byteLength) {
      if (signature !== previousSignature) {
        previousSignature = signature;
        stableSince = input.now();
      }
      if (stableSince !== undefined && input.now() - stableSince >= input.stableMs) {
        return new Uint8Array(bytes);
      }
    } else {
      previousSignature = undefined;
      stableSince = undefined;
    }
    await input.sleep(Math.min(100, Math.max(1, input.stableMs)));
  }
  throw new Error("finality-drain-open");
};

const stateEntryFor = (input: {
  readonly acceptedEventIds: readonly string[];
  readonly closed: boolean;
  readonly incarnationId: string;
  readonly nextTurn: number;
  readonly offset: number;
  readonly prefixHash: string;
  readonly runtime: NativeRuntime;
  readonly sessionId: string;
  readonly sourcePathHash: string;
  readonly streamPath: string;
  readonly transcriptHash?: string;
  readonly vendorOffset: number;
  readonly vendorPrefixHash: string;
}): CollectorStateEntry => ({
  acceptedEventIds: input.acceptedEventIds.slice(-127),
  closed: input.closed,
  incarnationId: input.incarnationId,
  nextTurn: input.nextTurn,
  offset: input.offset,
  prefixHash: input.prefixHash,
  runtime: input.runtime,
  sessionId: input.sessionId,
  sourcePathHash: input.sourcePathHash,
  streamPath: input.streamPath,
  ...(input.transcriptHash === undefined ? {} : { transcriptHash: input.transcriptHash }),
  vendorOffset: input.vendorOffset,
  vendorPrefixHash: input.vendorPrefixHash,
});

export const drainNativeWakeSpool = async (
  input: CollectorDrainOptions,
): Promise<CollectorReceiptV1> => {
  const drainId = randomUUID();
  const drainNow = input.drainNow ?? Date.now;
  const startedAt = drainNow();
  const maxBootstrapBytes = Math.max(1, Math.floor(input.maxBootstrapBytes ?? 256_000));
  const maxLines = Math.max(1, Math.floor(input.maxLines ?? 250));
  const maxElapsedMs = Math.max(1, Math.floor(input.maxElapsedMs ?? 240_000));
  const drainReceiptPath = input.drainReceiptPath ?? `${input.statePath}.drain-receipts.jsonl`;
  const counts = {
    admitted: 0,
    deferred: 0,
    excluded: 0,
    processed: 0,
    quarantined: 0,
    replayed: 0,
  };
  let compacted = 0;
  let processingLines = 0;
  let requeued = 0;
  let terminalError: unknown;
  let untouched = 0;
  const queuedLineCount = async () =>
    readFile(input.spoolPath, "utf8")
      .then(countNonEmptyLines)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return 0;
        throw error;
      });
  const emitDrainReceipt = async (
    phase: CollectorDrainHealthReceiptV1["phase"],
    error?: unknown,
  ) => {
    const receipt: CollectorDrainHealthReceiptV1 = {
      ...counts,
      compacted,
      drainId,
      elapsedMs: Math.max(0, drainNow() - startedAt),
      ...(error === undefined ? {} : { errorClass: collectorErrorClass(error) }),
      phase,
      processingLines,
      queuedLines: await queuedLineCount(),
      requeued,
      schemaVersion: 1,
      untouched,
    };
    if (input.persistDrainReceipt === undefined) {
      await appendDurableLine(drainReceiptPath, JSON.stringify(receipt));
    } else {
      await input.persistDrainReceipt(receipt);
    }
  };

  await mkdir(path.dirname(input.lockPath), { recursive: true, mode: 0o700 });
  const lock = await acquireProcessLock(input.lockPath);
  try {
    const processingPath = `${input.spoolPath}.processing`;
    const existingProcessing = await stat(processingPath)
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
    if (!existingProcessing) {
      await rename(input.spoolPath, processingPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    const spool = await readFile(processingPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    processingLines = countNonEmptyLines(spool);
    await emitDrainReceipt("started");
    const lines = spool.split("\n");
    const trailing = lines.at(-1) === "" ? "" : (lines.pop() ?? "");
    const state = await readState(input.statePath);
    const deferredLines: string[] = trailing.length === 0 ? [] : [trailing];
    const untouchedLines: string[] = [];
    const settledClosedSources = new Set<string>();
    const seenEventIds = new Set<string>();
    const persist = input.persistState ?? persistStateDefault;
    const streamRoot = streamRootFor(input);
    const excludedSessions = new Set(state.excludedSessions ?? []);
    const checkpointPendingReceipt = async (checkpointInput: {
      readonly completeSize: number;
      readonly exact?: CollectorStateEntry;
      readonly key: string;
      readonly receipt: ImmutableStreamReceiptV1;
      readonly sourceBytes: Uint8Array;
    }) => {
      const committedOffset =
        checkpointInput.exact?.offset ?? checkpointInput.receipt.fromByte ?? 0;
      const committedStreamPath =
        checkpointInput.exact?.streamPath ?? checkpointInput.receipt.streamPath;
      const committedSource = new Uint8Array(await readFile(committedStreamPath));
      if (committedOffset > committedSource.byteLength) {
        throw new Error("immutable-stream-state-mismatch");
      }
      const checkpointBytes = committedSource.subarray(0, committedOffset);
      if (
        checkpointInput.exact?.prefixHash !== undefined &&
        hash(checkpointBytes) !== checkpointInput.exact.prefixHash
      ) {
        throw new Error("immutable-stream-prefix-diverged");
      }
      const checkpointStreamPath = `${checkpointInput.receipt.streamPath}.checkpoint-${hash(checkpointInput.receipt.acceptedEventId).slice(0, 16)}.jsonl`;
      await writeFile(checkpointStreamPath, checkpointBytes, {
        flag: "wx",
        mode: 0o600,
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const acceptedEventIds = [
        ...new Set([
          ...(checkpointInput.exact?.acceptedEventIds ??
            checkpointInput.receipt.acceptedEventIds ??
            []),
          checkpointInput.receipt.acceptedEventId,
        ]),
      ];
      const nextTurn =
        checkpointInput.exact?.nextTurn ?? checkpointInput.receipt.priorTurnCount ?? 0;
      const transcriptHash =
        checkpointInput.exact?.transcriptHash ?? checkpointInput.receipt.previousTranscriptHash;
      const vendorPrefixHash = hash(
        checkpointInput.sourceBytes.subarray(0, checkpointInput.completeSize),
      );
      await persistStreamReceipt(input, checkpointInput.key, {
        acceptedEventId: checkpointInput.receipt.acceptedEventId,
        acceptedEventIds,
        closed: checkpointInput.receipt.closed,
        fromByte: committedOffset,
        incarnationId: checkpointInput.receipt.incarnationId,
        nextTurn,
        offset: committedOffset,
        prefixHash: hash(checkpointBytes),
        ...(transcriptHash === undefined ? {} : { transcriptHash }),
        ...(transcriptHash === undefined ? {} : { previousTranscriptHash: transcriptHash }),
        priorTurnCount: nextTurn,
        runtime: checkpointInput.receipt.runtime,
        sessionId: checkpointInput.receipt.sessionId,
        sourcePathHash: checkpointInput.receipt.sourcePathHash,
        status: "checkpointed",
        streamPath: checkpointStreamPath,
        vendorFromByte: checkpointInput.completeSize,
        vendorOffset: checkpointInput.completeSize,
        vendorPrefixHash,
        schemaVersion: 1,
      });
      state.streams[checkpointInput.key] = stateEntryFor({
        acceptedEventIds,
        closed: checkpointInput.receipt.closed,
        incarnationId: checkpointInput.receipt.incarnationId,
        nextTurn,
        offset: committedOffset,
        prefixHash: hash(checkpointBytes),
        runtime: checkpointInput.receipt.runtime,
        sessionId: checkpointInput.receipt.sessionId,
        sourcePathHash: checkpointInput.receipt.sourcePathHash,
        streamPath: checkpointStreamPath,
        ...(transcriptHash === undefined ? {} : { transcriptHash }),
        vendorOffset: checkpointInput.completeSize,
        vendorPrefixHash,
      });
      await persist(input.statePath, state);
    };
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? "";
      if (line.length === 0) continue;
      if (counts.processed >= maxLines || drainNow() - startedAt >= maxElapsedMs) {
        untouchedLines.push(...lines.slice(lineIndex).filter((candidate) => candidate.length > 0));
        untouched = untouchedLines.length;
        break;
      }
      let decoded: NativeWakeV1;
      try {
        decoded = decodeWake(line);
      } catch {
        await appendQuarantine(input.spoolPath, undefined, "invalid-native-wake");
        counts.quarantined += 1;
        counts.processed += 1;
        continue;
      }
      if (seenEventIds.has(decoded.eventId)) {
        counts.replayed += 1;
        counts.processed += 1;
        continue;
      }
      seenEventIds.add(decoded.eventId);
      const wake = incarnationForWake(state, decoded);
      const sessionKey = exclusionKey(wake);
      if (wake.exclusion === "inference-session") {
        excludedSessions.add(sessionKey);
        state.excludedSessions = [...excludedSessions].toSorted();
        await persist(input.statePath, state);
        counts.excluded += 1;
        counts.processed += 1;
        continue;
      }
      if (excludedSessions.has(sessionKey)) {
        counts.excluded += 1;
        counts.processed += 1;
        continue;
      }
      let counted = false;
      const key = streamKey(wake);
      const receipt = await readStreamReceipt(input, key);
      const exact = state.streams[key];
      const continuation =
        exact === undefined
          ? Object.values(state.streams)
              .filter(
                (entry) =>
                  entry.runtime === wake.runtime &&
                  entry.sessionId === wake.sessionId &&
                  entry.sourcePathHash === hash(wake.transcriptPath),
              )
              .sort(
                (left, right) =>
                  (right.vendorOffset ?? right.offset) - (left.vendorOffset ?? left.offset),
              )[0]
          : undefined;
      const recovered = receipt === undefined ? undefined : stateEntryFromReceipt(receipt);
      const prior = receipt?.status === "pending" ? recovered : (exact ?? recovered);
      if (receipt?.status !== "pending" && exact?.acceptedEventIds.includes(wake.eventId)) {
        counts.replayed += 1;
        counts.processed += 1;
        continue;
      }
      try {
        if (input.verifySource === true) await verifyNativeSource(wake);
        const sourceBytes = await readSource({
          close: wake.close,
          maxMs: input.closeMaxMs ?? 10_000,
          path: wake.transcriptPath,
          sleep: input.sleep ?? delay,
          stableMs: input.closeStableMs ?? 2_000,
          now: input.now ?? Date.now,
        });
        const sourceSize = sourceBytes.byteLength;
        const vendorOffset =
          receipt?.status === "pending"
            ? receipt.vendorOffset
            : (exact?.vendorOffset ?? continuation?.vendorOffset ?? receipt?.vendorOffset ?? 0);
        if (sourceSize < vendorOffset) throw new Error("source-shrank");
        const vendorPrefixHash =
          vendorOffset === 0 ? "" : hash(sourceBytes.subarray(0, vendorOffset));
        if (prior?.vendorPrefixHash !== undefined && vendorPrefixHash !== prior.vendorPrefixHash) {
          throw new Error("source-prefix-diverged");
        }
        const completeSize = completeSizeFor(sourceBytes);
        if (
          completeSize < vendorOffset ||
          (!wake.close &&
            completeSize === vendorOffset &&
            receipt === undefined &&
            !isStartEvent(wake))
        ) {
          deferredLines.push(line);
          counts.deferred += 1;
          counts.processed += 1;
          continue;
        }
        if (receipt?.closed === true && completeSize > receipt.vendorOffset) {
          throw new Error("late-bytes-after-finality");
        }
        const pendingStartByte = receipt?.fromByte ?? 0;
        if (
          receipt?.status === "pending" &&
          receipt.offset - pendingStartByte > maxBootstrapBytes
        ) {
          await checkpointPendingReceipt({
            completeSize,
            ...(exact === undefined ? {} : { exact }),
            key,
            receipt,
            sourceBytes,
          });
          counts.excluded += 1;
          counts.processed += 1;
          continue;
        }
        if (receipt?.status === "pending") {
          const pendingPrefix = new Uint8Array(
            await readFile(receipt.streamPath).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return new Uint8Array();
              throw error;
            }),
          );
          const pendingFromByte = receipt.fromByte ?? 0;
          if (
            pendingPrefix.byteLength !== receipt.offset ||
            pendingFromByte > pendingPrefix.byteLength ||
            hash(pendingPrefix) !== receipt.prefixHash
          ) {
            await checkpointPendingReceipt({
              completeSize,
              ...(exact === undefined ? {} : { exact }),
              key,
              receipt,
              sourceBytes,
            });
            counts.excluded += 1;
            counts.processed += 1;
            continue;
          }
          const pendingWake = {
            ...wake,
            close: receipt.closed,
            eventId: receipt.acceptedEventId,
            incarnationId: receipt.incarnationId,
          };
          const pendingInput: NativeAdmissionInputV1 = {
            fromByte: pendingFromByte,
            immutableStreamPath: receipt.streamPath,
            prefixBytes: pendingPrefix,
            priorTurnCount: receipt.priorTurnCount ?? 0,
            ...(receipt.previousTranscriptHash === undefined
              ? {}
              : { previousTranscriptHash: receipt.previousTranscriptHash }),
            segmentBytes: pendingPrefix.subarray(pendingFromByte),
            toByteExclusive: pendingPrefix.byteLength,
            vendorFromByte: receipt.vendorFromByte ?? 0,
            vendorToByteExclusive: receipt.vendorOffset,
            wake: pendingWake,
          };
          const pendingResult = await input.admission.admit(pendingInput);
          await input.afterAdmission?.(pendingInput, pendingResult);
          counts.processed += 1;
          counted = true;
          if (
            pendingResult.disposition === "admitted" ||
            pendingResult.disposition === "finalized" ||
            pendingResult.disposition === "excluded" ||
            pendingResult.disposition === "replay"
          ) {
            const nextTurn =
              pendingResult.acceptedToTurn === undefined
                ? receipt.nextTurn
                : pendingResult.acceptedToTurn + 1;
            const transcriptHash = pendingResult.acceptedTranscriptHash ?? receipt.transcriptHash;
            const acceptedEventIds = [...(receipt.acceptedEventIds ?? []), receipt.acceptedEventId];
            const pendingEntry = stateEntryFor({
              acceptedEventIds: [...new Set(acceptedEventIds)],
              closed: receipt.closed,
              incarnationId: receipt.incarnationId,
              nextTurn,
              offset: receipt.offset,
              prefixHash: receipt.prefixHash,
              runtime: receipt.runtime,
              sessionId: receipt.sessionId,
              sourcePathHash: receipt.sourcePathHash,
              streamPath: receipt.streamPath,
              ...(transcriptHash === undefined ? {} : { transcriptHash }),
              vendorOffset: receipt.vendorOffset,
              vendorPrefixHash: receipt.vendorPrefixHash,
            });
            await persistStreamReceipt(input, key, {
              acceptedEventId: receipt.acceptedEventId,
              acceptedEventIds: pendingEntry.acceptedEventIds,
              closed: receipt.closed,
              fromByte: pendingFromByte,
              incarnationId: receipt.incarnationId,
              nextTurn,
              offset: receipt.offset,
              prefixHash: receipt.prefixHash,
              ...(receipt.previousTranscriptHash === undefined
                ? {}
                : { previousTranscriptHash: receipt.previousTranscriptHash }),
              priorTurnCount: receipt.priorTurnCount ?? 0,
              runtime: receipt.runtime,
              sessionId: receipt.sessionId,
              sourcePathHash: receipt.sourcePathHash,
              status: "committed",
              streamPath: receipt.streamPath,
              ...(transcriptHash === undefined ? {} : { transcriptHash }),
              vendorFromByte: receipt.vendorFromByte ?? 0,
              vendorOffset: receipt.vendorOffset,
              vendorPrefixHash: receipt.vendorPrefixHash,
              schemaVersion: 1,
            });
            state.streams[key] = pendingEntry;
            await persist(input.statePath, state);
            if (pendingResult.disposition === "excluded") counts.excluded += 1;
            else counts.replayed += 1;
            if (completeSize > receipt.vendorOffset && !receipt.closed) {
              deferredLines.push(
                JSON.stringify(
                  growthWakeFor(wake, receipt.offset, completeSize, hash(sourceBytes)),
                ),
              );
              counts.deferred += 1;
            }
          } else if (pendingResult.disposition === "deferred") {
            deferredLines.push(line);
            counts.deferred += 1;
          } else {
            await appendQuarantine(input.spoolPath, wake, pendingResult.disposition);
            counts.quarantined += 1;
          }
          continue;
        }
        if (receipt !== undefined && completeSize === receipt.vendorOffset && !wake.close) {
          state.streams[key] = stateEntryFor({
            acceptedEventIds: [...new Set([...(prior?.acceptedEventIds ?? []), wake.eventId])],
            closed: receipt.closed,
            incarnationId: receipt.incarnationId,
            nextTurn: receipt.nextTurn,
            offset: receipt.offset,
            prefixHash: receipt.prefixHash,
            runtime: receipt.runtime,
            sessionId: receipt.sessionId,
            sourcePathHash: receipt.sourcePathHash,
            streamPath: receipt.streamPath,
            ...(receipt.transcriptHash === undefined
              ? {}
              : { transcriptHash: receipt.transcriptHash }),
            vendorOffset: receipt.vendorOffset,
            vendorPrefixHash: receipt.vendorPrefixHash,
          });
          await persist(input.statePath, state);
          counts.replayed += 1;
          counts.processed += 1;
          continue;
        }
        const effectiveWake =
          receipt !== undefined && completeSize > receipt.vendorOffset && !wake.close
            ? growthWakeFor(wake, receipt.offset, completeSize, hash(sourceBytes))
            : wake;
        const streamPath =
          exact?.streamPath ?? receipt?.streamPath ?? path.join(streamRoot, `${key}.jsonl`);
        await mkdir(path.dirname(streamPath), { recursive: true, mode: 0o700 });
        const existingStream = new Uint8Array(
          await readFile(streamPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return new Uint8Array();
            throw error;
          }),
        );
        const streamOffset = exact?.offset ?? receipt?.offset ?? 0;
        const vendorSegment = sourceBytes.subarray(vendorOffset, completeSize);
        if (
          receipt === undefined &&
          (exact === undefined || exact.offset === 0) &&
          (vendorSegment.byteLength > maxBootstrapBytes ||
            (exact !== undefined && existingStream.byteLength > 0))
        ) {
          const checkpointStreamPath =
            existingStream.byteLength === 0
              ? streamPath
              : `${streamPath}.checkpoint-${hash(effectiveWake.eventId).slice(0, 16)}.jsonl`;
          await writeFile(checkpointStreamPath, new Uint8Array(), {
            flag: "wx",
            mode: 0o600,
          }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          });
          state.streams[key] = stateEntryFor({
            acceptedEventIds: [
              ...new Set([...(exact?.acceptedEventIds ?? []), effectiveWake.eventId]),
            ],
            closed: effectiveWake.close,
            incarnationId: effectiveWake.incarnationId,
            nextTurn: 0,
            offset: 0,
            prefixHash: hash(new Uint8Array()),
            runtime: effectiveWake.runtime,
            sessionId: effectiveWake.sessionId,
            sourcePathHash: hash(effectiveWake.transcriptPath),
            streamPath: checkpointStreamPath,
            vendorOffset: completeSize,
            vendorPrefixHash: hash(sourceBytes.subarray(0, completeSize)),
          });
          await persist(input.statePath, state);
          counts.excluded += 1;
          counts.processed += 1;
          continue;
        }
        if (
          (exact !== undefined || receipt !== undefined) &&
          existingStream.byteLength !== streamOffset
        ) {
          throw new Error("immutable-stream-state-mismatch");
        }
        if (
          (exact?.prefixHash ?? receipt?.prefixHash) !== undefined &&
          hash(existingStream) !== (exact?.prefixHash ?? receipt?.prefixHash)
        ) {
          throw new Error("immutable-stream-prefix-diverged");
        }
        if (receipt?.status === "checkpointed") {
          if (vendorSegment.byteLength > 0) await appendFile(streamPath, vendorSegment);
        } else if (receipt !== undefined && existingStream.byteLength > 0) {
          const receiptVendorStart = receipt.vendorOffset - receipt.offset;
          if (receiptVendorStart < 0) throw new Error("immutable-stream-state-mismatch");
          const existingPrefix = sourceBytes.subarray(
            receiptVendorStart,
            receiptVendorStart + streamOffset,
          );
          if (
            existingPrefix.byteLength !== existingStream.byteLength ||
            hash(existingPrefix) !== hash(existingStream)
          ) {
            throw new Error("immutable-stream-prefix-diverged");
          }
          const growth = sourceBytes.subarray(receipt.vendorOffset, completeSize);
          if (growth.byteLength > 0) await appendFile(streamPath, growth);
        } else if (exact === undefined && existingStream.byteLength > 0) {
          const existingPrefix = vendorSegment.subarray(0, existingStream.byteLength);
          if (
            existingPrefix.byteLength !== existingStream.byteLength ||
            hash(existingPrefix) !== hash(existingStream)
          ) {
            throw new Error("immutable-stream-prefix-diverged");
          }
          const growth = vendorSegment.subarray(existingStream.byteLength);
          if (growth.byteLength > 0) await appendFile(streamPath, growth);
        } else if (vendorSegment.byteLength > 0) {
          await appendFile(streamPath, vendorSegment);
        } else if (exact === undefined && receipt === undefined) {
          await writeFile(streamPath, new Uint8Array(), { flag: "wx", mode: 0o600 });
        }
        const prefixBytes = new Uint8Array(await readFile(streamPath));
        const fromByte = streamOffset;
        const segmentBytes = prefixBytes.subarray(fromByte);
        if (
          segmentBytes.byteLength === 0 &&
          effectiveWake.close &&
          (exact?.nextTurn ?? receipt?.nextTurn ?? 0) === 0
        ) {
          deferredLines.push(line);
          counts.deferred += 1;
          counts.processed += 1;
          continue;
        }
        if (segmentBytes.byteLength === 0 && !effectiveWake.close) {
          if (exact !== undefined) {
            state.streams[key] = {
              ...exact,
              acceptedEventIds: [...new Set([...exact.acceptedEventIds, effectiveWake.eventId])],
            };
            await persist(input.statePath, state);
            counts.replayed += 1;
            counts.processed += 1;
            continue;
          }
          if (isStartEvent(effectiveWake) && receipt === undefined) {
            state.streams[key] = stateEntryFor({
              acceptedEventIds: [effectiveWake.eventId],
              closed: false,
              incarnationId: effectiveWake.incarnationId,
              nextTurn: 0,
              offset: 0,
              prefixHash: hash(prefixBytes),
              runtime: effectiveWake.runtime,
              sessionId: effectiveWake.sessionId,
              sourcePathHash: hash(effectiveWake.transcriptPath),
              streamPath,
              vendorOffset: completeSize,
              vendorPrefixHash: hash(sourceBytes.subarray(0, completeSize)),
            });
            await persist(input.statePath, state);
          } else {
            deferredLines.push(line);
          }
          counts.deferred += 1;
          counts.processed += 1;
          continue;
        }
        const priorTurnCount = exact?.nextTurn ?? receipt?.nextTurn ?? 0;
        const previousTranscriptHash = prior?.transcriptHash;
        const admissionInput: NativeAdmissionInputV1 = {
          fromByte,
          immutableStreamPath: streamPath,
          prefixBytes,
          priorTurnCount,
          ...(previousTranscriptHash === undefined ? {} : { previousTranscriptHash }),
          segmentBytes,
          toByteExclusive: prefixBytes.byteLength,
          vendorFromByte: vendorOffset,
          vendorToByteExclusive: completeSize,
          wake: effectiveWake,
        };
        await persistStreamReceipt(input, key, {
          acceptedEventId: effectiveWake.eventId,
          acceptedEventIds: [...(prior?.acceptedEventIds ?? []), effectiveWake.eventId],
          closed: effectiveWake.close,
          fromByte,
          incarnationId: effectiveWake.incarnationId,
          nextTurn: prior?.nextTurn ?? 0,
          offset: prefixBytes.byteLength,
          prefixHash: hash(prefixBytes),
          ...(previousTranscriptHash === undefined ? {} : { previousTranscriptHash }),
          priorTurnCount,
          runtime: effectiveWake.runtime,
          sessionId: effectiveWake.sessionId,
          sourcePathHash: hash(effectiveWake.transcriptPath),
          status: "pending",
          streamPath,
          vendorFromByte: vendorOffset,
          vendorOffset: completeSize,
          vendorPrefixHash: hash(sourceBytes.subarray(0, completeSize)),
          schemaVersion: 1,
        });
        const result = await input.admission.admit(admissionInput);
        await input.afterAdmission?.(admissionInput, result);
        counts.processed += 1;
        counted = true;
        if (
          result.disposition === "admitted" ||
          result.disposition === "finalized" ||
          result.disposition === "excluded" ||
          result.disposition === "replay"
        ) {
          if (result.disposition === "replay") counts.replayed += 1;
          else if (result.disposition === "excluded") counts.excluded += 1;
          else counts.admitted += 1;
          const nextTurn =
            result.acceptedToTurn === undefined
              ? (prior?.nextTurn ?? 0)
              : result.acceptedToTurn + 1;
          const transcriptHash = result.acceptedTranscriptHash ?? prior?.transcriptHash;
          const acceptedEventIds = [
            ...(prior?.acceptedEventIds ?? []),
            wake.eventId,
            ...(effectiveWake.eventId === wake.eventId ? [] : [effectiveWake.eventId]),
          ];
          const nextEntry = stateEntryFor({
            acceptedEventIds: [...new Set(acceptedEventIds)],
            closed: effectiveWake.close,
            incarnationId: effectiveWake.incarnationId,
            nextTurn,
            offset: prefixBytes.byteLength,
            prefixHash: hash(prefixBytes),
            runtime: effectiveWake.runtime,
            sessionId: effectiveWake.sessionId,
            sourcePathHash: hash(effectiveWake.transcriptPath),
            streamPath,
            ...(transcriptHash === undefined ? {} : { transcriptHash }),
            vendorOffset: completeSize,
            vendorPrefixHash: hash(sourceBytes.subarray(0, completeSize)),
          });
          await persistStreamReceipt(input, key, {
            acceptedEventId: effectiveWake.eventId,
            acceptedEventIds: nextEntry.acceptedEventIds,
            closed: effectiveWake.close,
            fromByte,
            incarnationId: effectiveWake.incarnationId,
            nextTurn,
            offset: nextEntry.offset,
            prefixHash: nextEntry.prefixHash ?? hash(prefixBytes),
            ...(previousTranscriptHash === undefined ? {} : { previousTranscriptHash }),
            priorTurnCount,
            runtime: effectiveWake.runtime,
            sessionId: effectiveWake.sessionId,
            sourcePathHash: hash(effectiveWake.transcriptPath),
            status: "committed",
            streamPath,
            ...(transcriptHash === undefined ? {} : { transcriptHash }),
            vendorFromByte: vendorOffset,
            vendorOffset: completeSize,
            vendorPrefixHash: hash(sourceBytes.subarray(0, completeSize)),
            schemaVersion: 1,
          });
          state.streams[key] = nextEntry;
          await persist(input.statePath, state);
          if (effectiveWake.close) {
            settledClosedSources.add(
              `${effectiveWake.runtime}:${effectiveWake.sessionId}:${hash(effectiveWake.transcriptPath)}`,
            );
          }
        } else if (result.disposition === "deferred") {
          deferredLines.push(line);
          counts.deferred += 1;
        } else {
          await appendQuarantine(input.spoolPath, wake, result.disposition);
          counts.quarantined += 1;
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "collector-failure";
        if (
          reason === "source-prefix-diverged" ||
          reason === "source-shrank" ||
          reason === "late-bytes-after-finality" ||
          reason === "previous-transcript-hash-mismatch" ||
          reason === "invalid-source-root" ||
          reason === "grok-summary-identity-mismatch" ||
          reason === "grok-updates-identity-ambiguous"
        ) {
          await appendQuarantine(input.spoolPath, wake, reason);
          counts.quarantined += 1;
        } else {
          deferredLines.push(line);
          counts.deferred += 1;
        }
        if (!counted) counts.processed += 1;
      }
    }
    const retainedDeferredLines = deferredLines.filter((line) => {
      try {
        const wake = decodeWake(line);
        return !settledClosedSources.has(
          `${wake.runtime}:${wake.sessionId}:${hash(wake.transcriptPath)}`,
        );
      } catch {
        return true;
      }
    });
    const requeueCompaction = compactWakeLines([...retainedDeferredLines, ...untouchedLines]);
    untouched = untouchedLines.length;
    if (requeueCompaction.compacted.length > 0) {
      await appendDurableLine(
        input.compactedWakePath ?? `${input.spoolPath}.compacted.jsonl`,
        requeueCompaction.compacted.join("\n"),
      );
      compacted = requeueCompaction.compacted.length;
    }
    if (requeueCompaction.retained.length > 0) {
      await appendDurableLine(input.spoolPath, requeueCompaction.retained.join("\n"));
      requeued = requeueCompaction.retained.length;
    }
    await unlink(processingPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await emitDrainReceipt("batch");
    return { ...counts, schemaVersion: 1 };
  } catch (error) {
    terminalError = error;
    await emitDrainReceipt("failed", error).catch(() => undefined);
    throw error;
  } finally {
    await emitDrainReceipt("finished", terminalError).catch(() => undefined);
    await unlinkOwnedProcessLock(input.lockPath, lock.token);
    await lock.handle.close();
  }
};

export interface NativeCollectorServiceOptions extends Omit<
  CollectorDrainOptions,
  "lockPath" | "spoolPath"
> {
  readonly activeSourceScan: () => Promise<readonly NativeWakeV1[]>;
  readonly scanIntervalMs?: number;
  readonly socketPath: string;
  readonly spoolPath: string;
}

export interface NativeCollectorService {
  readonly server: Server;
  readonly stop: () => Promise<void>;
}

export const startNativeCollectorService = async (
  input: NativeCollectorServiceOptions,
): Promise<NativeCollectorService> => {
  await mkdir(path.dirname(input.socketPath), { recursive: true, mode: 0o700 });
  const ownerLockPath = ownerLockPathFor(input.socketPath);
  let ownerLock: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 2 && ownerLock === undefined; attempt += 1) {
    try {
      ownerLock = await open(ownerLockPath, "wx", 0o600);
      await ownerLock.writeFile(
        `${JSON.stringify({ pid: process.pid, schemaVersion: 1, socketPath: input.socketPath })}\n`,
        { encoding: "utf8" },
      );
      await ownerLock.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = await readOwnerPid(ownerLockPath);
      if (pid !== undefined && processIsAlive(pid)) {
        throw new Error("collector-already-running");
      }
      await unlink(ownerLockPath).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      });
    }
  }
  if (ownerLock === undefined) throw new Error("collector-already-running");
  const socketExists = await stat(input.socketPath)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  if (socketExists) {
    const socketState = await socketProbe(input.socketPath);
    if (socketState === "active") {
      await ownerLock.close();
      await unlink(ownerLockPath).catch(() => undefined);
      throw new Error("collector-already-running");
    }
    await unlink(input.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  const drainReceiptPath = input.drainReceiptPath ?? `${input.statePath}.drain-receipts.jsonl`;
  const recordServiceFailure = async (error: unknown) => {
    const queuedLines = await readFile(input.spoolPath, "utf8")
      .then(countNonEmptyLines)
      .catch(() => 0);
    const processingLines = await readFile(`${input.spoolPath}.processing`, "utf8")
      .then(countNonEmptyLines)
      .catch(() => 0);
    const receipt: CollectorDrainHealthReceiptV1 = {
      admitted: 0,
      compacted: 0,
      deferred: 0,
      drainId: randomUUID(),
      elapsedMs: 0,
      errorClass: collectorErrorClass(error),
      excluded: 0,
      phase: "service-failure",
      processed: 0,
      processingLines,
      quarantined: 0,
      queuedLines,
      replayed: 0,
      requeued: 0,
      schemaVersion: 1,
      untouched: processingLines,
    };
    await appendDurableLine(drainReceiptPath, JSON.stringify(receipt));
  };
  let drainQueue: Promise<void> = Promise.resolve();
  const drain = () => {
    drainQueue = drainQueue.then(async () => {
      try {
        await drainNativeWakeSpool({
          ...input,
          lockPath: `${input.socketPath}.drain.lock`,
        });
      } catch (error) {
        await recordServiceFailure(error).catch(() => undefined);
      }
    });
    return drainQueue;
  };
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
    });
    socket.on("end", async () => {
      let invalid = false;
      try {
        for (const line of buffer.split("\n")) {
          if (line.length === 0) continue;
          try {
            await appendNativeWake(input.spoolPath, decodeWake(line));
          } catch {
            invalid = true;
            await appendQuarantine(input.spoolPath, undefined, "invalid-socket-wake");
          }
        }
        await new Promise<void>((resolve) => {
          socket.end(`${JSON.stringify({ ok: !invalid, schemaVersion: 1 })}\n`, "utf8", resolve);
        });
        await drain();
      } catch {
        socket.destroy();
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(input.socketPath, resolve);
    });
  } catch (error) {
    await ownerLock.close();
    await unlink(ownerLockPath).catch(() => undefined);
    throw (error as NodeJS.ErrnoException).code === "EADDRINUSE"
      ? new Error("collector-already-running")
      : error;
  }
  const interval = setInterval(() => {
    void (async () => {
      await drain();
      for (const wake of await input.activeSourceScan()) {
        await appendNativeWake(input.spoolPath, wake);
      }
      await drain();
    })().catch(() => undefined);
  }, input.scanIntervalMs ?? 15_000);
  const stop = async () => {
    clearInterval(interval);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await drain();
    await unlink(input.socketPath).catch(() => undefined);
    await ownerLock.close();
    await unlink(ownerLockPath).catch(() => undefined);
  };
  return { server, stop };
};
