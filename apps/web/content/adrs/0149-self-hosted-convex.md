---
status: researching
date: 2026-02-26
decision-makers: joel
---

# ADR-0149: Self-Hosted Convex Backend

## Context

Convex is a reactive backend-as-a-service with real-time subscriptions, ACID transactions, and built-in scheduling. The open-source self-hosted version runs as a single Docker container with SQLite (default) or Postgres/MySQL storage.

Gremlin (the course platform) already uses Convex cloud. The joelclaw k8s cluster runs all core infrastructure on a single Talos node. Self-hosting Convex would add a reactive database layer under full local control.

Reference: https://stack.convex.dev/self-hosted-develop-and-deploy

## Potential Workloads

1. **Gremlin dev/staging** — local Convex instance for development without cloud dependency. `npx convex dev` works identically against self-hosted.
2. **Agent state store** — reactive subscriptions for agent loop status, gateway state, session metadata. Currently spread across Redis keys and Typesense documents.
3. **Event/activity feed** — Convex's real-time queries could power the `/system/events` UI on joelclaw.com, replacing the current Typesense polling.
4. **Structured memory** — agent observations, dossiers, discoveries could live in Convex with full-text search and real-time sync to UI.

## What It Would Replace vs Complement

| Current | Convex Could | Verdict |
|---------|-------------|---------|
| Redis (event bus, message queue, pub/sub) | Convex has scheduling + subscriptions but no pub/sub primitives | **Complement** — Redis stays for pub/sub and ephemeral queues |
| Typesense (OTEL events, search) | Convex has full-text search but not optimized for high-volume append-only logs | **Complement** — Typesense stays for OTEL, Convex for structured app data |
| Inngest (durable functions, cron) | Convex has scheduled functions but no step-based durability | **Keep Inngest** — durable workflows are its strength |
| Postgres/SQLite (none currently in stack) | Convex uses one internally | **New capability** — structured relational-ish data with reactivity |

## Architecture Sketch

```
k8s cluster (joelclaw namespace)
├── convex-backend (StatefulSet, port 3210)
│   └── PVC for SQLite data (or connect to external Postgres)
├── convex-dashboard (optional, port 6791)
└── existing services (Redis, Inngest, Typesense, etc.)
```

Docker port mappings needed: 3210:3210, 6791:6791 (hot-add per ADR-0148 procedure).

## Deployment

```bash
# Docker Compose for local dev
npx degit get-convex/convex-backend/self-hosted/docker/docker-compose.yml
docker compose up

# For k8s: container image
ghcr.io/get-convex/convex-backend:latest
ghcr.io/get-convex/convex-dashboard:latest

# Dev workflow (identical to cloud)
CONVEX_SELF_HOSTED_URL='http://localhost:3210'
CONVEX_SELF_HOSTED_ADMIN_KEY='<generated>'
npx convex dev
```

## Risks

- **Single-node only** — open-source version doesn't horizontally scale. Fine for joelclaw's scale, not for production course platform traffic.
- **Upgrade burden** — migrations and version bumps are manual. No Convex team support.
- **Data locality** — if Convex backend and its database aren't co-located, query latency degrades (cloud does ~1ms, self-hosted varies).
- **Overlap** — adding another stateful service to a single-node cluster increases blast radius. Must justify each workload vs existing stack.

## Open Questions

1. Should gremlin production stay on Convex cloud with self-hosted only for dev/staging?
2. Which agent workload benefits most from reactivity? (Loop status dashboard? Memory UI?)
3. Postgres vs SQLite for the backing store? SQLite is simpler but Postgres enables external access.
4. Resource budget — how much CPU/memory can we allocate given current cluster load?

## Decision

Researching. Next step: spin up a local Docker Compose instance, run the Convex tutorial against it, and evaluate latency + DX before committing to k8s deployment.
