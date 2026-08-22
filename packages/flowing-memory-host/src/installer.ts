import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { inspectNativeCollector, type NativeCollectorPresenceV1 } from "./collector.js";

export type InstallableRuntime = "claude" | "codex" | "cursor" | "grok" | "pi";

export const RUNTIME_HOOK_EVENTS = {
  pi: ["session_start", "turn_end", "session_shutdown"],
  claude: ["SessionStart", "PostToolBatch", "Stop", "StopFailure", "SessionEnd"],
  codex: ["SessionStart", "PostToolUse", "Stop", "SessionEnd"],
  cursor: ["sessionStart", "afterAgentResponse", "stop", "sessionEnd"],
  grok: ["SessionStart", "Stop", "StopFailure", "StopCancelled", "Notification", "SessionEnd"],
} as const satisfies Record<InstallableRuntime, readonly string[]>;

type RuntimeEventName = (typeof RUNTIME_HOOK_EVENTS)[InstallableRuntime][number];
type JsonObject = Record<string, unknown>;
type FileMode = number;

type TargetKind = "absent" | "file" | "symlink";

interface TargetSnapshot {
  readonly bytes: Uint8Array;
  readonly existed: boolean;
  readonly kind: TargetKind;
  readonly linkTarget?: string;
  readonly mode?: FileMode;
}

interface OwnedFragmentV1 {
  readonly command: string;
  readonly eventName?: string;
}

interface DisplacedHandlerV1 {
  readonly eventName: string;
  readonly handler: JsonObject;
}

interface HookPatch {
  readonly bytes?: Uint8Array;
  readonly displacedHandlers: readonly DisplacedHandlerV1[];
  readonly kind: "file" | "symlink";
  readonly legacyHandlersRemoved: number;
  readonly linkTarget?: string;
  readonly ownedFragments: readonly OwnedFragmentV1[];
}

export interface HookInstallInput {
  readonly dryRun: boolean;
  readonly expectedPreimageHash?: string;
  readonly faultInjection?: "post-write-readback" | "rollback-restore";
  readonly fragmentRef: string;
  readonly idle: boolean;
  readonly manifestPath: string;
  readonly runtime: InstallableRuntime;
  readonly targetPath: string;
}

export interface HookInstallReceiptV1 {
  readonly action: "dry-run" | "installed";
  readonly backupHash?: string;
  readonly backupPath: string;
  readonly canaryReceiptPresent?: boolean;
  readonly collectorPresent?: boolean;
  readonly events: readonly string[];
  readonly fragmentHash?: string;
  readonly fragmentRef: string;
  readonly inversePatchHash?: string;
  readonly legacyHandlersRemoved: number;
  readonly manifestPath: string;
  readonly postWriteHash: string;
  readonly postWriteKind: "file" | "symlink";
  readonly preimageHash: string;
  readonly preimageLinkTarget?: string;
  readonly preimageMode?: FileMode;
  readonly ownedFragments: readonly OwnedFragmentV1[];
  readonly displacedHandlers: readonly DisplacedHandlerV1[];
  readonly runtime: InstallableRuntime;
  readonly schemaVersion: 1;
  readonly targetExisted: boolean;
  readonly targetKind: TargetKind;
  readonly targetPath: string;
}

export interface HookManifestV1 extends HookInstallReceiptV1 {
  readonly action: "installed";
  readonly installedAt: string;
}

export interface HookDoctorReceiptV1 {
  readonly eventCounts: Readonly<Record<string, number>>;
  readonly expectedEvents: readonly string[];
  readonly backupHashMatches?: boolean;
  readonly backupPresent: boolean;
  readonly canaryReceiptPresent?: boolean;
  readonly collectorPresent?: boolean;
  readonly collectorState?: NativeCollectorPresenceV1;
  readonly fragmentHashMatches?: boolean;
  readonly fragmentPresent: boolean;
  readonly inversePatchAvailable: boolean;
  readonly inversePatchHashMatches?: boolean;
  readonly legacyHandlerPresent: boolean;
  readonly modeMatches: boolean;
  readonly releaseHashMatches?: boolean;
  readonly releasePresent: boolean;
  readonly spoolPresent?: boolean;
  readonly manifestPath?: string;
  readonly packagePresent: boolean;
  readonly runtime: InstallableRuntime;
  readonly schemaVersion: 1;
  readonly state: "absent" | "drifted" | "installed-canary-unproven";
  readonly targetHash: string | null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const absentHash = sha("flowing-memory:absent:v1");
const symlinkHash = (target: string) => sha(`flowing-memory:symlink:v1:${target}`);

const object = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const parseJsonObject = (bytes: Uint8Array, existed: boolean, code: string): JsonObject => {
  if (!existed) return {};
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error(code);
  }
  const parsed = object(value);
  if (parsed === undefined) throw new Error(code);
  return parsed;
};

const encodeJson = (value: JsonObject) => encoder.encode(`${JSON.stringify(value, null, 2)}\n`);

const readOptional = async (target: string): Promise<TargetSnapshot> => {
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) {
      return {
        bytes: new Uint8Array(),
        existed: true,
        kind: "symlink",
        linkTarget: await readlink(target),
        mode: metadata.mode & 0o777,
      };
    }
    if (!metadata.isFile()) throw new Error(`installer-target-not-file:${target}`);
    return {
      bytes: new Uint8Array(await readFile(target)),
      existed: true,
      kind: "file",
      mode: metadata.mode & 0o777,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { bytes: new Uint8Array(), existed: false, kind: "absent" };
    }
    throw error;
  }
};

