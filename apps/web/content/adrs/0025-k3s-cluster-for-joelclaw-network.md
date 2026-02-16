---
title: Adopt k3s cluster to orchestrate the joelclaw network
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
  - "[ADR-0018 — Pi-native gateway with Redis event bridge](0018-pi-native-gateway-redis-event-bridge.md)"
  - "[ADR-0022 — Webhook-to-system-event pipeline](0022-webhook-to-system-event-pipeline.md)"
  - "[ADR-0023 — Docker sandbox for agent loops](0023-docker-sandbox-for-agent-loops.md)"
  - "[ADR-0024 — Taxonomy-enhanced session search](0024-taxonomy-enhanced-session-search.md)"
---

# ADR-0025: Adopt k3s Cluster to Orchestrate the joelclaw Network

## Context and Problem Statement

The joelclaw system has grown from "a Mac Mini with some Docker containers" to a multi-machine, multi-service architecture described across 24 ADRs. The services are managed by three unrelated mechanisms — Docker Compose, launchd plists, and manual SSH — with no unified view, no cross-machine scheduling, and no declarative infrastructure.

### Current infrastructure state

```
panda (Mac Mini M4 Pro — 64 GB RAM, 14 cores, 839 GB free)
├── Docker Compose
│   ├── inngest    (177 MB, 28% CPU — event bus + dashboard)
│   ├── qdrant     (331 MB, 0.1% CPU — vector search)
│   └── redis      (21 MB, 0.5% CPU — state + cache)
├── launchd
│   ├── caddy      (HTTPS proxy, TLS termination)
│   ├── system-bus-worker  (Bun — 12 Inngest functions)
│   └── vault-log-sync     (JSONL → markdown watcher)
├── Manual / ad-hoc
│   ├── pi sessions (primary agent interface)
│   ├── agent-secrets daemon
│   └── Docker sandbox (per-loop, ephemeral)
└── Total usage: ~2 GB RAM / 64 GB available (3%)

clanker-001 (Linux — specs unknown)
└── pdf-brain-api :3847  (700 docs, 393k chunks, embedding search)
    └── Managed by: unknown (systemd? manual?)

three-body (NAS — Intel Atom C3538, 8 GB RAM, 64 TB disk)
├── 57 TB free storage
├── No Docker, no containers
└── SSH accessible via Tailscale

Linux GPU Box (specs TBD — not yet on Tailscale?)
├── 2× NVIDIA RTX PRO 4500 Blackwell (24 GB GDDR7 each = 48 GB VRAM)
├── Blackwell architecture: FP4 tensor cores, ~1600 TOPS combined
└── Managed by: TBD

nightmare-router (Linux — exit node)
└── Idle

dark-wizard, triangle-2, joels-macbook-pro-2 (Macs — intermittent)
└── Offline
```

### What hurts today

1. **No unified service view.** `docker ps` shows 3 containers. `launchctl list | grep joel` shows 3 plists. pdf-brain on clanker-001 is invisible unless you SSH and check. There's no single command that shows "what's running across the joelclaw network."

2. **Worker crashes are silent.** The system-bus worker crashed because `bun install` wasn't run after a dependency change. We patched `start.sh` to self-heal, but the real problem is: launchd restarts the process, nobody is alerted, and the first sign of failure is "why didn't my Inngest function run?"

3. **Cross-machine work is manual.** pdf-brain runs on clanker-001 because someone put it there. Embedding 34k session chunks (ADR-0024) will need compute. There's no way to say "run this on whichever machine has capacity."

4. **Growing service count.** ADR-0024 adds 3 Inngest functions (session indexer, taxonomy sync, TTL cleanup). ADR-0006 adds Prometheus + Grafana. ADR-0022 adds webhook endpoints. ADR-0010 adds a system loop gateway. Each one is another service to start, monitor, and restart.

5. **Config drift.** Docker Compose YAML, launchd plists, Caddy config, `.env` files, `start.sh` scripts — infrastructure config is scattered across 5+ formats in 5+ locations. Changes aren't version-controlled as a unit.

6. **The 64 GB elephant.** The Mac Mini has 64 GB RAM and uses 3%. It's architecturally positioned as the hub (ADR-0002, ADR-0005), but it's running as if it were a Raspberry Pi.

### What k3s is

