---
type: adr
status: proposed
date: 2026-02-22
tags: [adr, pdf-brain, typesense, inngest, joelclaw, knowledge-management, langfuse, otel]
deciders: [joel]
supersedes: []
related: ["0082-typesense-unified-search", "0088-nas-backed-storage-tiering", "0095-typesense-native-memory-categories-skos-lite", "0101-langfuse-llm-only-observability", "0093-agent-friendly-navigation-contract", "0109-system-wide-taxonomy-concept-contract"]
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
| Cross-cutting execution concerns | Inngest middleware | `inngest-middleware` |
| Local/self-host operational parity | Inngest local setup/ops | `inngest-local` |
| Non-LLM telemetry | OTEL via `emitMeasuredOtelEvent` | `o11y-logging` |
| LLM tracing | Langfuse generation spans | `langfuse-observability` |
| Search + indexing | Typesense FTS + vector | (existing `joelclaw` OTEL patterns) |
| CLI output contract | HATEOAS JSON envelope | `cli-design` |
| Deployment context | k8s/Typesense always-on | `k8s`, `joelclaw` |
| Taxonomy alignment | SKOS-lite from ADR-0095 | `joelclaw` |

**Finding additional skills:** Use `find-skills` if a new concern emerges during implementation — run `npx skills find <domain>` before writing custom tooling.

---

## Decisions (previously open questions — resolved 2026-02-22)

| # | Question | Decision | Rationale |
|---|---|---|---|
| 1 | **Effect-TS** | ❌ Plain async/Bun — match existing system-bus patterns | No style split inside the package. Effect stays in pdf-brain standalone. |
| 2 | **PDS records** | ❌ Typesense-only for Phase 1 | YAGNI. Lexicon design not settled. Add in a follow-on ADR when needed. |
| 3 | **Convex UI** | ✅ Yes — design Convex schema alongside Typesense | Full search UI at `joelclaw.com/docs` from the start. Dope search capability is part of the spec. |
| 4 | **pi skill** | ✅ Yes — build `docs` skill in Phase 1, keep it current | Library is only useful if pi can query it mid-conversation. Ship the skill with the pipeline. |

---

## Decision

Implement **joelclaw PDF Brain** as a first-class subsystem inside the joelclaw monorepo:

- **Typesense** as sole backend — metadata, FTS, vector search (no SQLite, no Qdrant)
- **NAS `three-body`** as canonical file store (ADR-0088 Tier 3 HDD)
- **Inngest durable functions** for ingest, enrichment, re-index pipelines
- **Langfuse traces** on every LLM call — enrichment, embedding, taxonomy classification
- **OTEL events** on every non-LLM step — file ops, chunk counts, index writes
- **joelclaw CLI** subcommands following the HATEOAS JSON contract (ADR-0093)
- **Taxonomy** uses ADR-0109 global concept contract, seeded from `pdf-brain/data/taxonomy.json`
- **Memory-grade retrieval contract**: hierarchical chunking + rerank + progressive context expansion so books behave as durable evidence memory, not flat tag/search blobs

### Taxonomy Policy (2026-02-22 update)

1. **Canonical source**: the system-wide concept registry from ADR-0109.
2. **Storage vs semantics**:
   - storage routing remains coarse (`books/{category}`, `podcasts`) for filesystem operations.
   - semantic concepts (`concept_ids`) are separate and drive retrieval/graph behavior.
3. **Legacy `library.db` use**:
   - legacy concepts/tags are treated as alias/candidate input only.
   - they are not a canonical ontology source.
4. **No tag soup**:
   - free-form tags can be stored, but retrieval/routing uses mapped concept IDs.
   - unresolvable tags are diagnostics, not category truth.

---

## Model Routing

All LLM calls route through the joelclaw gateway. Explicit model choices:

| Call | Model | Rationale |
|---|---|---|
| Document enrichment (summary, category, docType) | `anthropic/claude-haiku-4-5` | Fast, cheap per-doc batch |
| Taxonomy classification | `anthropic/claude-haiku-4-5` | Structured output, classification task |
| Complex re-enrichment (on request) | `anthropic/claude-sonnet-4-5` | Higher quality for important docs |
| Chunk embedding (baseline recall) | Typesense built-in embedding (`ts/all-MiniLM-L12-v2`) | Fast local/index-time vectors, zero external embedding dependency |
| Optional high-quality rerank/contextualization | `anthropic/claude-haiku-4-5` default, `anthropic/claude-sonnet-4-5` for deep profile | Spend inference where it improves retrieval precision most |

