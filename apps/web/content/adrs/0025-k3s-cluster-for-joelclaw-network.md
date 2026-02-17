---
title: "Network architecture: start with what works, grow as needed"
status: proposed
date: 2026-02-16
deciders: Joel Hooks
consulted: Claude (pi session 2026-02-16)
informed: All agents operating on this system
related:
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

One Mac Mini runs everything. It works. Here's the full picture:

```
panda (Mac Mini M4 Pro — 64 GB RAM, 14 CPU cores, 20 GPU cores, 839 GB free disk)
├── Docker Compose (docker-compose.yml in ~/Code/joelhooks/joelclaw/packages/system-bus/)
│   ├── inngest/inngest     (event bus + dashboard, :8288/:8289, ~177 MB RAM)
│   ├── qdrant/qdrant       (vector search, :6333/:6334, ~331 MB RAM)
│   └── redis:7-alpine      (state + cache, :6379, ~21 MB RAM)
│
├── launchd services (~/Library/LaunchAgents/)
│   ├── com.joel.system-bus-worker   (Bun → serve.ts, :3111, 13 Inngest functions)
│   ├── com.joel.caddy               (HTTPS proxy + TLS, :443/:3443/:6443/:8290)
│   ├── com.joel.vault-log-sync      (FSEvents watcher → system-log.jsonl → markdown)
│   └── com.joel.adr-sync-watcher    (WatchPaths → fires system/adr.edited event)
│
├── Always running
│   ├── Tailscale (mesh VPN, SSH access from any device)
│   ├── Docker Desktop (container runtime)
│   └── Obsidian (vault UI, iCloud sync)
│
├── On-demand
│   ├── pi sessions (primary agent interface)
│   ├── agent-secrets daemon (TTL-based secret leasing)
│   └── Docker sandbox (ephemeral per agent-loop, /tmp/agent-loop/)
│
└── Resource usage: ~2 GB RAM of 64 GB (3%), 15 GB disk of 926 GB (2%)
```

Other machines on the Tailscale mesh:

```
clanker-001 (Linux, 100.95.167.75)
└── pdf-brain-api :3847  (700 docs, 393k chunks, semantic + hybrid search)
    └── Managed by: unknown — no health checks, no alerting, no restart policy

three-body (NAS — Intel Atom C3538, 8 GB RAM, 64 TB disk, 57 TB free)
├── SSH accessible via Tailscale
├── Video archive (by year), book library
└── No containers, no services — pure storage

nightmare-router (Linux, 100.107.12.80)
└── Idle — offers Tailscale exit node, nothing else

dark-wizard, joels-macbook-pro-2 (Macs — intermittent/offline)
iphone-15-pro-max, iphone181 (iOS — mobile access)
```

A Linux GPU box exists (2× NVIDIA RTX PRO 4500 Blackwell, 48 GB VRAM total) but is **not on the network** — dormant, not identified on Tailscale.

### Registered Inngest functions (13)

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

### What's version-controlled

- Docker Compose: `packages/system-bus/docker-compose.yml` ✅
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

- **Resource pressure.** 3% RAM usage. No contention.
- **Cross-machine scheduling.** Only pdf-brain runs elsewhere, and it's stable.
- **Scale.** 13 functions, 3 containers, 4 plists. Manageable by hand.

## Decision

**Improve what exists before adding infrastructure.** The current setup is simple and mostly works. The problems are observability and configuration management — not orchestration. Fix those first. Consider k3s only when there's a real multi-machine scheduling need.

### Why not k3s right now

- Three Docker containers and four launchd services don't need an orchestrator.
- k3s on macOS means k3d (k3s-in-Docker-in-VM) — three layers of abstraction for a problem that doesn't exist yet.
- Every node added is operational surface area: certificates, networking, upgrades, debugging.
- The family relies on this. Adding k3s to a working system introduces a new failure mode with no immediate payoff.

### When k3s becomes the right call

- **Trigger 1**: A second Mac joins permanently (Mac Studio purchase). Two always-on Macs with services on both = real scheduling need.
- **Trigger 2**: Service count exceeds ~15 and cross-machine coordination is manual pain.
- **Trigger 3**: GPU box comes online and workloads need to route between CUDA and MLX.

Until one of those triggers fires, stay on Docker Compose + launchd and make it solid.

## Phase 0: Make the Current Setup Reliable (now)

These are concrete improvements to what exists. No new infrastructure, no new machines.

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

### 0.2 — Health check Inngest cron

A new Inngest function (`system/health-check`) on a 5-minute cron:

- Ping each Docker container's health endpoint
- Check `curl localhost:3111/` for worker function count
- Check `curl clanker-001:3847/` for pdf-brain status
- Check Tailscale node status via `tailscale status --json`
- On failure: log to system-log, emit `system/health.degraded` event
- Future: send push notification or Slack message on degraded status

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

### 0.4 — Audit clanker-001

SSH into clanker-001 and document:
- Hardware specs (CPU, RAM, disk)
- How pdf-brain is managed (systemd? screen? manual?)
- Set up a systemd service if it's running manually
- Add a health endpoint check to the health-check cron
- Document in `~/Vault/Resources/tools/clanker-001.md`

### Phase 0 verification

