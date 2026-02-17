---
title: "Network architecture: start with what works, grow as needed"
status: proposed
date: 2026-02-17
deciders: Joel Hooks
consulted: Codex (session 2026-02-17)
informed: All agents operating on this system
related:
  - "[ADR-0004 — AT Protocol account architecture](0004-at-protocol-account-architecture.md)"
  - "[ADR-0002 — Personal assistant system architecture](0002-personal-assistant-system-architecture.md)"
  - "[ADR-0005 — Durable multi-agent coding loops](0005-durable-multi-agent-coding-loops.md)"
  - "[ADR-0006 — Observability: Prometheus + Grafana](0006-observability-prometheus-grafana.md)"
  - "[ADR-0010 — System loop gateway](0010-system-loop-gateway.md)"
  - "[ADR-0022 — Webhook-to-system-event pipeline](0022-webhook-to-system-event-pipeline.md)"
  - "[ADR-0023 — Docker sandbox for agent loops](0023-docker-sandbox-for-agent-loops.md)"
  - "[ADR-0024 — Taxonomy-enhanced session search](0024-taxonomy-enhanced-session-search.md)"
---

# ADR-0025: Network Architecture — Start with What Works, Grow as Needed

## Guiding Principle

This system is not a lab experiment. Joel's family is going to use it and rely on it. Every change must make things **more reliable**, not more interesting. Add complexity only when the current setup can't handle a real workload — not because the architecture diagram would look cooler with more boxes.

## What Exists Today (February 2026)

`panda` (Mac Mini) is the hub and current on-prem control point.

- `k3d` cluster `joelclaw` is running `k3s v1.33.6` on `panda`
- Docker Compose is decommissioned
- `Redis`, `Qdrant`, and `Inngest` run as Kubernetes StatefulSets
- k8s manifests are in `~/Code/joelhooks/joelclaw/k8s/`
- Current cluster + workload memory footprint is ~916 MB

Other machines on the Tailscale mesh still exist, but `clanker-001` is remote (not on-prem) and not a good control-plane candidate.

### Registered Inngest functions (14)

| Function | Trigger | Purpose |
|----------|---------|---------|
| video-download | event | yt-dlp → NAS pipeline |
| transcript-process | event | mlx-whisper transcription |
| content-summarize | event | LLM summary of transcripts |
| system-logger | event | Structured system logging |
| memory/observe-session | event | Session observation extraction |
| system/adr-sync | cron (hourly) + `system/adr.edited` | Sync ADRs to joelclaw.com |
| agent-loop-plan | event | PRD → story breakdown |
| agent-loop-test-writer | event | Write tests for a story |
| agent-loop-implement | event | Implement against tests |
| agent-loop-review | event | Review implementation |
| agent-loop-judge | event | Accept/reject review |
| agent-loop-complete | event | Finalize story |
| agent-loop-retro | event | Loop retrospective |
| content-sync | event | Sync updated content into downstream systems |

### What's version-controlled

- k8s manifests: `k8s/` ✅
- Inngest functions: `packages/system-bus/src/inngest/functions/` ✅
- Caddy config: **not version-controlled** ❌
- launchd plists: **not version-controlled** ❌
- worker start.sh: `packages/system-bus/start.sh` ✅
- pdf-brain on clanker-001: **not version-controlled, not documented** ❌

## What Actually Hurts

These are real problems, not hypothetical ones:

1. **Worker crashes are silent.** Last week the worker crashed because `bun install` wasn't run after a dependency change. launchd restarted it, but it kept crash-looping. Nobody knew until a function didn't run. We patched `start.sh` to self-heal (git pull + bun install before serve), but there's no alerting.

2. **No unified status view.** To know what's running: `docker ps` (3 containers), `launchctl list | grep joel` (4 plists), then SSH to clanker-001 to check pdf-brain. There's no `joelclaw status` command.

3. **Config is scattered.** Docker Compose YAML, launchd plists, Caddy config, `.env` files, `start.sh` — five formats in five locations. A change to one can break another with no obvious connection.

4. **clanker-001 is a mystery.** pdf-brain runs there. We can hit it over HTTP. We don't know: what manages it, how to restart it, what specs the machine has, whether it's healthy.

