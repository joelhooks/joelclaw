---
name: system-architecture
displayName: System Architecture
description: Canonical joelclaw topology and wiring map. Use when reasoning about architecture, tracing event flow, debugging why something ran/didn't run, identifying which worker executes a function, checking what listens on a port, or following an event end-to-end.
version: 0.1.0
author: joel
tags:
  - architecture
  - topology
  - inngest
  - gateway
  - kubernetes
  - observability
---

# System Architecture (Canonical Topology)

This skill is the **single source of truth** for joelclaw system wiring.
Use it for:
- "why did this run / not run"
- "which worker handles this function"
- "what is listening on port X"
- "how does event Y flow"
- full-stack routing/debug across CLI → Inngest → workers → gateway → telemetry

## Ground-Truth Scope + Evidence Snapshot

This document is grounded in direct reads of:
- `apps/docs-api/src/index.ts`
- `packages/restate/Dockerfile`
- `packages/restate/src/index.ts`
- `packages/restate/src/workflows/dag-orchestrator.ts`
- `packages/agent-execution/src/microvm.ts`
- `packages/system-bus/src/serve.ts`
- `packages/system-bus/src/inngest/functions/index.host.ts`
- `packages/system-bus/src/inngest/functions/index.cluster.ts`
- `packages/system-bus/src/inngest/client.ts`
- `infra/worker-supervisor/src/main.rs`
- `~/Library/LaunchAgents/com.joel*.plist`
- `k8s/*` (all files)
- `infra/pds/values.yaml`
- `packages/gateway/src/daemon.ts`
- `packages/gateway/src/channels/*.ts`
- `~/.joelclaw/gateway/AGENTS.md`
- `~/.joelclaw/gateway/.pi/settings.json`
- `~/.local/caddy/Caddyfile`
- `~/.colima/default/colima.yaml` + `colima status --json`
- `packages/cli/src/cli.ts`, `packages/cli/src/config.ts`, `packages/cli/src/inngest.ts`
- `packages/system-bus/src/observability/*` (key files: `emit.ts`, `otel-event.ts`, `store.ts`)
- `packages/telemetry/src/emitter.ts`
- `packages/system-bus/src/lib/langfuse.ts`
- `packages/inference-router/src/tracing.ts`
- ADRs in `~/Vault/docs/decisions/` (required + topology-adjacent)
- last 50 lines of `~/Vault/system/system-log.jsonl`

### Related docs verified
- `docs/architecture.md` — Restate/Firecracker runtime + workload execution flow
- `docs/deploy.md` — Restate worker deploy + auth/identity/PVC procedures
- `docs/cli.md` — workload command tree + runtime bridge
- `docs/observability.md` — **not inspected in this update**

---

## 1) Physical Topology

```text
Mac Mini "Panda" (host macOS)
├─ launchd services (gateway, worker supervisor, caddy, talon, agent-mail, etc.)
├─ Colima VM (driver: VZ, arch: aarch64, runtime: docker, VM IP: 192.168.64.2)
│  └─ Talos node: joelclaw-controlplane-1 (k8s v1.35.0, internal IP 10.5.0.2)
│     ├─ namespace: joelclaw
│     │  ├─ inngest (StatefulSet + NodePort 8288/8289)
│     │  ├─ redis (StatefulSet + NodePort 6379)
│     │  ├─ typesense (StatefulSet + ClusterIP 8108)
│     │  ├─ restate (StatefulSet + NodePort 8080/9070/9071)
│     │  ├─ system-bus-worker (Deployment + ClusterIP 3111)
│     │  ├─ restate-worker (Deployment + ClusterIP 9080; full agent image + Firecracker)
│     │  ├─ dkron (StatefulSet + ClusterIP 8080)
│     │  ├─ docs-api (Deployment + NodePort 3838)
│     │  ├─ livekit-server (Deployment + NodePort 7880/7881)
│     │  ├─ bluesky-pds (Deployment + NodePort 3000)
│     │  └─ minio (StatefulSet + NodePort 30900/30901)
│     └─ namespace: aistor
│        ├─ aistor operator (Deployments: adminjob-operator, object-store-operator)
│        └─ aistor-s3 object store (StatefulSet + NodePort 31000/31001)
├─ Caddy reverse proxy (tailnet HTTPS fan-in)
├─ Gateway daemon (embedded pi session)
├─ Firecracker substrate (requires Colima nestedVirtualization=true for /dev/kvm; OFF by default — unstable under load)
└─ NAS "three-body" (NFS tiers per ADR-0088)
```

### Known runtime endpoints
- Colima VM IP: `192.168.64.2` (`colima status --json`)
- Kubernetes API (stable operator tunnel): `https://127.0.0.1:16443`
- Talos API (stable operator tunnel): `127.0.0.1:15000`
- Tailnet hostnames seen in config:
  - `panda.tail7af24.ts.net` (Caddy routes)
  - `pds.panda.tail7af24.ts.net` (PDS values)

### Tailscale mesh state
- `tailscale status --json` failed in this environment: **UNKNOWN — needs manual verification**

---

## 2) Process Inventory (Long-Running)

## Host launchd inventory (snapshot)

> Snapshot source: `launchctl print gui/$(id -u)/<label>` and plist inspection.

