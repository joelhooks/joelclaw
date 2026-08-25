#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { stdin } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  decodeGrokEvent,
  decodeNativeEvent,
  type NativeRuntime,
  scanNativeSources,
} from "./adapters.js";
import {
  appendNativeWake,
  type NativeAdmissionPort,
  startNativeCollectorService,
} from "./collector.js";
import { runtimeProcessIsIdle } from "./idle-probe.js";
import {
  doctorHookFragment,
  type HookInstallInput,
  type InstallableRuntime,
  installHookFragments,
  uninstallHookFragments,
} from "./installer.js";
import { resolveTrustedAdmissionSourceConfig } from "./live-admission.js";
import { makeLiveOpenCodeAuthority } from "./opencode-authority.js";
import { OpenCodeGlobalStopError, reconcileOpenCodeSnapshot } from "./opencode-producer.js";
import {
  defaultOpenCodeDatabasePath,
  openCodeCliErrorReceipt,
  openCodeDryRunReceipt,
  readOpenCodeSource,
} from "./opencode-source.js";
import { makeTrustedAdmissionWriter } from "./trusted-admission.js";

const arguments_ = process.argv.slice(2);
const valueAfter = (name: string) => {
  const index = arguments_.indexOf(name);
  return index === -1 ? undefined : arguments_[index + 1];
};
const action = arguments_[0] === "hooks" ? arguments_[1] : undefined;
const runtimeValue = valueAfter("--runtime");
const dryRun = arguments_.includes("--dry-run");
const allRuntimes = ["pi", "claude", "codex", "cursor", "grok"] as const;
const runtimeNames = new Set<string>(allRuntimes);

type RuntimeSelection = InstallableRuntime | "all";

const asRuntimeSelection = (value: string | undefined): RuntimeSelection => {
  if (value === "all") return "all";
  if (value !== undefined && runtimeNames.has(value)) return value as InstallableRuntime;
  throw new Error(
    "usage: flowing-memory-host hooks <install|doctor|uninstall> --runtime <pi|claude|codex|cursor|grok|all> [--dry-run] --json",
  );
};

const selection = action === undefined ? undefined : asRuntimeSelection(runtimeValue);

const json = (value: unknown) => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const home = homedir();
const releaseRoot =
  process.env.JOELCLAW_FLOWING_MEMORY_RELEASE_ROOT ??
  path.join(home, ".joelclaw", "memory-hooks", "releases");
const installRoot =
  process.env.JOELCLAW_FLOWING_MEMORY_INSTALL_ROOT ??
  path.join(home, ".joelclaw", "memory-hooks", "installations");
const releaseVersion = process.env.JOELCLAW_FLOWING_MEMORY_HOOK_VERSION ?? "v1";
const packageDirectory = path.dirname(fileURLToPath(import.meta.url));

const targetPathFor = (runtime: InstallableRuntime) => {
  switch (runtime) {
    case "pi":
      return process.env.PI_CODING_AGENT_DIR === undefined
        ? path.join(home, ".pi", "agent", "extensions", "memory-capture")
        : path.join(process.env.PI_CODING_AGENT_DIR, "extensions", "memory-capture");
    case "claude":
      return path.join(home, ".claude", "settings.json");
    case "codex":
      return path.join(home, ".codex", "hooks.json");
    case "cursor":
      return path.join(home, ".cursor", "hooks.json");
    case "grok":
      return path.join(home, ".grok", "hooks", "joelclaw-memory.json");
  }
};