k3s is a lightweight, certified Kubernetes distribution designed for edge, IoT, and resource-constrained environments. It packages the Kubernetes API server, scheduler, controller, and etcd into a single ~70 MB binary. It supports ARM64 and x86_64, runs on Linux, and can form multi-node clusters over any network (including Tailscale).

Key properties:
- Single binary, ~70 MB, ~512 MB RAM footprint for the server
- Built-in: Traefik ingress, CoreDNS, local-path storage, Flannel CNI
- Supports Helm charts, standard Kubernetes manifests, CRDs
- `kubectl` compatible — same API as full Kubernetes
- Can run in Docker via **k3d** (k3s-in-Docker, no VM required)

## Decision Drivers

- **Unified orchestration**: One system to manage all services across all machines
- **Declarative infrastructure**: All service definitions as version-controlled YAML manifests
- **Cross-machine scheduling**: Workloads run where capacity exists, not where someone SSH'd
- **Health + restart**: Built-in liveness/readiness probes, automatic restart on failure
- **Observability foundation**: Kubernetes service discovery makes ADR-0006 (Prometheus) trivial
- **Operational simplicity**: Must not make the system harder to operate day-to-day
- **macOS reality**: k3s is Linux-only; the Mac Mini needs a compatibility strategy
- **Prototype stage**: This is a personal system, not a production cluster. Reversibility matters.

## Considered Options

### Option 1: k3d on Mac Mini as control plane + Linux nodes as agents

