---
type: adr
status: proposed
date: 2026-02-22
tags: [adr, pdf-brain, typesense, inngest, joelclaw, knowledge-management]
deciders: [joel]
supersedes: []
related: ["0082-typesense-unified-search", "0088-nas-backed-storage-tiering", "0095-typesense-native-memory-categories-skos-lite"]
---

# ADR-0105: joelclaw PDF Brain — Typesense-Backed Document Library

## Status

proposed

## Context

The existing [`pdf-brain`](https://github.com/joelhooks/pdf-brain) repo is a standalone CLI tool that manages a personal document library (PDFs, papers, books, podcast transcripts). It works well for its scope but has several friction points:

- **Storage fragmentation**: SQLite (libsql) for metadata + Qdrant for vectors + the file system = three systems to keep in sync
- **Not a network utility**: runs locally on a single machine; library doesn't follow Joel across panda → Mac Studio
- **No Inngest backing**: ingest is synchronous, not observable, not resumable
- **Separate from joelclaw**: not reachable by gateway, CLI, or Inngest events
- **Qdrant dependency**: another infra service to keep running; Typesense already handles vectors in the joelclaw stack (ADR-0082, ADR-0095)
- **File storage not settled**: files live wherever they were added; no canonical NAS-backed home

The immediate trigger is migrating ~806 documents (from dark-wizard and clanker) to `three-body` while building the permanent home for the library.

## Decision

Implement **joelclaw PDF Brain** as a first-class joelclaw subsystem:

- **Typesense** as the sole backend for metadata, full-text, and vector search (no SQLite, no Qdrant)
- **NAS (three-body)** as canonical file storage for all documents
- **Inngest durable functions** for ingest, enrichment, and taxonomy classification pipelines
- **joelclaw CLI** subcommands (`joelclaw docs search`, `joelclaw docs add`, `joelclaw docs status`)
- **OTEL telemetry** on every pipeline step
- **Taxonomy** carried forward from `pdf-brain/data/taxonomy.json` (SKOS-lite, aligns with ADR-0095)

---

## Architecture

### Typesense Collections

#### `pdf_documents` collection

```json
{
  "name": "pdf_documents",
  "fields": [
    { "name": "id",           "type": "string" },
    { "name": "title",        "type": "string",   "infix": true },
    { "name": "filename",     "type": "string",   "infix": true },
    { "name": "category",     "type": "string",   "facet": true, "optional": true },
    { "name": "document_type","type": "string",   "facet": true, "optional": true },
    { "name": "file_type",    "type": "string",   "facet": true },
    { "name": "tags",         "type": "string[]", "facet": true },
    { "name": "summary",      "type": "string",   "optional": true },
    { "name": "page_count",   "type": "int32",    "optional": true },
    { "name": "size_bytes",   "type": "int64",    "optional": true },
    { "name": "added_at",     "type": "int64" },
    { "name": "nas_path",     "type": "string" },
    { "name": "source_path",  "type": "string",   "optional": true },
    { "name": "source_host",  "type": "string",   "optional": true },
    { "name": "sha256",       "type": "string",   "optional": true }
  ],
  "default_sorting_field": "added_at"
}
```

#### `pdf_chunks` collection (vector + FTS search)

```json
{
  "name": "pdf_chunks",
  "fields": [
    { "name": "id",          "type": "string" },
    { "name": "doc_id",      "type": "string", "facet": true },
    { "name": "title",       "type": "string" },
    { "name": "page",        "type": "int32"  },
    { "name": "chunk_index", "type": "int32"  },
    { "name": "content",     "type": "string" },
    { "name": "embedding",   "type": "float[]", "num_dim": 1536, "optional": true }
  ]
}
```

Vector search uses `text-embedding-3-small` (1536 dims) via joelclaw gateway — no Ollama dependency.

### Inngest Pipeline

```
docs/ingest.requested  { nasPath, title?, tags? }
         │
         ▼
[docs-ingest function]
    Step 1: validate-file         — confirm nasPath exists, compute sha256
    Step 2: extract-text          — pdf-parse or markdown read → text chunks
    Step 3: upsert-document       — Typesense pdf_documents upsert
    Step 4: embed-chunks          — batch embed via gateway text-embedding-3-small
    Step 5: upsert-chunks         — Typesense pdf_chunks upsert (delete old first)
    Step 6: enrich-metadata       — LLM: summary + category + documentType
    Step 7: update-document       — Typesense patch with enrichment
    Step 8: emit-otel             — log completion metrics
         │
         ▼
docs/ingest.completed  { docId, title, category, chunksIndexed }
```

```
docs/enrich.requested  { docId }     ← re-run enrichment only
docs/reindex.requested {}            ← rebuild all chunks + embeddings
```

### File Storage

All ingested documents live on NAS under:
```
/Volumes/three-body/
  books/      ← PDFs, papers, books
  podcasts/   ← markdown transcripts, audio files
```

`nas_path` in Typesense is the canonical pointer. Files are never moved after ingestion.

### CLI Subcommands

```bash
joelclaw docs search "<query>"          # hybrid FTS + vector
joelclaw docs search "<query>" --facet category=business
joelclaw docs add /path/to/file.pdf     # trigger ingest
joelclaw docs status                    # counts, pending enrichment
joelclaw docs list [--category X]       # list documents
joelclaw docs show <id>                 # full document record
joelclaw docs reindex [--doc <id>]      # rebuild embeddings
```

Output follows the joelclaw agent-friendly JSON contract (ADR-0093).

### Taxonomy

Carry forward `pdf-brain/data/taxonomy.json` into `packages/system-bus/src/data/pdf-taxonomy.json`. Enrichment LLM maps each document to the nearest taxonomy concept. Same SKOS-lite format already used for memory categories (ADR-0095).

---

## Migration Path

### Phase 1: manifest-archive (immediate)

Copy all 806 manifest entries to `/Volumes/three-body`:
- dark-wizard (`joel@100.86.171.79`) → 779 files at their `sourcePath`
- clanker (`joel@100.95.167.75`) → 27 files at their `sourcePath`

Implemented as `manifest/archive.requested` Inngest function. Idempotent via Redis state. See implementation task in `~/Vault/system/system-log.jsonl`.

### Phase 2: Typesense collections (next sprint)

- Create `pdf_documents` and `pdf_chunks` collections
- Implement `docs-ingest` Inngest function
- Wire `joelclaw docs` CLI subcommands

### Phase 3: Bulk ingest from NAS

- Ingest all archived files from Phase 1 into Typesense
- Backfill enrichment from manifest.clean.jsonl (summaries, categories, tags already computed)
- Embed all chunks

### Phase 4: Retire pdf-brain standalone

- Archive repo, leave README pointing to joelclaw
- Remove dark-wizard pdf-library dependency

---

## Consequences

### Positive

- Single backend (Typesense) for metadata + FTS + vectors — no libsql, no Qdrant
- Shared with the rest of joelclaw's search stack (ADR-0082)
- Observable: every ingest step emits OTEL events
- Resumable: Inngest handles failures and retries
- Network utility: accessible from any machine via joelclaw CLI + NFS
- NAS canonical storage: documents survive machine changes

### Negative

- Typesense must be running for search (already always-on per ADR-0082)
- Vector embedding costs (text-embedding-3-small) — mitigated by lazy/async embedding
- Chunk storage in Typesense grows with library size — monitor collection size

### Risks

- Typesense `float[]` vector support: verified available in Typesense 0.25+ — check installed version
- NFS throughput for large PDF extraction: soft mount + read-heavy = fine
- Embedding cost for ~800 documents × ~20 chunks = ~16k API calls — batch carefully

---

## References

- https://github.com/joelhooks/pdf-brain — existing standalone implementation
- ADR-0082: Typesense unified search (primary search backend)
- ADR-0088: NAS-backed storage tiering (three-body file home)
- ADR-0095: Typesense native memory categories / SKOS-lite (taxonomy pattern)
- ADR-0093: Agent-friendly navigation contract (CLI output format)