| Launchd label | State | PID (snapshot) | Role | Ports / endpoints |
|---|---:|---:|---|---|
| `com.joel.system-bus-worker` | running | 75292 | Host worker supervisor (`worker-supervisor`) | supervises child bun on 3111 |
| `com.joel.restate-worker` | retired / rollback-only | — | Historical host Restate wrapper (`scripts/restate/start.sh`) | superseded by `deployment/restate-worker` on 9080 |
| `com.joel.gateway` | running | 81275 | Gateway daemon (`packages/gateway/src/daemon.ts`) | WS `:3018`, Redis bridge |
| `com.joel.caddy` | running | 9347 | Reverse proxy | 3443, 5443, 6443, 7443, 8290, 8443, 9443 |
| `com.joel.talon` | running | 96359 | Infra watchdog | health `127.0.0.1:9999` |
| `com.joel.agent-secrets` | running | 98048 | Secret lease daemon | no public port |
| `com.joel.imsg-rpc` | running | 61110 | iMessage JSON-RPC socket daemon | Unix socket `/tmp/imsg.sock` |
| `com.joel.kube-operator-access` | running | varies | stable kubectl/talos operator tunnel | local 16443 (kube), 15000 (talos) |
| `com.joel.voice-agent` | running | 71887 | voice agent runtime | local 8081 |
| `com.joel.local-sandbox-janitor` | scheduled | (launchd timer) | ADR-0221 local sandbox janitor (`scripts/local-sandbox-janitor.sh` → `joelclaw workload sandboxes janitor`) | logs in `/tmp/joelclaw/local-sandbox-janitor.{log,err}` |
| `com.joelclaw.agent-mail` | spawn scheduled | (none in launchctl snapshot) | agent-mail MCP HTTP service | observed listener `127.0.0.1:8765` (python process) |
| `com.joel.colima` | not running | — | startup helper for Colima | n/a |
| `com.joel.k8s-reboot-heal` | not running | — | periodic k8s heal script | n/a |
| `com.joel.system-bus-sync` | not running | — | sync guard watcher | n/a |
| `com.joel.gateway-tripwire` | not running | — | gateway tripwire script | n/a |
| `com.joel.content-sync-watcher` | not running | — | fs watch -> content/updated event | n/a |
| `com.joel.vault-log-sync` | not running | — | Vault log sync watcher | n/a |

### Process supervision behavior: `worker-supervisor`

Source: `infra/worker-supervisor/src/main.rs`

- Default config:
  - worker dir: `~/Code/joelhooks/joelclaw/packages/system-bus`
  - command: `bun run src/serve.ts`
  - port: `3111`
  - health endpoint: `/api/inngest`
  - sync endpoint: `/api/inngest` (PUT)
  - health interval: 30s
  - restart after 3 consecutive health failures
  - restart backoff: 1s → 30s max
- Pre-start kills stale process on port 3111.
- Runs host import preflight before spawn:
  - `bun --eval "await import('./src/inngest/functions/index.host.ts');"`
  - on failure, skips spawn and retries with exponential backoff
- Loads env from `~/.config/system-bus.env` plus leased secrets.
- Forces `WORKER_ROLE=host` for the supervised host worker.
- Emits OTEL events via CLI on supervisor failures/restarts:
  - `worker.supervisor.preflight.failed`
  - `worker.supervisor.worker_exit`
  - `worker.supervisor.health_check.restart`

### Worker supervision split note
- Talon is running (`com.joel.talon`), but host worker is still launched via `com.joel.system-bus-worker` -> `worker-supervisor`.
- ADR + system-log indicate Talon can defer worker supervision during coexistence.

---

## Kubernetes process inventory

## Node
- `joelclaw-controlplane-1` (Talos v1.12.4, k8s v1.35.0, internal IP `10.5.0.2`)

## Core services

| Service | Workload kind | Service type | Service port(s) | NodePort(s) / exposure | Role |
|---|---|---|---|---|---|
| Inngest | StatefulSet `inngest` | NodePort (`inngest-svc`) | 8288, 8289 | 8288, 8289 | Event API + connect ws |
| Redis | StatefulSet `redis` | NodePort | 6379 | 6379 | Queue/state/pubsub |
| Typesense | StatefulSet `typesense` | ClusterIP | 8108 | in-cluster only; operator access via short-lived port-forward when needed | Search + telemetry store |
| Restate | StatefulSet `restate` | NodePort | 8080, 9070, 9071 | 8080, 9070, 9071 | Durable workflow ingress + admin + metrics |
| system-bus-worker | Deployment | ClusterIP | 3111 | in-cluster only | Cluster-role worker (12 functions) |
| restate-worker | Deployment | ClusterIP | 9080 | in-cluster only | `dagOrchestrator` + `dagWorker` + queue drainer in full agent image |
| docs-api | Deployment | NodePort | 3838 | 3838 | PDF/docs API + agentic search + taxonomy graph |
| dkron | StatefulSet | ClusterIP (`dkron-svc`) + headless peer svc (`dkron-peer`) | 8080, 8946, 6868 | in-cluster only; operator access via short-lived CLI-managed tunnel | Distributed cron scheduler for Restate pipelines |
| livekit-server | Deployment (Helm) | NodePort | 80, 7881 | 7880 (for svc port 80), 7881 | LiveKit signaling + rtc tcp |
| bluesky-pds | Deployment (Helm-managed) | NodePort | 3000 | 3000 | AT Proto PDS |
| minio | StatefulSet | ClusterIP + NodePort | 9000, 9001 | 30900, 30901 | Legacy local S3-compatible runtime |
| aistor-s3-api (`aistor` ns) | NodePort service (operator-managed) | NodePort | 443, 9000 | 31000 (+ dynamic management NodePort) | AIStor S3 API (TLS + management) |
| aistor-s3-console (`aistor` ns) | NodePort service (operator-managed) | NodePort | 9443 | 31001 | AIStor web console |

### Restate / Firecracker runtime note