const snapshotHash = (snapshot: TargetSnapshot) => {
  if (!snapshot.existed) return absentHash;
  if (snapshot.kind === "symlink") {
    if (snapshot.linkTarget === undefined) throw new Error("installer-symlink-target-missing");
    return symlinkHash(snapshot.linkTarget);
  }
  return sha(snapshot.bytes);
};

const commandOf = (value: unknown) => {
  const handler = object(value);
  return text(handler?.command);
};

const groupHandlers = (value: unknown): readonly unknown[] => {
  const group = object(value);
  if (group === undefined) throw new Error("installer-hook-group-invalid");
  if (!Array.isArray(group.hooks)) throw new Error("installer-hook-handlers-invalid");
  for (const handler of group.hooks) {
    const parsed = object(handler);
    if (parsed === undefined || commandOf(parsed) === undefined) {
      throw new Error("installer-hook-handler-invalid");
    }
  }
  return group.hooks;
};

const hooksObject = (root: JsonObject, runtime: Exclude<InstallableRuntime, "pi">) => {
  if (root.hooks === undefined) return {};
  const hooks = object(root.hooks);
  if (hooks === undefined) throw new Error(`${runtime}-settings-hooks-invalid`);
  if (runtime === "cursor" && root.version !== undefined && root.version !== 1) {
    throw new Error("cursor-settings-version-invalid");
  }
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) throw new Error(`${runtime}-settings-hooks-invalid`);
    for (const group of groups) {
      if (runtime === "cursor") {
        if (commandOf(group) === undefined) throw new Error("cursor-hook-handler-invalid");
      } else {
        groupHandlers(group);
      }
    }
  }
  return hooks;
};

const handlersInGroup = (
  runtime: Exclude<InstallableRuntime, "pi">,
  value: unknown,
): readonly unknown[] => {
  if (runtime === "cursor") {
    if (commandOf(value) === undefined) throw new Error("cursor-hook-handler-invalid");
    return [value];
  }
  return groupHandlers(value);
};

const legacyPattern = (runtime: InstallableRuntime): RegExp | undefined => {
  switch (runtime) {
    case "claude":
      return /(?:joelclaw-capture-session|capture-session)\.ts/u;
    case "codex":
      return /(?:joelclaw-capture-codex-session|capture-codex-session)\.js/u;
    default:
      return undefined;
  }
};

const stripLegacyGroups = (
  groups: readonly unknown[],
  pattern: RegExp | undefined,
): {
  readonly groups: readonly unknown[];
  readonly removed: number;
  readonly removedHandlers: readonly JsonObject[];
} => {
  if (pattern === undefined) return { groups, removed: 0, removedHandlers: [] };
  let removed = 0;
  const removedHandlers: JsonObject[] = [];
  const next = groups.flatMap((value) => {
    const group = object(value);
    const handlers = groupHandlers(value);
    const kept = handlers.filter((handler) => {
      const command = commandOf(handler);
      const isLegacy = command !== undefined && pattern.test(command);
      if (isLegacy) {
        removed += 1;
        if (object(handler) !== undefined) removedHandlers.push(object(handler)!);
      }
      return !isLegacy;
    });
    if (kept.length === handlers.length) return [value];
    return kept.length === 0 ? [] : [{ ...group, hooks: kept }];
  });
  return { groups: next, removed, removedHandlers };
};

const configuredEvents = (runtime: Exclude<InstallableRuntime, "pi">) =>
  RUNTIME_HOOK_EVENTS[runtime];

const handlerGroup = (
  runtime: Exclude<InstallableRuntime, "pi">,
  eventName: string,
  fragmentRef: string,
): JsonObject => {
  if (runtime === "cursor") return { command: fragmentRef, timeout: 1 };
  const handler = { command: fragmentRef, timeout: 1, type: "command" };
  return eventName === "Notification"
    ? { hooks: [handler], matcher: "idle_prompt" }
    : { hooks: [handler] };
};

const validateFragmentRef = (fragmentRef: string) => {
  if (fragmentRef.trim().length === 0) throw new Error("installer-fragment-empty");
};

const patchJsonHooks = (
  runtime: Exclude<InstallableRuntime, "pi">,
  snapshot: TargetSnapshot,
  fragmentRef: string,
): HookPatch => {
  const root = parseJsonObject(snapshot.bytes, snapshot.existed, `${runtime}-settings-invalid`);
  const hooks = hooksObject(root, runtime);
  const occurrences = Object.values(hooks).reduce<number>((count, groups) => {
    if (!Array.isArray(groups)) return count;
    return (
      count +
      groups.reduce(
        (groupCount, group) =>
          groupCount +
          handlersInGroup(runtime, group).filter((handler) => commandOf(handler) === fragmentRef)
            .length,
        0,
      )
    );
  }, 0);
  if (occurrences > 0) throw new Error(`${runtime}-hook-fragment-already-present`);

  let legacyHandlersRemoved = 0;
  const displacedHandlers: DisplacedHandlerV1[] = [];
  const ownedFragments: OwnedFragmentV1[] = [];
  const nextHooks: JsonObject = { ...hooks };
  const pattern = legacyPattern(runtime);
  for (const [eventName, value] of Object.entries(nextHooks)) {
    if (!Array.isArray(value)) throw new Error(`${runtime}-${eventName}-hooks-invalid`);
    if (runtime === "cursor") continue;
    const stripped = stripLegacyGroups(value, pattern);
    nextHooks[eventName] = stripped.groups;
    legacyHandlersRemoved += stripped.removed;
    for (const handler of stripped.removedHandlers) {
      displacedHandlers.push({ eventName, handler });
    }
  }
  for (const eventName of configuredEvents(runtime)) {
    const groups = nextHooks[eventName];
    if (groups !== undefined && !Array.isArray(groups)) {
      throw new Error(`${runtime}-${eventName}-hooks-invalid`);
    }
    nextHooks[eventName] = [
      ...((groups as readonly unknown[] | undefined) ?? []),
      handlerGroup(runtime, eventName, fragmentRef),
    ];
    ownedFragments.push({ command: fragmentRef, eventName });
  }
  const nextRoot: JsonObject =
    runtime === "cursor" && root.version === undefined
      ? { ...root, hooks: nextHooks, version: 1 }
      : { ...root, hooks: nextHooks };
  return {
    bytes: encodeJson(nextRoot),
    displacedHandlers,
    kind: "file",
    legacyHandlersRemoved,
    ownedFragments,
  };
};