Every model call emits a **Langfuse generation span** per ADR-0101. Required correlation fields on every trace:
```
joelclaw.component   = "docs-ingest" | "docs-enrich" | "docs-embed"
joelclaw.action      = "enrich" | "classify" | "embed"
joelclaw.run_id      = <Inngest run id>
joelclaw.event_id    = <triggering event id>
environment          = "prod"
```

---

## Retrieval Quality Contract (Books As Memory)

### Hierarchical chunking (required)

Ingest must produce two linked chunk tiers:

- **Section chunks**: target ~1200-2200 tokens, semantic unit for broad recall
- **Snippet chunks**: target ~250-600 tokens, high-precision retrieval unit
- Every snippet carries `parent_chunk_id`, and both tiers carry `prev_chunk_id`/`next_chunk_id`
- Every chunk stores `heading_path[]` + `context_prefix` for structure-aware retrieval

### Contextual retrieval text (required)

Embedding/search text must include a short structural prefix:

```
[DOC: <title>]
[PATH: <heading_path joined>]
[CONCEPTS: <top concept labels/ids if present>]

<chunk text>
```

This preserves chapter/section semantics in vector space and improves hit quality on dense technical books.

### Retrieval pipeline (required)

`docs search` must follow:

1. **Snippet-first recall**: hybrid lexical + vector on `chunk_type=snippet`
2. **Concept-aware filtering/boosting**: `concept_ids`, `primary_concept_id`, `taxonomy_version`
3. **Rerank top-K**: inference rerank/judge pass for precision on complex queries
4. **Progressive expansion** (on demand):
   - `snippet-window` (local precision context)
   - `parent-section` (full local argument)
   - `section-neighborhood` (parent + adjacent sections)

### Distillation layer (required)

Each ingested book should additionally emit durable, citation-backed distillates (narrative + retained facts) that reference source chunk IDs. This mirrors ADR-0021 memory patterns: evidence and distillate are separate but linked.

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
    { "name": "primary_concept_id", "type": "string",   "facet": true, "optional": true },
    { "name": "concept_ids",        "type": "string[]", "facet": true, "optional": true },
    { "name": "concept_source",     "type": "string",   "facet": true, "optional": true },
    { "name": "taxonomy_version",   "type": "string",   "facet": true, "optional": true },
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
    { "name": "id",                 "type": "string" },
    { "name": "doc_id",             "type": "string",    "facet": true },
    { "name": "title",              "type": "string" },
    { "name": "chunk_type",         "type": "string",    "facet": true },
    { "name": "chunk_index",        "type": "int32" },
    { "name": "page_start",         "type": "int32",     "optional": true },
    { "name": "page_end",           "type": "int32",     "optional": true },
    { "name": "heading_path",       "type": "string[]",  "facet": true, "optional": true },
    { "name": "context_prefix",     "type": "string",    "optional": true },
    { "name": "parent_chunk_id",    "type": "string",    "facet": true, "optional": true },
    { "name": "prev_chunk_id",      "type": "string",    "optional": true },
    { "name": "next_chunk_id",      "type": "string",    "optional": true },
    { "name": "primary_concept_id", "type": "string",    "facet": true, "optional": true },
    { "name": "concept_ids",        "type": "string[]",  "facet": true, "optional": true },
    { "name": "taxonomy_version",   "type": "string",    "facet": true, "optional": true },
    { "name": "content",            "type": "string" },
    { "name": "retrieval_text",     "type": "string" },
    {
      "name": "embedding",
      "type": "float[]",
      "embed": {
        "from": ["retrieval_text"],
        "model_config": { "model_name": "ts/all-MiniLM-L12-v2" }
      }
    }
  ]
}
```

Check installed Typesense version supports `embed` with `float[]` before creating: `joelclaw otel search "typesense" --hours 1` or `kubectl -n joelclaw exec typesense-0 -- typesense-server --version`.

---

## Inngest Pipeline

### Events (add to `packages/system-bus/src/inngest/client.ts`)

```typescript
"docs/ingest.requested":    { data: { nasPath: string; title?: string; tags?: string[] } }
"docs/ingest.completed":    { data: { docId: string; title: string; category?: string; chunksIndexed: number } }
"docs/enrich.requested":    { data: { docId: string } }   // re-run enrichment only
"docs/reindex.requested":   { data: { docId?: string } }  // rebuild hierarchical chunks + vectors; all if docId omitted
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

    Step 2: extract-text          — pdf-parse (PDF) or read (md/txt) → rawText
                                    → OTEL: docs.text.extracted { pages, characters }

    Step 3: upsert-document       — Typesense pdf_documents upsert at staging path
                                    (nas_path = staging path; will be updated in Step 8)
                                    → OTEL: docs.document.upserted { docId }

    Step 4: build-hierarchical-chunks
                                  — section chunks + snippet chunks + links + retrieval_text
                                    → OTEL: docs.chunking.profiled { sectionCount, snippetCount, avgSectionTokens, avgSnippetTokens, profileVersion }

    Step 5: upsert-chunks         — Typesense pdf_chunks bulk upsert (delete old first)
                                    (Typesense built-in embedding generated from retrieval_text)
                                    → OTEL: docs.chunks.indexed { count, sectionCount, snippetCount }

    Step 6: enrich-metadata       — claude-haiku-4-5: summary + documentType from text sample
                                    → Langfuse: generation span { model, tokens, inputChars }
                                    → OTEL: docs.document.enriched { docType }

    Step 7: classify-taxonomy     — claude-haiku-4-5: map to concept IDs + storage category
                                    → Langfuse: generation span { model, primaryConceptId, conceptIds }
                                    → OTEL: docs.taxonomy.classified { primaryConceptId, conceptIds, storageCategory }

    Step 8: move-to-final-path    — mv staging → /Volumes/three-body/{type-folder}/{category}/{filename}
                                    Type routing:
                                      PDF/paper/book  → books/{category}/
                                      podcast md/mp3  → podcasts/
                                      uncategorized   → books/uncategorized/
                                    → OTEL: docs.file.placed { finalNasPath, category }

    Step 9: update-nas-path       — Typesense patch: nas_path = finalNasPath, category, concept fields, tags
                                    → OTEL: docs.document.finalized { docId, nas_path, category, primaryConceptId, conceptCount }

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

