---
status: "proposed"
date: 2026-02-14
decision-makers: "Joel Hooks"
consulted: "Claude (pi session 2026-02-14)"
informed: "All agents operating on this machine"
---

# Adopt Prometheus + Grafana for system observability

## Context and Problem Statement

The Mac Mini runs 3 Docker containers (Inngest, Qdrant, Redis), a Bun worker (system-bus), and Caddy — all managed via Docker Compose and launchd. AGENTS.md principle #2 states **"Observability over opacity — if you can't see it, you can't fix it."**

Today, observability is ad-hoc: the Inngest dashboard shows workflow traces, Docker healthchecks probe containers, `slog` logs config changes, and Qdrant exposes Prometheus metrics that nobody scrapes. There is no metrics history, no unified dashboard, no alerting, and no system-level visibility (CPU, memory, disk). Logs are scattered across Docker stdout, launchd stderr, and `system-log.jsonl`.

**The question: How should this single-machine personal system collect, store, visualize, and alert on operational metrics — given an 8GB RAM budget and one operator?**

## Decision Drivers

* **8GB RAM constraint** — current Docker containers use ~411MB; every new container costs real memory
* **Single operator** — Joel only; no on-call rotation, no team dashboards, no multi-tenant concerns
* **Already running Docker Compose** — adding containers is operationally cheap (one `docker compose up`)
* **AGENTS.md principle #2** — "Observability over opacity" is a stated system value
* **Tailscale access** — dashboards should be reachable from any device on the tailnet, not just SSH
* **Prototype stage** — avoid over-engineering; favor reversible choices
* **Existing Prometheus surface** — Qdrant already serves `/metrics` in Prometheus format; Redis and the host can be instrumented cheaply

## Considered Options

* **Option 1: Prometheus + Grafana stack** — industry-standard metrics pipeline with optional Loki for logs
* **Option 2: Lightweight custom approach** — extend `slog` or build a Bun/TypeScript metrics collector writing to SQLite
* **Option 3: Do nothing yet** — continue ad-hoc checks; revisit when complexity grows

## Decision Outcome

Chosen option: **"Option 1: Prometheus + Grafana stack"**, because the infrastructure already exists to support it (Docker Compose, Qdrant metrics endpoint, Caddy for HTTPS), the memory cost is manageable (~150–200MB total for Prometheus + Grafana), and it provides a battle-tested foundation that grows with the system. A custom approach (Option 2) would require building and maintaining bespoke tooling for a problem that's already well-solved. Doing nothing (Option 3) violates the stated observability principle and leaves pipeline failures silent.

**However** — implement in phases. Start with Prometheus + node_exporter only (Phase 1), add Grafana when dashboards are needed (Phase 2), and defer Loki/log aggregation until log volume or scatter actually causes pain (Phase 3).

### Consequences

* Good, because Qdrant metrics are immediately captured with zero code changes
* Good, because `node_exporter` provides Mac Mini CPU/memory/disk/temp visibility — the biggest current blind spot
* Good, because Grafana alerting can notify on pipeline failures, disk pressure, or container restarts
* Good, because Caddy + Tailscale makes dashboards accessible from iPhone/iPad/laptop
* Good, because Prometheus + Grafana are universally understood — vast ecosystem of dashboards, exporters, and docs
* Bad, because it adds ~150–200MB RAM to an 8GB machine (bringing Docker total to ~600MB)
* Bad, because Prometheus retention on a Mac Mini should be short (15 days) to avoid disk bloat
* Bad, because Grafana adds operational surface area (auth, provisioning, upgrades)
* Neutral, because the Inngest dashboard remains the primary tool for workflow debugging — Grafana supplements but doesn't replace it

## Implementation Plan

### Phase 1: Metrics Collection (Prometheus + exporters)

Add to `~/Code/system-bus/docker-compose.yml`:

```yaml
  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus/prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus_data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.retention.time=15d'
      - '--storage.tsdb.retention.size=1GB'
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:9090/-/healthy"]
      interval: 30s
      timeout: 5s
      retries: 3

  redis-exporter:
    image: oliver006/redis_exporter:latest
    ports:
      - "9121:9121"
    environment:
      - REDIS_ADDR=redis://redis:6379
    depends_on:
      - redis
    restart: unless-stopped

  node-exporter:
    image: prom/node-exporter:latest
    ports:
      - "9100:9100"
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
    command:
      - '--path.procfs=/host/proc'
      - '--path.sysfs=/host/sys'
    restart: unless-stopped
```

> **Note on node_exporter**: The Linux container image won't expose macOS-specific metrics. For full Mac Mini visibility, consider running `node_exporter` natively via Homebrew (`brew install node_exporter`) and scraping `host.docker.internal:9100` instead. Alternatively, use a macOS-compatible exporter like `macos_exporter`. Evaluate during implementation.

