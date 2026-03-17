# Audit: Firecracker MicroVM Execution Path — Fresh Eyes Analysis

**Date**: 2026-03-17  
**Session**: StubbornFerret  
**ADR**: 0230  

## Executive Summary

**The infrastructure is real. The execution path is not wired end-to-end.**

Firecracker boots inside k8s pods. The microVM runner code exists. The dagWorker has a `microvm` handler case. But no DAG workload has ever actually executed agent work inside a Firecracker VM. All "dogfood" codegen ran via the `shell` handler — directly in the pod, no VM boundary.

## Layer-by-Layer Status

### Layer 1: Hardware Virtualization ✅ PROVEN

```
macOS M4 Pro → Colima VZ (nestedVirtualization: true) → /dev/kvm → Firecracker v1.15.0
```

- `/dev/kvm` is `crw-rw---- root 994` inside the running restate-worker pod
- `firecracker --version` returns `v1.15.0` inside the pod
- Nested virt is live on the Colima VM

**Evidence**: `kubectl exec restate-worker-6d4d6b4f46-h8s4v -- ls -la /dev/kvm` confirms CharDevice accessible.

### Layer 2: Guest Images ✅ PRESENT

```
/tmp/firecracker-test/vmlinux           — 16.3MB aarch64 kernel (6.1.155)
/tmp/firecracker-test/agent-rootfs.ext4 — 1GB Alpine + bun + node + git
```

- Stored on PVC `firecracker-images` (5Gi, Bound) — survives pod restarts
- Built via `infra/firecracker/Dockerfile.rootfs` + `build-rootfs.sh`
- **No snapshot exists** — warm snapshot was created during the session in `/tmp` on the Colima VM, but that's separate from the PVC. The PVC only has kernel + rootfs.

### Layer 3: MicroVM Runner (`packages/agent-execution/src/microvm.ts`) ✅ CODE EXISTS, ⚠️ UNTESTED IN PRODUCTION

993 lines. Full API: `bootMicroVm`, `restoreMicroVm`, `execInMicroVm`, `pauseMicroVm`, `snapshotMicroVm`, `destroyMicroVm`.

**Critical gap — `execInMicroVm` uses a file-based protocol that has no guest-side implementation:**

```
Host side (microvm.ts):
  1. Writes command.sh, request.json to workspacePath/.joelclaw-microvm/
  2. Writes run.signal to trigger execution
  3. Polls for result.json at 50ms intervals
  4. Reads stdout.log, stderr.log on completion

Guest side (rootfs):
  ??? — NOTHING polls for run.signal
  ??? — NOTHING executes command.sh
  ??? — NOTHING writes result.json
```

**The rootfs `inittab` starts a bash shell (`::respawn:-/bin/bash`), but there is no daemon, init script, or polling loop that watches for `.joelclaw-microvm/run.signal` and executes commands.**

This means `execInMicroVm()` will always timeout — the host writes the signal file, polls for result.json, and no guest process ever produces it.

### Layer 4: dagWorker `microvm` Handler ✅ CODE EXISTS, ⚠️ CALLS BROKEN EXEC

```typescript
case "microvm":
  return executeMicroVm(resolvedConfig, depEnv, handlerTimeoutMs);
```

`executeMicroVm()` in `dag-orchestrator.ts`:
1. Imports from `@joelclaw/agent-execution`
2. Generates a sandbox ID
3. Boots or restores a microVM
4. Calls `execInMicroVm(instance, command, timeoutMs)`
5. Destroys the VM
6. Returns output

**This code is structurally correct** but depends on Layer 3's broken exec protocol.

### Layer 5: Workload CLI → DAG Dispatch ✅ WORKS

`joelclaw workload plan --stages-from stages.json` produces valid DAG plans with `handler: "microvm"` nodes. Redis queue → Restate dagOrchestrator → dagWorker dispatch is proven with `shell` and `infer` handlers.

## What's Actually Missing

### Gap 1: Guest-Side Command Runner (CRITICAL)

