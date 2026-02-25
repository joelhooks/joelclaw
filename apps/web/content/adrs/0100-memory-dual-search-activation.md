---
type: adr
status: proposed
date: 2026-02-22
tags: [adr, memory, dual-search, retrieval, deferred]
deciders: [joel]
consulted: [pi session 2026-02-22]
supersedes: []
superseded-by: []
related:
  - "0109-system-wide-taxonomy-concept-contract"
  - "0099-memory-knowledge-graph-substrate"
---

# ADR-0100: Memory Dual Search (Vector + Graph) Activation Plan

## Context

ADR-0077 deferred dual search because vector retrieval alone was sufficient at current scale and graph infrastructure was not yet justified. ADR-0099 defines a deferred, activation-gated graph substrate.

ADR-0109 defines the shared concept taxonomy contract that graph retrieval must use to mesh across domains.

Dual search should only be introduced when it can demonstrate measurable retrieval gains beyond category-aware vector search.

## Decision

Keep dual search deferred now, with a concrete activation plan:

1. Run vector and graph retrieval in parallel.
2. Merge rankings with a deterministic fusion strategy.
3. Fall back safely to vector-only when graph path is unavailable or low-confidence.

Dual search activation is contingent on ADR-0099 gates and objective benchmark gains.

## Activation Gates (all required)

1. ADR-0099 graph substrate activation approved and implemented for a pilot scope.
2. ADR-0109 concept contract has stable IDs across memory + docs (minimum cross-domain scope).
3. Benchmark set shows meaningful quality gain (target: >=10% nDCG or precision@k lift on hard queries).
4. Latency remains within interactive bounds for default budget profiles.
5. Failure fallback to vector-only path is verified and observable.

## Fusion Contract (planned)

- retrieval sources:
  - vector relevance score
  - graph path/relation relevance score
- merger:
  - weighted reciprocal rank fusion (wRRF) with versioned weights
- output diagnostics:
  - per-hit source attribution (`vector`, `graph`, `fused`)
  - dropped candidates by trust-pass/fusion thresholds

## Implementation Plan (deferred prep)

### Immediate (now)

- Define benchmark query suite for hard multi-hop memory queries.
- Add comparison harness for vector-only vs dual-search simulations.

### Activation phase

- Implement parallel retrieval and fusion layer.
- Add profile-aware dual-search toggles (budget integration with ADR-0096).
- Add OTEL diagnostics and health checks for fusion quality/latency.

Target files when activated:

- `packages/system-bus/src/memory/dual-search.ts` (new)
- `packages/cli/src/commands/recall.ts`
- `packages/system-bus/src/memory/context-prefetch.ts`
- `packages/system-bus/src/observability/*`

## Acceptance Criteria (for activation readiness)

- [ ] Benchmark suite exists and is reproducible.
- [ ] Dual-search gain thresholds are explicit and testable.
- [ ] Fallback behavior is deterministic and observable.
- [ ] Latency budgets per retrieval profile are defined.

## Verification Commands

- `joelclaw recall "<query>" --json`
- `joelclaw otel search "memory.recall|dual-search|fusion" --hours 24`
- `joelclaw otel stats --hours 24`

## Non-Goals

- Immediate dual-search implementation.
- Replacing existing retrieval with graph-only.
- Introducing a new memory database.

## Consequences

### Positive

- Preserves advanced roadmap with clear evidence thresholds.
- Avoids speculative complexity and latency cost before readiness.
- Enables controlled rollout when graph substrate is mature.

### Negative / Risks

- Deferred status postpones potential gains for complex relational queries.
- Requires benchmark discipline to avoid fuzzy go/no-go decisions.

## References

- ADR-0077: Memory System — Next Phase
- ADR-0096: Budget-Aware Memory Retrieval Policy
- ADR-0099: Memory Knowledge-Graph Substrate
- ADR-0109: System-Wide Taxonomy + Concept Contract

## Status

Deferred (activation-gated).