const manifestPathFor = (runtime: InstallableRuntime) =>
  path.join(installRoot, `${runtime}.manifest.json`);

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const writeIfAbsentOrExact = async (target: string, sourceBytes: Uint8Array) => {
  try {
    const targetBytes = new Uint8Array(await readFile(target));
    if (sha(targetBytes) !== sha(sourceBytes)) {
      throw new Error(`flowing-memory-release-drifted:${target}`);
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, sourceBytes, { mode: 0o700 });
};

const copyIfAbsentOrExact = async (source: string, target: string) =>
  writeIfAbsentOrExact(target, new Uint8Array(await readFile(source)));

const codexWrapperSource = () => `#!/bin/sh
set -eu
input_file="$(mktemp "\${TMPDIR:-/tmp}/flowing-memory-codex.XXXXXX")"
trap 'rm -f "$input_file"' EXIT HUP INT TERM
cat >"$input_file"
${shellQuote(process.execPath)} "$(dirname "$0")/hook-entry.js" --runtime codex <"$input_file"
`;

const releasePathFor = (runtime: InstallableRuntime) => {
  const releaseDirectory = path.join(releaseRoot, releaseVersion, runtime);
  if (runtime === "pi") return path.join(releaseDirectory, "memory-capture");
  if (runtime === "codex") return path.join(releaseDirectory, "codex-hook-entry.sh");
  return path.join(releaseDirectory, "hook-entry.js");
};

const ensureRelease = async (runtime: InstallableRuntime) => {
  const releaseDirectory = path.join(releaseRoot, releaseVersion, runtime);
  await mkdir(releaseDirectory, { recursive: true, mode: 0o700 });
  await copyIfAbsentOrExact(
    path.join(packageDirectory, "adapters.js"),
    path.join(releaseDirectory, "adapters.js"),
  );
  await copyIfAbsentOrExact(
    path.join(packageDirectory, "collector.js"),
    path.join(releaseDirectory, "collector.js"),
  );
  if (runtime === "pi") {
    const extensionDirectory = path.join(releaseDirectory, "memory-capture");
    await mkdir(extensionDirectory, { recursive: true, mode: 0o700 });
    await copyIfAbsentOrExact(
      path.join(packageDirectory, "pi-extension.js"),
      path.join(extensionDirectory, "index.js"),
    );
    await copyIfAbsentOrExact(
      path.join(packageDirectory, "adapters.js"),
      path.join(extensionDirectory, "adapters.js"),
    );
    await copyIfAbsentOrExact(
      path.join(packageDirectory, "collector.js"),
      path.join(extensionDirectory, "collector.js"),
    );
    return extensionDirectory;
  }
  await copyIfAbsentOrExact(
    path.join(packageDirectory, "hook-entry.js"),
    path.join(releaseDirectory, "hook-entry.js"),
  );
  if (runtime === "codex") {
    const wrapperPath = path.join(releaseDirectory, "codex-hook-entry.sh");
    await writeIfAbsentOrExact(wrapperPath, new TextEncoder().encode(codexWrapperSource()));
    return wrapperPath;
  }
  return path.join(releaseDirectory, "hook-entry.js");
};

const fragmentFor = async (runtime: InstallableRuntime, materialize: boolean) => {
  const release = materialize ? await ensureRelease(runtime) : releasePathFor(runtime);
  if (runtime === "pi") return release;
  if (runtime === "codex") {
    return `${shellQuote("/bin/sh")} ${shellQuote(release)} --runtime codex`;
  }
  return `${shellQuote(process.execPath)} ${shellQuote(release)} --runtime ${runtime}`;
};

const idleFor = (runtime: InstallableRuntime) => {
  const asserted = process.env.JOELCLAW_MEMORY_RUNTIME_IDLE === "1";
  const scoped = process.env[`JOELCLAW_MEMORY_${runtime.toUpperCase()}_IDLE`];
  const assertion = scoped === undefined ? asserted : scoped === "1";
  if (!assertion) return false;
  const explicitProbe = process.env[`JOELCLAW_MEMORY_${runtime.toUpperCase()}_IDLE_PROBE`];
  return explicitProbe === "1" || runtimeProcessIsIdle(runtime);
};

const inputsFor = async (
  runtimes: readonly InstallableRuntime[],
  dryRunValue: boolean,
  expectedPreimages?: ReadonlyMap<InstallableRuntime, string>,
): Promise<readonly HookInstallInput[]> =>
  Promise.all(
    runtimes.map(async (runtime) => {
      const expected = expectedPreimages?.get(runtime);
      return {
        dryRun: dryRunValue,
        ...(expected === undefined ? {} : { expectedPreimageHash: expected }),
        fragmentRef: await fragmentFor(runtime, !dryRunValue),
        idle: idleFor(runtime),
        manifestPath: manifestPathFor(runtime),
        runtime,
        targetPath: targetPathFor(runtime),
      } satisfies HookInstallInput;
    }),
  );

const selectedRuntimes = (value: RuntimeSelection): readonly InstallableRuntime[] =>
  value === "all" ? allRuntimes : [value];

const withInstallerLock = async <T>(effect: () => Promise<T>): Promise<T> => {
  const lockPath = path.join(installRoot, ".lock");
  await mkdir(installRoot, { recursive: true, mode: 0o700 });
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("installer-already-running");
    }
    throw error;
  }
  try {
    return await effect();
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
};

