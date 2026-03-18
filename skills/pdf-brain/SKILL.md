---
name: pdf-brain
description: "Research and library synthesis from the docs/PDF corpus, mapped to joelclaw system philosophy and concrete operational actions (especially k8s reliability). Trigger on: 'research this', 'from the library', 'from the books', 'pdf brain', 'correlate this', 'synthesize', or any request to derive practical architecture/ops guidance from the docs corpus. This skill is analysis-only; for ingestion/backfill workflows use pdf-brain-ingest."
version: 2.0.0
---

# PDF Brain — Research → Practical System Moves

Use this skill when the user wants evidence-backed synthesis from the docs library (600+ books, PDFs, long-form references), not generic web summarization.

## Pipeline v2 (ADR-0234)

The docs pipeline uses a staged artifact chain:
- **Extraction**: opendataloader-pdf → structured markdown with headings, tables, reading order
- **Chunking**: markdown-native heading detection, no overlap, hierarchical section + snippet chunks
- **Embeddings**: nomic-embed-text-v1.5 (768-dim, retrieval-tuned) in `docs_chunks_v2` collection
- **Artifacts**: durable on NAS at `/Volumes/three-body/docs-artifacts/{docId}/` — `.md`, `.meta.json`, `.chunks.jsonl`
- **Summaries**: LLM-generated per-document summaries in `.meta.json`

## When to Use

Trigger cues (explicit or implied):
- "research this" / "from the library" / "from the books"
- "pdf brain" / "correlate this to our system"
- "what does the research say" / "what do the books say"
- "expand this into practical ideas"

## Retrieval Workflow

### CLI path (preferred for interactive sessions)

```bash
# Search across all books — semantic by default (nomic 768-dim)
joelclaw docs search "distributed consensus" --limit 8

# Search within a specific book
joelclaw docs search "consensus" --doc designing-dataintensive-applications-39cc0d1842a5

# Expand a chunk into surrounding context
joelclaw docs context <chunk-id> --mode snippet-window --before 2 --after 2

# Get the full parent section
joelclaw docs context <chunk-id> --mode parent-section

# Get neighboring sections for broad context
joelclaw docs context <chunk-id> --mode section-neighborhood --neighbors 2

# Read the full structured markdown of a book
joelclaw docs markdown <doc-id>

# Get document summary + taxonomy metadata
joelclaw docs summary <doc-id>
```

### API path (for programmatic access or docs-api consumers)

```
GET /search?q=distributed+consensus&semantic=true&expand=true&assemble=true
GET /docs/:docId/toc
GET /docs/:docId/markdown
GET /docs/:docId/summary
GET /chunks/:chunkId
```

The docs-api runs on k8s at `docs-api:3838` (Bearer auth required).

### Context expansion strategy

The library supports progressive context expansion:

1. **Search** → chunk-level hits with heading_path and snippet
2. **snippet-window** → 2 chunks before/after for local context
3. **parent-section** → the full section containing the snippet
4. **section-neighborhood** → adjacent sections for broader flow
5. **markdown** → the complete structured book text

Start narrow, expand only when needed. Don't dump full books into context.

## Evidence Synthesis

### Build an evidence ledger

While reading, keep a compact ledger:
- `doc` (title)
- `chunk-id`
- `claim` (one sentence)
- `relevance` (why it matters to this problem)

Never output synthesis without traceable evidence.

### Convert evidence into principles

Turn each claim into an operational principle in imperative form:
- "Treat partial failure as normal."
- "Fail fast at dependency boundaries."
- "Prefer idempotent replay-safe remediation loops."

Avoid vague advice. Each principle must imply a technical behavior.

### Correlate to joelclaw philosophy

Map principles to existing joelclaw operating rules:
- single source of truth
- silent failures are bugs
- Inngest durability + retries
- CLI-first agent interface
- observability required at every step
- skill/doc updates when reality changes

### Translate into action

For each principle, produce:
1. **Concrete change** (file/service/config path)
2. **Validation gate** (exact command)
3. **Failure signal** (what proves it did not work)
4. **Rollback or containment move**

## Taxonomy

The library is classified via SKOS taxonomy:
- `jc:docs:programming` (systems, languages, architecture)
- `jc:docs:business` (creator economy)
- `jc:docs:education` (learning science, pedagogy)
- `jc:docs:design` (game, systems, product)
- `jc:docs:marketing`, `jc:docs:strategy`, `jc:docs:ai`, `jc:docs:operations`

Use `--concept jc:docs:programming:systems` to narrow by domain.
Use `joelclaw docs status` to see facet counts per concept.

## Rules

- Do not fabricate quotes or claims.
- Always cite chunk IDs for non-obvious assertions.
- Do not output "book report" fluff. Translate to operations.
- If infra changes are proposed, include verification commands.
- If work implies architectural policy change, tie it to an ADR path.
- Start with search, expand only as needed. Don't waste context on full book dumps.