- `deployment/restate-worker` is the current durable execution worker. The image bundles Bun + Node + `pi` + `codex`, the full repo checkout, and 76 symlinked skills.
- Runtime auth/identity come from `secret/pi-auth` and `configmap/agent-identity`, which recreate `/root/.pi/agent/auth.json` plus the joelclaw identity chain inside the pod.
- Firecracker is enabled in-pod via privileged access to `/dev/kvm` on Colima VZ. The `/dev/kvm` hostPath mount uses type `""` (optional) so the pod starts without it when nestedVirtualization is off.
- Persistent microVM assets live on PVC `firecracker-images`, mounted at `/tmp/firecracker-test` for kernel, rootfs, and snapshot files.
- **Retry caps (2026-03-17)**: dagWorker maxAttempts=5, dagOrchestrator maxAttempts=3. Prevents Restate journal poisoning from infinite retries after code changes or infrastructure failures.
- **Colima stability**: nestedVirtualization is OFF by default (crashes VM under Docker build load). Toggle ON only for Firecracker testing sessions, then toggle OFF. See k8s skill for recovery procedures.

### Control-plane access
- kube API exposed locally at `127.0.0.1:16443` via `com.joel.kube-operator-access` (`ssh -S none -o ControlPath=none -L 16443:10.5.0.2:6443`)
- Talos API exposed locally at `127.0.0.1:15000` via the same daemon (`ssh -S none -o ControlPath=none -L 15000:10.5.0.2:50000`)
- NodePort/runtime app ports still come from Colima/Lima forwarding; the operator daemon exists specifically because the direct host-published 6443 path was not boring after the rebuild

---

## 3) Worker Architecture (Role Split + Registration)

Source files:
- `packages/system-bus/src/serve.ts`
- `packages/system-bus/src/inngest/functions/index.host.ts`
- `packages/system-bus/src/inngest/functions/index.cluster.ts`
- `packages/system-bus/src/inngest/client.ts`

## Role model
- `WORKER_ROLE` parsed as `host` (default) or `cluster`.
- Registered function set is role-dependent:
  - host uses `hostFunctionDefinitions`
  - cluster uses `clusterFunctionDefinitions`

## Ground-truth counts
- Host function set: **101**
- Cluster function set: **12**
- Cluster subset functions:
  - `approvalRequest`, `approvalResolve`
  - `todoistCommentAdded`, `todoistTaskCompleted`, `todoistTaskCreated`
  - `frontMessageReceived`, `frontMessageSent`, `frontAssigneeChanged`
  - `todoistMemoryReviewBridge`
  - `githubWorkflowRunCompleted`, `githubPackagePublished`
  - `webhookSubscriptionDispatchGithubWorkflowRunCompleted`

## App registration isolation
From `inngest/client.ts`:
- app id resolves to:
  - `system-bus-host` when role is host
  - `system-bus-cluster` when role is cluster
- explicit `INNGEST_APP_ID` overrides role-derived id.

This prevents host and cluster workers from overwriting each other’s function graphs.

## serveHost behavior
From `serve.ts`:
- host role default `serveHost`: `http://host.docker.internal:3111`
- cluster role default `serveHost`: unset (connect-mode default)
- `INNGEST_SERVE_HOST` overrides either role.

Kubernetes cluster worker manifest sets:
- `INNGEST_BASE_URL=http://inngest-svc:8288`
- `INNGEST_SERVE_HOST=http://system-bus-worker:3111`

## Registration mechanics
- Worker exposes `GET|POST|PUT /api/inngest`.
- Worker sends a delayed self-sync `PUT /api/inngest` ~5s after startup.
- `worker-supervisor` also performs startup PUT sync.

## Host is primary today
From index comments + function lists:
- ADR-0089 transition: host remains authoritative for broad function ownership.
- Cluster is intentionally limited to cluster-safe subset (12 functions).

---

## 4) Event Flow (CLI → Inngest → Worker → Completion)

## Canonical flow: `joelclaw send`

1. CLI `joelclaw send <event>` calls `Inngest.send()`.
2. `Inngest.send()` POSTs event JSON to:
   - `${INNGEST_URL}/e/${INNGEST_EVENT_KEY}`
   - default: `http://localhost:8288/e/<key>`
3. Inngest server persists the event and resolves matching function triggers.
4. Inngest dispatches function steps to the worker app graph that owns that function ID:
   - host app (`system-bus-host`) for 101-host set
   - cluster app (`system-bus-cluster`) for 12-cluster subset
5. Worker handles callbacks via `/api/inngest` (Hono + `inngest/hono` handler).
6. Each `step.run` result is memoized by Inngest; next step executes when prior completes.
7. Completion/failure is queryable via GraphQL (`/v0/gql`) and CLI commands (`runs`, `run`, `event`, `events`).

## Queue flow: `joelclaw queue emit` → Restate drainer → durable dispatch

1. CLI `joelclaw queue emit <event>` persists a `QueueEventEnvelope` into Redis stream `joelclaw:queue:events` and indexes it in sorted set `joelclaw:queue:priority`.
2. The `restate-worker` k8s deployment (`packages/restate/src/index.ts`) starts a deterministic queue drainer beside the channel callback listener.
3. On startup, the drainer claims pending + never-delivered entries via `@joelclaw/queue#getUnacked()`, reindexes replayable entries, and emits OTEL replay evidence.
4. Each drain tick selects the next priority candidate from the sorted set, resolves its static registry target from `packages/queue/src/registry.ts`, and POSTs a one-node DAG request to Restate `/dagOrchestrator/{workflowId}/run/send`.
5. When backlog remains and a dispatch slot frees, the drainer self-pulses immediately instead of waiting for the next `QUEUE_DRAIN_INTERVAL_MS` heartbeat. That interval is now the idle poll / retry cadence, not a mandatory 2-second tax between successful sends.
6. The current Story-3 bridge re-emits the queue item to its registered Inngest event target inside that one-node DAG request. This is deliberate: the deterministic queue/drainer is proven first; per-family Restate cutovers remain Story 4 work.
7. On accepted Restate dispatch, the drainer acks the queue message; on failure it leaves the message in Redis, applies retry cooldown, and emits `queue.dispatch.failed` OTEL evidence.
8. If backlog remains in Redis but the drainer stops making progress past `QUEUE_DRAIN_STALL_AFTER_MS`, it emits `queue.drainer.stalled` and exits non-zero so k8s restarts `deployment/restate-worker`. That is the self-heal path for a wedged drainer inside an otherwise-running Bun process.
9. Crash recovery comes from the Redis stream + consumer-group replay path, not from vibes: restart the `restate-worker` pod, let `getUnacked()` reclaim the inflight entries, then drain resumes.