const patchPiSettings = (snapshot: TargetSnapshot, fragmentRef: string): HookPatch => {
  const settings = parseJsonObject(snapshot.bytes, snapshot.existed, "pi-settings-invalid");
  const packages = settings.packages ?? [];
  if (!Array.isArray(packages)) throw new Error("pi-settings-packages-invalid");
  for (const entry of packages) {
    if (typeof entry !== "string" && object(entry) === undefined) {
      throw new Error("pi-settings-package-invalid");
    }
  }
  const occurrences = packages.filter((entry) => entry === fragmentRef).length;
  if (occurrences > 1) throw new Error("pi-hook-duplicate-package");
  const next = occurrences === 1 ? packages : [...packages, fragmentRef];
  return {
    bytes: encodeJson({ ...settings, packages: next }),
    displacedHandlers: [],
    kind: "file",
    legacyHandlersRemoved: 0,
    ownedFragments: [{ command: fragmentRef }],
  };
};

const patchPiLink = (fragmentRef: string): HookPatch => {
  if (!path.isAbsolute(fragmentRef)) throw new Error("pi-release-path-not-absolute");
  return {
    displacedHandlers: [],
    kind: "symlink",
    legacyHandlersRemoved: 0,
    linkTarget: fragmentRef,
    ownedFragments: [{ command: fragmentRef }],
  };
};

const patchTarget = (
  input: Pick<HookInstallInput, "runtime" | "targetPath">,
  snapshot: TargetSnapshot,
  fragmentRef: string,
): HookPatch => {
  if (input.runtime === "pi") {
    // The live Pi target is the extension symlink. Keep the old settings.json
    // package mode for callers that use the legacy package registration path.
    return snapshot.kind === "symlink" || !input.targetPath.endsWith(".json")
      ? patchPiLink(fragmentRef)
      : patchPiSettings(snapshot, fragmentRef);
  }
  return patchJsonHooks(input.runtime, snapshot, fragmentRef);
};

const patchHash = (patch: HookPatch) => {
  if (patch.kind === "symlink") {
    if (patch.linkTarget === undefined) throw new Error("installer-patch-link-target-missing");
    return symlinkHash(patch.linkTarget);
  }
  if (patch.bytes === undefined) throw new Error("installer-patch-bytes-missing");
  return sha(patch.bytes);
};

const writeFileAtomic = async (target: string, bytes: Uint8Array, mode = 0o600) => {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, bytes, { mode });
  await chmod(temporary, mode);
  await rename(temporary, target);
};

const writeSymlinkAtomic = async (target: string, linkTarget: string) => {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await symlink(linkTarget, temporary);
  await rename(temporary, target);
};