const printSelection = (selectedRuntime: RuntimeSelection, receipts: readonly unknown[]) =>
  selectedRuntime === "all"
    ? json({ action, receipts, runtime: "all", schemaVersion: 1 })
    : json(receipts[0]);

const runHooks = async () => {
  if (action === undefined || selection === undefined) throw new Error("invalid hook action");
  const runtimes = selectedRuntimes(selection);
  if (action === "doctor") {
    const receipts = await Promise.all(
      runtimes.map((runtime) => doctorHookFragment(manifestPathFor(runtime), runtime)),
    );
    printSelection(selection, receipts);
    return;
  }

  if (runtimes.some((runtime) => !idleFor(runtime))) {
    throw new Error(
      selection === "all"
        ? "runtime-not-idle:all"
        : `runtime-not-idle:${runtimes.find((runtime) => !idleFor(runtime))}`,
    );
  }

  if (action === "install") {
    await withInstallerLock(async () => {
      const previewInputs = await inputsFor(runtimes, true);
      const preview = await installHookFragments(previewInputs);
      if (dryRun) {
        printSelection(selection, preview);
        return;
      }
      const expectedPreimages = new Map(
        preview.map((receipt) => [receipt.runtime, receipt.preimageHash] as const),
      );
      const installInputs = await inputsFor(runtimes, false, expectedPreimages);
      const receipts = await installHookFragments(installInputs);
      printSelection(selection, receipts);
    });
    return;
  }

  if (dryRun) throw new Error("--dry-run-is-only-valid-for-install");
  await withInstallerLock(async () => {
    const receipts = await uninstallHookFragments(runtimes.map(manifestPathFor));
    printSelection(selection, receipts);
  });
};

