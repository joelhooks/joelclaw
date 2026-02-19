---
status: deferred
date: 2026-02-18
decision-makers: Joel Hooks
consulted: Claude (pi session 2026-02-18)
informed: All agents operating on this machine
related:
  - "[ADR-0002 — Personal assistant system architecture](0002-personal-assistant-system-architecture.md)"
  - "[ADR-0029 — Colima + Talos migration](0029-colima-talos-migration.md)"
---

# Self-host Convex as the real-time data layer for joelclaw.com

## Context and Problem Statement

joelclaw.com is a statically-generated Next.js 16 site with MDX content. It has no database, no auth, no real-time features. Joel wants to add:

1. **Auth** — know who's visiting, gate admin features
2. **Inline comments** — Tufte-style sidenotes anchored to article text, persisted, real-time
3. **Author dashboard** — web-based system health, slog tail, loop status, pipeline activity
4. **Group chat** — real-time conversation on the site (Joel + invited guests)
5. **Network map** — live topology visualization with heartbeat status
6. **Ops stats** — live counters (functions executed, tokens, transcription minutes)

The system already has Redis (state/cache), Qdrant (vectors), Inngest (durable workflows), and a k8s cluster. The question is: what provides the real-time data layer for the web frontend?

### What Convex Is

Convex is a reactive backend-as-a-service: TypeScript functions (queries, mutations, actions) that run server-side with automatic real-time subscriptions. Write a query function, call `useQuery()` in React — the component re-renders when the data changes. No WebSocket setup, no polling, no cache invalidation.

It also includes: built-in auth, file storage, scheduling (cron + one-shot), vector search, full-text search, and HTTP actions. Functions execute in a V8 isolate with ACID transactions.

**Self-hosting:** Fully supported since Feb 2025. Open-source backend + dashboard. Docker container with SQLite (default) or Postgres backing. License: FSL-1.1-Apache-2.0 (converts to Apache-2.0 after 2 years). Production self-hosting explicitly allowed.

### What Convex Is NOT (for this system)

Convex is **not replacing Inngest** for durable workflows. Inngest's step-level durability model (memoized steps, independent retry, event chaining) is battle-tested in this system with 28 functions across two pipelines. Convex has a Workflow component with Inngest-inspired syntax, but it's newer and we'd lose the existing investment.

Convex is also **not replacing Redis** for ephemeral state (gateway event queues, session registration, pub/sub). Redis is purpose-built for that.

**Convex fills the gap:** real-time frontend data that needs persistence, subscriptions, and auth — the features a static site can't provide.

## Decision Drivers

- **Real-time native**: Comments, dashboard, chat all need live updates. Convex's `useQuery` subscriptions are zero-config.
- **Auth built-in**: `@convex-dev/auth` handles OAuth, sessions, user storage. No separate auth provider.
- **TypeScript end-to-end**: Schema → functions → client all typed. Matches the existing stack.
- **Self-host option**: Can run in the existing k8s cluster alongside Redis/Qdrant/Inngest. Full data sovereignty.
- **Cloud option**: Free tier (1M calls/mo) already configured with deploy key in Vercel.
- **Don't add what we don't need**: If Redis + Inngest + static MDX covers a use case, don't add Convex for it.

## Considered Options

### Option A: Convex Cloud (managed)

Use Convex's hosted platform. Deploy key already in Vercel. Zero infrastructure.

**Ports:** 
- Backend API at `*.convex.cloud`
- Dashboard at `dashboard.convex.dev`

**Pros:**
- Zero ops — managed backups, scaling, monitoring
- Preview environments for PRs
- Free tier generous: 1M function calls/mo, 1GB database, 1GB file storage
- Sub-millisecond query latency (co-located backend + storage)

**Cons:**
- Data lives on Convex's infrastructure (US-based)
- Network hop from Mac Mini to Convex Cloud for dashboard/ops features
- If Convex goes down, real-time features go down (static content still works)
- No way to inspect backend internals without their dashboard

