---
type: adr
status: proposed
date: 2026-02-25
tags: [adr, twitter, x, typesense, ingest, archive]
deciders: [joel]
related:
  - "0082-typesense-unified-search"
  - "0088-nas-backed-storage-tiering"
  - "0109-system-wide-taxonomy-concept-contract"
  - "0119-x-twitter-cli-integration"
  - "0131-unified-channel-intelligence-pipeline"
supersedes: []
---

# ADR-0136: Integrate 20-Year Twitter Archive as a Typesense-Backed Corpus

## Status

proposed

## Context

A complete Twitter archive (~7+ GB, ~20 years) exists at [`/Volumes/three-body/twitter`](file:///Volumes/three-body/twitter).

The question is how to make this useful inside joelclaw without creating another silo.

Current constraints:

- Qdrant is no longer part of the active system.
- Typesense is already the unified search backend and supports vector/embedding fields (ADR-0082).
- joelclaw architecture prefers durable, idempotent Inngest pipelines and CLI-first operations.
- Source archives on NAS should remain immutable and re-indexable (ADR-0088).

If we only import directly into one ad-hoc Typesense collection, we lose reproducibility, make re-indexing painful, and couple parsing bugs to serving state.

## Decision

Adopt a three-layer architecture for Twitter archive integration:

1. **Raw layer (immutable)**
   - Keep original archive files unchanged at `/Volumes/three-body/twitter`.

2. **Canonical normalized layer (rebuildable)**
   - Produce normalized records (JSONL or Parquet) from archive exports.
   - This layer is the source for all re-indexing and schema migrations.

3. **Typesense serving layer (query/runtime)**
   - Use Typesense for both lexical and vector retrieval.
   - Store embeddings directly in Typesense fields.

### Collection strategy

Phase 1 collections:

- `twitter_tweets` — one document per tweet
- `twitter_threads` — materialized thread/conversation documents

Optional phase 2:

- `twitter_links` — URL/domain-centric documents for link intelligence

### Required normalized tweet fields

At minimum:

- `id` (tweet id, stable primary key)
- `author_id`
- `created_at`
- `text`
- `conversation_id`
- `in_reply_to_status_id`
- `lang`
- `hashtags[]`
- `mentions[]`
- `urls[]`
- `media_keys[]`
- `raw_ref` (pointer back to original archive artifact)
- `archive_batch` (for ingest provenance)

### Retrieval policy

- Hybrid search by default (keyword + vector), not vector-only.
- Support filters for date range, thread/conversation, mentions, hashtags, URL domains.
- Recency and exact-match signals should be tunable so old tweets do not dominate broad queries.

## Alternatives considered

1. **Typesense-only, no canonical normalized layer**
   - Rejected: fragile, difficult re-index, no clean replay path.

2. **Keep archive as files + grep/jq only**
   - Rejected: poor ranking, poor typo tolerance, weak semantic recall.

3. **Add another vector DB beside Typesense**
   - Rejected: unnecessary infra split; current direction is Typesense consolidation.

## Non-goals

- Replacing or changing the existing `joelclaw x` posting/auth commands (ADR-0119).
- Building full social automation from historical tweets in phase 1.
- Real-time firehose ingest in this ADR (archive-first only).

## Implementation plan

### Affected paths (planned)

- `packages/system-bus/src/inngest/client.ts` (event schema)
- `packages/system-bus/src/inngest/functions/twitter-archive-ingest.ts` (new)
- `packages/system-bus/src/inngest/functions/index.host.ts` (function registration)
- `packages/system-bus/src/lib/typesense.ts` (collection schema helpers/constants)
- `packages/cli/src/commands/x.ts` or `packages/cli/src/commands/twitter.ts` (archive ingest/search ops)
- `skills/x-api/SKILL.md` (operator guidance updates)

### Pipeline shape

1. Emit `twitter/archive.ingest.requested` with source path + run metadata.
2. Parse archive files into normalized records with idempotent dedupe on `tweet_id`.
3. Materialize threads (`twitter_threads`) from canonical tweet set.
4. Upsert into Typesense collections with embedding fields.
5. Emit OTEL checkpoints for parse/normalize/threadize/index stages.
6. Expose CLI operations for ingest status, reindex, and search.

### Patterns to follow / avoid

Follow:

- Reuse existing Typesense helper patterns in `packages/system-bus/src/lib/typesense.ts`.
- Keep ingest idempotent with deterministic document IDs.
- Keep event naming in past-tense happened/requested style already used by system-bus.

Avoid:

- Do **not** call the live X API for historical backfill when local archive data exists.
- Do **not** write parser output straight to Typesense without persisting canonical normalized data first.
- Do **not** introduce a second vector store for this pipeline.

### Data location policy

- Raw source stays at `/Volumes/three-body/twitter`.
- Canonical normalized output should live adjacent on NAS under a dedicated subdir (e.g. `/Volumes/three-body/twitter/normalized/`).
- Typesense is serving index only; never source of truth.

### Configuration impact

- No new external API credentials are required for archive backfill.
- Reuse existing `typesense_api_key` lease flow and current Typesense connectivity.

## Verification

- [ ] A full ingest run can be re-executed without duplicates (idempotency by tweet id).
- [ ] `twitter_tweets` and `twitter_threads` exist in Typesense with expected doc counts.
- [ ] A known tweet can be found by exact phrase and by semantic paraphrase.
- [ ] Date-filtered queries return correct bounded result sets.
- [ ] Pipeline emits OTEL events for every stage with success/failure counts.
- [ ] Reindex from canonical layer succeeds without reading external APIs.

## Consequences

### Positive

- 20 years of personal signal becomes first-class, queryable context inside joelclaw.
- No extra search/vector database to operate.
- Deterministic replay/reindex path from canonical data.

### Negative / risks

- Initial normalization will be heavy and may expose malformed historical payloads.
- Schema design mistakes in phase 1 can create expensive reindex cycles.
- Embedding cost/latency must be controlled for large backfills.

## Follow-up

If accepted, create implementation stories for:

1. Archive parser + canonical writer
2. Typesense schema + ingest functions
3. CLI surfaces (`ingest`, `status`, `search`, `reindex`)
4. OTEL dashboards for archive ingest health