5. **No health checks.** None of the services expose health endpoints that an automated system checks. The Inngest dashboard shows function runs, but nothing monitors "is the worker process alive" or "is Qdrant accepting writes."

### What does NOT hurt (yet)

- **Resource pressure.** Cluster overhead is low (~916 MB total on a 64 GB machine).
- **Scale.** 14 functions and core services remain manageable.

## Decision

We already made the k3s move via k3d. It works for single-node and is now production for core services. The open decision is not "k3s or not"; it is "how to graduate from single-machine k3d to true multi-node when required."

The trigger for multi-node remains workload-based:

- **A second always-on machine with real workloads needs to join the network.**

## Phase 0: Make the Current Setup Reliable (now)

These were and are concrete reliability improvements around the current stack.

### 0.1 — `joelclaw status` CLI

A single command that shows everything running across the network:

```bash
$ joelclaw status

panda (Mac Mini M4 Pro, 64 GB)
  docker    inngest     ✅ healthy   :8288   177 MB
  docker    qdrant      ✅ healthy   :6333   331 MB
  docker    redis       ✅ healthy   :6379    21 MB
  launchd   worker      ✅ running   :3111   13 functions
  launchd   caddy       ✅ running   :443    TLS proxy
  launchd   vault-sync  ✅ running           FSEvents watcher
  launchd   adr-sync    ✅ running           WatchPaths watcher

clanker-001
  http      pdf-brain   ✅ healthy   :3847   700 docs

three-body (NAS, 64 TB)
  ssh       reachable   ✅           57 TB free

Resources: 2.1 GB / 64 GB RAM (3%)  •  15 GB / 926 GB disk (2%)
```

Implementation: Bun CLI in `~/Code/joelhooks/joelclaw/packages/cli/`. Checks Docker API, launchctl, HTTP health endpoints, SSH reachability. JSON output for agents, formatted for humans.
Current status: **not done**.

### 0.2 — Health check Inngest cron

A new Inngest function (`system/health-check`) on a 5-minute cron:

- Ping each Docker container's health endpoint
- Check `curl localhost:3111/` for worker function count
- Check `curl clanker-001:3847/` for pdf-brain status
- Check Tailscale node status via `tailscale status --json`
- On failure: log to system-log, emit `system/health.degraded` event
- Future: send push notification or Slack message on degraded status

Current status: **partially done**. Service health endpoints exist; unified scheduled health orchestration is still incomplete.

### 0.3 — Version-control all config

Move into the monorepo and track:

```
~/Code/joelhooks/joelclaw/
├── infra/
│   ├── launchd/
│   │   ├── com.joel.system-bus-worker.plist
│   │   ├── com.joel.caddy.plist
│   │   ├── com.joel.vault-log-sync.plist
│   │   └── com.joel.adr-sync-watcher.plist
│   ├── caddy/
│   │   └── Caddyfile
│   └── docker/
│       └── docker-compose.yml  (move from packages/system-bus/)
```

Add a `joelclaw infra apply` command that symlinks/copies config to the right places and restarts affected services. One command to go from repo state → running state.
Current status: **not done**.

### 0.4 — Audit clanker-001

SSH into clanker-001 and document:
- Hardware specs (CPU, RAM, disk)
- How pdf-brain is managed (systemd? screen? manual?)
- Set up a systemd service if it's running manually
- Add a health endpoint check to the health-check cron
- Document in `~/Vault/Resources/tools/clanker-001.md`
Current status: **not done**.

### Phase 0 verification

- [ ] `joelclaw status` shows all services across panda + clanker-001 + three-body
- [ ] Health check cron runs every 5 minutes, logs to system-log on failure
- [ ] All launchd plists and Caddy config tracked in `infra/` directory
- [ ] `joelclaw infra apply` deploys config and restarts services
- [ ] clanker-001 documented: specs, management, health endpoint
- [x] No regressions: all 14 Inngest functions still register and execute

## k3d Graduation (Open Decision)

`k3d` is a dead end for multi-node in this environment: it runs k3s inside Docker on one host and remote machines cannot join as real cluster nodes.

When the trigger fires (second always-on machine with real workloads), graduation options are:

