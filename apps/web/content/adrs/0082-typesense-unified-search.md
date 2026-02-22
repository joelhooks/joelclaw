---
status: shipped
date: 2026-02-20
decision-makers: Joel
tags:
  - adr
  - search
  - infrastructure
  - typesense
  - k8s
type: adr
---

# ADR-0082: Typesense as Unified Search Layer for the JoelClaw Network

## Update (2026-02-21)

- Qdrant is retired from the active k8s runtime and active memory ingestion path.
- `observe.ts`, `joelclaw recall`, `joelclaw search`, and `joelclaw vault search --semantic` are now Typesense-backed.
- `joelclaw inngest memory-e2e` validates observe ingest, Typesense mutation, vector retrieval, and recall in one probe.
- Vault re-indexing was hardened into a queued flow: noisy upstream events (`content/updated`, `discovery/captured`, `system/adr.sync.requested`) now debounce through `typesense/vault-sync-queue` and emit `typesense/vault-sync.requested`.
- `typesense/vault-sync` now processes only `typesense/vault-sync.requested` with single concurrency + throttling, preventing overlapping full-vault scans.
- Targeted indexing is supported with `path`/`paths` payloads: existing files upsert, deleted files remove from `vault_notes`, and full re-index remains fallback.

## Context

The JoelClaw network generates and stores knowledge across many systems: Obsidian vault (~2000+ markdown files), blog posts (14 MDX files), voice call transcripts, memory observations (Qdrant), ADRs, project docs, email summaries, task history, system logs, discovery captures, and video transcripts. Today, searching this corpus uses two mechanisms:

1. **Qdrant** (vector-only) — semantic nearest-neighbor search via `joelclaw recall`. No keyword search, no typo tolerance, no faceting, no filtering by metadata.
2. **ripgrep** via `joelclaw vault search` — exact text matching on vault files only. Fast but no ranking, no fuzzy matching, no semantic understanding.

Neither provides the unified, typo-tolerant, faceted, hybrid (keyword + semantic) search experience the network needs. A voice agent asking "what was that ADR about hexagonal architecture from last month" needs typo tolerance (voice-to-text noise), semantic understanding, AND metadata filtering (type=adr, date range). Neither tool does all three.

### What's Missing

- **Typo tolerance**: Voice STT produces noisy text ("heksagonal" → "hexagonal")
- **Hybrid search**: Combine keyword precision with semantic recall in one query
- **Faceting**: Filter results by `type` (adr/note/transcript/blog), `source` (vault/voice/email), `project`, date ranges
- **Unified index**: Search across ALL data sources in one query, not siloed tools
- **Search analytics**: Track what gets searched, surface popular queries, improve results over time
- **Sub-50ms latency**: Voice agent tools need instant responses

### Why Typesense