- [ ] `joelclaw status` shows all services across panda + clanker-001 + three-body
- [ ] Health check cron runs every 5 minutes, logs to system-log on failure
- [ ] All launchd plists and Caddy config tracked in `infra/` directory
- [ ] `joelclaw infra apply` deploys config and restarts services
- [ ] clanker-001 documented: specs, management, health endpoint
- [ ] No regressions: all 13 Inngest functions still register and execute

## Phase 1: Two-Mac Cluster (when Mac Studio arrives)

**Trigger**: Mac Studio M4 Max purchase (128 GB unified, 2 TB SSD, 10 Gb Ethernet, TB5).

The Studio becomes the primary machine. The Mini becomes a worker. This is when k3s earns its place — two always-on machines with services that need to be managed together.

### What changes

- Install k3s on the Studio (Linux via k3d, since macOS). Control plane + primary workloads.
- Install k3s agent on the Mini. Join over Tailscale or local network.
- Migrate Docker Compose services to k8s manifests: Inngest, Qdrant, Redis as StatefulSets/Deployments.
- Caddy becomes a k8s Ingress (Traefik built into k3s, or keep Caddy as Ingress controller).
- Worker becomes a k8s Deployment.
- Manifests live in `~/Code/joelhooks/joelclaw/k8s/`.
- launchd plists retired for anything that moves to k8s. vault-log-sync stays (macOS FSEvents).

### What the Studio unlocks

| Capability | Details |
|---|---|
| Local LLM inference | 128 GB runs 70B models (Q4 ~40 GB, Q6 ~55 GB) with room to spare |
| Fast local embedding | 40-core GPU via MLX — potentially 500-1000 chunks/sec |
| k3s headroom | Control plane ~512 MB = 0.4% of 128 GB |
| Concurrent workloads | LLM + Qdrant + Redis + Inngest + embedding + 60 GB free |
| NAS bandwidth | 10 Gb Ethernet to three-body for near-local storage speed |

### What the Mini becomes

Not retired — promoted to dedicated worker:
- Agent loop execution (coding loops run here, keep Studio free for inference)
- Embedding batch jobs, session indexing (ADR-0024)
- Secondary compute for overflow workloads
- 64 GB is still a powerful machine

### macOS + k3s reality

k3s is Linux-only. Options for running on Mac:

| Approach | Overhead | Notes |
|---|---|---|
| **k3d** (k3s in Docker) | ~512 MB + existing Docker | Lightest path, Docker Desktop already running |
| **OrbStack** | ~256 MB | Lightweight, ARM-native, good macOS integration |
| **Lima VM** | ~1 GB | Heavier, separate VM to manage |
| Control plane on clanker-001 | 0 on Mac | Macs are agents only — cleaner but brain on weaker machine |

k3d is the default choice. OrbStack worth evaluating if Docker Desktop's VM overhead bothers us.

### Networking considerations

k3s nodes over Tailscale = Flannel overlay inside WireGuard tunnel (double encapsulation). Works but adds latency and debugging layers. If both Macs are on the same local network, prefer direct connectivity with Tailscale as fallback.

Alternative: `--flannel-backend=none` + Tailscale k8s operator. Experimental but eliminates the double-encap.

### Phase 1 verification

- [ ] `kubectl get nodes` shows Studio + Mini
- [ ] All services from Phase 0 running as k8s workloads
- [ ] `kubectl get pods -A` = single view of everything
- [ ] Health checks via k8s liveness/readiness probes (replaces Phase 0 cron)
- [ ] Manifests in `k8s/` directory, version-controlled
- [ ] No downtime during migration — run parallel, cut over, decommission old

## Phase 2+: Add Nodes as Pressure Demands

Beyond Phase 1, detail decreases intentionally. Plans change when reality strikes. These are **options with known triggers**, not a roadmap.

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

### exo for distributed LLM inference (when single-machine memory isn't enough)

**Trigger**: 128 GB unified memory on the Studio can't fit the model you need.

[exo](https://github.com/exo-explore/exo) turns multiple Apple Silicon machines into a unified inference cluster — automatic discovery, RDMA over Thunderbolt 5, tensor parallelism, OpenAI-compatible API. Studio (128 GB) + Mini (64 GB) = 192 GB unified → Qwen3 235B (4-bit, ~135 GB) runs across both.

This is Phase 3+ at earliest. 128 GB handles Llama 70B and most frontier models comfortably. exo matters when 235B+ models become the standard, or when you want to run multiple large models simultaneously.

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

**Decision: keep the cluster, cut over immediately.**

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
| ADR-0021 (memory system) | No change — runs on existing infra | Observer/Reflector can use local LLM on Studio |
| ADR-0024 (session search) | Embedding runs on Mini as-is | Can schedule embedding across both Macs |
| ADR-0005 (coding loops) | Docker sandbox continues | k8s Jobs with resource limits, schedule on Mini |
| ADR-0023 (Docker sandbox) | No change | k8s Jobs with namespace isolation |

## Decision Summary

1. **Now**: Fix observability and config management on what exists. Build `joelclaw status`. Add health checks. Version-control all config. Audit clanker-001.
2. **When the Studio arrives**: Stand up k3s, migrate services, two-node cluster. Stop there.
3. **When pressure demands**: Add GPU box, NAS, or exo — one at a time, only when there's a concrete workload that justifies the operational surface area.

Every node added is a machine to maintain, update, monitor, and debug. The family relies on this. Keep it as simple as the workload allows.
