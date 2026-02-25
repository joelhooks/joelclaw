---
status: accepted
date: 2026-02-18
decision-makers: joel
tags:
  - atproto
  - pds
  - kubernetes
  - bento
  - infrastructure
  - architecture
supersedes:
related:
  - "0004-atproto-federation-native-app"
  - "0029-replace-docker-desktop-with-colima"
  - "0041-first-class-media-from-channels"
---

# ADR-0044: Private-First PDS with Bento Bridge

## Context

ADR-0004 established AT Protocol as the bedrock of joelclaw — every record lives on a PDS, Inngest orchestrates, clients are AppViews. That ADR is accepted but had zero implementation.

Meanwhile, the system has been building the layers *around* the PDS without calling them that:

- **Media pipeline** (ADR-0041) produces structured data (descriptions, transcripts, MIME types) — a lexicon waiting to be formalized
- **NAS video archive** on three-body — content-addressed storage, the future PDS data plane
- **slog** produces structured log entries — direct mapping to `dev.joelclaw.system.log` records
- **Inngest event bus** already describes data flows — maps to PDS firehose patterns
- **Agent identity** (bot app, DID, Telegram bot) — identity layer already exists

The question is how to get from "fully designed, zero code" to "running PDS with real data flowing through it" without solving the hard problems (DNS, TLS, public exposure, federation) upfront.

## Decision

**Deploy a private-first PDS to the existing k8s cluster, accessible only via Tailscale. Use Bento as a declarative stream processor to bridge PDS ↔ Inngest. Federation comes later.**

### What "private-first" means