[Typesense](https://github.com/typesense/typesense) is an open-source, C++-based search engine purpose-built for this use case:

- **Hybrid search** (keyword + vector) in a single query with tunable `alpha` weighting
- **Built-in auto-embedding**: Can use OpenAI/compatible APIs or local ONNX models to generate embeddings server-side — no separate embedding pipeline needed
- **Typo tolerance**: Core feature, handles up to 2-character edits by default
- **Faceting & filtering**: First-class support for facets, filters, geo-search
- **Sub-50ms latency**: C++ engine, optimized data structures (HNSW for vectors, inverted index for text)
- **Multi-search**: Query multiple collections in one API call (Union Search in v30)
- **Analytics**: Built-in search analytics, popular queries, click tracking (v30 adds global analytics rules)
- **Simple operation**: Single binary, single port (8108), data directory + API key = done
- **Active development**: v30.1 released Jan 28, 2026. Features: MMR diversity, global synonyms/curations, IPv6, facet sampling
- **TypeScript client**: `typesense` npm package with full API coverage
- **Helm-deployable**: StatefulSet with PVC — fits our existing Talos k8s cluster pattern

### Alternatives Considered

| Option | Verdict |
|--------|---------|
| **Elasticsearch/OpenSearch** | Massively over-engineered for our scale. JVM, complex config, high memory. |
| **Meilisearch** | Good but weaker vector/hybrid search. No built-in embedding generation. |
| **Qdrant alone** | No keyword search, no typo tolerance, no faceting. Already have it — not enough. |
| **SQLite FTS5** | No vector search, no server, would require building everything ourselves. |
| **Tantivy/Sonic** | Rust search libraries — would need to build the server layer ourselves. |

## Decision

Deploy Typesense v30.1 to the joelclaw k8s cluster as the unified search layer for the entire JoelClaw network. Build and maintain custom Helm charts at `~/Code/joelhooks/typesense-helm-charts/`. **Typesense replaces Qdrant** — it handles both vector search (auto-embedding) and keyword search in one system, eliminating the need for a separate vector DB at our scale (1,355 observations).

### Architecture

```
                    ┌──────────────────────────────┐
                    │       Data Sources           │
                    │  Vault · Blog · Transcripts  │
                    │  ADRs · Email · Tasks · Logs │
                    └──────────┬───────────────────┘
                               │ indexing pipeline
                               │ (Inngest functions)
                    ┌──────────▼───────────────────┐
                    │       Typesense v30.1        │
                    │  ┌─────────┐ ┌────────────┐  │
                    │  │Inverted │ │  HNSW Vec  │  │
                    │  │ Index   │ │   Index    │  │
                    │  └─────────┘ └────────────┘  │
                    │  Hybrid Search · Facets      │
                    │  Typo Tolerance · Analytics   │
                    └──────────┬───────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
        ┌─────▼────┐   ┌──────▼─────┐   ┌──────▼──────┐
        │joelclaw  │   │  Voice     │   │ joelclaw.com│
        │  CLI     │   │  Agent     │   │   (web UI)  │
        │search cmd│   │  tools     │   │  search bar │
        └──────────┘   └────────────┘   └─────────────┘
```

### Collections Design

```
vault_notes          — Obsidian vault documents
  fields: id, title, content, type (adr/note/project/resource/daily),
          tags[], path, project, created_at, updated_at,
          embedding (auto, from content)

blog_posts           — joelclaw.com MDX content
  fields: id, title, slug, content, summary, tags[], published_at,
          embedding (auto, from title+content)

voice_transcripts    — Call transcripts from voice agent
  fields: id, content, speaker, room, timestamp, turns,
          embedding (auto, from content)

memory_observations  — Agent memory observations (mirrors Qdrant)
  fields: id, observation, source, session_id, timestamp, score,
          embedding (auto, from observation)

email_summaries      — Triaged email summaries
  fields: id, subject, from, summary, category, timestamp,
          embedding (auto, from subject+summary)

system_log           — slog entries
  fields: id, action, tool, detail, reason, timestamp

discoveries          — Captured discoveries/bookmarks
  fields: id, title, url, summary, tags[], timestamp,
          embedding (auto, from title+summary)
```

### Helm Chart Design (`~/Code/joelhooks/typesense-helm-charts/`)

Modern, production-quality Helm chart for single-node and HA deployments:

```
typesense-helm-charts/
├── charts/
│   └── typesense/
│       ├── Chart.yaml              # v0.1.0, appVersion 30.1
│       ├── values.yaml             # Sensible defaults for single-node
│       ├── values-ha.yaml          # HA overrides (3 replicas)
│       ├── templates/
│       │   ├── _helpers.tpl
│       │   ├── statefulset.yaml    # Core workload
│       │   ├── service.yaml        # ClusterIP (API port 8108)
│       │   ├── service-headless.yaml # For StatefulSet DNS (peering)
│       │   ├── secret.yaml         # API key from values or existing secret
│       │   ├── configmap.yaml      # Optional: nodes list for HA
│       │   ├── health-check.yaml   # Readiness probe (GET /health)
│       │   ├── NOTES.txt
│       │   └── tests/
│       │       └── test-connection.yaml
│       └── README.md
├── .github/
│   └── workflows/
│       └── release.yaml            # Chart release via GitHub Pages
├── .helmignore
└── README.md
```

**Key values.yaml decisions:**

```yaml
image:
  repository: typesense/typesense
  tag: "30.1"
  pullPolicy: IfNotPresent

replicas: 1                          # Single node for joelclaw (scale later)

apiKey:
  existingSecret: ""                 # Use existing k8s secret
  secretKey: "api-key"
  value: ""                          # Or set directly (not recommended)

persistence:
  enabled: true
  storageClass: "local-path"         # Matches our Talos cluster
  size: 5Gi                          # Vault is <100MB, room to grow
  accessMode: ReadWriteOnce

resources:
  requests:
    cpu: 100m
    memory: 256Mi
  limits:
    cpu: "2"
    memory: 1Gi                      # Typesense is memory-efficient

service:
  type: ClusterIP
  port: 8108

server:
  enableCors: false                  # Internal only — agents access via CLI/SDK
  threadPoolSize: ""                 # Default: NUM_CORES * 8
  cacheNumEntries: 1000
  enableSearchAnalytics: true
  analyticsFlushInterval: 60

probes:
  readiness:
    enabled: true
    path: /health
    initialDelaySeconds: 10
    periodSeconds: 10
  liveness:
    enabled: false                   # Typesense docs warn against liveness probes
```

### Integration Points

1. **`joelclaw search` CLI command** — New command that queries Typesense, returns HATEOAS JSON with faceted results
2. **Voice agent `search` tool** — Replaces current `search_vault` (Qdrant-only), adds hybrid search
3. **Indexing pipeline** — Inngest functions triggered on vault changes, blog deploys, voice calls, observations
4. **joelclaw.com search** — Future: client-side search with scoped read-only API key
5. **TypeScript client** in system-bus — `typesense` npm package for indexing and querying

### Deployment Plan

**Phase 1: Infrastructure** ✅ DONE
- ~~Create Helm chart~~ → Used raw k8s manifest (`k8s/typesense.yaml`)
- Deployed StatefulSet `typesense-0` to k8s `joelclaw` namespace on port 8108
- API key stored in `agent-secrets` as `typesense_api_key`
- Access via `kubectl port-forward` (Tailscale operator planned for persistent access)

**Phase 2: Indexing** ✅ DONE
- 6 collections created with auto-embedding (`ts/all-MiniLM-L12-v2`, local ONNX)
- vault_notes: 747 docs, blog_posts: 13 docs, system_log: 577 docs
- memory_observations: 1,355 migrated from Qdrant (zero errors)
- Dual-write in `observe.ts` — new observations go to both Qdrant and Typesense
- 3 Inngest sync functions: vault-sync (on content changes), blog-sync (on Vercel deploy), full-sync (daily 3am cron)

**Phase 3: Search Interface** ✅ DONE
- `joelclaw search` CLI — multi-collection, typo-tolerant, faceted, filterable
- `joelclaw recall` migrated from Qdrant to Typesense — eliminates `embed.py` Python dependency
- Voice agent search tool: pending swap
- Search-only API key for web UI: pending

**Phase 4: Analytics & Tuning** — NOT STARTED
- Enable search analytics, track popular queries
- Tune hybrid search alpha (keyword vs semantic weighting)
- Add synonyms (e.g., "k8s" = "kubernetes", "ADR" = "architecture decision record")
- Add curations (pin important results for common queries)

### Qdrant Replacement

Typesense fully replaces Qdrant. At 1,355 memory observations, Qdrant's specialized vector DB features (quantization, sharding) are irrelevant. Typesense provides the same vector operations plus keyword search, typo tolerance, and faceting.

| Qdrant operation | Typesense equivalent |
|---|---|
| Upsert point with 768-dim vector | Upsert document with auto-embedding field |
| Nearest-neighbor search | `vector_query: "embedding:([], k:10)"` |
| Cosine similarity dedup | Search before insert with `distance_threshold` |
| Local sentence-transformers (embed.py) | Typesense built-in model or OpenAI-compatible API |

**Migration**: Bulk import 1,355 existing points → update `observe.ts` and `recall.ts` → remove `embed.py` → delete Qdrant pod/PVC/service → remove Caddy `:6443` entry.

**What we gain**: Eliminate `embed.py` Python dependency, one fewer pod, one fewer port mapping, hybrid search on memories (keyword + semantic), faceted memory queries by source/date/session.

### Resource Impact

Typesense is lightweight for our data volume:
- **Memory**: ~256MB for <50K documents (our entire corpus is well under this)
- **Disk**: 5Gi PVC (generous — actual data likely <500MB)
- **CPU**: Minimal for single-node, sub-50ms queries
- **Network**: Internal ClusterIP only, no external exposure

Current cluster load (5 pods): Redis, Qdrant, Inngest, PDS, LiveKit. Adding Typesense as the 6th pod is well within the Mac Mini's capacity (32GB RAM, M-series CPU).

## Consequences

### Positive
- **One search to rule them all**: Voice agent, CLI, web UI all search the same index
- **Dramatically better search quality**: Typo tolerance + hybrid ranking + faceting
- **Voice-agent-friendly**: Noisy STT input handled gracefully
- **Self-hosted, no vendor lock-in**: Runs in our k8s cluster, data stays local
- **Search analytics**: Learn what Joel searches for, improve results over time
- **Future web UI**: joelclaw.com gets a proper search bar with instant results

### Negative
- **Indexing pipeline work**: Must build Inngest functions to keep Typesense in sync
- **Migration effort**: Port observe.ts/recall.ts from Qdrant client to Typesense client

### Risks
- **Data freshness**: Index must stay in sync with source data — solved by event-driven indexing via Inngest
- **Schema evolution**: Collection schema changes require re-indexing — mitigated by Typesense's alter schema API
- **Helm chart maintenance**: Custom chart means we own updates — but Typesense's simple config makes this low-effort

## References

- [Typesense GitHub](https://github.com/typesense/typesense) — 25.2K stars, C++, GPLv3
- [Typesense v30 API docs](https://typesense.org/docs/30.1/api/)
- [Typesense vector/hybrid search](https://typesense.org/docs/29.0/api/vector-search.html)
- [Typesense server configuration](https://typesense.org/docs/29.0/api/server-configuration.html)
- [typesense-js npm client](https://www.npmjs.com/package/typesense) — v3.0.0 for Typesense v30
- [Spittal/typesense-helm](https://github.com/Spittal/typesense-helm) — outdated (v0.13), referenced for structure only
- [akyriako/typesense-helm](https://github.com/akyriako/typesense-helm) — modern alternative with peer resolver sidecar
- [Typesense Kubernetes Operator](https://github.com/akyriako/typesense-operator) — CRD-based, heavier than we need
- ADR-0029: Colima + Talos k8s cluster
- ADR-0044: PDS Helm deployment pattern
- ADR-0077: Memory system build order (Qdrant pipeline)
