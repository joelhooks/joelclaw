# Session TODO: Firecracker MicroVM End-to-End

Carried forward from session `b43fe359` (2026-03-16) + fresh-eyes audit session `StubbornFerret` (2026-03-17).

## From Previous Session

- [ ] **Move dag-dispatch + job-monitor extensions** from `pi-tools/` → `joelclaw/pi/extensions/`, update symlinks
- [ ] **Wire exec-in-microVM path** — dagWorker `microvm` handler exists but doesn't actually run agent work inside Firecracker VMs
- [ ] **Large file edit timeouts** — pi agent on 1495-line files can exceed Restate inactivity timeout (now 15m)
- [ ] **ADR-0229** (markdown-aware chunking) — proposed, not started
- [ ] **ADR-0232** (Vercel Workflow world-restate adapter) — proposed, not started
- [ ] **Wire worker heartbeat extension** into pi's extension loading inside k8s pod
- [ ] **Pre-cloned repo cache** in worker image — `cp -a /app/repo-cache` pattern built but needs verification across restarts

## From Fresh-Eyes Audit (StubbornFerret 2026-03-17)

### The Blocker: No Guest-Side Command Runner

`execInMicroVm()` writes commands to a shared filesystem and polls for results.
**Nothing inside the VM reads those commands or writes results.** The rootfs starts a bare bash shell. Until a guest-side runner exists, the microvm handler is dead code that will always timeout.

### Ordered Fix Sequence

1. [ ] **Write `guest-runner.sh`** — poll loop that watches `.joelclaw-microvm/run.signal`, executes `command.sh`, writes `result.json` + stdout/stderr logs (~30-50 lines)
2. [ ] **Add workspace mount to rootfs init** — `inittab` needs to mount `/dev/vdb` at `/workspace` so the shared filesystem is accessible
3. [ ] **Update `Dockerfile.rootfs`** — include guest-runner, workspace mount, auto-start on boot
4. [ ] **Rebuild rootfs** — `./infra/firecracker/build-rootfs.sh`, copy to PVC
5. [ ] **Create warm snapshot on PVC** — boot, verify tools, snapshot. Currently only exists in Colima VM `/tmp` (not persisted)
6. [ ] **Trivial microVM canary** — DAG with `handler: "microvm"`, `config.command: "echo hello"`. Must produce `result.json`, not timeout.
7. [ ] **Real agent work in microVM** — pi codegen dispatched via microvm handler (requires network bridge for API calls)
8. [ ] **Network bridge** — TAP device per VM + NAT for outbound. Blocks any work needing git/npm/API access.
9. [ ] **Integration test** — `bun test` that boots real Firecracker, runs exec protocol, verifies result
10. [ ] **Update ADR-0230 status** — frontmatter says "proposed" but session summary says "accepted"; reconcile once microVM exec is actually proven

### Other Audit Findings

- [ ] **Move dag-dispatch + job-monitor extensions** — currently in `pi-tools/`, should be `joelclaw/pi/extensions/`
- [ ] **ADR-0229** (markdown-aware chunking) — proposed, not started
- [ ] **ADR-0232** (Vercel Workflow world-restate adapter) — proposed, not started

## Analysis

Full audit: `AUDIT-firecracker-execution-path.md`

### What's Actually Proven vs Claimed

| Claim | Verdict |
|-------|---------|
| Firecracker boots on M4 Pro | ✅ |
| MicroVMs boot inside k8s pods | ✅ |
| 9ms snapshot restore | ✅ (demo only, not persisted) |
| DAG workloads execute in microVMs | ❌ Never happened |
| Agent code runs isolated in Firecracker | ❌ Never happened |
| Shell handler works in pod | ✅ All real work used this |