### `docs-context` retrieval helper

`docs-context` expands a snippet hit into broader context using deterministic modes:

- `snippet-window`
- `parent-section`
- `section-neighborhood`

This is the primary mechanism for getting more complete source text into context while keeping default queries fast.

---

## CLI Subcommands

Location: `packages/cli/src/commands/docs.ts`

```bash
joelclaw docs search "<query>"                 # hybrid FTS + vector, returns ranked docs
joelclaw docs search "<query>" --category business --limit 10
joelclaw docs context <chunk-id> --mode snippet-window
joelclaw docs context <chunk-id> --mode parent-section
joelclaw docs context <chunk-id> --mode section-neighborhood
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
              | "docs.chunking.profiled" | "docs.chunks.indexed" | "docs.document.enriched"
              | "docs.retrieve.reranked" | "docs.context.expanded",
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

### Phase 1: Typesense collections + `docs-ingest` + pi skill + Convex schema
- Create `pdf_documents` + `pdf_chunks` Typesense collections
- Implement `docs-ingest` Inngest function (plain async/Bun, no Effect)
- Implement hierarchical chunking profile (`section` + `snippet`) with links + retrieval text
- Add rerank path for `docs search` and deterministic `docs context` expansion modes
- Wire `joelclaw docs` CLI subcommands
- Build `docs` pi skill at `~/Code/joelhooks/joelclaw/skills/docs/` — ship with pipeline
- Design Convex `docs` schema alongside Typesense (documents + search index)
- `joelclaw.com/docs` route with Convex-backed real-time search UI
- Verify Langfuse traces for all LLM calls

### Phase 2: Bulk ingest
- Trigger `docs/ingest.requested` for all Phase 0 archived files
- Backfill enrichment from `manifest.clean.jsonl` (summaries + categories already computed — skip LLM steps, write directly to Typesense + Convex)
- Verify `joelclaw docs status` shows full coverage
- Verify pi skill returns real results mid-conversation

### Phase 3: Retire standalone pdf-brain
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
- Typesense collection size: hierarchical chunking will increase chunk cardinality (expected 2-4x over flat chunking). Monitor with `joelclaw otel search "typesense|docs.chunks.indexed" --hours 24`
 - Rerank/enrichment API rate limits: mitigated by `throttle`/concurrency controls on docs workflows

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
 - `inngest-flow-control` — concurrency + throttle for chunking/rerank pipeline
- `inngest-middleware` — shared context injection, request correlation, cross-cutting safeguards
- `inngest-local` — self-hosted local/k8s parity for workflow testing and operations
- `o11y-logging` — OTEL contract, emitMeasuredOtelEvent usage, verification commands
- `langfuse-observability` — Langfuse tracing setup, generation spans, correlation fields *(newly installed)*
- `cli-design` — HATEOAS JSON envelope, agent-friendly output, next_actions
- `k8s` — Typesense pod management, collection admin
- `joelclaw` — operational context, event bus, standard commands
- `find-skills` — discover additional skills if new concerns arise during implementation *(newly installed)*
