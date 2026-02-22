---
type: adr
status: deferred
date: 2026-02-22
tags: [adr, memory, knowledge-graph, skos, deferred]
deciders: [joel]
consulted: [pi session 2026-02-22]
supersedes: []
superseded-by: []
related:
  - "0109-system-wide-taxonomy-concept-contract"
  - "0095-typesense-native-memory-categories-skos-lite"
---

# ADR-0099: Memory Knowledge-Graph Substrate (Deferred, Activation-Gated)

## Context

ADR-0077 identified knowledge graphs as part of the full memory vision and deferred them due to complexity/ROI uncertainty at current scale. ADR-0024 provides SKOS and graph direction but was designed around Qdrant-era assumptions.

With Typesense now canonical, we need a graph path that:

- preserves SKOS direction,
- avoids premature database migration,
- activates only when measurable relation-blind retrieval gaps justify it.

ADR-0109 establishes system-wide concept IDs. This graph substrate must build on those shared IDs, not memory-only tags.

## Decision

Define a **Typesense-compatible graph substrate** as the next graph step, but keep implementation deferred behind explicit activation gates.

### Planned substrate (when activated)

1. Add relation records (triple-style facts + temporal validity) in Typesense-side collections.
2. Link relations to canonical concept IDs (ADR-0109; ADR-0095 categories are one scheme).
3. Keep graph extraction and graph retrieval independent from core ingest until quality gates pass.

No Datomic or dedicated graph database is adopted in this ADR.

## Activation Gates (all required)

1. **Concept contract maturity**: ADR-0109 Phase 1 complete for memory/docs with stable concept IDs.
2. **Category maturity**: ADR-0095 implemented and stable (`category_id` coverage >= 95%).
3. **Write-gate maturity**: ADR-0094 live with acceptable fallback/error rates.
4. **Miss evidence**: at least 20% of analyzed difficult-query misses are relation/multi-hop misses not solved by vector + categories.
5. **Operational readiness**: memory health remains green for 14 consecutive days while instrumentation is active.

If these gates are not met, graph work remains deferred.

## Planned Graph Contract (for activation)

Relation record shape:

- `relation_id`
- `subject_id`
- `predicate`
- `object_id` or `object_text`
- `valid_from` / `valid_to`
- `confidence`
- `source_observation_id`
- `category_id`
- `relation_version`

## Implementation Plan (deferred prep)

### Immediate (now, low-risk prep only)

- Add retrieval miss labeling to OTEL for relation-blind diagnostics.
- Define schema contract docs and test fixtures (no production extraction yet).

### Activation phase (after gates)

- Implement relation extraction pipeline.
- Add relation storage and reconciliation.
- Add relation health checks (coverage, conflict rate, drift).

Target files when activated:

- `packages/system-bus/src/memory/relations/*` (new)
- `packages/system-bus/src/inngest/functions/memory/*` (new relation jobs)
- `packages/cli/src/commands/inngest.ts` (relation diagnostics)

## Acceptance Criteria (for activation readiness)

- [ ] Gates are measurable and queryable from CLI/OTEL.
- [ ] Relation-blind miss evidence is captured for a representative query set.
- [ ] Go/no-go decision can be made from observed metrics, not intuition.

## Verification Commands

- `joelclaw otel search "memory.recall|relation_miss" --hours 24`
- `joelclaw inngest memory-health --hours 24 --json`
- `joelclaw otel stats --hours 24`

## Non-Goals

- Implementing graph extraction immediately.
- Introducing Datomic, Neo4j, or another graph store now.
- Replacing current vector retrieval paths.

## Consequences

### Positive

- Keeps long-term graph path explicit and SKOS-aligned.
- Prevents premature complexity.
- Forces evidence-based activation.

### Negative / Risks

- Deferred status may delay capabilities needed by edge cases.
- Requires disciplined miss labeling to avoid blind spots.

## References

- ADR-0077: Memory System — Next Phase
- ADR-0024: Taxonomy-Enhanced Session Search (deferred strategic source)
- ADR-0095: Typesense-Native Memory Categories
- ADR-0109: System-Wide Taxonomy + Concept Contract

## Status

Deferred (activation-gated).