## Workload flow: `joelclaw workload run` → Redis → Restate DAG → execution

1. `joelclaw workload plan ... --stages-from <file>` can load an explicit stage DAG, validate unknown deps/self-deps/duplicates/cycles, and preserve per-stage acceptance gates.
2. `joelclaw workload run <plan-artifact>` normalizes the selected stage into the canonical `workload/requested` runtime request.
3. Queue admission writes the request into Redis, where the deterministic drainer forwards it into Restate as a `dagOrchestrator/{workflowId}/run/send` request.
4. `dagOrchestrator` executes dependency waves: ready nodes in parallel, chained nodes only after every `dependsOn` node has terminal output.
5. `dagWorker` executes the node handler:
   - `shell` → subprocess work inside the `restate-worker` pod
   - `infer` → `pi -p --no-session --no-extensions` inside the pod, using the mounted auth + identity + skill set
   - `microvm` → Firecracker boot/restore through `/dev/kvm` with kernel/rootfs/snapshot files on PVC `firecracker-images`
6. Each node emits OTEL (`dag.node.*`), and the workflow emits `dag.workflow.*` so queue → Restate → execution remains observable.
7. Current truthful limit: the microVM runtime boots and restores snapshots in-cluster, but the broader exec-in-VM workspace drive protocol is still incomplete for general coding slices.

## Webhook flow

1. External service posts to `/webhooks/:provider`.
2. Caddy routes `/webhooks/*` on `localhost:8443` to worker `localhost:3111`.
3. `webhookApp` verifies signature, normalizes payload, emits Inngest events (`provider/event`).
4. Inngest executes subscribed functions.

## "Why did this run / not run" trace recipe

1. `joelclaw send <event> -d '<payload>'`
2. `joelclaw events --prefix <event-prefix> --hours 1`
3. `joelclaw event <event-id>` (fan-out to function runs)
4. `joelclaw run <run-id>` (step trace + errors)
5. `joelclaw runs --count 20 --hours 1`
6. `joelclaw otel search "<component/action>" --hours 1`
7. Validate function ownership in `index.host.ts` / `index.cluster.ts`.

---

## 5) Port Map (Canonical)

> Exposure sources: k8s service manifests, Caddyfile, `kubectl get svc`, `lsof` listeners.

| Port | Listener / owner | What it is | Exposure path |
|---:|---|---|---|
| 3111 | host bun worker | host system-bus worker HTTP (`/`, `/api/inngest`, `/webhooks`, `/observability/emit`) | local host; proxied via Caddy 3443 + webhook path via 8443 |
| 8080 | ssh forward (Colima) -> restate | Restate ingress / workflow API | NodePort + host forward |
| 8288 | ssh forward (Colima) -> Inngest svc | Inngest API + dashboard backend | NodePort + host forward; proxied via Caddy 9443 |
| 8289 | ssh forward (Colima) -> Inngest ws | Inngest connect websocket | NodePort + host forward; proxied via Caddy 8290 |
| 6379 | ssh forward (Colima) -> Redis | Redis | NodePort + host forward |
| 8108 | transient `kubectl port-forward` | Typesense API | ClusterIP only; short-lived operator tunnel |
| 9070 | ssh forward (Colima) -> restate | Restate admin API | NodePort + host forward |
| 9071 | ssh forward (Colima) -> restate | Restate metrics | NodePort + host forward |
| 9080 | k8s `restate-worker` service | Restate worker HTTP (`dagOrchestrator`, `dagWorker`, queue drainer) | ClusterIP only |
| random high local port | transient `kubectl port-forward` (CLI-managed) -> `svc/dkron-svc:8080` | Dkron HTTP API | ClusterIP only; short-lived operator tunnel |
| 3838 | ssh forward (Colima) -> docs-api | docs-api HTTP | NodePort + host forward; proxied via Caddy 5443 |
| 7880 | ssh forward (Colima) -> livekit-server | LiveKit signaling | NodePort 7880; proxied via Caddy 7443 |
| 7881 | ssh forward (Colima) -> livekit-server | LiveKit RTC TCP | NodePort 7881 |
| 3000 | k8s bluesky-pds NodePort | Bluesky PDS HTTP | NodePort 3000 |
| 30900 | k8s minio-nodeport | Legacy MinIO S3 API (HTTP) | NodePort 30900 |
| 30901 | k8s minio-nodeport | Legacy MinIO console (HTTP) | NodePort 30901 |
| 31000 | k8s aistor-s3-api (`aistor` ns) | AIStor S3 API (TLS) | NodePort 31000 |
| 31001 | k8s aistor-s3-console (`aistor` ns) | AIStor console (TLS) | NodePort 31001 |
| 3443 | Caddy | HTTPS reverse proxy to `localhost:3111` | tailnet HTTPS |
| 5443 | Caddy | HTTPS reverse proxy to `localhost:3838` | tailnet HTTPS |
| 7443 | Caddy | HTTPS reverse proxy to `localhost:7880` | tailnet HTTPS |
| 9443 | Caddy | HTTPS reverse proxy to `localhost:8288` | tailnet HTTPS |
| 8290 | Caddy | HTTPS reverse proxy to `localhost:8289` | tailnet HTTPS |
| 8443 | Caddy (HTTP) | webhook/public ingress router | expected Funnel target |
| 6443 | Caddy | reverse proxy to local 6333 (Qdrant) | tailnet HTTPS |
| 3018 | gateway daemon | gateway websocket stream port | local |
| 9999 | talon | Talon health endpoint | local `127.0.0.1` |
| 8765 | agent-mail HTTP service | MCP agent-mail API | local `127.0.0.1` |
| 15000 | `com.joel.kube-operator-access` | Talos API | stable local talosctl endpoint |
| 16443 | `com.joel.kube-operator-access` | Kubernetes API | stable local kubectl endpoint |