### Option B: Self-hosted in k8s (recommended for this system)

Run Convex backend + dashboard as StatefulSets in the existing Talos k8s cluster. SQLite backing initially, Postgres if needed later.

**Services:**
```
convex-backend:  localhost:3210 (API), localhost:3211 (HTTP actions)
convex-dashboard: localhost:6791
```

**K8s manifest sketch:**
```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: convex
  namespace: joelclaw
spec:
  serviceName: convex-svc  # NOT "convex" — same k8s naming lesson as Inngest
  replicas: 1
  template:
    spec:
      containers:
      - name: backend
        image: ghcr.io/get-convex/convex-backend:latest
        ports:
        - containerPort: 3210
        - containerPort: 3211
        env:
        - name: INSTANCE_NAME
          value: "joelclaw"
        - name: INSTANCE_SECRET
          valueFrom:
            secretKeyRef:
              name: convex-secrets
              key: instance-secret
        - name: CONVEX_CLOUD_ORIGIN
          value: "https://convex.joelclaw.com"  # via Caddy + Tailscale cert
        - name: CONVEX_SITE_ORIGIN
          value: "https://convex-site.joelclaw.com"
        volumeMounts:
        - name: data
          mountPath: /convex/data
      - name: dashboard
        image: ghcr.io/get-convex/convex-dashboard:latest
        ports:
        - containerPort: 6791
        env:
        - name: NEXT_PUBLIC_DEPLOYMENT_URL
          value: "https://convex.joelclaw.com"
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 5Gi
```

**Caddy config additions:**
```
convex.joelclaw.com {
  reverse_proxy localhost:3210
  tls { get_certificate tailscale }
}

convex-site.joelclaw.com {
  reverse_proxy localhost:3211
  tls { get_certificate tailscale }
}

convex-dash.joelclaw.com {
  reverse_proxy localhost:6791
  tls { get_certificate tailscale }
}
```

**Pros:**
- Full data sovereignty — everything on the Mac Mini
- No network hop for dashboard/ops (same machine)
- Convex dashboard accessible via Tailscale from phone
- Consistent with existing k8s deployment pattern (Redis, Qdrant, Inngest all self-hosted)
- SQLite backing = simple, no additional Postgres to manage
- Can inspect, backup, export data directly

**Cons:**
- Another StatefulSet to maintain (minor — same pattern as existing services)
- No managed backups — need to set up our own
- No preview environments (Convex Cloud feature)
- ~200-400MB additional RAM for backend + dashboard containers
- Must manage Convex version upgrades manually
- Self-hosted Convex Auth requires manual setup (CLI auto-provision only works with cloud)

### Option C: Hybrid — Cloud for prod, self-hosted for dev

Use Convex Cloud for the production joelclaw.com site (where latency to users matters), self-host a local instance for development and the author dashboard (where local access matters).

**Pros:** Best of both — managed prod, local dev
**Cons:** Two Convex instances to manage, data sync between them, more complexity than the problem warrants for a personal site

### Option D: Don't use Convex — build with existing stack

Use Redis for real-time (pub/sub), Inngest for persistence, build a custom WebSocket layer for the frontend.

**Pros:** No new infrastructure
**Cons:** Significant custom code for what Convex provides out of the box. `useQuery` with automatic subscriptions vs hand-rolling WebSocket state sync is not a close comparison.

## Decision

**Option B — Self-hosted in k8s.** Aligns with the existing self-hosted infrastructure pattern. A personal site doesn't need managed cloud — the Mac Mini is always on, the k8s cluster is stable, and local access for the dashboard is a feature.

Start with SQLite backing. Graduate to Postgres only if write throughput demands it (unlikely for a personal site).

### Phased Rollout

