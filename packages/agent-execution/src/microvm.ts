import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface MicroVmConfig {
  sandboxId: string;
  kernelPath: string;
  rootfsPath: string;
  snapshotDir?: string;
  vcpuCount?: number;
  memSizeMib?: number;
  workspacePath?: string;
  socketPath?: string;
}

export interface MicroVmInstance {
  sandboxId: string;
  pid: number;
  socketPath: string;
  status: "running" | "paused" | "stopped";
}

export interface ValidatedMicroVmConfig extends MicroVmConfig {
  sandboxId: string;
  kernelPath: string;
  rootfsPath: string;
  snapshotDir?: string;
  vcpuCount: number;
  memSizeMib: number;
  workspacePath?: string;
  socketPath: string;
}

export interface FirecrackerRequest {
  method: "PUT" | "PATCH";
  path: string;
  body: Record<string, unknown>;
}

export interface MicroVmExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface SpawnedMicroVmProcess {
  pid: number;
  kill(signal?: string | number): unknown;
  exited: Promise<number>;
}

interface TrackedMicroVm {
  child: SpawnedMicroVmProcess;
  config: ValidatedMicroVmConfig;
  instance: MicroVmInstance;
}

interface UnixFetchRequestInit extends RequestInit {
  unix?: string;
}

interface MicroVmCommandResultFile extends Partial<MicroVmExecResult> {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export const DEFAULT_MICROVM_VCPU_COUNT = 2;
export const DEFAULT_MICROVM_MEM_SIZE_MIB = 512;
export const DEFAULT_MICROVM_ROOT = process.env.JOELCLAW_MICROVM_ROOT?.trim() || "/tmp/joelclaw/microvms";
export const DEFAULT_FIRECRACKER_BIN = process.env.FIRECRACKER_BIN?.trim() || "firecracker";
export const DEFAULT_MICROVM_BOOT_ARGS = "console=ttyS0 reboot=k panic=1 pci=off";
export const DEFAULT_MICROVM_API_TIMEOUT_MS = 5_000;
export const DEFAULT_MICROVM_EXEC_TIMEOUT_MS = 60_000;
export const MICROVM_POLL_INTERVAL_MS = 50;
export const MICROVM_PROTOCOL_DIRNAME = ".joelclaw-microvm";

const trackedMicroVms = new Map<string, TrackedMicroVm>();
const trackedMicroVmPids = new Map<number, TrackedMicroVm>();

export class MicroVmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MicroVmError";
  }
}

export function defaultMicroVmRoot(): string {
  return DEFAULT_MICROVM_ROOT;
}

export function resolveMicroVmSocketPath(
  config: Pick<MicroVmConfig, "sandboxId" | "socketPath">,
  rootDir = defaultMicroVmRoot(),
): string {
  if (config.socketPath?.trim()) {
    return config.socketPath.trim();
  }

  const hash = shortHash(config.sandboxId || "microvm").slice(0, 12);
  return join(rootDir, `fc-${hash}.sock`);
}

export function resolveMicroVmSnapshotPaths(snapshotDir: string): { snapPath: string; memPath: string } {
  return {
    snapPath: join(snapshotDir, "vm.snap"),
    memPath: join(snapshotDir, "vm.mem"),
  };
}

export function validateMicroVmConfig(
  config: MicroVmConfig,
  options: { mode?: "boot" | "restore" } = {},
): ValidatedMicroVmConfig {
  const mode = options.mode ?? "boot";
  const sandboxId = config.sandboxId?.trim();
  const kernelPath = config.kernelPath?.trim();
  const rootfsPath = config.rootfsPath?.trim();
  const snapshotDir = config.snapshotDir?.trim();
  const workspacePath = config.workspacePath?.trim();
  const vcpuCount = config.vcpuCount ?? DEFAULT_MICROVM_VCPU_COUNT;
  const memSizeMib = config.memSizeMib ?? DEFAULT_MICROVM_MEM_SIZE_MIB;

  if (!sandboxId) {
    throw new MicroVmError("sandboxId is required");
  }
  if (!kernelPath) {
    throw new MicroVmError("kernelPath is required");
  }
  if (!rootfsPath) {
    throw new MicroVmError("rootfsPath is required");
  }
  if (mode === "restore" && !snapshotDir) {
    throw new MicroVmError("snapshotDir is required when restoring a microVM");
  }
  if (!Number.isInteger(vcpuCount) || vcpuCount < 1) {
    throw new MicroVmError("vcpuCount must be a positive integer");
  }
  if (!Number.isInteger(memSizeMib) || memSizeMib < 1) {
    throw new MicroVmError("memSizeMib must be a positive integer");
  }
  if (config.socketPath !== undefined && !config.socketPath.trim()) {
    throw new MicroVmError("socketPath cannot be empty when provided");
  }
  if (config.workspacePath !== undefined && !workspacePath) {
    throw new MicroVmError("workspacePath cannot be empty when provided");
  }

  return {
    sandboxId,
    kernelPath,
    rootfsPath,
    snapshotDir,
    workspacePath,
    vcpuCount,
    memSizeMib,
    socketPath: resolveMicroVmSocketPath({ sandboxId, socketPath: config.socketPath }),
  };
}