### Notes
- Host NodePort exposure appears through an `ssh` listener process (Colima portForwarder=ssh).
- Exact per-port ssh forward command line is **UNKNOWN — needs manual verification** (process introspection restricted in this environment).

---

## 6) Storage Topology

## Redis

- Runtime: k8s StatefulSet (`redis:7-alpine`, appendonly enabled).
- Primary uses:
  - gateway queue/session keys (`joelclaw:events:*`, `joelclaw:notify:*`, `joelclaw:gateway:sessions`)
  - webhook subscriptions (`joelclaw:webhook:*`)
  - gateway health mute/streak keys (`gateway:health:*`)

## Typesense

From observability code:
- `otel_events` collection (canonical telemetry event store)
- `memory_observations` collection (vector-aware memory index; schema validated at startup)
- docs-api also points at `http://typesense:8108` for docs search/index surfaces.

## Firecracker runtime storage

- PVC: `firecracker-images`
- Mounted in `deployment/restate-worker` at `/tmp/firecracker-test`
- Stores:
  - kernel (`vmlinux`)
  - rootfs (`agent-rootfs.ext4`)
  - snapshots (`snapshots/vm.snap`, `snapshots/vm.mem`)
- Firecracker snapshot restore is currently operator-proven at ~9ms on the Colima VZ nested-virt path.

## Inngest state
- StatefulSet PVC mounted at `/data`
- `INNGEST_SQLITE_DIR=/data`

## docs-api surface

- Deployment: `docs-api` on NodePort `3838`
- Route count: 11 endpoints including `/health`
- Key routes:
  - `GET /search` — hybrid chunk search with `concept`, `concepts`, `doc_id`, `expand`, and `assemble`
  - `GET /docs/search`
  - `GET /docs`
  - `GET /docs/:id`
  - `GET /docs/:id/toc`
  - `GET /docs/:id/chunks`
  - `GET /chunks/:id`
  - `GET /concepts`
  - `GET /concepts/:id`
  - `GET /concepts/:id/docs`
- Taxonomy surface: 21-concept SKOS graph (10 parents + 11 sub-concepts) with `broader`, `narrower`, and `related` edges.

## NAS (ADR-0088 + ADR-0187)

Tiering policy:
- Tier 1 local SSD (hot runtime state)
- Tier 2 NAS NVMe (`/Volumes/nas-nvme` ↔ `/volume2/data`)
- Tier 3 NAS HDD (`/Volumes/three-body`)

### Access paths

| From | NVMe tier (1.5TB) | HDD tier (56TB) | Method |
|------|-----------|----------|--------|
| macOS host | `/Volumes/nas-nvme` | `/Volumes/three-body` | NFS mount via LaunchDaemon |
| k8s pods | PVC `nas-nvme` | PVC `nas-hdd` | NFS PV (192.168.1.163) |
| host-worker funcs | `/Volumes/nas-nvme` | `/Volumes/three-body` | Direct path (runs on macOS) |

### k8s ↔ NAS networking

k8s pods reach the NAS via a LAN route through the Colima col0 bridge:
`Talos → Docker NAT → VM col0 → macOS (ip.forwarding=1) → LAN → NAS`

The VZ NAT on eth0 does NOT forward LAN traffic. Route persisted in Colima provision + colima-tunnel script:
`ip route replace 192.168.1.0/24 via 192.168.64.1 dev col0`

**Always use IP 192.168.1.163, never hostname three-body** — DNS doesn't resolve from k8s.

Degradation contract (ADR-0187):
- writes must fallback `local -> remote -> queued`
- queue spool default: `/tmp/joelclaw/nas-queue`

## Vault
- Obsidian vault at `/Users/joel/Vault`
- system log file: `/Users/joel/Vault/system/system-log.jsonl`

---

## 7) Networking Topology

## Caddy reverse proxy routes (from `~/.local/caddy/Caddyfile`)

- `https://panda.tail7af24.ts.net:9443` -> `localhost:8288` (Inngest)
- `https://panda.tail7af24.ts.net:8290` -> `localhost:8289` (Inngest connect)
- `https://panda.tail7af24.ts.net:3443` -> `localhost:3111` (worker)
- `https://panda.tail7af24.ts.net:5443` -> `localhost:3838` (docs-api)
- `https://panda.tail7af24.ts.net:7443` -> `localhost:7880` (LiveKit)
- `https://panda.tail7af24.ts.net:6443` -> `localhost:6333` (Qdrant)
- `http://localhost:8443` path router:
  - `/webhooks/*` -> `localhost:3111`
  - fallback -> `localhost:8288`

## Tailscale + Funnel

- Config comments and ADR-0051 describe Funnel path `:443 -> localhost:8443`.
- Runtime `tailscale status` unavailable here: **UNKNOWN — needs manual verification**.

## External webhook ingress