Create `~/Code/system-bus/prometheus/prometheus.yml`:

```yaml
global:
  scrape_interval: 30s
  evaluation_interval: 30s

scrape_configs:
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

  - job_name: 'qdrant'
    static_configs:
      - targets: ['qdrant:6333']

  - job_name: 'redis'
    static_configs:
      - targets: ['redis-exporter:9121']

  - job_name: 'node'
    static_configs:
      - targets: ['host.docker.internal:9100']  # if running natively
      # - targets: ['node-exporter:9100']        # if running in Docker
```

**Estimated memory**: Prometheus ~80–100MB, redis_exporter ~10MB, node_exporter ~15MB.

### Phase 2: Dashboards (Grafana)

Add to `docker-compose.yml`:

```yaml
  grafana:
    image: grafana/grafana-oss:latest
    ports:
      - "3000:3000"
    volumes:
      - grafana_data:/var/lib/grafana
      - ./grafana/provisioning:/etc/grafana/provisioning
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD}
      - GF_USERS_ALLOW_SIGN_UP=false
      - GF_AUTH_ANONYMOUS_ENABLED=false
    depends_on:
      - prometheus
    restart: unless-stopped
```

Create `~/Code/system-bus/grafana/provisioning/datasources/prometheus.yml`:

```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
```

Add Caddy route for Tailscale HTTPS access:

```
grafana.three-body.tail[...].ts.net {
    reverse_proxy localhost:3000
    tls /path/to/tailscale/certs/cert.pem /path/to/tailscale/certs/key.pem
}
```

**Estimated memory**: Grafana ~50–80MB.

**Initial dashboards** (import from Grafana marketplace):
- Node Exporter Full (ID: 1860) — CPU, memory, disk, network
- Redis Dashboard (ID: 763) — connections, memory, commands/sec
- Qdrant — custom or community dashboard using the exposed metrics

### Phase 3: Log Aggregation (Loki) — Deferred

Only add Loki when scattered logs actually cause debugging pain. When ready:
- Loki container (~40MB) + Promtail sidecar
- Scrape Docker container logs + launchd stderr + system-log.jsonl
- Grafana Explore for unified log search

### Alerting Rules (Phase 2)

Start with a small set of high-signal alerts. Add to Prometheus rules or Grafana alerts:

| Alert | Condition | Why it matters |
|-------|-----------|----------------|
| **Disk > 80%** | `node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.2` | Mac Mini has limited SSD; video ingest fills disk |
| **Container restart** | `increase(container_restart_count[5m]) > 0` | Inngest/Qdrant/Redis crashed and restarted |
| **Qdrant memory > 1GB** | `qdrant_memory_allocated_bytes > 1e9` | Vector store growing beyond budget on 8GB machine |
| **Redis memory > 200MB** | `redis_memory_used_bytes > 2e8` | Approaching the 256MB maxmemory limit |

Alert delivery: start with Grafana → webhook → Inngest event (`system/alert`), which the system-logger can write to system-log.jsonl. Add Telegram/Slack/email later.

* **Affected paths**: `~/Code/system-bus/docker-compose.yml`, new `~/Code/system-bus/prometheus/` dir, new `~/Code/system-bus/grafana/` dir, `~/.local/caddy/Caddyfile`
* **Dependencies**: Docker images `prom/prometheus`, `oliver006/redis_exporter`, `prom/node-exporter`, `grafana/grafana-oss`. Optionally `brew install node_exporter` for native macOS metrics.
* **Patterns to follow**: All new services go in the existing `docker-compose.yml`. Caddy routes follow existing pattern in Caddyfile. Credentials via `agent-secrets`.
* **Patterns to avoid**: Do NOT expose Grafana or Prometheus to the public internet — Tailscale only. Do NOT set Prometheus retention beyond 15 days on this machine. Do NOT add Loki in Phase 1 or 2.
* **Configuration**: Store `GRAFANA_ADMIN_PASSWORD` in agent-secrets. Prometheus config is file-based (no env vars needed).
* **Migration steps**: None — this is additive. Existing services are unchanged.

### Verification

#### Phase 1

- [ ] `docker compose up` starts Prometheus, redis-exporter, and node-exporter without errors
- [ ] `curl -s http://localhost:9090/api/v1/targets` shows Qdrant, Redis, and node targets as `"health": "up"`
- [ ] `curl -s http://localhost:9090/api/v1/query?query=up` returns results for all scrape targets
- [ ] `docker stats --no-stream` shows Prometheus using < 120MB
- [ ] Total Docker memory (all containers) stays under 700MB

#### Phase 2

