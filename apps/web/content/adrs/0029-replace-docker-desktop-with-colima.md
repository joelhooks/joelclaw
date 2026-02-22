---
title: "Replace Docker Desktop with Colima + Talos for container runtime"
status: shipped
date: 2026-02-17
deciders: Joel Hooks
consulted: pi (session 2026-02-17)
informed: All agents operating on this system
related:
  - "[ADR-0025 — k3s cluster architecture](0025-k3s-cluster-for-joelclaw-network.md)"
  - "[ADR-0023 — Docker sandbox for agent loops](0023-docker-sandbox-for-agent-loops.md)"
---

# ADR-0029: Replace Docker Desktop + k3d with Colima + Talos

## Context and Problem Statement

`panda` (Mac Mini M4 Pro, 64 GB) runs 24/7 as a headless server managed via Tailscale SSH. The container runtime powers the k3d cluster (`joelclaw`), which runs Redis, Qdrant, and Inngest as Kubernetes StatefulSets.

Docker Desktop is currently the container runtime. It was never designed for this role — it's a developer desktop application being used as always-on server infrastructure. Every other service on this machine (worker, caddy, vault-sync, adr-sync) is CLI-managed via launchd. Docker Desktop is the odd one out: a GUI app pretending to be infrastructure.

### What hurts

- **Unreliable under long uptime.** Docker Desktop is known for engine hangs, socket disconnects, and needing GUI-initiated restarts. When it breaks on a headless server, the recovery path is awkward — SSH in and... open an app?
- **No CLI configuration.** CPU/memory allocation for the VM requires the GUI. VM parameters can't be set via config file or CLI flag.
- **Disruptive auto-updates.** Can restart the daemon mid-operation, killing running containers and the k3d cluster.
- **Heavy baseline.** 3–4 GB RAM idle for the Desktop app + VM, even with no containers running.
- **Opaque VM layer.** Can't inspect, tune, or debug the underlying VM. No `ssh` access to the runtime environment.
- **Operations mismatch.** Everything else on this machine is launchd + CLI. Docker Desktop breaks that model.

## Steelman: The Case for Keeping Docker Desktop

Before deciding, the strongest possible case for the status quo:

1. **It works today.** The k3d cluster was proven on Docker Desktop. k3d explicitly tests against it. Zero migration needed.
2. **Maximum compatibility.** Every tool, tutorial, and CI pipeline assumes Docker Desktop on Mac. Least likely to hit edge cases.
3. **Free for personal use.** No licensing cost at this scale.
4. **Integrated updates.** Handles its own engine version management.
5. **GUI has value at the keyboard.** When physically at the Mac Mini, provides quick visual container overview without terminal gymnastics.
6. **Apple Silicon native.** Uses Virtualization.framework (VZ) already since Docker Desktop 4.x. The raw performance gap vs Colima is narrower than it used to be.
7. **64 GB machine.** The RAM overhead (3–4 GB idle) is under 6% of total. It's wasteful, not crippling.
8. **Proven k3d combination.** The specific k3d cluster config — immutable ports, NodePort ranges, service naming — was debugged against Docker Desktop.

**Why switch anyway:** Docker Desktop is a desktop app optimized for developer laptops with sleep/wake cycles and a human at the keyboard. This machine is a 24/7 headless server. The reliability and operability concerns compound over time — every Docker Desktop hang on a headless server is a manual SSH + GUI recovery. Colima makes the container runtime match the operations model of everything else on this machine.

## Decision Drivers

- **Durability**: Runtime must survive weeks/months of uptime without manual intervention
- **CLI-native**: Must be fully manageable via SSH — no GUI dependency for any operation
- **launchd-compatible**: Must integrate with the existing launchd service management pattern
- **Docker socket**: Must provide a standard Docker socket (k3d, docker compose, agent sandboxes depend on it)
- **Apple Silicon performance**: Must use Virtualization.framework (VZ) for native M4 Pro performance
- **Low overhead**: Minimize idle resource consumption