Expected path:
1. Internet provider -> Tailscale Funnel :443
2. Funnel -> local `:8443`
3. Caddy path route `/webhooks/*` -> worker `:3111`
4. worker `/webhooks/:provider` verifies + emits Inngest event

---

## 8) CLI Wiring (Command Tree → Endpoint Surface)

Primary command tree root: `packages/cli/src/cli.ts`.

## Endpoint map by command family

| Command family | Primary backend |
|---|---|
| `send` | Inngest Event API `POST /e/<event-key>` |
| `runs`, `run`, `functions`, `event`, `events` | Inngest GraphQL `POST /v0/gql` |
| `status` | Inngest/worker health probes + k8s checks + agent-mail liveness |
| `gateway *` | Redis keys/channels + launchd/system ops |
| `workload *` | workload planner + Redis queue admission + Restate `dagOrchestrator` / `dagWorker` runtime |
| `docs *` | docs-api REST API (`/search`, `/docs/*`, `/chunks/*`, `/concepts*`) |
| `restate cron *` | Dkron REST API via direct `--base-url` or short-lived `kubectl port-forward` to `svc/dkron-svc` |
| `otel *` | Typesense `otel_events` via capability adapter |
| `recall *` | Typesense recall adapter |
| `mail *` | Agent-mail MCP HTTP (`127.0.0.1:8765`) via CLI adapter wrappers |
| `inngest *` | worker launchd + Talon + k8s + Typesense diagnostics |

Config source:
- `~/.config/system-bus.env` (plus env overrides)
- defaults:
  - `INNGEST_URL=http://localhost:8288`
  - `INNGEST_WORKER_URL=http://localhost:3111`

---

## 9) Observability + Tracing Topology

## OTEL event pipeline

- Worker emits via `emitOtelEvent()` / `emitMeasuredOtelEvent()`.
- Gateway emits via `@joelclaw/telemetry` (`emitGatewayOtel`) to:
  - default `OTEL_EMIT_URL=http://localhost:3111/observability/emit`
- Worker endpoint `/observability/emit` validates token (`x-otel-emit-token`) if configured.
- Store path (`storeOtelEvent`):
  1. Typesense `otel_events` (primary)
  2. optional Convex mirror for high-severity recent window
  3. optional Sentry forward for `warn/error/fatal`

## Langfuse integration points

- Gateway boot: `packages/gateway/src/daemon.ts` calls `initTracing({})` from inference-router.
- Inference router traces model-route decisions:
  - `packages/inference-router/src/tracing.ts`
  - used from `packages/inference-router/src/router.ts`
- System-bus LLM traces:
  - `packages/system-bus/src/lib/langfuse.ts` (`traceLlmGeneration`)
  - called by `packages/system-bus/src/lib/inference.ts` and `channel-message-classify.ts`

---

## 10) Key ADR Topology Decisions

| ADR | Title | Status | Topology impact |
|---|---|---|---|
| ADR-0048 | Webhook gateway | shipped | `/webhooks/:provider` normalization + signature verification + Inngest emission |
| ADR-0088 | NAS-backed storage tiering | shipped | Defines SSD/NAS NVMe/NAS HDD storage contract |
| ADR-0089 | Single-source worker deployment | shipped | Host/cluster role split + single canonical source |
| ADR-0144 | Gateway hexagonal architecture | shipped | Gateway as composition root; heavy logic in `@joelclaw/*` |
| ADR-0155 | Three-stage story pipeline | shipped | Simplified story function flow through Inngest durable steps |
| ADR-0156 | Graceful worker restart | superseded | Historical restart strategy; superseded by Talon ADR |
| ADR-0159 | Talon watchdog daemon | shipped | Compiled watchdog + infra supervision model |
| ADR-0038 | Embedded pi gateway daemon | shipped | Always-on gateway session architecture |
| ADR-0051 | Tailscale Funnel ingress | shipped | Public webhook ingress via Funnel/Caddy pattern |
| ADR-0148 | k8s resilience policy | accepted | NodePort-first exposure, probe requirements, restart recovery checklist |
| ADR-0158 | worker-supervisor binary | superseded | Legacy supervisor ADR now superseded, but binary remains in active launchd path |
| ADR-0182 | node-0 localhost resilience | shipped | endpoint class fallback (`localhost -> vm -> svc_dns`) |
| ADR-0187 | NAS degradation fallback contract | accepted | mandatory local/remote/queued write fallback |
| ADR-0212 | AIStor as local S3 runtime | accepted | maintained local S3 runtime in `aistor` namespace; legacy MinIO retained for rollback |

---

## 10.1) Sandbox Execution Contract (@joelclaw/agent-execution)

**Package**: `packages/agent-execution/`  
**Purpose**: Canonical contract for sandboxed story execution shared between Restate workflows, system-bus Inngest functions, and k8s Job launcher.

### Contract Types

**Request**: `SandboxExecutionRequest`
- `workflowId`, `requestId`, `storyId`: identifiers
- `task`: story prompt/task to execute
- `agent`: `{ name, variant?, model?, program? }`
- `sandbox`: `"workspace-write" | "danger-full-access"`
- `baseSha`: git SHA before execution
- `cwd?`: working directory
- `timeoutSeconds?`: timeout
- `verificationCommands?`: post-execution verification
- `sessionId?`: tracking identifier

**Result**: `SandboxExecutionResult`
- `requestId`: correlation ID
- `state`: `"pending" | "running" | "completed" | "failed" | "cancelled"`
- `startedAt`, `completedAt?`, `durationMs?`: timing
- `artifacts?`: execution artifacts (see below)
- `error?`: error message (failed state)
- `output?`: stdout/stderr output