- [ ] Grafana accessible at `https://grafana.<tailscale-hostname>/` from another tailnet device
- [ ] Prometheus datasource shows "Data source is working" in Grafana → Settings → Data Sources
- [ ] At least one dashboard shows live Qdrant and Redis metrics
- [ ] Disk usage alert fires when manually tested (e.g., lower threshold temporarily)

## Pros and Cons of the Options

### Option 1: Prometheus + Grafana stack

Industry-standard observability stack. Prometheus scrapes metrics endpoints on a schedule and stores time-series data. Grafana visualizes and alerts.

* Good, because Qdrant `/metrics` works out of the box — zero code changes
* Good, because `redis_exporter` and `node_exporter` are mature, single-binary, low-overhead
* Good, because Grafana has thousands of pre-built dashboards — no custom UI work
* Good, because alerting is built into Grafana — webhook, email, Slack, Telegram
* Good, because universal knowledge — any future collaborator (human or agent) knows this stack
* Neutral, because 30s scrape interval is plenty for a personal system (not real-time)
* Bad, because adds ~150–200MB RAM across 3–4 new containers
* Bad, because `node_exporter` in Docker on macOS has limited host visibility — may need native install
* Bad, because Grafana provisioning (dashboards-as-code) has a learning curve
* Bad, because it's arguably over-built for 3 containers on one machine

### Option 2: Lightweight custom approach

Build a Bun/TypeScript service that periodically polls `docker stats`, Qdrant `/metrics`, Redis `INFO`, and writes to SQLite. Query via CLI (`slog`-style) or a minimal web UI.

* Good, because zero new containers — runs as another Inngest function or launchd service
* Good, because full control over what's collected and how it's stored
* Good, because SQLite + Bun is extremely lightweight (~10MB)
* Good, because fits the "build tools you understand" philosophy
* Bad, because building a metrics collector, storage layer, query API, and alerting from scratch is significant work
* Bad, because no pre-built dashboards — every visualization is custom
* Bad, because alerting would need to be built from scratch
* Bad, because not portable — future collaborators can't leverage existing knowledge
* Bad, because it reinvents what Prometheus already does well

### Option 3: Do nothing yet

Continue using `docker stats`, `curl`, Inngest dashboard, and `slog tail` for ad-hoc checks. Revisit when the system grows.

* Good, because zero additional resource usage
* Good, because no new operational surface area to maintain
* Good, because the system is young — unclear what metrics actually matter yet
* Bad, because Qdrant metrics are generated and immediately discarded — wasted signal
* Bad, because pipeline failures are silent — you discover them hours or days later
* Bad, because "do nothing" contradicts AGENTS.md principle #2 ("Observability over opacity")
* Bad, because as more Inngest functions are added, the blind spots compound

## More Information

### Related ADRs

- [ADR-0002](0002-personal-assistant-system-architecture.md): Established vault as single source of truth and "observability over opacity" as a core principle
- [ADR-0005](0005-durable-multi-agent-coding-loops.md): Multi-agent Inngest pipelines that produce the workflow traces needing observability

### Memory Budget

| Service | Current | After Phase 1 | After Phase 2 |
|---------|---------|----------------|----------------|
| Inngest | 78 MB | 78 MB | 78 MB |
| Qdrant | 312 MB | 312 MB | 312 MB |
| Redis | 21 MB | 21 MB | 21 MB |
| Prometheus | — | ~100 MB | ~100 MB |
| redis_exporter | — | ~10 MB | ~10 MB |
| node_exporter | — | ~15 MB | ~15 MB |
| Grafana | — | — | ~70 MB |
| **Total** | **411 MB** | **~536 MB** | **~606 MB** |

Leaves ~7GB for macOS, the Bun worker, pi, Claude Code, and other processes. Acceptable.

### Revisit Triggers

- If total Docker memory exceeds 1GB → re-evaluate what's running or increase to 16GB RAM
- If Prometheus disk exceeds 1GB → reduce retention or add downsampling
- If Grafana goes unused for 30 days → remove it and keep Prometheus + CLI queries
- If a better macOS-native monitoring solution emerges → evaluate replacing node_exporter
- If Inngest adds native Prometheus metrics → add as scrape target

### Open Questions

- **Inngest `/metrics` auth**: The endpoint returned "Authentication failed." Need to investigate whether the signing key or event key unlocks it. If so, add as a Prometheus scrape target.
- **macOS node_exporter**: The Docker image mounts `/proc` and `/sys` which don't exist on macOS. Need to test whether Homebrew `node_exporter` or a macOS-specific exporter is needed.
- **Alert delivery**: Webhook to Inngest is elegant but circular (monitoring depends on the thing being monitored). May need an independent notification path (e.g., direct Telegram bot).
