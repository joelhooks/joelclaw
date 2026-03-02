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

### Missing requested docs (at capture time)
- `docs/architecture.md` — **UNKNOWN — needs manual verification**
- `docs/deploy.md` — **UNKNOWN — needs manual verification**
- `docs/observability.md` — **UNKNOWN — needs manual verification**

---

## 1) Physical Topology

```text
Mac Mini "Panda" (host macOS)
├─ launchd services (gateway, worker supervisor, caddy, talon, agent-mail, etc.)
├─ Colima VM (driver: VZ, arch: aarch64, runtime: docker, VM IP: 192.168.64.2)
│  └─ Talos node: joelclaw-controlplane-1 (k8s v1.35.0, internal IP 10.5.0.2)
│     └─ namespace: joelclaw
│        ├─ inngest (StatefulSet + NodePort 8288/8289)
│        ├─ redis (StatefulSet + NodePort 6379)
│        ├─ typesense (StatefulSet + ClusterIP 8108)
│        ├─ system-bus-worker (Deployment + ClusterIP 3111)
│        ├─ docs-api (Deployment + NodePort 3838)
│        ├─ livekit-server (Deployment + NodePort 7880/7881)
│        └─ bluesky-pds (Deployment + NodePort 3000)
├─ Caddy reverse proxy (tailnet HTTPS fan-in)
├─ Gateway daemon (embedded pi session)
└─ NAS "three-body" (NFS tiers per ADR-0088)
```

### Known runtime endpoints
- Colima VM IP: `192.168.64.2` (`colima status --json`)
- Kubernetes API (local forward): `https://127.0.0.1:64784` (`kubectl cluster-info`)
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
| `com.joel.gateway` | running | 81275 | Gateway daemon (`packages/gateway/src/daemon.ts`) | WS `:3018`, Redis bridge |
| `com.joel.caddy` | running | 9347 | Reverse proxy | 3443, 5443, 6443, 7443, 8290, 8443, 9443 |
| `com.joel.talon` | running | 96359 | Infra watchdog | health `127.0.0.1:9999` |
| `com.joel.agent-secrets` | running | 98048 | Secret lease daemon | no public port |
| `com.joel.imsg-rpc` | running | 61110 | iMessage JSON-RPC socket daemon | Unix socket `/tmp/imsg.sock` |
| `com.joel.typesense-portforward` | running | 32095 | `kubectl port-forward svc/typesense 8108:8108` | local 8108 |
| `com.joel.voice-agent` | running | 71887 | voice agent runtime | local 8081 |
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
- Loads env from `~/.config/system-bus.env` plus leased secrets.
- Forces `WORKER_ROLE=host` for the supervised host worker.

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
| Typesense | StatefulSet `typesense` | ClusterIP | 8108 | host via launchd port-forward 8108 | Search + telemetry store |
| system-bus-worker | Deployment | ClusterIP | 3111 | in-cluster only | Cluster-role worker (12 functions) |
| docs-api | Deployment | NodePort | 3838 | 3838 | PDF/docs API |
| livekit-server | Deployment (Helm) | NodePort | 80, 7881 | 7880 (for svc port 80), 7881 | LiveKit signaling + rtc tcp |
| bluesky-pds | Deployment (Helm-managed) | NodePort | 3000 | 3000 | AT Proto PDS |

### Control-plane access
- kube API exposed locally at `127.0.0.1:64784` (forwarded)
- additional forwarded control ports observed: `64785`, `9627` (**exact ownership mapping UNKNOWN — needs manual verification**)

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
| 8288 | ssh forward (Colima) -> Inngest svc | Inngest API + dashboard backend | NodePort + host forward; proxied via Caddy 9443 |
| 8289 | ssh forward (Colima) -> Inngest ws | Inngest connect websocket | NodePort + host forward; proxied via Caddy 8290 |
| 6379 | ssh forward (Colima) -> Redis | Redis | NodePort + host forward |
| 8108 | ssh forward / kubectl port-forward | Typesense API | ClusterIP; exposed locally by port-forward |
| 3838 | ssh forward (Colima) -> docs-api | docs-api HTTP | NodePort + host forward; proxied via Caddy 5443 |
| 7880 | ssh forward (Colima) -> livekit-server | LiveKit signaling | NodePort 7880; proxied via Caddy 7443 |
| 7881 | ssh forward (Colima) -> livekit-server | LiveKit RTC TCP | NodePort 7881 |
| 3000 | k8s bluesky-pds NodePort | Bluesky PDS HTTP | NodePort 3000 |
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
| 64784 | ssh forward | Kubernetes API | local kubectl endpoint |

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

## Inngest state
- StatefulSet PVC mounted at `/data`
- `INNGEST_SQLITE_DIR=/data`

## NAS (ADR-0088 + ADR-0187)

Tiering policy:
- Tier 1 local SSD (hot runtime state)
- Tier 2 NAS NVMe (`/Volumes/nas-nvme` ↔ `/volume2/data`)
- Tier 3 NAS HDD (`/Volumes/three-body`)

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
