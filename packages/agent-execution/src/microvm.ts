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

/**
 * One-shot microVM execution (Lambda model):
 *
 * 1. Create a workspace ext4 image
 * 2. Mount it on host, write protocol files (command.sh, request.json)
 * 3. Unmount on host
 * 4. Boot microVM with workspace image as /dev/vdb
 * 5. Guest-runner.sh auto-executes command, writes results, powers off
 * 6. Wait for VM process to exit
 * 7. Mount workspace on host, read result.json
 * 8. Clean up
 *
 * This avoids the dual-mount page cache problem — host and guest never
 * access the workspace image simultaneously.
 */
export async function execInMicroVm(
  _instance: MicroVmInstance | null,
  command: string,
  timeoutMs = DEFAULT_MICROVM_EXEC_TIMEOUT_MS,
  config?: MicroVmConfig,
): Promise<MicroVmExecResult> {
  if (!command.trim()) {
    throw new MicroVmError("command is required");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new MicroVmError("timeoutMs must be a positive number");
  }

  const sandboxId = config?.sandboxId ?? `exec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const kernelPath = config?.kernelPath?.trim() || "/tmp/firecracker-test/vmlinux";
  const rootfsPath = config?.rootfsPath?.trim() || "/tmp/firecracker-test/agent-rootfs.ext4";
  const vcpuCount = config?.vcpuCount ?? DEFAULT_MICROVM_VCPU_COUNT;
  const memSizeMib = config?.memSizeMib ?? DEFAULT_MICROVM_MEM_SIZE_MIB;

  const workDir = join(defaultMicroVmRoot(), `workspace-${sandboxId}`);
  const workspaceImage = join(workDir, "workspace.ext4");
  const mountDir = join(workDir, "mnt");

  await mkdir(workDir, { recursive: true });

  try {
    // 1. Create workspace ext4 image (64MB — enough for protocol files + output)
    await createWorkspaceImage(workspaceImage, 64);

    // 2. Mount on host, write protocol files
    await mkdir(mountDir, { recursive: true });
    await mountExt4(workspaceImage, mountDir);

    try {
      const protocolDir = join(mountDir, MICROVM_PROTOCOL_DIRNAME);
      await mkdir(protocolDir, { recursive: true });

      const request = {
        version: "2026-03-17",
        sandboxId,
        command,
        timeoutMs,
        createdAt: new Date().toISOString(),
      };

      await writeFile(
        join(protocolDir, "command.sh"),
        `#!/bin/sh\nset -eu\n${command.trim()}\n`,
        "utf8",
      );
      await writeFile(
        join(protocolDir, "request.json"),
        `${JSON.stringify(request, null, 2)}\n`,
        "utf8",
      );
    } finally {
      // 3. Unmount before boot — critical for one-shot model
      await unmountExt4(mountDir);
    }

    // 4. Boot VM with workspace as /dev/vdb
    const vmConfig: MicroVmConfig = {
      sandboxId,
      kernelPath,
      rootfsPath,
      vcpuCount,
      memSizeMib,
      workspacePath: workspaceImage,
    };
    const instance = await bootMicroVm(vmConfig);

    // 5. Wait for VM process to exit (guest-runner powers off after command)
    const tracked = getTrackedMicroVm(instance);
    if (tracked) {
      const exitCode = await Promise.race([
        tracked.child.exited,
        sleep(timeoutMs).then(() => {
          tracked.child.kill("SIGKILL");
          return -1;
        }),
      ]);
      trackedMicroVms.delete(instance.sandboxId);
      trackedMicroVmPids.delete(instance.pid);
      if (exitCode === -1) {
        return {
          exitCode: 124,
          stdout: "",
          stderr: `microVM timed out after ${timeoutMs}ms`,
        };
      }
    }

    // 6. Mount workspace again, read results
    await mountExt4(workspaceImage, mountDir);
    try {
      const resultPath = join(mountDir, MICROVM_PROTOCOL_DIRNAME, "result.json");
      const stdoutPath = join(mountDir, MICROVM_PROTOCOL_DIRNAME, "stdout.log");
      const stderrPath = join(mountDir, MICROVM_PROTOCOL_DIRNAME, "stderr.log");

      const result = await tryReadCommandResult(resultPath, stdoutPath, stderrPath);
      if (result) {
        return result;
      }

      // No result.json — VM exited without writing results
      const stdout = (await readOptionalText(stdoutPath)) ?? "";
      const stderr = (await readOptionalText(stderrPath)) ?? "";
      return {
        exitCode: 1,
        stdout,
        stderr: stderr || "microVM exited without writing result.json",
      };
    } finally {
      await unmountExt4(mountDir);
    }
  } finally {
    // 7. Clean up workspace
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    // Clean up socket
    const socketPath = resolveMicroVmSocketPath({ sandboxId });
    await unlink(socketPath).catch(() => {});
  }
}

/** Create a small ext4 image for the workspace protocol files. */
async function createWorkspaceImage(imagePath: string, sizeMB: number): Promise<void> {
  // Use dd + mkfs.ext4
  const dd = Bun.spawn(["dd", "if=/dev/zero", `of=${imagePath}`, "bs=1M", `count=${sizeMB}`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await dd.exited;

  const mkfs = Bun.spawn(["mkfs.ext4", "-F", "-q", "-L", "workspace", imagePath], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const mkfsExit = await mkfs.exited;
  if (mkfsExit !== 0) {
    const stderr = await new Response(mkfs.stderr).text();
    throw new MicroVmError(`mkfs.ext4 failed (exit ${mkfsExit}): ${stderr}`);
  }
}

/** Loop-mount an ext4 image. Requires privileges (the pod is privileged). */
async function mountExt4(imagePath: string, mountPoint: string): Promise<void> {
  await mkdir(mountPoint, { recursive: true });
  const proc = Bun.spawn(["mount", "-o", "loop", imagePath, mountPoint], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new MicroVmError(`mount failed (exit ${exitCode}): ${stderr}`);
  }
}

/** Unmount a loop-mounted filesystem. */
async function unmountExt4(mountPoint: string): Promise<void> {
  const proc = Bun.spawn(["umount", mountPoint], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    // Try lazy unmount as fallback
    const lazy = Bun.spawn(["umount", "-l", mountPoint], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await lazy.exited;
  }
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
