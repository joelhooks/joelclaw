---
status: deferred
date: 2026-02-23
---

# ADR-0112: Unified Caching Layer

## Context

joelclaw integrates with 6+ external APIs (Front, Todoist, Granola, Convex, PDS, Typesense) and reads local resources (Vault, session transcripts). Every interaction re-fetches from source. There is no shared caching strategy — only ad-hoc Redis cooldowns for notification dedup.

This costs:
- **Latency**: `joelclaw email read` takes 2-5s per thread. Gateway agent reads the same threads repeatedly.
- **Rate limits**: Granola MCP aggressively throttles. Front API has undocumented limits. Todoist webhooks echo back.
- **Token waste**: Agent sessions re-read the same Vault files, email threads, and task lists across turns.
- **Fragility**: When APIs are down, the entire CLI surface fails. No stale fallback.

The email CLI now has file-based thread/attachment caching (uncommitted, in progress). This ADR generalizes that pattern into a system-wide caching layer.

## Decision

### Cache tiers

| Tier | Backend | TTL | Use case |
|------|---------|-----|----------|
| **Hot** | Redis | 5-60 min | API responses, task lists, meeting lists, search results |
| **Warm** | File (~/.cache/joelclaw/) | 1-24 hr | Email threads, attachments, media, transcripts |
| **Cold** | NAS (/Volumes/nas-nvme/cache/) | 7-30 days | Large media, full conversation archives, model artifacts |

### Key schema

```
cache:{service}:{resource}:{id}
```

Examples:
- `cache:front:thread:cnv_abc123` — email thread JSON
- `cache:todoist:tasks:all` — full task list snapshot
- `cache:granola:meetings:list` — meeting list response
- `cache:typesense:search:{hash}` — search result by query hash

### Invalidation

1. **TTL expiry** — primary strategy. Each service defines a default TTL.
2. **Webhook-driven** — Todoist, Front, and Vercel webhooks clear relevant cache keys on mutation events.
3. **CLI `--refresh`** — every cached CLI command supports `--refresh` to bypass and rewrite cache.
4. **Write-through** — mutations (close task, archive email) update the cache inline.

### Service defaults

| Service | Hot TTL | Warm TTL | Invalidation |
|---------|---------|----------|-------------|
| Front email | 15 min | 4 hr | front.message.received webhook |
| Todoist tasks | 5 min | — | todoist.task.* webhooks |
| Granola meetings | 30 min | 24 hr | TTL only (no webhook) |
| Typesense search | 5 min | — | TTL only |
| Vault files | — | 60 min | content-sync watcher |
| PDS records | 15 min | — | TTL only |

### Attachment/media caching

Large binary content (email attachments, Telegram media, video thumbnails) caches to the warm file tier:

```
~/.cache/joelclaw/email/attachments/{conversation_id}/{filename}
~/.cache/joelclaw/media/{hash}.{ext}
```

Content-addressed where possible (SHA-256 of URL or content). NAS cold tier for files >10MB or older than 7 days.

### Implementation

1. **`packages/system-bus/src/lib/cache.ts`** — shared cache module with `get/set/invalidate/wrap` helpers. `wrap(key, ttl, fetcher)` is the primary API — returns cached value or calls fetcher and caches result.
2. **Redis client reuse** — uses the existing singleton Redis client, not new connections.
3. **File cache** — atomic write (write to `.tmp`, rename) to prevent partial reads.
4. **OTEL instrumentation** — cache hit/miss/invalidation events for observability.
5. **CLI integration** — all `joelclaw` commands that fetch external data use `cache.wrap()`. `--refresh` flag on every cached command.

### What this does NOT cover

- **Convex caching** — Convex handles its own caching and real-time invalidation. Leave it alone.
- **CDN/edge caching** — Vercel handles static asset caching. Not in scope.
- **Session transcript caching** — already on local disk, no API involved.

## Consequences

- External API calls drop 80%+ for repeated reads (email triage, task review, meeting checks).
- Gateway agent sessions become resilient to API outages via stale fallback.
- Granola rate limit pressure drops significantly — cached meeting lists serve 30min windows.
- Cache coherence is eventually consistent (TTL-based), acceptable for this use case.
- Disk usage grows (~/.cache/joelclaw/) — mitigated by TTL-based eviction and cold tier rotation to NAS.