export function buildBootMicroVmRequests(config: MicroVmConfig): FirecrackerRequest[] {
  const validated = validateMicroVmConfig(config, { mode: "boot" });
  const requests: FirecrackerRequest[] = [
    {
      method: "PUT",
      path: "/boot-source",
      body: {
        kernel_image_path: validated.kernelPath,
        boot_args: DEFAULT_MICROVM_BOOT_ARGS,
      },
    },
    {
      method: "PUT",
      path: "/drives/rootfs",
      body: {
        drive_id: "rootfs",
        path_on_host: validated.rootfsPath,
        is_root_device: true,
        is_read_only: false,
      },
    },
  ];

  if (validated.workspacePath) {
    requests.push({
      method: "PUT",
      path: "/drives/workspace",
      body: {
        drive_id: "workspace",
        path_on_host: validated.workspacePath,
        is_root_device: false,
        is_read_only: false,
      },
    });
  }

  requests.push(
    {
      method: "PUT",
      path: "/machine-config",
      body: {
        vcpu_count: validated.vcpuCount,
        mem_size_mib: validated.memSizeMib,
        smt: false,
      },
    },
    {
      method: "PUT",
      path: "/actions",
      body: {
        action_type: "InstanceStart",
      },
    },
  );

  return requests;
}

export function buildRestoreMicroVmRequests(config: MicroVmConfig): FirecrackerRequest[] {
  const validated = validateMicroVmConfig(config, { mode: "restore" });
  const snapshotPaths = resolveMicroVmSnapshotPaths(validated.snapshotDir!);

  return [
    {
      method: "PUT",
      path: "/snapshot/load",
      body: {
        snapshot_path: snapshotPaths.snapPath,
        mem_file_path: snapshotPaths.memPath,
        enable_diff_snapshots: false,
        resume_vm: true,
      },
    },
  ];
}

export async function bootMicroVm(config: MicroVmConfig): Promise<MicroVmInstance> {
  const validated = validateMicroVmConfig(config, { mode: "boot" });
  return startMicroVm(validated, buildBootMicroVmRequests(validated));
}

export async function restoreMicroVm(config: MicroVmConfig): Promise<MicroVmInstance> {
  const validated = validateMicroVmConfig(config, { mode: "restore" });
  return startMicroVm(validated, buildRestoreMicroVmRequests(validated));
}

export async function execInMicroVm(
  instance: MicroVmInstance,
  command: string,
  timeoutMs = DEFAULT_MICROVM_EXEC_TIMEOUT_MS,
): Promise<MicroVmExecResult> {
  const tracked = getTrackedMicroVm(instance);
  const workspacePath = tracked?.config.workspacePath?.trim();

  if (!workspacePath) {
    throw new MicroVmError(
      `microVM ${instance.sandboxId} does not have a workspacePath; execInMicroVm requires a host-visible workspace directory`,
    );
  }
  if (instance.status !== "running") {
    throw new MicroVmError(`microVM ${instance.sandboxId} is not running`);
  }
  if (!command.trim()) {
    throw new MicroVmError("command is required");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new MicroVmError("timeoutMs must be a positive number");
  }

  const protocolDir = join(workspacePath, MICROVM_PROTOCOL_DIRNAME);
  const commandPath = join(protocolDir, "command.sh");
  const requestPath = join(protocolDir, "request.json");
  const signalPath = join(protocolDir, "run.signal");
  const resultPath = join(protocolDir, "result.json");
  const stdoutPath = join(protocolDir, "stdout.log");
  const stderrPath = join(protocolDir, "stderr.log");

  await mkdir(protocolDir, { recursive: true });
  await Promise.all([
    rm(signalPath, { force: true }),
    rm(resultPath, { force: true }),
    rm(stdoutPath, { force: true }),
    rm(stderrPath, { force: true }),
  ]);

  const request = {
    version: "2026-03-16",
    sandboxId: instance.sandboxId,
    command,
    timeoutMs,
    createdAt: new Date().toISOString(),
    files: {
      command: "command.sh",
      stdout: "stdout.log",
      stderr: "stderr.log",
      result: "result.json",
      signal: "run.signal",
    },
  };

  await writeFile(commandPath, `#!/bin/sh\nset -eu\n${command.trim()}\n`, "utf8");
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  await writeFile(signalPath, `${Date.now()}\n`, "utf8");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const result = await tryReadCommandResult(resultPath, stdoutPath, stderrPath);
    if (result) {
      return result;
    }

    await sleep(MICROVM_POLL_INTERVAL_MS);
  }

  const stdout = (await readOptionalText(stdoutPath)) ?? "";
  const stderrBase = (await readOptionalText(stderrPath)) ?? "";
  await destroyMicroVm(instance).catch(() => {});

  return {
    exitCode: 124,
    stdout,
    stderr: [stderrBase, `microVM command timed out after ${timeoutMs}ms`].filter(Boolean).join("\n"),
  };
}