| Option | Why choose it | Tradeoff |
|---|---|---|
| **OrbStack** | Lightweight VM, built-in k8s, API exposure is clean on macOS | New runtime/tooling to standardize |
| **Colima + k3s** | Lima VM approach with full control | More manual setup and ops burden |
| **microk8s via Multipass** | Familiar packaging and straightforward cluster model | ~4 GB VM overhead; known disk I/O issues on Apple Silicon |
| **On-prem Linux control plane** | Cleanest long-term architecture for multi-node k3s | Requires buying or repurposing on-prem Linux hardware |

`clanker-001` is remote, not on-prem, and should not be the control-plane host for this network.

## Phase 1: Multi-Node Expansion (When Workload Demands It)

**Trigger**: A second always-on machine with real workloads needs to join the network.

What changes at that point:

- Promote from single-machine `k3d` to a true multi-node k3s topology
- Keep `panda` as the hub for on-prem control-plane responsibilities
- Migrate or attach additional workloads as node roles become clear (compute, storage, specialized services)

### Phase 1 verification

- [ ] `kubectl get nodes` shows at least two always-on nodes
- [ ] Control-plane ownership and fail/recovery runbooks are documented
- [ ] Workloads requiring cross-machine scheduling run under one cluster view
- [ ] Health and alerting stay at least as strong as current single-node setup
- [ ] No regression in existing `panda` service reliability

### GPU box (when inference throughput is a bottleneck)

**Trigger**: Embedding pipeline or transcription is too slow on Apple Silicon. Or a workload needs CUDA-specific acceleration.

What we know about the hardware:
- 2× NVIDIA RTX PRO 4500 Blackwell (24 GB GDDR7 each = 48 GB VRAM total)
- Blackwell FP4 tensor cores, ~1600 TOPS combined
- Currently dormant, not on Tailscale

What joining looks like:
```bash
# On the GPU box:
curl -sfL https://get.k3s.io | K3S_URL=https://<control-plane>:6443 K3S_TOKEN=<token> sh -
kubectl apply -f https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/v0.17.0/deployments/static/nvidia-device-plugin.yml
```

One command to join. NVIDIA device plugin auto-detects the GPUs. k8s schedules GPU workloads there via `nvidia.com/gpu` resource requests.

**Complementary roles**: CUDA for throughput (models ≤48 GB at maximum speed), Apple Silicon for capacity (models >48 GB that need 128+ GB unified memory). Don't duplicate — route by workload type.

### three-body NAS (when storage access is a bottleneck)

**Trigger**: Pipelines need to read/write NAS data frequently enough that SSH/SCP is painful, and NFS mounts from k8s would simplify things.

Reality check: Intel Atom C3538, 8 GB RAM. k3s agent takes ~256 MB. It can serve NFS PersistentVolumes — label as `node-role=storage`, taint to prevent compute scheduling. But it's a weak machine. Don't ask it to do more than serve files.

If plain NFS mounts (without k8s) are sufficient, skip adding it as a node entirely. Don't add orchestration overhead to a NAS that works fine as a NAS.

### clanker-001 as k3s agent (when it needs managed workloads beyond pdf-brain)

**Trigger**: We want to schedule additional services on clanker-001, or pdf-brain needs the restart/health guarantees that k8s provides.

If pdf-brain is the only thing running there and it's stable, a systemd service (Phase 0.4) is enough. k3s agent is for when clanker-001 becomes a general-purpose worker node.

## Spike Results (2026-02-16)

Time-boxed investigation to validate Phase 1 feasibility on the current Mac Mini before committing.

### What we tested

- k3d v5.8.3 (k3s v1.33.6 inside Docker) — single server, no agents, traefik disabled
- Migrated all three Docker Compose services (Redis, Qdrant, Inngest) to k8s StatefulSets
- All three pods running and healthy with liveness/readiness probes

### Findings

| Metric | Docker Compose | k8s (inside k3d) | k3s overhead |
|--------|---------------|-------------------|--------------|
| Redis | 21 MB | 9 MB | — |
| Qdrant | 340 MB | 273 MB | — |
| Inngest | 175 MB | 46 MB | — |
| **Services total** | **536 MB** | **328 MB** | — |
| k3s control plane + LB | — | — | **~587 MB** |
| **Grand total** | **536 MB** | — | **~915 MB** |