| Phase | Feature | Convex Role | Depends On |
|-------|---------|-------------|------------|
| 0 | Deploy Convex to k8s | Infrastructure | k8s cluster, Caddy |
| 1 | Auth (GitHub OAuth) | User identity, sessions | Phase 0 |
| 2 | Inline comments | Anchored comments with real-time subs | Phase 1, Tufte sidenotes UI |
| 3 | Author dashboard | System health, slog, loops (Convex actions poll Inngest/Redis) | Phase 1 |
| 4 | Group chat | Real-time messages, channels | Phase 1 |
| 5 | Ops stats + network map | Live counters, topology visualization | Phase 3 |

### What Stays Where

| Concern | Tool | Why |
|---------|------|-----|
| Durable workflows | Inngest | Battle-tested, 28 functions, step-level retry |
| Ephemeral state | Redis | Gateway events, session registration, pub/sub |
| Vector search | Qdrant | Embeddings, semantic search |
| Real-time frontend data | **Convex** | Comments, chat, dashboard, auth |
| Static content | MDX files | Articles, ADRs — no database needed |
| System log | slog (JSONL) | Append-only, file-based, Vault-synced |

### Convex ↔ Inngest Bridge

The author dashboard needs data from Inngest (run history, function status) and Redis (gateway events, loop state). Convex actions can reach these:

```typescript
// convex/actions/systemHealth.ts
export const getSystemHealth = action({
  handler: async (ctx) => {
    // Call Inngest API (same machine, via Tailscale or localhost)
    const inngestStatus = await fetch("http://localhost:8288/v1/events?limit=10");
    // Call Redis via HTTP (or direct, if Convex action can reach it)
    // Return structured health data
  },
});
```

Frontend subscribes to the result. Convex caches and rate-limits the polling.

## Consequences

### Positive
- Real-time features become trivial (comments, chat, dashboard all use `useQuery`)
- Auth is built-in, not another provider to manage
- Consistent self-hosted pattern — all infrastructure in one k8s cluster
- TypeScript end-to-end — schema, functions, client all typed
- Convex dashboard gives visibility into the data layer (accessible from phone via Tailscale)

### Negative
- Another service to maintain (5th container in the cluster)
- ~200-400MB additional RAM
- Self-hosted Convex is newer — rougher edges than cloud
- No automatic backups — need a cron to export/snapshot
- Convex Auth manual setup (no CLI auto-provision for self-hosted)

### Risks
- Convex self-hosting is ~1 year old. May hit edge cases cloud users don't.
- FSL license converts to Apache after 2 years — not pure OSS today (mitigated: production use explicitly allowed)
- If Convex backend crashes, real-time features are down (static content unaffected)

## Resource Requirements

| Resource | Estimate |
|----------|----------|
| RAM (backend) | ~200-300MB |
| RAM (dashboard) | ~100-150MB |
| Disk (SQLite) | 5GB PVC (starts near zero) |
| Ports | 3210 (API), 3211 (HTTP actions), 6791 (dashboard) |
| CPU | Minimal for personal-site traffic |

Current cluster overhead: ~915MB for control plane + Redis + Qdrant + Inngest. Adding Convex: ~400MB. Total: ~1.3GB on a 64GB machine.

## References

- [Convex self-hosted README](https://github.com/get-convex/convex-backend/blob/main/self-hosted/README.md)
- [Convex self-hosting blog post](https://news.convex.dev/self-hosting/)
- [Self-hosting guide (bitdoze)](https://www.bitdoze.com/convex-self-host/)
- [Convex Auth docs](https://docs.convex.dev/auth/convex-auth)
- [Convex durable workflows](https://stack.convex.dev/durable-workflows-and-strong-guarantees)
- [Convex + Next.js App Router](https://github.com/get-convex/convex-nextjs-app-router-demo)
- [Convex llms.txt](https://docs.convex.dev/llms.txt) — full docs index for agent consumption
- Tufte sidenotes design: `~/Vault/Projects/09-joelclaw/tufte-sidenotes-design.md`
- Convex integration ideas: `~/Vault/Projects/09-joelclaw/convex-integration-ideas.md`
