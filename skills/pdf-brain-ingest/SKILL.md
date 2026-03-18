---
name: pdf-brain-ingest
displayName: PDF Brain Ingest
description: "Ingest PDF/Markdown/TXT files into joelclaw's docs memory pipeline with Inngest durability, durable NAS artifacts, and OTEL verification. Use when adding docs, running batch reindex, reconciling coverage, or recovering stuck runs. Triggers on: 'ingest pdf', 'ingest markdown', 'docs add', 'pdf-brain ingest', 'backfill books', 'docs reconcile', 'reindex docs', 'batch reindex'."
version: 2.0.0
author: Joel Hooks
tags: [joelclaw, docs, pdf, markdown, ingest, inngest, typesense, memory, opendataloader]
---

# PDF Brain Ingest v2 (ADR-0234)

Staged artifact-chain pipeline with durable NAS storage, nomic embeddings, and workload queue orchestration.

## Pipeline v2 Architecture

```
PDF (source, immutable)
  → Stage 1: CONVERT — opendataloader-pdf → {docId}.md (NAS artifact)
  → Stage 2: CLASSIFY + SUMMARIZE — taxonomy + LLM summary → {docId}.meta.json (NAS artifact)
  → Stage 3: CHUNK — markdown-native headings, no overlap → {docId}.chunks.jsonl (NAS artifact)
  → Stage 4: INDEX — upsert to docs + docs_chunks_v2 (nomic-embed-text-v1.5, 768-dim)
```

**Key properties:**
- **Durable**: artifacts on NAS RAID5, survive reboots/crashes
- **Resumable**: each stage checks for existing artifacts, skips if present
- **Recoverable**: re-run any stage from existing artifacts without re-extracting
- **Observable**: OTEL event per stage per book

**Artifacts dir**: `/Volumes/three-body/docs-artifacts/{docId}/`
- `{docId}.md` — structured markdown extraction
- `{docId}.meta.json` — taxonomy, summary, metadata
- `{docId}.chunks.jsonl` — chunk records, one per line

## Core Workflow

### 1) Preflight

```bash
joelclaw status
joelclaw docs status
```

Status now shows both v1 and v2 collection stats plus artifact availability.

### 2) Single File Ingest (v1 pipeline)

```bash
joelclaw docs add "/absolute/path/to/file.pdf"
joelclaw docs add "/absolute/path/to/file.pdf" --title "Title" --tags "tag1,tag2" --category programming
```

### 3) Single File v2 Reindex (artifact pipeline)

```bash
joelclaw docs reindex-v2 "/absolute/path/to/file.pdf"
joelclaw docs reindex-v2 "/absolute/path/to/file.pdf" --title "Title" --skip-existing
```

Fires `docs/reindex-v2.requested` → 4-stage artifact pipeline → NAS artifacts + docs_chunks_v2.

### 4) Batch Reindex (full library)

```bash
# Reindex all PDFs from NAS /Volumes/three-body/books/
joelclaw docs batch-reindex --skip-existing

# Reindex from existing Typesense docs collection
joelclaw docs batch-reindex --from-collection --skip-existing
```

Fires `docs/reindex-batch.requested` → scans NAS/collection → dispatches individual reindex-v2 events in batches of 10, concurrency 3.

`--skip-existing` skips books that already have all 3 artifacts on NAS (default true).

### 5) Monitor Progress

```bash
# Artifact count on NAS
ls /Volumes/three-body/docs-artifacts/ | wc -l

# v2 collection chunk count
joelclaw docs status

# OTEL events from pipeline
joelclaw otel search "docs.reindex" --hours 4
joelclaw o11y session system-bus --hours 4

# Individual run trace
joelclaw runs --count 10
joelclaw run <run-id>
```

### 6) Inspect Artifacts

```bash
# Read the extracted markdown
joelclaw docs markdown <doc-id>

# Read the summary + taxonomy metadata
joelclaw docs summary <doc-id>

# Or directly on NAS
cat /Volumes/three-body/docs-artifacts/<docId>/<docId>.md
cat /Volumes/three-body/docs-artifacts/<docId>/<docId>.meta.json | jq
wc -l /Volumes/three-body/docs-artifacts/<docId>/<docId>.chunks.jsonl
```

### 7) Retrieval from v2

```bash
# Search uses docs_chunks_v2 (nomic 768-dim) by default
joelclaw docs search "distributed consensus" --limit 8

# Context expansion
joelclaw docs context <chunk-id> --mode snippet-window
joelclaw docs context <chunk-id> --mode parent-section
joelclaw docs context <chunk-id> --mode section-neighborhood
```

### 8) Coverage Reconcile

```bash
joelclaw docs reconcile --sample 20
```

### 9) Recovery

If the batch stalls or books fail:
- Inngest retries each step automatically (default retry policy)
- `--skip-existing` means re-firing the batch only processes unfinished books
- Check OTEL for errors: `joelclaw otel list --level error --hours 4`
- Individual retry: `joelclaw docs reindex-v2 "/path/to/failed.pdf"`

## Extraction Details

- **Primary**: opendataloader-pdf v2.0.0 (Java-based, #1 in benchmarks, 0.90 accuracy)
- **Fallback**: pypdf (basic text extraction if Java unavailable)
- **Requires**: Java 11+ (OpenJDK 25 installed on panda, PATH configured in worker start.sh)
- **Speed**: ~2.5s per book on M4 Pro

## Embedding Model

- **v2**: `ts/nomic-embed-text-v1.5` — 768-dim, retrieval-tuned, Typesense built-in
- **v1**: `ts/all-MiniLM-L12-v2` — 384-dim, general-purpose (legacy, still in `docs_chunks`)

## Chunking Strategy (ADR-0234)

- Markdown-native heading detection (`#` markers, not heuristics)
- Recursive splitting within sections exceeding target tokens
- No overlap (arxiv R100-0 finding: 45% higher precision)
- Two-level hierarchy: section chunks + snippet sub-chunks
- heading_path derived from actual markdown heading levels
- Context inheritance: retrieval_text includes `[DOC: title] [SUMMARY: ...] [PATH: heading > path] [CONCEPTS: ...]`

## Acquisition Pipeline (aa-book → ingest)

```bash
joelclaw send pipeline/book.download -d '{
  "query": "designing data-intensive applications",
  "format": "pdf",
  "reason": "library expansion"
}'
```

Downloads via aa-book → NAS backup → fires `docs/ingest.requested` for immediate processing.

## Inngest Events

| Event | Function | Purpose |
|-------|----------|---------|
| `docs/ingest.requested` | docs-ingest | v1 pipeline (single file) |
| `docs/reindex-v2.requested` | docs-reindex-v2 | v2 artifact pipeline (single file) |
| `docs/reindex-batch.requested` | docs-reindex-batch | Batch orchestrator (all PDFs) |
| `docs/backlog.requested` | docs-backlog | Legacy manifest-based backfill |
| `docs/enrich.requested` | docs-enrich | Re-enrich metadata for existing doc |
| `pipeline/book.download` | book-download | Acquire + ingest new book |