k8s pods actually use less memory than Docker Compose equivalents (328 vs 536 MB). The overhead is the k3s control plane (~587 MB). Total ~915 MB — still under 2% of 64 GB.

### Gotcha: k8s service naming collision

A Service named `inngest` causes k8s to inject `INNGEST_PORT=tcp://10.43.x.x:8288` into all pods in the namespace. The Inngest binary tries to parse this as a port number → crash. **Fix**: name the Service `inngest-svc` to avoid the `INNGEST_` env prefix collision.

### Verdict

k3d works on this Mac Mini with negligible overhead. The migration path from Docker Compose is mechanical — same images, same health checks, StatefulSets with PVCs for persistence. The cluster is running alongside Docker Compose right now with both stacks operational.

**Decision at spike time: keep the cluster, cut over immediately.**

### Migration (same session)

After the spike validated feasibility, we completed the full migration:

1. Deleted spike cluster, recreated with host port mappings (`6379`, `6333`, `6334`, `8288`, `8289` on `server:0`)
2. Needed `--kube-apiserver-arg=service-node-port-range=80-32767` — k8s default NodePort range is 30000-32767
3. k3d cluster config is **immutable after creation** — ports, k3s args, everything. Plan before `cluster create`.
4. Deployed all three services as NodePort StatefulSets on the original ports
5. Worker (still on launchd) re-registered with Inngest — 14 functions confirmed
6. Smoke test: sent `content/updated` event, `content-sync` completed successfully
7. `docker compose down` — Docker Compose decommissioned

**Final state**: k3d cluster `joelclaw` is the production service layer. 916 MB total. Worker stays on launchd (needs host filesystem access for git, Vault, whisper). Manifests in `k8s/`.

## AT Protocol Connection (ADR-0004)

ADR-0004 defines AT Protocol account architecture and PDS concerns. This network decision intersects it directly:

- Kubernetes is **infrastructure federation**: where containers run and how workloads are scheduled across machines.
- AT Protocol is **data and identity federation**: who owns data, where identities resolve, and how agents communicate.
- The hub model (`panda` today, on-prem control plane in the future) can host both control planes together.
- PDS instances become Kubernetes workloads (pods + persistent volumes).
- Inngest bridges both worlds: subscribe to PDS firehose events, then schedule downstream compute via Kubernetes-backed services.
- NAS storage serves both domains: k8s PVC backing where appropriate and PDS data volumes for protocol state.

## What Stays Outside Any Cluster

Some things don't belong in an orchestrator:

- **pi sessions** — interactive TUI in a terminal
- **agent-secrets** — ephemeral daemon during pi sessions
- **Obsidian** — macOS app with iCloud sync
- **vault-log-sync** — macOS FSEvents API, launchd is the right tool
- **adr-sync-watcher** — macOS WatchPaths, same

## Impact on Other ADRs

| ADR | Phase 0 impact | Phase 1+ impact |
|---|---|---|
| ADR-0006 (observability) | Health check cron + `joelclaw status` | Prometheus + Grafana via Helm, automatic service discovery |
| ADR-0004 (AT Protocol) | No change to account model | PDS workloads run as k8s pods with persistent storage |
| ADR-0021 (memory system) | No change — runs on existing infra | Observer/Reflector can use local LLM on Studio |
| ADR-0024 (session search) | Embedding runs on Mini as-is | Can schedule embedding across both Macs |
| ADR-0005 (coding loops) | Docker sandbox continues | k8s Jobs with resource limits, schedule on Mini |
| ADR-0023 (Docker sandbox) | No change | k8s Jobs with namespace isolation |

## Decision Summary

1. **Now**: Keep running the current single-node k3d/k3s production cluster on `panda` and close remaining reliability gaps (`joelclaw status`, infra apply, clanker-001 audit).
2. **When trigger fires**: Graduate from k3d to a true multi-node approach once a second always-on machine with real workloads must join.
3. **As architecture matures**: Treat this as a dual-federation hub: Kubernetes for infrastructure placement, AT Protocol for data/identity federation.

Every node added is a machine to maintain, update, monitor, and debug. The family relies on this. Keep it as simple as the workload allows.