The rootfs needs a daemon that:
1. Starts at boot (via `inittab` or systemd unit)
2. Mounts the workspace virtio-block device (currently no mount instruction)
3. Polls `.joelclaw-microvm/run.signal`
4. On signal: runs `command.sh`, captures stdout/stderr to log files, writes `result.json` with exit code
5. Loops back to polling

This is ~30-50 lines of shell script added to the rootfs init. Without it, `execInMicroVm` is dead code.

### Gap 2: Workspace Volume Mount Inside Guest

`bootMicroVm` mounts the workspace as virtio-block device `workspace` (appears as `/dev/vdb` in guest). But:
- The rootfs `inittab` does NOT mount `/dev/vdb` anywhere
- The guest has no `fstab` entry for it
- The command runner needs it mounted at a known path (e.g., `/workspace`)

### Gap 3: No Warm Snapshot on PVC

Session proved 9ms snapshot restore. But the snapshot was in the Colima VM's `/tmp`, not on the PVC. Current PVC has only kernel + rootfs. Without a snapshot, every microVM cold-boots (~2.1s instead of 9ms).

### Gap 4: Network Access Inside MicroVM

The rootfs has `iptables` and `iproute2` installed but:
- No TAP device configuration in the boot sequence
- No network bridge setup in the microVM runner
- Agent work (git clone, npm install, API calls) needs outbound network
- ADR-0230 Step 6 notes this but it's unimplemented

**For the shell handler workaround, this doesn't matter — the pod has full network. For true microVM isolation, this blocks real agent work.**

### Gap 5: No Integration Test Against Real Firecracker

`microvm.test.ts` tests validation, config, and request building — pure unit tests. No test boots a real Firecracker VM or calls `execInMicroVm` against a running instance. The session's manual `colima ssh` tests proved boot works, but there's no automated test.

## What "Truly Validated" Looks Like

To claim microVM DAG execution works end-to-end, you need:

### Minimum Viable Proof (could do today)

1. **Add guest-side runner** to rootfs init — 30 lines of shell
2. **Add `/dev/vdb` mount** to rootfs init
3. **Rebuild rootfs** (`build-rootfs.sh`)
4. **Copy to PVC** (kubectl cp)
5. **Send a DAG with `handler: "microvm"`** containing a trivial command
6. **Observe**: microVM boots, command executes, result.json written, dagWorker returns output, OTEL `dag.node.completed` emitted with `handler: microvm`

### Full Proof (needs more work)

7. **Snapshot on PVC** — boot once, snapshot, restore for 9ms starts
8. **Network bridge** — TAP device per VM, NAT for outbound
9. **pi agent inside microVM** — install pi in rootfs, mount auth, run real codegen
10. **Automated integration test** — `bun test` that boots a real VM and verifies exec
11. **ADR-0228 phase dispatched through microVM handler** — same work that ran via shell, now isolated

### The Honest Rubric

| Claim | Status |
|-------|--------|
| "Firecracker boots on Panda" | ✅ Proven |
| "MicroVMs boot inside k8s pods" | ✅ Proven |
| "9ms snapshot restore" | ✅ Proven (session demo, not PVC-persisted) |
| "DAG workloads execute in microVMs" | ❌ Never happened |
| "Agent code runs isolated in Firecracker" | ❌ Never happened |
| "microvm handler works end-to-end" | ❌ Will timeout — no guest runner |
| "Shell handler works in pod" | ✅ Proven, used for all real work |

## Recommended Sequence to Close the Gap

1. Write `infra/firecracker/guest-runner.sh` (inotifywait or poll loop)
2. Update `Dockerfile.rootfs` to include runner + workspace mount in init
3. Rebuild rootfs, copy to PVC
4. Create + persist warm snapshot on PVC
5. Run `joelclaw workload run` with `handler: "microvm"` — trivial echo test
6. Run with `handler: "microvm"` — real pi agent codegen
7. Add integration test to CI

Steps 1-5 are probably 2-3 hours of focused work. Steps 6-7 depend on network bridge.