const removeTarget = async (target: string) => {
  await unlink(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
};

const writePatch = async (target: string, patch: HookPatch, mode?: FileMode) => {
  if (patch.kind === "symlink") {
    if (patch.linkTarget === undefined) throw new Error("installer-patch-link-target-missing");
    await writeSymlinkAtomic(target, patch.linkTarget);
    return;
  }
  if (patch.bytes === undefined) throw new Error("installer-patch-bytes-missing");
  await writeFileAtomic(target, patch.bytes, mode);
};

const restoreSnapshot = async (target: string, snapshot: TargetSnapshot) => {
  if (!snapshot.existed) {
    await removeTarget(target);
    return;
  }
  if (snapshot.kind === "symlink") {
    if (snapshot.linkTarget === undefined) throw new Error("installer-symlink-target-missing");
    await removeTarget(target);
    await writeSymlinkAtomic(target, snapshot.linkTarget);
    return;
  }
  await writeFileAtomic(target, snapshot.bytes, snapshot.mode);
};

const backupBytesFor = (snapshot: TargetSnapshot) =>
  snapshot.kind === "file"
    ? snapshot.bytes
    : encoder.encode(`${snapshot.kind === "symlink" ? (snapshot.linkTarget ?? "") : ""}\n`);

const backupHashFor = (snapshot: TargetSnapshot) => sha(backupBytesFor(snapshot));

const backupSnapshot = async (backupPath: string, snapshot: TargetSnapshot) => {
  await writeFileAtomic(backupPath, backupBytesFor(snapshot), snapshot.mode);
};

const eventCountsFor = (
  runtime: InstallableRuntime,
  snapshot: TargetSnapshot,
  fragmentRef: string,
): Readonly<Record<string, number>> => {
  const expected = RUNTIME_HOOK_EVENTS[runtime];
  if (!snapshot.existed) return Object.fromEntries(expected.map((event) => [event, 0]));
  if (runtime === "pi") {
    const count =
      snapshot.kind === "symlink"
        ? snapshot.linkTarget === fragmentRef
          ? 1
          : 0
        : snapshot.kind === "file"
          ? (() => {
              const root = parseJsonObject(snapshot.bytes, true, "pi-settings-invalid");
              const packages = root.packages;
              return Array.isArray(packages) &&
                packages.filter((entry) => entry === fragmentRef).length === 1
                ? 1
                : 0;
            })()
          : 0;
    return Object.fromEntries(expected.map((event) => [event, count]));
  }
  const runtimeWithoutPi: Exclude<InstallableRuntime, "pi"> = runtime;
  const root = parseJsonObject(snapshot.bytes, true, `${runtimeWithoutPi}-settings-invalid`);
  const hooks = hooksObject(root, runtimeWithoutPi);
  const counts: Record<string, number> = {};
  for (const event of expected) {
    const groups = hooks[event];
    counts[event] = Array.isArray(groups)
      ? groups.reduce<number>(
          (count, group) =>
            count +
            handlersInGroup(runtimeWithoutPi, group).filter(
              (handler) => commandOf(handler) === fragmentRef,
            ).length,
          0,
        )
      : 0;
  }
  return counts;
};

const allExpectedExactlyOnce = (counts: Readonly<Record<string, number>>) =>
  Object.values(counts).every((count) => count === 1);

const hasLegacyHandler = (runtime: InstallableRuntime, snapshot: TargetSnapshot) => {
  const pattern = legacyPattern(runtime);
  if (!snapshot.existed || pattern === undefined || snapshot.kind !== "file" || runtime === "pi")
    return false;
  const root = parseJsonObject(snapshot.bytes, true, `${runtime}-settings-invalid`);
  const hooks = hooksObject(root, runtime);
  return Object.values(hooks).some((groups) =>
    (groups as readonly unknown[]).some((group) =>
      handlersInGroup(runtime, group).some((handler) => {
        const command = commandOf(handler);
        return command !== undefined && pattern.test(command);
      }),
    ),
  );
};

const receiptFor = (
  input: HookInstallInput,
  snapshot: TargetSnapshot,
  patch: HookPatch,
): HookInstallReceiptV1 => {
  const preimageLinkTarget = snapshot.kind === "symlink" ? snapshot.linkTarget : undefined;
  return {
    action: input.dryRun ? "dry-run" : "installed",
    backupPath: `${input.manifestPath}.preimage`,
    events: [...RUNTIME_HOOK_EVENTS[input.runtime]],
    fragmentRef: input.fragmentRef,
    legacyHandlersRemoved: patch.legacyHandlersRemoved,
    manifestPath: input.manifestPath,
    postWriteHash: patchHash(patch),
    postWriteKind: patch.kind,
    preimageHash: snapshotHash(snapshot),
    ...(preimageLinkTarget === undefined ? {} : { preimageLinkTarget }),
    ...(snapshot.mode === undefined ? {} : { preimageMode: snapshot.mode }),
    ownedFragments: patch.ownedFragments,
    displacedHandlers: patch.displacedHandlers,
    runtime: input.runtime,
    schemaVersion: 1,
    targetExisted: snapshot.existed,
    targetKind: snapshot.kind,
    targetPath: input.targetPath,
  };
};

const manifestExists = async (manifestPath: string) => {
  try {
    await lstat(manifestPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

export const installHookFragments = async (
  inputs: readonly HookInstallInput[],
): Promise<readonly HookInstallReceiptV1[]> => {
  if (inputs.length === 0) throw new Error("installer-no-targets");
  const dryRunMode = inputs[0]?.dryRun;
  if (dryRunMode === undefined || inputs.some((input) => input.dryRun !== dryRunMode)) {
    throw new Error("installer-mixed-dry-run-mode");
  }
  const targetPaths = new Set<string>();
  const manifestPaths = new Set<string>();
  const prepared = [] as Array<{
    readonly input: HookInstallInput;
    readonly patch: HookPatch;
    readonly receipt: HookInstallReceiptV1;
    readonly snapshot: TargetSnapshot;
  }>;

  for (const input of inputs) {
    validateFragmentRef(input.fragmentRef);
    if (!input.idle) throw new Error(`runtime-not-idle:${input.runtime}`);
    if (targetPaths.has(input.targetPath)) throw new Error("installer-duplicate-target");
    if (manifestPaths.has(input.manifestPath)) throw new Error("installer-duplicate-manifest");
    targetPaths.add(input.targetPath);
    manifestPaths.add(input.manifestPath);
    const snapshot = await readOptional(input.targetPath);
    const preimageHash = snapshotHash(snapshot);
    if (
      !input.dryRun &&
      (input.expectedPreimageHash === undefined || input.expectedPreimageHash !== preimageHash)
    ) {
      throw new Error(`installer-target-changed-after-dry-run:${input.runtime}`);
    }
    const patch = patchTarget(input, snapshot, input.fragmentRef);
    const baseReceipt = receiptFor(input, snapshot, patch);
    const releasePath = releasePathFromFragment({
      ...baseReceipt,
      action: "installed",
      installedAt: "",
    } as HookManifestV1);
    const fragmentHash = await hashPath(releasePath);
    const postimage: TargetSnapshot =
      patch.kind === "symlink"
        ? {
            bytes: new Uint8Array(),
            existed: true,
            kind: "symlink",
            ...(patch.linkTarget === undefined ? {} : { linkTarget: patch.linkTarget }),
            ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode }),
          }
        : {
            bytes: patch.bytes ?? new Uint8Array(),
            existed: true,
            kind: "file",
            ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode }),
          };
    const provisionalManifest = {
      ...baseReceipt,
      action: "installed",
      installedAt: "",
      ...(fragmentHash === undefined ? {} : { fragmentHash }),
    } as HookManifestV1;
    const inversePatch =
      patch.kind === "symlink" ? undefined : inversePatchFor(provisionalManifest, postimage);
    const receipt: HookInstallReceiptV1 = {
      ...baseReceipt,
      ...(fragmentHash === undefined ? {} : { fragmentHash }),
      backupHash: backupHashFor(snapshot),
      inversePatchHash:
        inversePatch === undefined ? snapshotHash(snapshot) : patchHash(inversePatch),
    };
    prepared.push({ input, patch, receipt, snapshot });
  }

  if (dryRunMode) return prepared.map(({ receipt }) => receipt);

  for (const { input } of prepared) {
    if (await manifestExists(input.manifestPath)) {
      throw new Error(`installer-manifest-already-exists:${input.runtime}`);
    }
  }

  // Register every target before the first mutation. A post-write readback
  // failure must roll back the target that failed verification too.
  const writtenTargets: typeof prepared = [...prepared];
  const writtenBackups: string[] = [];
  const writtenManifests: string[] = [];
  try {
    for (const item of prepared) {
      await backupSnapshot(item.receipt.backupPath, item.snapshot);
      writtenBackups.push(item.receipt.backupPath);
      await writePatch(item.input.targetPath, item.patch, item.snapshot.mode);
      if (item.input.faultInjection === "post-write-readback") {
        throw new Error(`installer-fault-post-write-readback:${item.input.runtime}`);
      }
      const postimage = await readOptional(item.input.targetPath);
      if (
        !postimage.existed ||
        postimage.kind !== item.receipt.postWriteKind ||
        snapshotHash(postimage) !== item.receipt.postWriteHash
      ) {
        throw new Error(`installer-post-write-hash-mismatch:${item.input.runtime}`);
      }
    }
    const installedAt = new Date().toISOString();
    for (const item of prepared) {
      const manifest: HookManifestV1 = {
        ...item.receipt,
        action: "installed",
        installedAt,
      };
      await writeFileAtomic(item.input.manifestPath, encodeJson(manifest as unknown as JsonObject));
      writtenManifests.push(item.input.manifestPath);
    }
    // Hash the inverse against the actual post-write bytes. This catches
    // serialization and mode differences between the prepared patch and disk.
    for (const item of prepared) {
      const manifest = await readManifest(item.input.manifestPath);
      const inverse = await uninstallPrepared(item.input.manifestPath);
      const inversePatchHash =
        inverse.inversePatch === undefined
          ? snapshotHash(inverse.snapshot)
          : patchHash(inverse.inversePatch);
      await writeFileAtomic(
        item.input.manifestPath,
        encodeJson({
          ...manifest,
          inversePatchHash,
        } as unknown as JsonObject),
      );
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const manifestPath of writtenManifests) {
      try {
        await removeTarget(manifestPath);
      } catch (rollbackError) {
        rollbackErrors.push(`manifest:${manifestPath}:${String(rollbackError)}`);
      }
    }
    for (const item of writtenTargets.toReversed()) {
      try {
        await removeTarget(item.input.targetPath);
        if (item.input.faultInjection === "rollback-restore") {
          throw new Error(`installer-fault-rollback-restore:${item.input.runtime}`);
        }
        await restoreSnapshot(item.input.targetPath, item.snapshot);
        const restored = await readOptional(item.input.targetPath);
        if (snapshotHash(restored) !== item.receipt.preimageHash) {
          throw new Error(`installer-rollback-verify:${item.input.runtime}`);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`target:${item.input.runtime}:${String(rollbackError)}`);
      }
    }
    for (const backupPath of writtenBackups) {
      try {
        await removeTarget(backupPath);
      } catch (rollbackError) {
        rollbackErrors.push(`backup:${backupPath}:${String(rollbackError)}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`installer-rollback-failed:${rollbackErrors.join("|")}`, { cause: error });
    }
    throw error;
  }
  return prepared.map(({ receipt }) => ({ ...receipt, action: "installed" as const }));
};

export const installHookFragment = async (
  input: HookInstallInput,
): Promise<HookInstallReceiptV1> => {
  const [receipt] = await installHookFragments([input]);
  if (receipt === undefined) throw new Error("installer-no-receipt");
  return receipt;
};

const readManifest = async (manifestPath: string): Promise<HookManifestV1> => {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new Error("installer-manifest-invalid");
  }
  const manifest = object(value);
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.action !== "installed" ||
    typeof manifest.runtime !== "string" ||
    !RUNTIME_HOOK_EVENTS[manifest.runtime as InstallableRuntime] ||
    typeof manifest.fragmentRef !== "string" ||
    typeof manifest.targetPath !== "string" ||
    typeof manifest.manifestPath !== "string" ||
    typeof manifest.preimageHash !== "string" ||
    typeof manifest.postWriteHash !== "string" ||
    typeof manifest.backupPath !== "string"
  ) {
    throw new Error("installer-manifest-invalid");
  }
  const runtime = manifest.runtime as InstallableRuntime;
  const targetKind =
    manifest.targetKind === "absent" ||
    manifest.targetKind === "file" ||
    manifest.targetKind === "symlink"
      ? manifest.targetKind
      : manifest.targetExisted === false
        ? "absent"
        : "file";
  const postWriteKind = manifest.postWriteKind === "symlink" ? "symlink" : "file";
  const events = Array.isArray(manifest.events)
    ? manifest.events.filter((event): event is string => typeof event === "string")
    : [...RUNTIME_HOOK_EVENTS[runtime]];
  const ownedFragments = Array.isArray(manifest.ownedFragments)
    ? manifest.ownedFragments.filter((value): value is OwnedFragmentV1 => {
        const item = object(value);
        return (
          item !== undefined &&
          typeof item.command === "string" &&
          (item.eventName === undefined || typeof item.eventName === "string")
        );
      })
    : [{ command: manifest.fragmentRef }];
  const displacedHandlers = Array.isArray(manifest.displacedHandlers)
    ? manifest.displacedHandlers.filter((value): value is DisplacedHandlerV1 => {
        const item = object(value);
        return (
          item !== undefined &&
          typeof item.eventName === "string" &&
          object(item.handler) !== undefined
        );
      })
    : [];
  return {
    ...(manifest as unknown as HookManifestV1),
    displacedHandlers,
    events,
    ownedFragments,
    postWriteKind,
    runtime,
    targetKind,
  };
};

const inversePatchFor = (manifest: HookManifestV1, current: TargetSnapshot): HookPatch => {
  if (manifest.runtime === "pi" && current.kind === "symlink") {
    throw new Error(`installer-target-drifted:${manifest.runtime}`);
  }
  if (!current.existed || current.kind !== "file") {
    throw new Error(`installer-target-drifted:${manifest.runtime}`);
  }
  const root = parseJsonObject(current.bytes, true, `${manifest.runtime}-settings-invalid`);
  if (manifest.runtime === "pi") {
    const packages = root.packages;
    if (!Array.isArray(packages)) throw new Error("pi-settings-packages-invalid");
    let removed = 0;
    const nextPackages = packages.filter((entry) => {
      if (entry === manifest.fragmentRef) {
        removed += 1;
        return false;
      }
      return true;
    });
    if (removed !== 1) throw new Error("installer-owned-fragment-missing");
    return {
      bytes: encodeJson({ ...root, packages: nextPackages }),
      displacedHandlers: [],
      kind: "file",
      legacyHandlersRemoved: 0,
      ownedFragments: manifest.ownedFragments,
    };
  }
  const hooks = hooksObject(root, manifest.runtime);
  const nextHooks: JsonObject = { ...hooks };
  let removed = 0;
  for (const [eventName, value] of Object.entries(nextHooks)) {
    if (!Array.isArray(value)) throw new Error(`${manifest.runtime}-hooks-invalid`);
    if (manifest.runtime === "cursor") {
      nextHooks[eventName] = value.filter((handler) => {
        const command = commandOf(handler);
        if (command !== manifest.fragmentRef) return true;
        removed += 1;
        return false;
      });
      continue;
    }
    nextHooks[eventName] = value.flatMap((group) => {
      const parsed = object(group);
      if (parsed === undefined || !Array.isArray(parsed.hooks)) return [group];
      const kept = parsed.hooks.filter((handler) => {
        if (commandOf(handler) !== manifest.fragmentRef) return true;
        removed += 1;
        return false;
      });
      return kept.length === parsed.hooks.length
        ? [group]
        : kept.length === 0
          ? []
          : [{ ...parsed, hooks: kept }];
    });
  }
  if (removed !== manifest.ownedFragments.length) {
    throw new Error("installer-owned-fragment-missing");
  }
  for (const displaced of manifest.displacedHandlers) {
    const groups = Array.isArray(nextHooks[displaced.eventName])
      ? (nextHooks[displaced.eventName] as readonly unknown[])
      : [];
    const firstGroup = groups[0];
    const firstObject = object(firstGroup);
    if (firstObject !== undefined && Array.isArray(firstObject.hooks)) {
      nextHooks[displaced.eventName] = [
        { ...firstObject, hooks: [displaced.handler, ...firstObject.hooks] },
        ...groups.slice(1),
      ];
    } else {
      nextHooks[displaced.eventName] = [...groups, { hooks: [displaced.handler] }];
    }
  }
  return {
    bytes: encodeJson({ ...root, hooks: nextHooks }),
    displacedHandlers: [],
    kind: "file",
    legacyHandlersRemoved: 0,
    ownedFragments: manifest.ownedFragments,
  };
};

const absentDoctor = (runtime: InstallableRuntime, manifestPath?: string): HookDoctorReceiptV1 => ({
  backupHashMatches: false,
  backupPresent: false,
  canaryReceiptPresent: false,
  collectorPresent: false,
  collectorState: "absent",
  eventCounts: Object.fromEntries(RUNTIME_HOOK_EVENTS[runtime].map((event) => [event, 0])),
  expectedEvents: [...RUNTIME_HOOK_EVENTS[runtime]],
  fragmentHashMatches: false,
  fragmentPresent: false,
  inversePatchAvailable: false,
  inversePatchHashMatches: false,
  legacyHandlerPresent: false,
  modeMatches: false,
  releaseHashMatches: false,
  releasePresent: false,
  spoolPresent: false,
  ...(manifestPath === undefined ? {} : { manifestPath }),
  packagePresent: false,
  runtime,
  schemaVersion: 1,
  state: "absent",
  targetHash: null,
});

const releasePathFromFragment = (manifest: HookManifestV1) => {
  if (manifest.runtime === "pi" || !manifest.fragmentRef.startsWith("'")) {
    return manifest.fragmentRef;
  }
  const parts = manifest.fragmentRef.split("' '");
  const encoded = parts[1]?.split("' --runtime")[0];
  if (encoded === undefined) return undefined;
  return encoded.replaceAll("'\\''", "'");
};

const pathPresent = async (value: string | undefined) => {
  if (value === undefined) return false;
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const hashPath = async (value: string | undefined): Promise<string | undefined> => {
  if (value === undefined) return undefined;
  let metadata;
  try {
    metadata = await lstat(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (metadata.isSymbolicLink()) return symlinkHash(await readlink(value));
  if (metadata.isFile()) return sha(new Uint8Array(await readFile(value)));
  if (!metadata.isDirectory()) return undefined;
  const entries = (await readdir(value, { withFileTypes: true })).toSorted((left, right) =>
    left.name.localeCompare(right.name),
  );
  const children: string[] = [];
  for (const entry of entries) {
    const childHash = await hashPath(path.join(value, entry.name));
    if (childHash !== undefined) children.push(`${entry.name}:${childHash}`);
  }
  return sha(children.join("\\n"));
};

export const doctorHookFragment = async (
  manifestPath: string,
  runtimeHint: InstallableRuntime = "pi",
): Promise<HookDoctorReceiptV1> => {
  let manifest: HookManifestV1;
  try {
    manifest = await readManifest(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return absentDoctor(runtimeHint, manifestPath);
    }
    throw error;
  }
  const target = await readOptional(manifest.targetPath);
  const targetHash = target.existed ? snapshotHash(target) : null;
  const eventCounts = eventCountsFor(manifest.runtime, target, manifest.fragmentRef);
  const fragmentPresent =
    target.existed &&
    targetHash === manifest.postWriteHash &&
    target.kind === manifest.postWriteKind &&
    allExpectedExactlyOnce(eventCounts);
  const legacyHandlerPresent = hasLegacyHandler(manifest.runtime, target);
  const releasePath = releasePathFromFragment(manifest);
  const releaseHash = await hashPath(releasePath);
  const releasePresent = releaseHash !== undefined;
  const fragmentHashMatches =
    manifest.fragmentHash !== undefined &&
    releaseHash !== undefined &&
    manifest.fragmentHash === releaseHash;
  const backupBytes = await readFile(manifest.backupPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const backupPresent = backupBytes !== undefined;
  const backupHashMatches =
    manifest.backupHash !== undefined &&
    backupBytes !== undefined &&
    manifest.backupHash === sha(new Uint8Array(backupBytes));
  const modeMatches = manifest.preimageMode === undefined || target.mode === manifest.preimageMode;
  const inversePatchAvailable = manifest.ownedFragments.length > 0;
  let inversePatchHashMatches = false;
  try {
    const prepared = await uninstallPrepared(manifestPath);
    const actualInverseHash =
      prepared.inversePatch === undefined
        ? snapshotHash(prepared.snapshot)
        : patchHash(prepared.inversePatch);
    inversePatchHashMatches =
      manifest.inversePatchHash !== undefined && manifest.inversePatchHash === actualInverseHash;
  } catch {
    inversePatchHashMatches = false;
  }
  const homeRoot = process.env.HOME ?? "/tmp";
  const collectorSocket =
    process.env.JOELCLAW_FLOWING_MEMORY_COLLECTOR_SOCKET ??
    path.join(homeRoot, ".joelclaw", "flowing-memory", "collector.sock");
  const collectorState = await inspectNativeCollector(collectorSocket);
  const collectorPresent = collectorState !== "absent";
  const spoolPresent = await pathPresent(
    process.env.JOELCLAW_FLOWING_MEMORY_WAKE_SPOOL ??
      path.join(homeRoot, ".joelclaw", "flowing-memory", "native-wakes.jsonl"),
  );
  const canaryReceiptPresent = await pathPresent(
    process.env.JOELCLAW_FLOWING_MEMORY_CANARY_RECEIPT,
  );
  const usable =
    fragmentPresent &&
    !legacyHandlerPresent &&
    releasePresent &&
    fragmentHashMatches &&
    backupPresent &&
    backupHashMatches &&
    modeMatches &&
    inversePatchAvailable &&
    inversePatchHashMatches;
  return {
    backupHashMatches,
    backupPresent,
    canaryReceiptPresent,
    collectorPresent,
    collectorState,
    eventCounts,
    expectedEvents: [...RUNTIME_HOOK_EVENTS[manifest.runtime]],
    fragmentHashMatches,
    fragmentPresent,
    inversePatchAvailable,
    inversePatchHashMatches,
    legacyHandlerPresent,
    manifestPath,
    modeMatches,
    packagePresent: fragmentHashMatches,
    releaseHashMatches: fragmentHashMatches,
    releasePresent,
    runtime: manifest.runtime,
    schemaVersion: 1,
    spoolPresent,
    state: usable ? "installed-canary-unproven" : "drifted",
    targetHash,
  };
};

const uninstallPrepared = async (manifestPath: string) => {
  const manifest = await readManifest(manifestPath);
  const target = await readOptional(manifest.targetPath);
  const exactPostimage =
    target.existed &&
    target.kind === manifest.postWriteKind &&
    snapshotHash(target) === manifest.postWriteHash;
  const inversePatch = exactPostimage ? undefined : inversePatchFor(manifest, target);
  const snapshot: TargetSnapshot =
    manifest.targetKind === "symlink"
      ? {
          bytes: new Uint8Array(),
          existed: true,
          kind: "symlink",
          ...(manifest.preimageLinkTarget === undefined
            ? {}
            : { linkTarget: manifest.preimageLinkTarget }),
          ...(manifest.preimageMode === undefined ? {} : { mode: manifest.preimageMode }),
        }
      : manifest.targetKind === "file"
        ? {
            bytes: new Uint8Array(await readFile(manifest.backupPath)),
            existed: true,
            kind: "file",
            ...(manifest.preimageMode === undefined ? {} : { mode: manifest.preimageMode }),
          }
        : { bytes: new Uint8Array(), existed: false, kind: "absent" };
  if (snapshot.kind === "symlink" && snapshot.linkTarget === undefined) {
    throw new Error("installer-manifest-missing-link-preimage");
  }
  return { current: target, inversePatch, manifest, snapshot };
};

export const uninstallHookFragments = async (manifestPaths: readonly string[]) => {
  if (manifestPaths.length === 0) throw new Error("installer-no-manifests");
  const prepared = [] as Array<{
    readonly manifestPath: string;
    readonly manifest: HookManifestV1;
    readonly snapshot: TargetSnapshot;
    readonly current: TargetSnapshot;
    readonly inversePatch?: HookPatch;
  }>;
  const targets = new Set<string>();
  for (const manifestPath of manifestPaths) {
    const item = await uninstallPrepared(manifestPath);
    if (targets.has(item.manifest.targetPath)) throw new Error("installer-duplicate-target");
    targets.add(item.manifest.targetPath);
    prepared.push({
      current: item.current,
      ...(item.inversePatch === undefined ? {} : { inversePatch: item.inversePatch }),
      manifestPath,
      manifest: item.manifest,
      snapshot: item.snapshot,
    });
  }
  // Register all targets before mutation so a verification failure on the
  // first target also restores every already-attempted target.
  const attempted: typeof prepared = [...prepared];
  const restoredHashes = new Map<string, string>();
  try {
    for (const item of prepared) {
      await removeTarget(item.manifest.targetPath);
      if (item.inversePatch === undefined) {
        await restoreSnapshot(item.manifest.targetPath, item.snapshot);
        const restored = await readOptional(item.manifest.targetPath);
        if (snapshotHash(restored) !== item.manifest.preimageHash) {
          throw new Error(`installer-restore-hash-mismatch:${item.manifest.runtime}`);
        }
        restoredHashes.set(item.manifest.targetPath, snapshotHash(restored));
      } else {
        await writePatch(item.manifest.targetPath, item.inversePatch, item.current.mode);
        const restored = await readOptional(item.manifest.targetPath);
        const remaining = eventCountsFor(
          item.manifest.runtime,
          restored,
          item.manifest.fragmentRef,
        );
        if (Object.values(remaining).some((count) => count !== 0)) {
          throw new Error(`installer-inverse-patch-incomplete:${item.manifest.runtime}`);
        }
        restoredHashes.set(item.manifest.targetPath, snapshotHash(restored));
      }
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const item of attempted.toReversed()) {
      try {
        await removeTarget(item.manifest.targetPath);
        await restoreSnapshot(item.manifest.targetPath, item.current);
        const restored = await readOptional(item.manifest.targetPath);
        if (snapshotHash(restored) !== snapshotHash(item.current)) {
          throw new Error(`installer-uninstall-rollback-verify:${item.manifest.runtime}`);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`target:${item.manifest.runtime}:${String(rollbackError)}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`installer-uninstall-rollback-failed:${rollbackErrors.join("|")}`, {
        cause: error,
      });
    }
    throw error;
  }
  for (const item of prepared) {
    await removeTarget(item.manifest.backupPath);
    await removeTarget(item.manifestPath);
  }
  return prepared.map((item) => ({
    action: "uninstalled" as const,
    restoredHash: restoredHashes.get(item.manifest.targetPath) ?? item.manifest.preimageHash,
    runtime: item.manifest.runtime,
    schemaVersion: 1 as const,
    targetExisted: item.manifest.targetExisted,
  }));
};

export const uninstallHookFragment = async (manifestPath: string) => {
  const [receipt] = await uninstallHookFragments([manifestPath]);
  if (receipt === undefined) throw new Error("installer-no-receipt");
  return receipt;
};

export const installPiHook = async (input: {
  readonly dryRun: boolean;
  readonly expectedPreimageHash?: string;
  readonly idle: boolean;
  readonly manifestPath: string;
  readonly packageRef: string;
  readonly targetPath: string;
}) =>
  installHookFragment({
    dryRun: input.dryRun,
    ...(input.expectedPreimageHash === undefined
      ? {}
      : { expectedPreimageHash: input.expectedPreimageHash }),
    fragmentRef: input.packageRef,
    idle: input.idle,
    manifestPath: input.manifestPath,
    runtime: "pi",
    targetPath: input.targetPath,
  });

export const doctorPiHook = (manifestPath: string) => doctorHookFragment(manifestPath, "pi");
export const uninstallPiHook = uninstallHookFragment;

export const runtimeHookEvents = (runtime: InstallableRuntime): readonly string[] => [
  ...RUNTIME_HOOK_EVENTS[runtime],
];