- PDS runs in `joelclaw` k8s namespace alongside inngest-0, qdrant-0, redis-0
- Reachable only via Tailscale (port-forward or Caddy proxy on tailnet)
- No internet exposure, no public DNS, no TLS cert from a public CA
- DID registered with plc.directory (outbound call works, inbound resolution fails for external parties — that's fine)
- No crawlers, no relay subscription, no Bluesky network participation
- Custom `dev.joelclaw.*` records written/read via XRPC from Inngest functions and CLI

### What Bento does

Bento (WarpStream fork of Benthos) is a Go stream processor deployed as a k8s pod. It replaces what would otherwise be a custom Node.js firehose subscriber and XRPC write-back service.

Two stream pipelines:

1. **PDS → Inngest**: WebSocket input subscribing to PDS firehose (`com.atproto.sync.subscribeRepos`) → filter for `dev.joelclaw.*` collections → transform to Inngest event format → HTTP POST to Inngest event API
2. **Inngest → PDS**: Redis pub/sub input (existing event bridge) → transform to XRPC `createRecord` payloads → HTTP POST to PDS

Bento runs in streams mode — multiple pipeline configs in a single ConfigMap. Declarative, not application code. Built-in retries, backpressure, reconnection, Prometheus metrics.

### Cluster topology after deployment

```
joelclaw namespace:
  inngest-0    — event bus + function orchestration
  qdrant-0     — vector search (indexes PDS records + Vault)
  redis-0      — cache + pub/sub + ephemeral state
  pds-0        — AT Proto personal data server
  bento-0      — stream processor (PDS ↔ Inngest bridge)
```

## Implementation

### Phase 1: PDS (done)

- [x] Generate secrets (JWT, admin password, PLC rotation key) → stored in agent-secrets
- [x] Helm install `nerkho/bluesky-pds` v0.4.2 into `joelclaw` namespace
- [x] Create account — DID `<internal-did>`, handle `<internal-pds-handle>`
- [x] Write test records: `dev.joelclaw.system.log`, `dev.joelclaw.media.processed`
- [x] Verify XRPC read/write via port-forward on 2583
- [x] Values file at `infra/pds/values.yaml` (secrets reference `existingSecret`, not plaintext)

### Phase 1.5: Operational tooling (done)

- [x] `joelclaw pds` CLI subcommand tree: health, describe, collections, records, write, delete, session
- [x] PDS Effect service (`~/Code/joelhooks/joelclaw-cli/src/pds.ts`) — XRPC client with auto-session management
- [x] Auto-lease credentials from agent-secrets (no manual env var setup needed)
- [x] Session caching at `~/.joelclaw/pds-session.json` with auto-refresh
- [x] HATEOAS JSON output on all commands
- [x] PDS skill at `~/.agents/skills/pds/` — operational guide, symlinked to pi + claude

### Phase 2: Lexicon definitions

- [ ] Define `dev.joelclaw.system.log` lexicon JSON (mirrors slog schema)
- [ ] Define `dev.joelclaw.media.processed` lexicon JSON (mirrors ADR-0041 output)
- [ ] Define `dev.joelclaw.memory.observation` lexicon JSON (mirrors ADR-0020 shape)
- [ ] Store lexicon files in `packages/lexicons/` or `infra/pds/lexicons/`
- [ ] Optional: generate TypeScript types from lexicons via `@atproto/lex-cli`

### Phase 3: Bento bridge

- [ ] Helm install `warpstreamlabs/bento` into `joelclaw` namespace
- [ ] Stream config: PDS firehose (WebSocket) → filter `dev.joelclaw.*` → Inngest HTTP POST
- [ ] Stream config: Redis pub/sub `pds:write` channel → XRPC `createRecord`
- [ ] Auth: PDS session token managed by Bento (refresh on expiry)
- [ ] ConfigMap for stream definitions, values file at `infra/bento/values.yaml`

### Phase 4: Wire existing pipelines

- [ ] `media-process` Inngest function writes `dev.joelclaw.media.processed` record to PDS (via Redis → Bento → XRPC, or direct XRPC call from step)
- [ ] slog writes `dev.joelclaw.system.log` record to PDS alongside JSONL
- [ ] Memory observation pipeline writes `dev.joelclaw.memory.observation` to PDS
- [ ] Qdrant indexes PDS records (via Bento → Inngest → embedding function)

### Phase 5: Persistent access

- [ ] Add PDS to Caddy config for Tailscale HTTPS (`<internal-tailnet-host>` → `svc/bluesky-pds:3000`)
- [ ] Or: launchd plist for persistent `kubectl port-forward`
- [ ] Add PDS health to `joelclaw-system-check` skill

### Future (not this ADR)

- Public DNS + TLS for federation (ADR-0004 Phase 0 step 3+)
- Family PDS instances
- Relay deployment
- iPhone app connecting via XRPC
- NAS-backed storage (replace local-path PVC with NFS/three-body volume)

## Consequences

### Enables

- **Immediate value**: system data (logs, media, memory) gets a structured, typed, queryable home beyond JSONL and Redis
- **Incremental migration**: existing pipelines don't break — PDS writes are additive alongside current storage
- **Schema-first**: lexicon definitions formalize what's been implicit in Inngest event schemas
- **Bridge pattern**: Bento is swappable — if Jetstream or a custom subscriber is better later, only the ConfigMap changes
- **Federation-ready**: when public access is added, the PDS already has data and the DID is registered

### Risks

- **PDS is a new stateful service** — adds operational burden (backups, upgrades, storage management)
- **Bento is a new dependency** — another thing to monitor, though it's a single Go binary with minimal resource usage
- **Token management**: Bento needs a valid PDS session token; refresh logic must be reliable
- **local-path storage**: PVC on Colima is not durable across cluster rebuilds — NAS-backed storage should come before real data accumulates
- **PDS version drift**: Bluesky ships PDS updates; Helm chart may lag behind

### Non-goals

- Bluesky social features (posts, follows, likes) — this is a personal data server, not a social media account
- Multi-account PDS — Joel only for now, family PDS instances are future work
- Custom AppView — no web UI for browsing PDS records yet
- Lexicon publishing — `dev.joelclaw.*` schemas are private, not registered with `lexicon.community`

## Affected Paths

- `infra/pds/values.yaml` — PDS Helm values (created)
- `infra/bento/values.yaml` — Bento Helm values (Phase 3)
- `infra/bento/streams/` — Bento stream config YAML files (Phase 3)
- `packages/lexicons/` — Lexicon JSON definitions (Phase 2)
- `packages/system-bus/src/inngest/functions/media-process.ts` — add PDS write step (Phase 4)
- `~/Code/joelhooks/slog/` — add PDS write alongside JSONL (Phase 4)

## Verification

- [x] PDS pod running in `joelclaw` namespace
- [x] XRPC health check returns `{"version": "0.4.204"}`
- [x] Custom `dev.joelclaw.*` records can be created and read back
- [x] `describeRepo` shows custom collections
- [ ] Bento pod running, stream pipelines connected
- [ ] `media-process` function output appears as PDS record
- [ ] slog entry appears as PDS record
- [ ] PDS accessible via Tailscale HTTPS (Caddy)

## Notes

- PDS default port is 2583 — used for port-forward: `kubectl port-forward -n joelclaw svc/bluesky-pds 2583:3000`
- PDS image: `ghcr.io/bluesky-social/pds:0.4.204` (100MB)
- Bento image: `ghcr.io/warpstreamlabs/bento:1.2.0` (~50MB)
- `validationStatus: "unknown"` on custom records is expected — PDS is lexicon-agnostic
- Helm chart source: [Nerkho/helm-charts](https://github.com/Nerkho/helm-charts)
- Bento Helm chart: [warpstreamlabs/bento-helm-chart](https://github.com/warpstreamlabs/bento-helm-chart)
- Credit: dame.is for the "personal lexicon" concept; Groundmist project for "AT Proto as legibility layer for local-first software"

## Credits

- **Bluesky / AT Protocol team** — PDS implementation, lexicon-agnostic record storage
- **Nerkho** — PDS Helm chart for Kubernetes
- **WarpStream Labs** — Bento stream processor (Benthos fork)
- **dame.is** — personal lexicon concept (`is.dame.*` records as custom "file formats")
- **Groundmist / grjte** — AT Proto as legibility layer for local-first software
- **Kyle Wilson (kyledev.co)** — PDS on Kubernetes walkthrough