Run k3s inside Docker containers on the Mac Mini via **k3d** (no VM, no Lima, uses Docker Desktop's existing runtime). Mac Mini is the server node. clanker-001 and optionally three-body join as k3s agents over Tailscale.

```
panda (k3d server — k3s control plane in Docker)
├── k3s server (API, scheduler, etcd) — ~512 MB
├── Workloads: inngest, qdrant, redis, caddy, worker, prometheus, grafana
│   (same as today, now as Deployments/StatefulSets)
├── Agent loop Jobs (ephemeral, scheduled by k8s)
└── ADR-0024 pipeline (session indexer, taxonomy sync, TTL cron)
         │
         │ Tailscale (WireGuard mesh)
         │
clanker-001 (k3s agent)
├── pdf-brain (Deployment)
├── Embedding workers (can offload from panda)
└── Future: additional compute workloads
         │
three-body (k3s agent — storage-only node)
├── NFS/Longhorn persistent volumes (64 TB)
├── Labeled: node-role=storage
└── No compute workloads (Intel Atom, 8 GB RAM)
```

**Pros:**
- Mac Mini stays the brain — control plane + primary workloads
- k3d is the lightest path on macOS: no VM, uses existing Docker
- clanker-001 gets a real identity: it's a k3s agent, workloads are scheduled to it declaratively
- three-body becomes a persistent volume provider — NAS storage accessible as PVCs
- `kubectl get pods -A` = one command to see everything across all machines
- Health checks, auto-restart, rolling updates — all built in
- Helm charts for Prometheus, Grafana, Loki — one `helm install` replaces ADR-0006's manual Docker Compose
- Agent loop sandboxes (ADR-0023) could become k8s Jobs with resource limits
- All infrastructure as manifests in `~/Code/joelhooks/joelclaw/k8s/` — version controlled

**Cons:**
- k3d adds a Docker-in-Docker layer (k3s runs inside Docker containers, which run your containers)
- Networking: k3s uses Flannel CNI internally + Docker network externally + Tailscale for cross-machine. Three network layers.
- Three-body has an Intel Atom with 8 GB RAM — k3s agent alone takes ~256 MB, leaving little for workloads. Storage-only node is fine, but needs careful resource limits.
- Multi-arch: Mac Mini is ARM64, clanker-001 and three-body are x86_64. All images need multi-arch builds or architecture-specific scheduling.
- Operational surface area: etcd, certificates, RBAC, ingress controller, PV provisioner — each is a new thing to understand and debug.
- Current Docker Compose + launchd works. It's messy, but it works.

### Option 2: Docker Desktop Kubernetes (built-in)

Enable Kubernetes in Docker Desktop settings. Single-node cluster on the Mac Mini only. No cross-machine orchestration.

**Pros:**
- Zero install — toggle one setting in Docker Desktop
- kubectl already works (confirmed: v1.34.1 available)
- Single node avoids all cross-machine networking complexity
- Familiar Docker Desktop UX for debugging

**Cons:**
- Single node only — clanker-001 and three-body stay unmanaged
- Docker Desktop's k8s is full Kubernetes, not lightweight — heavier than k3s
- No cross-machine scheduling — doesn't solve the "distribute work" problem
- Docker Desktop Kubernetes has historically been buggy and slow to update

### Option 3: Stay with Docker Compose + launchd — improve what exists

Don't adopt Kubernetes. Instead:
- Add health check endpoints to all services
- Build a lightweight status CLI (`joelclaw status`) that queries all machines
- Use Inngest cron for monitoring (already have the event bus)
- Version-control all launchd plists and Docker Compose files together
- Add alerting via Inngest functions that check service health

**Pros:**
- Zero new infrastructure to learn, deploy, or maintain
- Docker Compose is simple, well-understood, and sufficient for 3 containers
- launchd is macOS-native, reliable, and transparent
- Avoids the "Kubernetes tax" (certificates, networking, storage, RBAC)
- Can always migrate to k3s later if scale demands it

**Cons:**
- Cross-machine orchestration remains manual SSH
- No declarative multi-machine infrastructure
- No workload scheduling — services run where they were manually placed
- Health checks are custom per service, not unified
- Doesn't address the "64 GB elephant" — no mechanism to utilize available capacity

### Option 4: Nomad (HashiCorp)

HashiCorp Nomad — simpler orchestrator than Kubernetes, supports Docker, exec, and raw_exec drivers. Single binary, multi-platform including macOS (native, no VM).

**Pros:**
- Runs natively on macOS — no Docker-in-Docker layer
- Simpler mental model than Kubernetes (jobs, tasks, groups vs. pods, deployments, services, ingress, PVC)
- Supports Docker and non-Docker workloads (raw_exec for Bun/Node processes)
- Multi-platform: ARM64 macOS + x86_64 Linux in same cluster, natively
- Lighter operational surface than Kubernetes

**Cons:**
- Smaller ecosystem — fewer Helm charts, operators, and community resources
- No built-in service mesh, ingress, or DNS (need Consul + Traefik separately)
- HashiCorp's BSL license change (2023) adds uncertainty
- Joel would be learning a niche tool vs. industry-standard Kubernetes
- Less transferable knowledge

## Discussion Points

### Is Kubernetes actually needed at this scale?

The honest answer: **probably not yet.** Three Docker containers and two launchd services don't need an orchestrator. The case for k3s is forward-looking:

- ADR-0024 adds 3+ new Inngest functions and an embedding pipeline
- ADR-0006 adds Prometheus + Grafana (2 more containers)
- ADR-0010 adds a system loop gateway (persistent process)
- ADR-0022 adds webhook consumers
- The pdf-brain on clanker-001 is already a second machine with no management

At 10-15 services across 2-3 machines, ad-hoc management starts to hurt. The question is whether to adopt k3s now (when it's easy to migrate) or later (when it's urgent and harder).

### The macOS problem

k3s is Linux-only. The options for the Mac Mini:

| Approach | Overhead | Complexity | Native feel |
|---|---|---|---|
| **k3d** (k3s in Docker) | ~512 MB + Docker | Medium | Docker Desktop already running |
| **Lima VM** | ~1 GB + VM overhead | High | Separate VM to manage |
| **Multipass VM** | ~1 GB + VM overhead | High | Canonical tooling |
| **OrbStack** | ~256 MB, optimized for Mac | Low | Lightweight, ARM-native |
| **Run control plane on clanker-001** | 0 on Mac | Medium | Mac is agent, not server |

k3d is the path of least resistance since Docker Desktop is already running. But it means k3s-in-Docker-in-VM (Docker Desktop itself runs a Linux VM). Three layers of abstraction.

**Alternative**: Make clanker-001 the k3s server (it's already Linux), and the Mac Mini joins as a worker. This is cleaner architecturally but means the brain runs on the less powerful machine. Though k3s server is lightweight — it could work if clanker-001 has enough RAM.

### The Tailscale networking question

k3s nodes need to communicate (API server, pod networking, service mesh). Over Tailscale, this means:

- k3s Flannel VXLAN overlay runs over Tailscale WireGuard tunnel
- Pod-to-pod traffic: double-encapsulated (Flannel → Tailscale)
- Service discovery: CoreDNS inside k3s, not Tailscale MagicDNS

This works but adds latency and debugging complexity. An alternative: use `--flannel-backend=none` and let Tailscale handle all networking (pods get Tailscale IPs directly). This is experimental but aligns with Tailscale's own k8s operator.

### What would migration look like?

Phase 0 (today): Docker Compose + launchd (status quo)

Phase 1: k3d on Mac Mini, migrate Docker Compose services to manifests
- Inngest, Qdrant, Redis become StatefulSets/Deployments
- Caddy becomes an Ingress
- Worker becomes a Deployment
- All manifests in `~/Code/joelhooks/joelclaw/k8s/`
- launchd plists retired (except vault-log-sync which is macOS-specific)
- **Validation**: `kubectl get pods` shows all services, `docker compose down` with no impact

Phase 2: Add clanker-001 as k3s agent
- Install k3s agent binary on clanker-001
- Join cluster over Tailscale
- Migrate pdf-brain to a k8s Deployment scheduled on clanker-001
- Schedule embedding workers on clanker-001 (offload from Mac Mini)
- **Validation**: `kubectl get nodes` shows 2 nodes, pdf-brain runs as a pod

Phase 3: Add three-body as storage node
- Install k3s agent on NAS (if Atom CPU can handle it)
- Label as `node-role=storage`, taint to prevent compute scheduling
- Expose NFS volumes as PersistentVolumes
- Video archive, book library accessible as PVCs from any pod
- **Validation**: `kubectl get pv` shows NAS volumes, pods can mount them

Phase 4: Observability (ADR-0006 realized)
- `helm install prometheus kube-prometheus-stack`
- Automatic service discovery for all k8s services
- Grafana dashboards accessible via Caddy/Tailscale
- **Validation**: Grafana shows metrics from all nodes and services

### Adding nodes is trivial in k3s

This is the core argument for k3s over ad-hoc management. Adding a new node to the cluster:

```bash
# On the new machine (Linux):
curl -sfL https://get.k3s.io | K3S_URL=https://mac-studio:6443 K3S_TOKEN=<token> sh -

# That's it. The node appears in:
kubectl get nodes
```

The GPU box, when activated, joins with one command. NVIDIA device plugin auto-detects the GPUs:

```bash
# On GPU box:
curl -sfL https://get.k3s.io | K3S_URL=https://mac-studio:6443 K3S_TOKEN=<token> sh -
kubectl apply -f https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/v0.17.0/deployments/static/nvidia-device-plugin.yml
```

Any future Mac, any Linux box, any device on the Tailscale mesh — one command to join. This is why k3s makes sense even before you need it: the marginal cost of adding capacity drops to near zero.

### What stays outside k3s?

Some things don't belong in a cluster:
- **pi sessions** — interactive TUI, runs in terminal, not a service
- **agent-secrets** — runs ephemerally during pi sessions
- **Obsidian** — macOS app, not a server process
- **vault-log-sync** — macOS-specific launchd watcher (FSEvents API)
- **Docker sandbox for loops** — k8s Jobs could replace these, but Docker sandbox is simpler for now

## Hardware Trajectory: Mac Studio M4 Max

A Mac Studio upgrade is under consideration:

| Spec | Mac Mini (current) | Mac Studio (planned) |
|---|---|---|
| Chip | M4 Pro (14-core CPU, 20-core GPU) | M4 Max (16-core CPU, 40-core GPU) |
| Neural Engine | 16-core | 16-core |
| RAM | 64 GB unified | **128 GB unified** |
| SSD | 1 TB (839 GB free) | **2 TB** |
| Ethernet | Gigabit | **10 Gb Ethernet** |
| Thunderbolt | 3× TB4 | **4× TB5** |
| Displays | 3 | 5 |
| Price | — | $4,099 |

### What 128 GB unified memory unlocks

1. **Local LLM inference.** 128 GB can run 70B parameter models (Q4 quantized = ~40 GB, Q6 = ~55 GB) entirely in unified memory with room to spare. Llama 3.3 70B, Qwen 2.5 72B, DeepSeek-V2-Lite — all viable locally. This eliminates API dependency for the Observer, Reflector, and system loop gateway (ADR-0010, ADR-0021).

2. **Local embedding at scale.** `nomic-embed-text-v1.5` already runs locally, but 128 GB means you can batch-embed the entire session corpus (34k+ chunks) without memory pressure. The 40-core GPU via MLX makes this fast — potentially 500-1000 chunks/sec vs ~100/sec on M4 Pro.

3. **k3s headroom is negligible.** k3s server takes ~512 MB. On 128 GB that's 0.4%. The "overhead concern" from the original assessment evaporates.

4. **Multiple concurrent agents.** 128 GB can simultaneously run: a local LLM (40-55 GB), Qdrant (1-4 GB for ADR-0024 vectors), Redis, Inngest, Prometheus, Grafana, embedding workers, and still have 60+ GB free for agent sandboxes.

5. **10 Gb Ethernet.** Real bandwidth for NAS storage mounts (three-body). PVC access to 64 TB of video/books at near-local speeds on the local network.

### The two-Mac cluster

The Mac Mini doesn't get retired — it becomes a **powerful worker node**:

```
Mac Studio M4 Max (NEW — control plane + primary compute)
├── k3s server (control plane)
├── 128 GB — local LLM inference (Observer, Reflector, system loop)
├── 40-core GPU — MLX embedding, whisper transcription
├── Primary workloads: Inngest, Qdrant, Redis, Prometheus, Grafana
├── Agent sandboxes (k8s Jobs with resource limits)
└── 10 Gb Ethernet → three-body NAS

Mac Mini M4 Pro (CURRENT → promoted to worker)
├── k3s agent
├── 64 GB — secondary compute + exo tensor parallel partner
├── Offload: embedding batch jobs, session indexing (ADR-0024)
├── Agent loop execution (ADR-0005 coding loops)
└── Thunderbolt 5 ↔ Mac Studio (RDMA for exo)

Linux GPU Box (2× NVIDIA RTX PRO 4500 Blackwell)
├── k3s agent + NVIDIA device plugin
├── 48 GB VRAM (24 GB × 2) — CUDA inference server
├── vLLM / TensorRT-LLM / SGLang for high-throughput serving
├── Hot path: embedding at GPU speed, 8B/70B models, batch inference
├── Blackwell FP4 tensor cores: ~1600 TOPS combined
└── Role: speed demon — what fits in 48 GB runs 2-3× faster than Apple Silicon

clanker-001 (Linux worker)
├── k3s agent
├── pdf-brain (existing)
├── Additional compute workloads
└── x86_64 — useful for images without ARM builds

three-body (NAS — storage node)
├── k3s agent (lightweight, storage-only)
├── NFS PersistentVolumes → 64 TB
├── Intel Atom — no compute, just serves storage
└── 10 Gb Ethernet ↔ Mac Studio (local network)
```

**Total cluster**: 192+ GB unified RAM, 48 GB VRAM, 30+ CPU cores, 60-core Apple GPU + dual Blackwell GPUs (~1600 FP4 TOPS), 64+ TB storage, across 5 nodes. For a personal system, this is absurd capacity — which is exactly the point. It means the system never has to think about resources, only about scheduling.

### The NVIDIA advantage: speed vs. capacity

The dual RTX PRO 4500s and the Apple Silicon serve complementary roles:

| Dimension | 2× RTX PRO 4500 (CUDA) | Mac Studio M4 Max (MLX) |
|---|---|---|
| **Memory** | 48 GB VRAM (hard limit) | 128 GB unified (shared with system) |
| **Bandwidth** | ~896 GB/s combined | ~546 GB/s |
| **Throughput** | ~1600 TOPS FP4 | ~200 TOPS equivalent |
| **Best for** | Models ≤48 GB at maximum speed | Models >48 GB that need capacity |
| **Ecosystem** | vLLM, TensorRT-LLM, SGLang, CUDA | MLX, exo, Apple-native |

**Optimal workload split:**

```
Linux GPU Box (speed path — 48 GB VRAM)
├── Embedding pipeline (ADR-0024): nomic-embed-text on CUDA = 5-10× faster than MLX
├── Observer LLM (ADR-0021): Llama 70B Q4 (~40 GB) at high tok/s
├── Batch inference: session indexing, concept tagging, metadata extraction
└── Whisper: faster-whisper on CUDA for video transcription (ADR video-ingest)

Mac Studio + Mac Mini (capacity path — 192 GB unified)
├── Frontier models via exo: Qwen3 235B, Kimi K2 — too large for 48 GB VRAM
├── Reflector LLM (ADR-0021): long-context reasoning over accumulated observations
├── System loop gateway (ADR-0010): complex SENSE→ORIENT→DECIDE with 235B model
└── Interactive inference: direct conversation with frontier local models
```

The Linux box becomes the **workhorse** — high-throughput, GPU-accelerated inference for pipeline workloads (embedding, observation extraction, transcription). The Apple cluster handles **frontier reasoning** — models that need 100+ GB of memory for long-context, complex tasks.

### k3s GPU scheduling

Kubernetes natively supports NVIDIA GPUs via the [NVIDIA device plugin](https://github.com/NVIDIA/k8s-device-plugin):

```yaml
# Example: embedding worker pod requesting a GPU
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: embedding-worker
    image: ghcr.io/joelhooks/embedding-worker:latest
    resources:
      limits:
        nvidia.com/gpu: 1  # request 1 of 2 GPUs
  nodeSelector:
    gpu: "rtx-4500"
```

This means k3s can schedule GPU workloads to the Linux box while keeping non-GPU services on the Macs. The scheduler respects resource limits — two GPU-hungry pods can each claim one of the two 4500s.

### Impact on existing ADRs

| ADR | Impact of Mac Studio + k3s |
|---|---|
| ADR-0005 (coding loops) | Agent loop sandboxes become k8s Jobs. Can schedule on Mini to keep Studio free for LLM inference. |
| ADR-0006 (observability) | Prometheus + Grafana via Helm. Service discovery automatic across all nodes. |
| ADR-0010 (system loop gateway) | Gateway runs as k8s Deployment with local LLM — no API cost for SENSE→ORIENT→DECIDE. |
| ADR-0021 (memory system) | Observer and Reflector use local LLM on Studio. No haiku-4.5 API dependency. |
| ADR-0023 (Docker sandbox) | k8s Jobs with namespace isolation replace Docker sandbox. Better resource limits + scheduling. |
| ADR-0024 (session search) | Embedding pipeline scheduled across Studio + Mini. Batch indexing at GPU speed. |

## Preliminary Assessment

The Mac Studio changes the answer from "maybe later" to "this is the natural architecture." With 128 GB unified memory, the Studio becomes a genuine AI compute hub — local LLMs, GPU embedding, and k3s control plane with negligible overhead. The Mac Mini transitions from "the machine" to "a node" without losing any capability.

**Recommended path**: Option 1 (k3d on Mac Studio as control plane) with the Mac Mini as first worker node. Migrate when the Studio arrives. The current Docker Compose services translate almost 1:1 to k8s manifests.

**If the Studio purchase is deferred**, Option 3 (improve existing Docker Compose + launchd) remains the pragmatic choice — the Mini alone doesn't have enough pressure to justify k3s overhead.

## Future: exo for Distributed LLM Inference

[exo](https://github.com/exo-explore/exo) turns multiple Apple Silicon machines into a unified AI cluster — automatic device discovery, RDMA over Thunderbolt 5, tensor parallelism, and an OpenAI-compatible API. It's the inference layer that sits on top of the k3s orchestration layer.

### Why exo matters for this cluster

The Mac Studio M4 Max has **Thunderbolt 5** ports. The Mac Mini M4 Pro also has **Thunderbolt 5**. Connected via a single TB5 cable, exo can split models across both machines with RDMA — 99% lower latency than network-based tensor parallel.

**192 GB unified memory (128 + 64) enables frontier models:**

| Model | Quant | RAM needed | Single Studio? | 2-Mac exo cluster? |
|---|---|---|---|---|
| Llama 3.3 70B | 8-bit | ~76 GB | ✅ | ✅ |
| MiniMax M2.1 | 3-bit | ~95 GB | ✅ tight | ✅ |
| Qwen3 235B | 4-bit | ~135 GB | ❌ | ✅ (57 GB free) |
| Kimi K2 Thinking | 4-bit | ~210 GB | ❌ | ✅ (tight) |
| DeepSeek V3.1 | 4-bit | ~385 GB | ❌ | ❌ (need more Macs) |

The sweet spot: **Qwen3 235B (4-bit)** — a genuinely frontier 235B parameter model running locally across two Macs. No API, no cost per token, no latency to a data center.

### Architecture with exo + CUDA

exo operates at a different layer than k3s. k3s orchestrates services (Inngest, Qdrant, Redis, pipelines). exo orchestrates inference (model loading, tensor sharding, request routing). The NVIDIA box can serve inference via vLLM/SGLang independently or join the exo cluster when CUDA support ships.

```
k3s cluster (service orchestration)
├── Deployments: inngest, qdrant, redis, prometheus, grafana, worker
├── Jobs: agent loops, embedding batches, taxonomy sync
├── CronJobs: TTL cleanup, session indexing
└── Services call inference APIs:
         │
         ├── http://gpu-box:8000/v1/...    (vLLM on CUDA — fast path)
         │     └── 70B models, embedding, transcription
         │
         └── http://localhost:52415/v1/...  (exo on Apple Silicon — capacity path)
               └── 235B models, frontier reasoning
         
exo cluster (Apple Silicon inference)
├── Mac Studio: 128 GB — primary node (TB5 RDMA)
├── Mac Mini: 64 GB — tensor parallel partner (TB5 RDMA)
└── 192 GB unified → Qwen3 235B, Kimi K2

CUDA inference (Linux GPU box)
├── vLLM / SGLang / TensorRT-LLM
├── 2× RTX PRO 4500: 48 GB VRAM, Blackwell tensor cores
├── Llama 70B Q4 at ~80+ tok/s (vs ~40-60 on MLX)
└── Future: joins exo cluster when CUDA backend ships
```

**Two inference APIs, one routing layer.** Pipeline workloads (Observer, embedding, transcription) hit the CUDA fast path. Interactive and frontier reasoning hits exo. A simple proxy or the system-bus worker routes based on model/task.

### Impact on ADR-0021 and ADR-0024

- **Observer LLM** (ADR-0021): Instead of calling haiku-4.5 API, calls `exo /v1/chat/completions` with a local 70B model. Zero API cost, zero latency to provider, full privacy.
- **Reflector LLM** (ADR-0021): Same — local inference for memory compression.
- **System loop gateway** (ADR-0010): SENSE→ORIENT→DECIDE→ACT powered by local 235B reasoning model. No token metering.
- **Embedding pipeline** (ADR-0024): exo doesn't handle embeddings (that's MLX/nomic directly), but freeing the GPU from API-dependent workloads means more capacity for batch embedding.

### exo implementation notes

- **Event-sourced architecture**: exo uses event sourcing internally with master election — resilient to device disconnection/reconnection.
- **Automatic discovery**: Devices running exo find each other via mDNS — same as Tailscale, but for the local TB5 network.
- **OpenAI-compatible API**: Drop-in replacement for any code calling OpenAI. Change the base URL to `http://localhost:52415` and it works.
- **macOS app**: Ships as `.dmg` — runs in background, menu bar icon.
- **Tier 1 support**: Mac Studio M3 Ultra, Mac Mini M4 Pro, MacBook Pro M4 Max/M5 — exactly the hardware in this cluster.
- **48 model cards** out of the box: Llama, Qwen, DeepSeek, Kimi, MiniMax, GLM, GPT-OSS, plus FLUX image models.

### Timeline

exo is a Phase 5+ addition — after k3s is running, after ADR-0024 search is operational, after the Mac Studio arrives. The dependency chain:

1. Mac Studio purchase → hardware foundation
2. k3s cluster (this ADR) → service orchestration
3. ADR-0024 pipeline → session indexing + taxonomy
4. ADR-0021 Phases 1-4 → memory pipeline
5. **exo → local LLM inference for Observer, Reflector, gateway, and direct conversation**

At that point, the system is a self-contained AI OS: CUDA inference for throughput, MLX inference for capacity, local embedding, local search, local orchestration, 64 TB storage — with API access as an optional enhancement rather than a dependency.

When exo ships CUDA support (Tier 1 planned on their roadmap), the NVIDIA box joins the exo cluster directly. At that point, the combined cluster has 192 GB unified + 48 GB VRAM = models can spill from VRAM to unified memory across the mesh. That's the endgame: a heterogeneous compute fabric where the scheduler picks the fastest available hardware for each inference request.

## Verification Criteria (if accepted)

- [ ] `kubectl get nodes` shows at least 2 nodes (Mac Mini + clanker-001)
- [ ] All current services (Inngest, Qdrant, Redis, Caddy, worker) running as k8s workloads
- [ ] `kubectl get pods -A` provides unified view across all machines
- [ ] pdf-brain on clanker-001 managed as a k8s Deployment
- [ ] Health checks and auto-restart working (kill a pod, confirm it recovers)
- [ ] All manifests version-controlled in the joelclaw monorepo
- [ ] Prometheus + Grafana deployed via Helm (ADR-0006 realized)
- [ ] No regression: all existing Inngest functions still register and execute