**Artifacts**: `ExecutionArtifacts`
- `headSha`: git SHA after execution
- `touchedFiles`: list of modified/untracked files from `git status --porcelain`
- `patch?`: git patch content (format-patch or diff)
- `verification?`: `{ commands, success, output }`
- `logs?`: `{ executionLog?, verificationLog? }`

### Repo Materialization (Story 3)

**Function**: `materializeRepo(targetPath, baseSha, options)`

**Behavior**:
- Clone repo if target path doesn't exist (requires `remoteUrl`)
- Fetch + checkout if target path exists
- SHA verification after checkout
- Automatic unshallow if SHA not in shallow clone
- Isolated sandbox-local workspace (host worktree untouched)

**Returns**: `{ path, sha, freshClone, durationMs }`

**Key options**:
- `remoteUrl?`: remote URL for fresh clone
- `branch?`: branch/ref to fetch (default: `"main"`)
- `depth?`: shallow clone depth (default: `1`)
- `includeSubmodules?`: include submodules
- `timeoutSeconds?`: timeout (default: `300`)

### Artifact Export (Story 3)

**Function**: `generatePatchArtifact(options)`

**Behavior**:
- Captures touched-file inventory via `getTouchedFiles()`
- Generates git patch from `baseSha..headSha`:
  - Uses `git format-patch` if commits exist in range
  - Uses `git diff` if only uncommitted changes
- Optionally includes untracked files as patch content
- Embeds verification summary and log references
- Serializable to JSON via `writeArtifactBundle()`

**Key options**:
- `repoPath`: path to git repo
- `baseSha`: base SHA (start of diff range)
- `headSha?`: head SHA (default: HEAD)
- `includeUntracked?`: include untracked files (default: `true`)
- `verificationCommands?`, `verificationSuccess?`, `verificationOutput?`: verification data
- `executionLogPath?`, `verificationLogPath?`: log references
- `timeoutSeconds?`: timeout (default: `60`)

**Returns**: `ExecutionArtifacts`

### Promotion Boundary (Phase 1)

**Authoritative output is patch bundle + metadata.**

Sandbox runs **do not** merge to main or push to remote. The runtime:
1. Materializes repo at `baseSha` in sandbox-local workspace
2. Executes agent task
3. Runs verification commands
4. Exports patch artifact with touched files and verification results
5. Emits `SandboxExecutionResult` event with `ExecutionArtifacts`

Promotion is a separate operator decision:
- Restate workflow receives `ExecutionArtifacts`
- Operator reviews patch + verification summary
- Operator applies patch to host repo (or discards)
- Operator commits and pushes (if approved)

This keeps sandbox runs isolated and reversible.

### k8s Job Integration

**Job spec generation**: `generateJobSpec(request, options)`

Cold k8s Jobs for isolated story execution:
- Deterministic Job naming keyed by `requestId`
- Runtime image contract: Git, Bun, agent tooling, `/workspace` directory
- Environment-driven config: `WORKFLOW_ID`, `REQUEST_ID`, `STORY_ID`, `TASK_PROMPT_B64`, `BASE_SHA`, etc.
- Resource limits: `500m-2` CPU, `1-4Gi` memory (configurable)
- TTL cleanup: auto-delete after 5 minutes (default)
- Active deadline: 1 hour max runtime (default)
- No automatic retries (`backoffLimit: 0`)
- Security: non-root (UID 1000), no privilege escalation, capabilities dropped

**Runtime contract**:
1. Decode `TASK_PROMPT_B64` from env
2. Call `materializeRepo()` at `BASE_SHA`
3. Execute agent with task
4. Run verification commands (if `VERIFICATION_COMMANDS_B64` set)
5. Call `generatePatchArtifact()` with results
6. Emit `SandboxExecutionResult` event with `ExecutionArtifacts`
7. Exit 0 (success) or non-zero (failure)

**Cancellation**: Delete Job resource (SIGTERM to container)

**Job deletion**: `generateJobDeletion(requestId)` -> `{ name, namespace, propagationPolicy }`

See `k8s/agent-runner.yaml` for full runtime contract specification.

### Topology Impact

- **Story 2**: Added contract types and Job spec generation
- **Story 3**: Added repo materialization and artifact export helpers
- **ADR-0221 phase 1**: added explicit local sandbox isolation primitives — deterministic sandbox identity, deterministic local sandbox paths, per-sandbox env materialization, minimal/full mode vocabulary, and a JSON registry helper for host-worker sandboxes
- **ADR-0221 phase 2**: wired those local helpers into the real host-worker `system/agent-dispatch` local backend so sandbox runs now allocate deterministic paths under `~/.joelclaw/sandboxes/`, materialize `.sandbox.env`, persist registry state, and carry `localSandbox` metadata in inbox snapshots
- **ADR-0221 phase 3/4/5/6**: phase 3 added terminal retention/cleanup policy (`cleanupAfter` + registry metadata), opportunistic pruning of expired local sandboxes on new-run startup, copy-first `.devcontainer` materialization helpers with exclusion rules for env/secret junk, live sandbox env injection so the agent process actually sees the reserved runtime identity, a hash-preserving sandbox identity fix after live dogfood exposed path collisions from long shared requestId prefixes, abbreviated-`baseSha` acceptance during repo materialization, truthful failed inbox snapshots when dispatch crashes before normal terminal writeback, and a repeatable operator probe at `bun scripts/verify-local-sandbox-dispatch.ts`; phase 4 adds `sandboxMode=minimal|full` through the workload front door, requested-cwd mapping inside the cloned checkout, compose-backed full local mode startup, the reality that stale Restate workers can reject `workload/requested` until restarted and reloaded, a recursion guard because sandboxed stage runs were able to call `scripts/verify-workload-full-mode.ts` / `joelclaw workload run` from inside the sandbox and spawn nested canaries instead of terminating honestly, and a guarded workflow-rig proof run (`WR_20260310_013158`) that completes terminally with healthy compose startup plus clean teardown; phase 5 adds the operator-facing CLI surface `joelclaw workload sandboxes list|cleanup|janitor` so retained sandboxes can be inspected and janitored on demand instead of only during startup opportunistic pruning, and the operator surfaces now reconcile registry entries against per-sandbox metadata before reporting or deleting so old partial writeback residue stops lying about terminal state; phase 6 makes janitoring scheduled instead of purely manual via repo-managed launchd service `com.joel.local-sandbox-janitor`, which runs `scripts/local-sandbox-janitor.sh` → `joelclaw workload sandboxes janitor` at load and every 30 minutes
- **Future**: Runtime image build, hot-image CronJob, warm-pool scheduler, Restate integration

