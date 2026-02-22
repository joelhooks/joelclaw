---
type: adr
status: proposed
date: 2026-02-22
tags: [adr, memory, categories, skos, typesense]
deciders: [joel]
consulted: [pi session 2026-02-22]
supersedes: []
superseded-by: []
---

# ADR-0095: Typesense-Native Memory Categories (SKOS-Lite V1)

## Context

ADR-0077 deferred categories as a high-leverage memory quality upgrade. ADR-0024 contains strong taxonomy/SKOS direction but is deferred and Qdrant-centric. The current memory system is Typesense-native.

Without explicit categories:

- retrieval relevance depends too heavily on lexical overlap,
- summary and maintenance jobs cannot reason by domain,
- future budget-aware retrieval and forward triggers have weak scoping.

Constraints:

1. Must remain Typesense-native (no Qdrant reintroduction).
2. Must preserve ADR-0024 SKOS direction.
3. Must be shippable with current memory pipeline (observe → reflect → triage → promote).

## Decision

Adopt a **SKOS-lite category layer** for `memory_observations` with a fixed, curated top-level taxonomy in V1.

### V1 taxonomy (fixed)

- `jc:preferences`
- `jc:rules-conventions`
- `jc:system-architecture`
- `jc:operations`
- `jc:memory-system`
- `jc:projects`
- `jc:people-relationships`

V1 policy:

1. Every observation gets `category_id` and `category_confidence`.
2. Category assignment uses deterministic mapping first, LLM assist second, deterministic fallback last.
3. Category summaries are generated weekly and used as a retrieval acceleration/tiering surface.
4. Taxonomy is versioned (`taxonomy_version=v1`) and explicitly migratable.

## SKOS-Lite Contract

For each category concept:

- `id` (e.g. `jc:operations`)
- `prefLabel`
- `altLabels[]`
- `broader[]` / `narrower[]` / `related[]`
- `scopeNote`
- `taxonomy_version`

This is SKOS-inspired and migration-friendly to deeper graph work later.

## Implementation Plan

### 1) Canonical taxonomy source

Create a single source file for category definitions and aliases.

- `packages/system-bus/src/memory/taxonomy-v1.ts` (new)

### 2) Ingest-time category assignment

Assign category metadata during observation ingest.

- `packages/system-bus/src/inngest/functions/observe.ts`
- `packages/system-bus/src/inngest/functions/observe-session-noted.ts`

Add fields on `memory_observations` docs:

- `category_id` (string)
- `category_confidence` (float)
- `category_source` (`rules|llm|fallback`)
- `taxonomy_version` (string)

### 3) Retrieval/category filtering

Add category-aware filters and diagnostics.

- `packages/cli/src/commands/recall.ts`
- `packages/system-bus/src/memory/context-prefetch.ts`

### 4) Weekly category summaries

Generate short summaries per category from recent high-confidence observations.

- `packages/system-bus/src/inngest/functions/memory/weekly-maintenance-summary.ts`
- `packages/system-bus/src/inngest/functions/memory/category-summaries.ts` (new)

### 5) Schema reconciliation + health signals

Ensure category fields exist and are reported by memory health.

- `packages/cli/src/commands/inngest.ts`

## Acceptance Criteria

- [x] ≥95% of new observations have non-empty `category_id`.
- [x] `joelclaw recall` supports category-constrained retrieval.
- [x] Weekly summary emits per-category counts and confidence distribution.
- [x] OTEL contains category assignment evidence (`category_id`, `category_source`, `taxonomy_version`).
- [ ] Category summaries are generated and queryable for at least 7 days of data.

## Verification Commands

- `bunx tsc --noEmit -p packages/system-bus/tsconfig.json`
- `bunx tsc --noEmit -p packages/cli/tsconfig.json`
- `joelclaw inngest memory-schema-reconcile --json`
- `joelclaw recall "memory pipeline" --json`
- `joelclaw otel search "category_id|taxonomy_version|weekly-maintenance" --hours 24`

## Non-Goals

- Dynamic category creation in V1.
- Full knowledge graph/triple extraction.
- Replacing ADR-0024 strategic taxonomy direction.

## Consequences

### Positive

- Better retrieval precision and scoping.
- Cleaner foundation for budget-aware retrieval and forward triggers.
- Explicit path from current Typesense model toward SKOS-aligned semantics.

### Negative / Risks

- Misclassification can hide relevant items if confidence/policy is mis-tuned.
- Taxonomy governance overhead (aliases, scope notes, drift management).

## References

- ADR-0077: Memory System — Next Phase
- ADR-0094: Memory Write Gate V1
- ADR-0024: Taxonomy-Enhanced Session Search (deferred strategic reference)

## More Information

### 2026-02-22 validation snapshot

- `joelclaw inngest memory-e2e --wait-ms 120000 --poll-ms 1500 --json` shows category metrics in run output (`categorizedCount=5`, `uncategorizedCount=0`, populated category/source buckets, `taxonomyVersions=["v1"]`).
- `joelclaw recall "memory-e2e-mlx5t4fl-z1sg4r" --category memory --limit 5 --json` validates alias normalization (`memory -> jc:memory-system`) and category-constrained recall behavior.
- `joelclaw otel search "weekly-category-summary.emitted" --hours 24 --json` confirms weekly category summary emission.
- Latest `observe.store.completed` OTEL metadata includes category assignment evidence: `categoryBuckets` (with canonical `category_id`s), `categorySourceBuckets`, and `taxonomyVersions`.
- Added daily ADR evidence capture loop (`system/memory-adr-evidence-capture`) emitting `memory/adr-evidence.daily.captured` snapshots for rolling 7-day gate tracking.

Remaining acceptance gap: sustained 7-day category summary evidence and broader backfill/coverage migration.

## Status

Proposed (pending 7-day category summary evidence window).
