import { describe, expect, test } from "bun:test";

import {
  buildBootMicroVmRequests,
  buildRestoreMicroVmRequests,
  DEFAULT_MICROVM_MEM_SIZE_MIB,
  DEFAULT_MICROVM_ROOT,
  DEFAULT_MICROVM_VCPU_COUNT,
  resolveMicroVmSnapshotPaths,
  resolveMicroVmSocketPath,
  validateMicroVmConfig,
} from "../src/index.js";

describe("microVM Firecracker helpers", () => {
  test("validateMicroVmConfig applies defaults for cold boot", () => {
    const validated = validateMicroVmConfig({
      sandboxId: "sandbox-123",
      kernelPath: "/tmp/firecracker-test/vmlinux",
      rootfsPath: "/tmp/firecracker-test/agent-rootfs.ext4",
    });

    expect(validated.sandboxId).toBe("sandbox-123");
    expect(validated.vcpuCount).toBe(DEFAULT_MICROVM_VCPU_COUNT);
    expect(validated.memSizeMib).toBe(DEFAULT_MICROVM_MEM_SIZE_MIB);
    expect(validated.socketPath.startsWith(DEFAULT_MICROVM_ROOT)).toBe(true);
  });

  test("validateMicroVmConfig rejects restore config without snapshotDir", () => {
    expect(() =>
      validateMicroVmConfig(
        {
          sandboxId: "sandbox-restore",
          kernelPath: "/tmp/firecracker-test/vmlinux",
          rootfsPath: "/tmp/firecracker-test/agent-rootfs.ext4",
        },
        { mode: "restore" },
      ),
    ).toThrow("snapshotDir is required");
  });

  test("validateMicroVmConfig rejects invalid CPU and memory values", () => {
    expect(() =>
      validateMicroVmConfig({
        sandboxId: "sandbox-invalid-cpu",
        kernelPath: "/tmp/firecracker-test/vmlinux",
        rootfsPath: "/tmp/firecracker-test/agent-rootfs.ext4",
        vcpuCount: 0,
      }),
    ).toThrow("vcpuCount must be a positive integer");

    expect(() =>
      validateMicroVmConfig({
        sandboxId: "sandbox-invalid-mem",
        kernelPath: "/tmp/firecracker-test/vmlinux",
        rootfsPath: "/tmp/firecracker-test/agent-rootfs.ext4",
        memSizeMib: -1,
      }),
    ).toThrow("memSizeMib must be a positive integer");
  });

  test("resolveMicroVmSocketPath is deterministic and keeps paths compact", () => {
    const first = resolveMicroVmSocketPath({ sandboxId: "WL_20260316_story_firecracker" });
    const second = resolveMicroVmSocketPath({ sandboxId: "WL_20260316_story_firecracker" });

    expect(first).toBe(second);
    expect(first.startsWith(DEFAULT_MICROVM_ROOT)).toBe(true);
    expect(first.endsWith(".sock")).toBe(true);
    expect(first.length).toBeLessThan(108);
  });

  test("resolveMicroVmSocketPath respects explicit socket paths", () => {
    expect(
      resolveMicroVmSocketPath({
        sandboxId: "sandbox-explicit",
        socketPath: "/tmp/custom-firecracker.sock",
      }),
    ).toBe("/tmp/custom-firecracker.sock");
  });

  test("buildBootMicroVmRequests includes rootfs, workspace, machine config, and start action", () => {
    const requests = buildBootMicroVmRequests({
      sandboxId: "sandbox-boot",
      kernelPath: "/tmp/firecracker-test/vmlinux",
      rootfsPath: "/tmp/firecracker-test/agent-rootfs.ext4",
      workspacePath: "/tmp/firecracker-test/workspaces/sandbox-boot",
      vcpuCount: 4,
      memSizeMib: 1024,
    });

    expect(requests).toHaveLength(5);
    expect(requests[0]).toEqual({
      method: "PUT",
      path: "/boot-source",
      body: {
        kernel_image_path: "/tmp/firecracker-test/vmlinux",
        boot_args: expect.any(String),
      },
    });
    expect(requests[1]).toEqual({
      method: "PUT",
      path: "/drives/rootfs",
      body: {
        drive_id: "rootfs",
        path_on_host: "/tmp/firecracker-test/agent-rootfs.ext4",
        is_root_device: true,
        is_read_only: false,
      },
    });
    expect(requests[2]).toEqual({
      method: "PUT",
      path: "/drives/workspace",
      body: {
        drive_id: "workspace",
        path_on_host: "/tmp/firecracker-test/workspaces/sandbox-boot",
        is_root_device: false,
        is_read_only: false,
      },
    });
    expect(requests[3]).toEqual({
      method: "PUT",
      path: "/machine-config",
      body: {
        vcpu_count: 4,
        mem_size_mib: 1024,
        smt: false,
      },
    });
    expect(requests[4]).toEqual({
      method: "PUT",
      path: "/actions",
      body: {
        action_type: "InstanceStart",
      },
    });
  });

  test("buildRestoreMicroVmRequests targets the canonical snapshot files", () => {
    const snapshotPaths = resolveMicroVmSnapshotPaths("/tmp/firecracker-test/snapshots");
    const requests = buildRestoreMicroVmRequests({
      sandboxId: "sandbox-restore",
      kernelPath: "/tmp/firecracker-test/vmlinux",
      rootfsPath: "/tmp/firecracker-test/agent-rootfs.ext4",
      snapshotDir: "/tmp/firecracker-test/snapshots",
    });

    expect(snapshotPaths).toEqual({
      snapPath: "/tmp/firecracker-test/snapshots/vm.snap",
      memPath: "/tmp/firecracker-test/snapshots/vm.mem",
    });
    expect(requests).toEqual([
      {
        method: "PUT",
        path: "/snapshot/load",
        body: {
          snapshot_path: "/tmp/firecracker-test/snapshots/vm.snap",
          mem_file_path: "/tmp/firecracker-test/snapshots/vm.mem",
          enable_diff_snapshots: false,
          resume_vm: true,
        },
      },
    ]);
  });
});