**Current state**: the host-worker local sandbox path is now using the local-isolation helpers in production code, the package has a concurrent proof that two local sandboxes keep distinct compose identity plus copied devcontainer state, guarded full-mode workflow-rig dogfood closes terminally, and cleanup now has both on-demand CLI surfaces and scheduled launchd janitoring. Follow-on work is now about deeper runtime ergonomics and debugging any remaining non-terminal stale residues, not missing basic cleanup automation.

---

## 11) Verification Commands (Health + Wiring)

## Core topology

```bash
# Colima + VM IP
colima status --json

# Kubernetes control plane + node
kubectl cluster-info
kubectl get nodes -o wide

# Core workloads
kubectl get pods -n joelclaw -o wide
kubectl get svc -n joelclaw -o wide
```

## Host supervision

```bash
# Worker supervisor launchd state
launchctl print gui/$(id -u)/com.joel.system-bus-worker | rg "state =|pid =|last exit code"

# Gateway / Caddy / Talon
launchctl print gui/$(id -u)/com.joel.gateway | rg "state =|pid ="
launchctl print gui/$(id -u)/com.joel.caddy | rg "state =|pid ="
launchctl print gui/$(id -u)/com.joel.talon | rg "state =|pid ="

# Talon health
curl -s http://127.0.0.1:9999/health
```

## Worker role split

```bash
# Parse role counts directly from source lists
python - <<'PY'
import re
from pathlib import Path
for f,name in [('packages/system-bus/src/inngest/functions/index.host.ts','host'),('packages/system-bus/src/inngest/functions/index.cluster.ts','cluster')]:
    txt=Path(f).read_text()
    body=re.search(rf'export const {name}FunctionDefinitions = \[(.*?)\];', txt, re.S).group(1)
    count=sum(1 for line in body.splitlines() if line.strip() and not line.strip().startswith('//'))
    print(name, count)
PY

# Inngest app ID derivation logic
rg -n "INNGEST_APP_ID|system-bus-host|system-bus-cluster|WORKER_ROLE" packages/system-bus/src/inngest/client.ts
```

## Event flow trace

```bash
# Send event
joelclaw send <event> -d '<json>'

# Trace event and resulting runs
joelclaw events --prefix <event-prefix> --hours 1 --count 20
joelclaw event <event-id>
joelclaw runs --hours 1 --count 20
joelclaw run <run-id>

# Telemetry correlation
joelclaw otel search "<component_or_action>" --hours 1
```

## Networking

```bash
# Caddy route config
caddy validate --config ~/.local/caddy/Caddyfile

# Listening ports snapshot
/usr/sbin/lsof -iTCP -sTCP:LISTEN -n -P

# Tailscale runtime (if daemon available)
tailscale status --json
```

---

## 12) Known Unknowns (Do Not Guess)

- Tailscale daemon state is not readable in this environment.
  - `tailscale status --json` -> failed to connect.
  - **UNKNOWN — needs manual verification**
- `docs/architecture.md`, `docs/deploy.md`, `docs/observability.md` are absent in-repo.
  - **UNKNOWN — needs manual verification**
- Exact command-line ownership of all Colima ssh forwarding ports (`64784`, `64785`, `9627`, etc.)
  - **UNKNOWN — needs manual verification**
- Ingress controller runtime status for `k8s/docs-api-ingress.yaml`
  - **UNKNOWN — needs manual verification**

---

## 13) Mandatory Update Policy (Non-Optional)

Update this skill **in the same change** whenever any of these change:

1. Worker runtime wiring
   - `serve.ts`, `client.ts`, `index.host.ts`, `index.cluster.ts`
   - `WORKER_ROLE`, app IDs, serveHost behavior, registration path
2. Supervision/process topology
   - any `~/Library/LaunchAgents/com.joel*.plist`
   - `infra/worker-supervisor/*`, Talon behavior, gateway launch script/label
3. Kubernetes topology
   - any file under `k8s/`
   - Helm values affecting core services (`livekit`, `pds`, etc.)
   - Service type/port changes (NodePort/ClusterIP)
4. Networking/ingress
   - Caddyfile route/port changes
   - Tailscale/Funnel hostnames or ingress path changes
   - Colima/VM networking model changes
5. Storage topology
   - Redis keyspace contracts for gateway/webhook routing
   - Typesense telemetry collection/schema changes
   - NAS mount/fallback/queue contract changes
6. Observability/tracing
   - OTEL emit endpoint/token behavior
   - telemetry storage path changes (Typesense/Convex/Sentry)
   - Langfuse integration points
7. CLI control-plane routing
   - command families moved to different endpoints/services
8. ADR status changes affecting topology
   - especially ADR-0048, 0088, 0089, 0144, 0155, 0156, 0159, 0182, 0187

If any item above changed and this skill was not updated, this skill is stale and non-canonical.