## Considered Options

### Option 1: Keep Docker Desktop (status quo)

**Pros**: Works today, maximum compatibility, zero migration effort, k3d tested against it.

**Cons**: GUI dependency, no launchd integration, unreliable under long uptime, opaque VM, heavy idle footprint, disruptive auto-updates.

**Verdict**: Tolerable but architecturally wrong for a headless server.

### Option 2: Colima ← Recommended

Pure CLI container runtime built on Lima (Linux on Mac). Uses Apple Virtualization.framework for native Apple Silicon VMs.

**Pros**:
- Pure CLI — `colima start`, `colima stop`, `colima status`. Full SSH management.
- VZ framework native — same underlying tech as Docker Desktop, explicitly configurable.
- ~400 MB idle RAM vs Docker Desktop's 3–4 GB.
- `colima ssh` gives direct VM access for debugging.
- Explicit config: CPU, memory, disk set via CLI flags or `~/.colima/default/colima.yaml`.
- Docker runtime mode provides standard Docker socket — k3d works unchanged.
- Can run k3s directly (`colima start --kubernetes`) as an alternative to k3d.
- launchd plist for auto-start fits the existing operations model.
- Free, open source (MIT).
- brew-managed (`brew install colima`, currently v0.10.0).

**Cons**:
- No GUI (non-issue for headless server).
- Doesn't auto-start on login by default (solved with launchd plist).
- Smaller community than Docker Desktop — edge cases may be less documented.
- VM config requires `colima stop` + `colima start` to change (can't hot-resize).

### Option 3: OrbStack

macOS-native container runtime. Fastest benchmarks, excellent UX.

**Pros**: Extremely fast, low resource usage (~1 GB idle), Docker CLI compatible, built-in k8s support.

**Cons**: macOS GUI app at its core (background app, but still an app — not a pure daemon). $8/month for commercial use. Closed source. Less control over VM internals than Colima.

**Verdict**: Great developer tool, but still a "desktop app" — doesn't fully solve the headless server operations model problem.

### Option 4: Podman

Daemonless, rootless container engine.

**Pros**: No daemon, rootless by default, Docker CLI compatible via alias, free.

**Cons**: No native Kubernetes support (no k3d equivalent). `podman machine` on Mac is a VM — similar weight to Colima but without k8s integration. Docker Compose compatibility has gaps. Would require rethinking the entire k3d/k8s approach.

**Verdict**: Wrong tool — we need a Docker socket for k3d, and Podman's Mac story is weaker for this use case.

## Decision

**Replace the entire stack**: Docker Desktop + k3d/k3s → Colima + Talos.

- **Container runtime**: Colima with VZ framework (replaces Docker Desktop)
- **Kubernetes distro**: Talos v1.12.4 on Docker via `talosctl cluster create docker` (replaces k3d/k3s)
- **Storage**: local-path-provisioner (same as k3s used, but added explicitly since Talos doesn't bundle one)

Colima config:
```yaml
# ~/.colima/default/colima.yaml
cpu: 4
memory: 8
disk: 60
runtime: docker
vmType: vz
mountType: virtiofs  # fastest mount type for VZ
```

Talos cluster:
```bash
talosctl cluster create docker \
  --name joelclaw \
  --workers 0 \
  --memory-controlplanes 4GiB \
  -p 6379:6379/tcp,6333:6333/tcp,6334:6334/tcp,8288:8288/tcp,8289:8289/tcp \
  --config-patch-controlplanes @controlplane-patch.yaml
```

Control plane patch (`controlplane-patch.yaml`):
```yaml
cluster:
  allowSchedulingOnControlPlanes: true
  apiServer:
    extraArgs:
      service-node-port-range: "80-32767"
```

## Implementation Plan (As Executed 2026-02-17)

### Phase 1: Install Colima + talosctl

```bash
brew install colima                        # v0.10.0 + lima 2.0.3
brew install siderolabs/tap/talosctl       # v1.12.4
```

### Phase 2: Stop Docker Desktop, start Colima

```bash
osascript -e 'quit app "Docker Desktop"'
colima start --vm-type vz --mount-type virtiofs --cpu 4 --memory 8 --disk 60
docker context use colima
```

### Phase 3: Create Talos cluster

```bash
# Set DOCKER_HOST for talosctl (Colima socket isn't at /var/run/docker.sock)
export DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"

talosctl cluster create docker \
  --name joelclaw \
  --workers 0 \
  --memory-controlplanes 4GiB \
  -p 6379:6379/tcp,6333:6333/tcp,6334:6334/tcp,8288:8288/tcp,8289:8289/tcp \
  --config-patch-controlplanes @/tmp/talos-patch.yaml
```

talosctl auto-configures `~/.talos/config` and merges kubeconfig into `~/.kube/config`.

### Phase 4: Install storage provisioner

Talos doesn't bundle a storage provisioner (unlike k3s). Added local-path-provisioner:

```bash
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.30/deploy/local-path-storage.yaml
kubectl patch storageclass local-path -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

**Gotcha**: Talos enforces PodSecurity by default. local-path-provisioner's helper pods use hostPath volumes which violate the `baseline` policy. Fix:

```bash
kubectl label namespace joelclaw pod-security.kubernetes.io/enforce=privileged --overwrite
kubectl label namespace local-path-storage pod-security.kubernetes.io/enforce=privileged --overwrite
```

### Phase 5: Apply k8s manifests

```bash
kubectl apply -f ~/Code/joelhooks/joelclaw/k8s/namespace.yaml
kubectl apply -f ~/Code/joelhooks/joelclaw/k8s/secret.yaml
kubectl apply -f ~/Code/joelhooks/joelclaw/k8s/redis.yaml
kubectl apply -f ~/Code/joelhooks/joelclaw/k8s/qdrant.yaml
kubectl apply -f ~/Code/joelhooks/joelclaw/k8s/inngest.yaml
```

Same manifests as before — no changes needed. Service named `inngest-svc` (not `inngest`) to avoid `INNGEST_PORT` env var collision.

### Phase 6: Shell config + launchd

```bash
# ~/.zshrc
export DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"
```

Colima launchd plist at `~/Code/joelhooks/joelclaw/infra/launchd/com.joel.colima.plist`, installed to `~/Library/LaunchAgents/`.

Talos containers auto-restart when Colima starts (Docker restart policy).

### Phase 7: Remove Docker Desktop (pending 24-48h soak)

1. Stop Docker Desktop
2. `docker context rm desktop-linux`
3. Uninstall Docker Desktop app
4. `rm -rf ~/.docker/desktop/`
5. `slog write --action remove --tool docker-desktop --detail "replaced with colima+talos" --reason "ADR-0029"`

### Data considerations

- PV data from Docker Desktop era is gone (expected — Redis is cache, Qdrant regenerable)
- New PVs live in Colima's VM disk, persist across `colima stop`/`colima start`
- `colima delete` destroys VM and all PVs — avoid unless intentional
- Talos cluster state in `~/.talos/clusters/joelclaw/`

### Affected files

| Path | Change |
|------|--------|
| `~/Code/joelhooks/joelclaw/k8s/*.yaml` | No change — same manifests |
| `~/Code/joelhooks/joelclaw/infra/launchd/` | Added `com.joel.colima.plist` |
| `~/Library/LaunchAgents/` | Added colima plist |
| `~/.colima/default/colima.yaml` | Created by `colima start` |
| `~/.talos/config` | Talos cluster config (auto-generated) |
| `~/.talos/clusters/joelclaw/` | Cluster state directory |
| `~/.kube/config` | Merged Talos kubeconfig context |
| `~/.zshrc` | Added `DOCKER_HOST` for Colima socket |
| Docker context | Switched from `desktop-linux` to `colima` |

## Consequences

### Positive

- **Two layers replaced at once**: Docker Desktop → Colima, k3d/k3s → Talos. Cleaner stack.
- Container runtime matches the operations model — CLI + launchd like everything else
- ~400 MB idle (Colima) vs 3–4 GB (Docker Desktop) — frees ~3 GB RAM
- Full CLI configurability over SSH — no GUI needed for any operation
- `colima ssh` provides VM access for debugging — no more opaque runtime
- `talosctl dashboard` and `talosctl logs` for cluster-level observability
- Talos cluster config is declarative YAML — same manifests, same approach as bare metal Talos later
- launchd manages Colima lifecycle — consistent with worker, caddy, vault-sync
- **Path to bare metal**: When Pi 5 support lands, the Talos knowledge transfers directly. k8s manifests and operational muscle memory carry over.

### Negative

- One-time migration: k3d cluster and PV data lost (Redis is cache, Qdrant regenerable)
- Colima + Talos is a smaller community intersection — edge cases less documented
- VM resize requires stop/start cycle (not hot-resizable)
- Two more brew packages to track (colima, talosctl)
- Talos PodSecurity defaults are stricter — required namespace labeling for local-path-provisioner
- Talos doesn't bundle a storage provisioner — had to add local-path-provisioner manually

### Neutral

- Docker CLI and Docker Compose commands work identically on Colima
- Agent sandbox (ADR-0023) uses Docker socket — works unchanged
- k8s manifests unchanged — same NodePort services, same ports

## Risks

- **Colima VM corruption**: If the VM disk corrupts, the Talos cluster and all PV data are lost. Mitigation: manifests in git, cluster rebuild is mechanical (`talosctl cluster create docker` + `kubectl apply`).
- **Colima project health**: Smaller project than Docker Desktop. Mitigation: Colima is a thin wrapper around Lima (backed by multiple companies). Lima is the real dependency.
- **Talos-in-Docker edge cases**: `talosctl cluster create docker` is primarily a dev/test tool, not a production deployment method. Mitigation: acceptable for single-machine use; bare metal Talos is the production path (when Pi 5 support lands).
- **DOCKER_HOST dependency**: talosctl and other tools need `DOCKER_HOST` set to find Colima's socket (not at the default `/var/run/docker.sock`). Mitigation: set in `~/.zshrc`, documented in this ADR.

## Verification

- [x] `colima status` shows running with VZ VM type
- [x] `docker context ls` shows `colima` as active context
- [x] `docker info` shows Colima runtime
- [x] Talos cluster `joelclaw` created with correct port mappings (6379, 6333, 6334, 8288, 8289)
- [x] `kubectl get nodes` shows Talos v1.12.4 / k8s v1.35.0
- [x] `kubectl get pods -n joelclaw` shows redis, qdrant, inngest pods Running
- [x] `curl localhost:8288/` returns Inngest dashboard
- [x] `curl localhost:3111/` shows worker with 19 registered functions
- [x] Redis responds to PING on localhost:6379
- [x] `curl localhost:6333/healthz` returns healthy
- [x] Colima launchd plist installed and loaded
- [x] `DOCKER_HOST` set in `~/.zshrc`
- [x] `slog` entries written for install/configure actions
- [ ] System survives reboot: Colima starts → Talos container resumes → pods healthy → worker reconnects
- [ ] Docker Desktop uninstalled after 24–48 hour soak

## More Information

- Colima GitHub: https://github.com/abiosoft/colima
- Lima (underlying VM): https://github.com/lima-vm/lima
- Apple Virtualization.framework: https://developer.apple.com/documentation/virtualization
- k3d on non-Docker-Desktop runtimes: https://k3d.io/
- ADR-0025 spike results: k3d cluster overhead ~587 MB, services ~328 MB, total ~915 MB
- k3d gotcha: Service named `inngest` causes `INNGEST_PORT` env collision → use `inngest-svc`