export async function pauseMicroVm(instance: MicroVmInstance): Promise<void> {
  await sendFirecrackerRequest(instance.socketPath, {
    method: "PATCH",
    path: "/vm",
    body: { state: "Paused" },
  });

  instance.status = "paused";
  const tracked = getTrackedMicroVm(instance);
  if (tracked) {
    tracked.instance.status = "paused";
  }
}

export async function snapshotMicroVm(
  instance: MicroVmInstance,
  snapshotDir: string,
): Promise<{ snapPath: string; memPath: string }> {
  const targetDir = snapshotDir?.trim();
  if (!targetDir) {
    throw new MicroVmError("snapshotDir is required");
  }

  await mkdir(targetDir, { recursive: true });
  const snapshotPaths = resolveMicroVmSnapshotPaths(targetDir);
  await sendFirecrackerRequest(instance.socketPath, {
    method: "PUT",
    path: "/snapshot/create",
    body: {
      snapshot_type: "Full",
      snapshot_path: snapshotPaths.snapPath,
      mem_file_path: snapshotPaths.memPath,
    },
  });

  return snapshotPaths;
}

export async function destroyMicroVm(instance: MicroVmInstance): Promise<void> {
  const tracked = getTrackedMicroVm(instance);

  if (tracked) {
    try {
      tracked.child.kill("SIGTERM");
      await waitForProcessExit(tracked.child, 2_000);
    } catch {
      try {
        tracked.child.kill("SIGKILL");
        await waitForProcessExit(tracked.child, 1_000);
      } catch {
        // Ignore teardown failures here; cleanup still runs.
      }
    } finally {
      trackedMicroVms.delete(instance.sandboxId);
      trackedMicroVmPids.delete(instance.pid);
    }
  } else {
    try {
      process.kill(instance.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") {
        throw error;
      }
    }
  }

  instance.status = "stopped";
  await unlink(instance.socketPath).catch(() => {});
}

async function startMicroVm(
  config: ValidatedMicroVmConfig,
  requests: FirecrackerRequest[],
): Promise<MicroVmInstance> {
  await mkdir(defaultMicroVmRoot(), { recursive: true });
  await unlink(config.socketPath).catch(() => {});

  const child = Bun.spawn([DEFAULT_FIRECRACKER_BIN, "--api-sock", config.socketPath], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }) as SpawnedMicroVmProcess;

  try {
    await waitForSocket(config.socketPath, DEFAULT_MICROVM_API_TIMEOUT_MS);
    for (const request of requests) {
      await sendFirecrackerRequest(config.socketPath, request);
    }
  } catch (error) {
    child.kill("SIGKILL");
    await unlink(config.socketPath).catch(() => {});
    throw error;
  }

  const instance: MicroVmInstance = {
    sandboxId: config.sandboxId,
    pid: child.pid,
    socketPath: config.socketPath,
    status: "running",
  };

  const tracked: TrackedMicroVm = {
    child,
    config,
    instance,
  };
  trackedMicroVms.set(instance.sandboxId, tracked);
  trackedMicroVmPids.set(instance.pid, tracked);

  return instance;
}

async function waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    try {
      await access(socketPath, constants.F_OK);
      return;
    } catch {
      await sleep(MICROVM_POLL_INTERVAL_MS);
    }
  }

  throw new MicroVmError(`timed out waiting for Firecracker API socket at ${socketPath}`);
}

async function sendFirecrackerRequest(socketPath: string, request: FirecrackerRequest): Promise<void> {
  const response = await fetch(`http://localhost${request.path}`, {
    method: request.method,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(request.body),
    unix: socketPath,
  } as UnixFetchRequestInit);

  if (!response.ok) {
    const errorText = (await response.text()).trim();
    throw new MicroVmError(
      `Firecracker API ${request.method} ${request.path} failed (${response.status}): ${errorText || response.statusText}`,
    );
  }
}

async function tryReadCommandResult(
  resultPath: string,
  stdoutPath: string,
  stderrPath: string,
): Promise<MicroVmExecResult | null> {
  const raw = await readOptionalText(resultPath);
  if (!raw) {
    return null;
  }

  let parsed: MicroVmCommandResultFile;
  try {
    parsed = JSON.parse(raw) as MicroVmCommandResultFile;
  } catch {
    return null;
  }

  return {
    exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : 0,
    stdout: parsed.stdout ?? (await readOptionalText(stdoutPath)) ?? "",
    stderr: parsed.stderr ?? (await readOptionalText(stderrPath)) ?? "",
  };
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function waitForProcessExit(processHandle: SpawnedMicroVmProcess, timeoutMs: number): Promise<void> {
  await Promise.race([
    processHandle.exited.then(() => undefined),
    sleep(timeoutMs).then(() => {
      throw new MicroVmError(`timed out waiting for firecracker pid=${processHandle.pid} to exit`);
    }),
  ]);
}

function getTrackedMicroVm(instance: MicroVmInstance): TrackedMicroVm | undefined {
  return trackedMicroVms.get(instance.sandboxId) ?? trackedMicroVmPids.get(instance.pid);
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