const runCollector = async () => {
  const modulePath = process.env.JOELCLAW_FLOWING_MEMORY_ADMISSION_MODULE;
  if (modulePath === undefined) {
    throw new Error("collector-admission-module-required");
  }
  const loaded = (await import(pathToFileURL(modulePath).href)) as {
    readonly admission?: unknown;
    readonly default?: unknown;
  };
  const admission = loaded.admission ?? loaded.default;
  if (
    typeof admission !== "object" ||
    admission === null ||
    !("admit" in admission) ||
    typeof admission.admit !== "function"
  ) {
    throw new Error("collector-admission-module-invalid");
  }
  const homeRoot = path.join(home, ".joelclaw", "flowing-memory");
  const service = await startNativeCollectorService({
    admission: admission as NativeAdmissionPort,
    spoolPath:
      process.env.JOELCLAW_FLOWING_MEMORY_WAKE_SPOOL ?? path.join(homeRoot, "native-wakes.jsonl"),
    statePath: path.join(homeRoot, "collector-state.json"),
    ...(process.env.JOELCLAW_FLOWING_MEMORY_STREAM_ROOT === undefined
      ? {}
      : { streamRoot: process.env.JOELCLAW_FLOWING_MEMORY_STREAM_ROOT }),
    activeSourceScan: () =>
      scanNativeSources({
        activeWindowMs: Number(
          process.env.JOELCLAW_FLOWING_MEMORY_ACTIVE_SOURCE_WINDOW_MS ?? 5 * 60_000,
        ),
      }),
    verifySource: true,
    socketPath:
      process.env.JOELCLAW_FLOWING_MEMORY_COLLECTOR_SOCKET ?? path.join(homeRoot, "collector.sock"),
  });
  await new Promise<void>((resolve) => {
    const stop = () => {
      void service.stop().finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
};

interface OpenCodeCommandOptions {
  readonly apply: boolean;
  readonly confirmed: boolean;
  readonly databasePath: string;
  readonly maxSessions?: number;
}

const openCodeCommandOptions = (): OpenCodeCommandOptions => {
  let apply = false;
  let confirmed = false;
  let databasePath: string | undefined;
  let jsonSeen = false;
  let maxSessions: number | undefined;
  for (let index = 2; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--json" && !jsonSeen) {
      jsonSeen = true;
      continue;
    }
    if (argument === "--apply" && !apply) {
      apply = true;
      continue;
    }
    if (argument === "--yes" && !confirmed) {
      confirmed = true;
      continue;
    }
    if (argument === "--database" && databasePath === undefined) {
      const candidate = arguments_[index + 1];
      if (candidate === undefined || candidate.startsWith("--")) {
        throw new Error("invalid-command");
      }
      databasePath = candidate;
      index += 1;
      continue;
    }
    if (argument === "--max-sessions" && maxSessions === undefined) {
      const candidate = arguments_[index + 1];
      if (candidate === undefined || candidate.startsWith("--")) {
        throw new Error("invalid-command");
      }
      maxSessions = Number(candidate);
      index += 1;
      continue;
    }
    throw new Error("invalid-command");
  }
  if (confirmed && !apply) throw new Error("invalid-command");
  return {
    apply,
    confirmed,
    databasePath: databasePath ?? defaultOpenCodeDatabasePath(),
    ...(maxSessions === undefined ? {} : { maxSessions }),
  };
};

const openCodeCommandErrorReceipt = (error: unknown) => {
  if (error instanceof OpenCodeGlobalStopError) {
    return { code: error.code, receiptVersion: 1 };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string" &&
    error._tag.startsWith("OpenCode") &&
    "phase" in error
  ) {
    return openCodeCliErrorReceipt(error);
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z0-9-]{1,80}$/u.test(error.code)
  ) {
    return { code: error.code, receiptVersion: 1 };
  }
  return openCodeCliErrorReceipt(error);
};

const runOpenCodeCommand = async () => {
  let live: ReturnType<typeof makeLiveOpenCodeAuthority> | undefined;
  try {
    const command = arguments_[1];
    if (command === "dry-run") {
      const options = openCodeCommandOptions();
      if (options.apply || options.confirmed || options.maxSessions !== undefined) {
        throw new Error("invalid-command");
      }
      json(openCodeDryRunReceipt(readOpenCodeSource(options.databasePath)));
      return;
    }
    if (command !== "reconcile" && command !== "backfill") {
      throw new Error("invalid-command");
    }
    const options = openCodeCommandOptions();
    if (options.maxSessions === undefined) throw new Error("invalid-command");
    const snapshot = readOpenCodeSource(options.databasePath);
    live = makeLiveOpenCodeAuthority();
    const writer = makeTrustedAdmissionWriter({
      evidenceDirectory:
        process.env.JOELCLAW_MEMORY_EVIDENCE_DIRECTORY ??
        path.join(home, ".joelclaw", "flowing-memory", "evidence"),
      ledger: live.authority,
    });
    const receipt = await reconcileOpenCodeSnapshot(
      snapshot,
      {
        apply: options.apply,
        confirmed: options.confirmed,
        maxSessions: options.maxSessions,
      },
      {
        authority: live.authority,
        resolveConfig: (stream, source) =>
          resolveTrustedAdmissionSourceConfig({
            adapterInstanceIdHash: source.adapterInstanceIdentityHash,
            cwd: stream.sourceDirectory,
            historicalWorkstream: "default",
          }),
        writer,
      },
    );
    json(receipt);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(openCodeCommandErrorReceipt(error))}\n`);
    process.exitCode = 1;
  } finally {
    await live?.dispose();
  }
};

const runWake = async () => {
  const runtime = valueAfter("--runtime");
  if (runtime === undefined || !runtimeNames.has(runtime)) return;
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) return;
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  const decoded =
    runtime === "grok"
      ? await decodeGrokEvent(input, { captureInferenceSession: true })
      : decodeNativeEvent(runtime as Exclude<NativeRuntime, "grok">, input, {
          captureInferenceSession: true,
        });
  if (decoded._tag !== "Accepted") return;
  const spoolPath =
    process.env.JOELCLAW_FLOWING_MEMORY_WAKE_SPOOL ??
    path.join(home, ".joelclaw", "flowing-memory", "native-wakes.jsonl");
  await appendNativeWake(spoolPath, decoded.wake);
};

if (arguments_[0] === "opencode") {
  await runOpenCodeCommand();
} else if (arguments_[0] === "collector") {
  await runCollector();
} else if (arguments_[0] === "wake") {
  try {
    await runWake();
  } catch {
    // Hook capture is fail-open. The collector remains the retry boundary.
  }
} else {
  if (
    (action !== "doctor" && action !== "install" && action !== "uninstall") ||
    runtimeValue === undefined
  ) {
    throw new Error(
      "usage: flowing-memory-host hooks <install|doctor|uninstall> --runtime <pi|claude|codex|cursor|grok|all> [--dry-run] --json",
    );
  }
  await runHooks();
}
