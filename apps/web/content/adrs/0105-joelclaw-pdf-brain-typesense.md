---
type: adr
status: proposed
date: 2026-02-22
tags: [adr, pdf-brain, typesense, inngest, joelclaw, knowledge-management, langfuse, otel]
deciders: [joel]
supersedes: []
related: ["0082-typesense-unified-search", "0088-nas-backed-storage-tiering", "0095-typesense-native-memory-categories-skos-lite", "0101-langfuse-llm-only-observability", "0093-agent-friendly-navigation-contract"]
---

# ADR-0105: joelclaw PDF Brain — Document Library as First-Class Network Utility

## Status

proposed

## Context

[`pdf-brain`](https://github.com/joelhooks/pdf-brain) is a standalone CLI that manages a personal document library (PDFs, papers, books, podcast transcripts). It works but sits outside the joelclaw idiom stack:

- **Wrong storage**: SQLite (libsql) + Qdrant — two stores, neither shared across machines, Qdrant is extra infra
- **Not observable**: ingest is synchronous, no OTEL, no Langfuse traces on LLM calls
- **Not durable**: interrupted ingest is lost, no step memoization
- **Not a network utility**: doesn't follow Joel across panda → Mac Studio; not reachable by gateway or pi
- **Not pi-first**: can't ask pi "find me papers on knowledge graphs" and get real results
- **No Typesense**: the canonical joelclaw search stack already has FTS + vector in Typesense (ADR-0082); pdf-brain runs a separate engine

The immediate trigger is migrating ~806 documents (dark-wizard + clanker) to `three-body` (ADR-0088) and building a permanent indexed home for the library. That migration is tracked separately as the `manifest-archive` Inngest function — this ADR covers the permanent system.

---

## Idiom Stack

This system must be built with the full joelclaw idiom stack. Each concern maps to a specific skill implementors should load.

| Concern | Idiom | Skill to load |
|---|---|---|
| Durable ingest pipeline | Inngest functions + steps | `inngest-durable-functions`, `inngest-steps` |
| Event naming + schema | joelclaw event conventions | `inngest-events` |
| Pipeline throughput | Concurrency + throttle | `inngest-flow-control` |
| Non-LLM telemetry | OTEL via `emitMeasuredOtelEvent` | `o11y-logging` |
| LLM tracing | Langfuse generation spans | `langfuse-observability` |
| Search + indexing | Typesense FTS + vector | (existing `joelclaw` OTEL patterns) |
| CLI output contract | HATEOAS JSON envelope | `cli-design` |
| Deployment context | k8s/Typesense always-on | `k8s`, `joelclaw` |
| Taxonomy alignment | SKOS-lite from ADR-0095 | `joelclaw` |

**Finding additional skills:** Use `find-skills` if a new concern emerges during implementation — run `npx skills find <domain>` before writing custom tooling.

---

## Open Questions (the `???`)

Before implementation begins, these idiom choices need to be confirmed:

| # | Question | Options | Recommendation |
|---|---|---|---|
| 1 | **Effect-TS** — pdf-brain already uses Effect for schema/error modeling. Bring it into joelclaw system-bus? | (a) Use Effect for ingest services (b) Plain async/Bun patterns | Decide before coding — don't mix within the package |
| 2 | **PDS records** — store `dev.joelclaw.docs.document` records in the AT Proto PDS for portability? | (a) Typesense-only (b) Typesense + PDS | Cheap to add, durable, portable across machines |
| 3 | **Convex UI** — surface the library at `joelclaw.com/docs` with real-time search? | (a) joelclaw.com page backed by Typesense (b) Convex for real-time updates | If yes, design the Convex schema alongside Typesense |
| 4 | **joelclaw pi skill** — a `docs` skill so pi can query the library mid-conversation | (a) Add `docs` skill to `~/Code/joelhooks/joelclaw/skills/` (b) Handle ad-hoc via Typesense search | Recommend yes — makes the library actually pi-first |

---

## Decision

Implement **joelclaw PDF Brain** as a first-class subsystem inside the joelclaw monorepo:

- **Typesense** as sole backend — metadata, FTS, vector search (no SQLite, no Qdrant)
- **NAS `three-body`** as canonical file store (ADR-0088 Tier 3 HDD)
- **Inngest durable functions** for ingest, enrichment, re-index pipelines
- **Langfuse traces** on every LLM call — enrichment, embedding, taxonomy classification
- **OTEL events** on every non-LLM step — file ops, chunk counts, index writes
- **joelclaw CLI** subcommands following the HATEOAS JSON contract (ADR-0093)
- **Taxonomy** carried from `pdf-brain/data/taxonomy.json` — SKOS-lite aligned with ADR-0095

---

## Model Routing

All LLM calls route through the joelclaw gateway. Explicit model choices:

| Call | Model | Rationale |
|---|---|---|
| Document enrichment (summary, category, docType) | `anthropic/claude-haiku-4-5` | Fast, cheap per-doc batch |
| Taxonomy classification | `anthropic/claude-haiku-4-5` | Structured output, classification task |
| Complex re-enrichment (on request) | `anthropic/claude-sonnet-4-5` | Higher quality for important docs |
| Chunk embedding | `text-embedding-3-small` (1536d) via OpenAI gateway | No Ollama dependency; consistent dims |

Every model call emits a **Langfuse generation span** per ADR-0101. Required correlation fields on every trace:
```
joelclaw.component   = "docs-ingest" | "docs-enrich" | "docs-embed"
joelclaw.action      = "enrich" | "classify" | "embed"
joelclaw.run_id      = <Inngest run id>
joelclaw.event_id    = <triggering event id>
environment          = "prod"
```

---

## Typesense Schema

### `pdf_documents` collection

```json
{
  "name": "pdf_documents",
  "fields": [
    { "name": "id",            "type": "string" },
    { "name": "title",         "type": "string",   "infix": true },
    { "name": "filename",      "type": "string",   "infix": true },
    { "name": "category",      "type": "string",   "facet": true, "optional": true },
    { "name": "document_type", "type": "string",   "facet": true, "optional": true },
    { "name": "file_type",     "type": "string",   "facet": true },
    { "name": "tags",          "type": "string[]", "facet": true },
    { "name": "summary",       "type": "string",   "optional": true },
    { "name": "page_count",    "type": "int32",    "optional": true },
    { "name": "size_bytes",    "type": "int64",    "optional": true },
    { "name": "added_at",      "type": "int64" },
    { "name": "nas_path",      "type": "string" },
    { "name": "source_host",   "type": "string",   "optional": true },
    { "name": "sha256",        "type": "string",   "optional": true }
  ],
  "default_sorting_field": "added_at"
}
```

### `pdf_chunks` collection (FTS + vector)

```json
{
  "name": "pdf_chunks",
  "fields": [
    { "name": "id",          "type": "string" },
    { "name": "doc_id",      "type": "string",    "facet": true },
    { "name": "title",       "type": "string" },
    { "name": "page",        "type": "int32" },
    { "name": "chunk_index", "type": "int32" },
    { "name": "content",     "type": "string" },
    { "name": "embedding",   "type": "float[]",   "num_dim": 1536, "optional": true }
  ]
}
```

Check installed Typesense version supports `float[]` before creating: `joelclaw otel search "typesense" --hours 1` or `kubectl -n joelclaw exec typesense-0 -- typesense-server --version`.

---

## Inngest Pipeline

### Events (add to `packages/system-bus/src/inngest/client.ts`)

```typescript
"docs/ingest.requested":    { data: { nasPath: string; title?: string; tags?: string[] } }
"docs/ingest.completed":    { data: { docId: string; title: string; category?: string; chunksIndexed: number } }
"docs/enrich.requested":    { data: { docId: string } }   // re-run enrichment only
"docs/reindex.requested":   { data: { docId?: string } }  // rebuild chunks + embeddings; all if docId omitted
"docs/search.requested":    { data: { query: string; filters?: string; limit?: number } }
```

### `docs-ingest` function

Files enter via a **staging drop folder** on NAS: `/Volumes/three-body/.ingest-staging/`. After taxonomy classification the file is **moved** to its permanent category path. `nas_path` in Typesense reflects the final location, not the staging path.

```
docs/ingest.requested  { stagingPath | nasPath, title?, tags? }
         │
         ▼
    Step 1: validate-file         — confirm file exists; sha256; size; detect file type
                                    → OTEL: docs.file.validated { bytes, sha256, fileType }

    Step 2: extract-text          — pdf-parse (PDF) or read (md/txt) → chunks[]
                                    → OTEL: docs.text.extracted { pages, chunks }

    Step 3: upsert-document       — Typesense pdf_documents upsert at staging path
                                    (nas_path = staging path; will be updated in Step 8)
                                    → OTEL: docs.document.upserted { docId }

    Step 4: embed-chunks          — batch text-embedding-3-small (50 chunks/batch)
                                    → Langfuse: generation span per batch { model, tokens, latency }
                                    → OTEL: docs.chunks.embedded { count, totalTokens }

    Step 5: upsert-chunks         — Typesense pdf_chunks bulk upsert (delete old first)
                                    → OTEL: docs.chunks.indexed { count }

    Step 6: enrich-metadata       — claude-haiku-4-5: summary + documentType from text sample
                                    → Langfuse: generation span { model, tokens, inputChars }
                                    → OTEL: docs.document.enriched { docType }

    Step 7: classify-taxonomy     — claude-haiku-4-5: map to taxonomy concept → category
                                    → Langfuse: generation span { model, conceptId, category }
                                    → OTEL: docs.taxonomy.classified { category }

    Step 8: move-to-final-path    — mv staging → /Volumes/three-body/{type-folder}/{category}/{filename}
                                    Type routing:
                                      PDF/paper/book  → books/{category}/
                                      podcast md/mp3  → podcasts/
                                      uncategorized   → books/uncategorized/
                                    → OTEL: docs.file.placed { finalNasPath, category }

    Step 9: update-nas-path       — Typesense patch: nas_path = finalNasPath, category, tags
                                    → OTEL: docs.document.finalized { docId, nas_path, category }

    Step 10: emit-completion      — step.sendEvent docs/ingest.completed
                                    → pushGatewayEvent (title, category, finalNasPath)
                                    → slog write
```

**Move is atomic at the NAS level** (same volume, `mv` not `cp+rm`). If Step 8 is retried, check if file already at final path before moving. `nas_path` in Typesense is the source of truth — staging path is transient.

NAS folder map (mirrors Phase 0 manifest-archive layout):
```
/Volumes/three-body/
  books/
    programming/
    business/
    education/
    design/
    other/
    uncategorized/
  podcasts/
  .ingest-staging/    ← transient; cleared after successful ingest
```

Flow control:
```typescript
{
  id: "docs-ingest",
  concurrency: { limit: 3 },          // 3 concurrent ingest runs max (embedding API)
  throttle: { limit: 100, period: "60s", key: '"embedding"' },  // embedding rate limit
  retries: 4,
}
```

### `docs-enrich` function (re-enrichment only, no re-chunking)

Triggered by `docs/enrich.requested`. Steps 6–8 from above only. Useful for re-running enrichment with a better model.

### `docs-reindex` function (rebuild all chunks + embeddings)

Triggered by `docs/reindex.requested`. Queries Typesense for all docs (or one), re-runs steps 2–5.

---

## CLI Subcommands

Location: `packages/cli/src/commands/docs.ts`

```bash
joelclaw docs search "<query>"                 # hybrid FTS + vector, returns ranked docs
joelclaw docs search "<query>" --category business --limit 10
joelclaw docs add /Volumes/three-body/books/x.pdf
joelclaw docs status                           # counts, pending enrichment, embedding coverage
joelclaw docs list [--category X] [--limit 20]
joelclaw docs show <id>                        # full doc record with chunk count
joelclaw docs enrich <id>                      # trigger re-enrichment
joelclaw docs reindex [--doc <id>]             # rebuild embeddings
```

All output: HATEOAS JSON envelope per ADR-0093. `next_actions` on every response. Machine-first.

---

## OTEL Contract (non-LLM telemetry)

Every step emits via `emitMeasuredOtelEvent`. Required fields per ADR-0087:

```typescript
{
  action:     "docs.file.validated" | "docs.text.extracted" | "docs.document.upserted"
              | "docs.chunks.embedded" | "docs.chunks.indexed" | "docs.document.enriched",
  component:  "docs-ingest" | "docs-enrich" | "docs-reindex",
  source:     "inngest",
  metadata_json: JSON.stringify({ docId, nasPath, ...stepMetrics })
}
```

Verify with `joelclaw otel search "docs." --hours 1` after any ingest run.

---

## Taxonomy

Carry `pdf-brain/data/taxonomy.json` to `packages/system-bus/src/data/pdf-taxonomy.json`. Format is SKOS-lite — same as memory categories (ADR-0095). Classification prompt maps document summary → nearest `concept.id`. Store in Typesense as `category` (top-level concept) and `tags` (matched concept labels).

---

## Migration Path

### Phase 0: manifest-archive (in progress)
Copy 806 manifest entries to `three-body` **in category sub-folders** using the manifest's `enrichmentCategory` field. Tracked separately (`manifest/archive.requested` Inngest function). Destination layout:

```
/Volumes/three-body/
  books/
    programming/      ← enrichmentCategory = "programming"  (229 docs)
    business/         ← enrichmentCategory = "business"     (185 docs)
    education/        ← enrichmentCategory = "education"    (156 docs)
    design/           ← enrichmentCategory = "design"        (91 docs)
    other/            ← enrichmentCategory = "other"          (37 docs)
    uncategorized/    ← enrichmentCategory = null/missing    (108 docs)
  podcasts/           ← sourcePath contains /clawd/podcasts/  (all formats flat)
```

This ADR's ingest pipeline runs on the archived files in Phase 1.

### Phase 1: Typesense collections + `docs-ingest`
- Create `pdf_documents` + `pdf_chunks` collections
- Implement `docs-ingest` function
- Wire CLI subcommands
- Verify Langfuse traces appearing for enrichment + embedding calls

### Phase 2: Bulk ingest
- Trigger `docs/ingest.requested` for all Phase 0 archived files
- Backfill enrichment from `manifest.clean.jsonl` (summaries + categories already computed — skip enrichment steps for those, write directly)
- Verify `joelclaw docs status` shows full coverage

### Phase 3: Decide open questions
- Effect-TS usage, PDS records, Convex UI, pi skill
- Implement whichever are accepted

### Phase 4: Retire standalone pdf-brain
- Archive repo, point README to joelclaw
- Remove dark-wizard pdf-library dependency

---

## Consequences

### Positive
- Single backend — Typesense handles metadata, FTS, vector; no extra infra
- Shares Typesense instance already running in k8s (ADR-0082)
- Every LLM call traced in Langfuse; every step measured in OTEL
- Durable ingest: interrupt + restart, no lost work
- Network utility: NAS + Typesense means library accessible from any joelclaw machine
- pi-first: `docs search` becomes a joelclaw CLI tool pi can call in any session

### Negative
- Typesense must be running for search (already always-on per ADR-0082 — acceptable)
- Embedding cost for ~800 docs × ~20 chunks = ~16k API calls at first ingest
- `float[]` vector support must be verified against installed Typesense version

### Risks
- Typesense collection size: 800 docs × 20 chunks = 16k chunk documents. Monitor with `joelclaw otel search "typesense" --hours 24`
- Embedding API rate limits: mitigated by `throttle` flow control on `docs-ingest`

---

## References

- https://github.com/joelhooks/pdf-brain — existing standalone implementation (carries taxonomy + types)
- ADR-0082: Typesense unified search (primary search backend, always-on)
- ADR-0088: NAS-backed storage tiering (three-body file home, Tier 3 HDD)
- ADR-0093: Agent-friendly navigation contract (CLI output format, HATEOAS JSON)
- ADR-0095: Typesense native memory categories / SKOS-lite (taxonomy pattern)
- ADR-0101: Langfuse as LLM-only observability plane (boundary contract, correlation fields)

## Skills Referenced

Implementors should load these skills before working on this system:

- `inngest-durable-functions` — step structure, memoization, retry patterns
- `inngest-steps` — step.run, step.sendEvent, step.ai.infer
- `inngest-events` — event naming conventions, payload schema
- `inngest-flow-control` — concurrency + throttle for embedding pipeline
- `o11y-logging` — OTEL contract, emitMeasuredOtelEvent usage, verification commands
- `langfuse-observability` — Langfuse tracing setup, generation spans, correlation fields *(newly installed)*
- `cli-design` — HATEOAS JSON envelope, agent-friendly output, next_actions
- `k8s` — Typesense pod management, collection admin
- `joelclaw` — operational context, event bus, standard commands
- `find-skills` — discover additional skills if new concerns arise during implementation *(newly installed)*
