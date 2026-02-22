---
type: adr
status: proposed
date: 2026-02-22
tags: [adr, memory, retrieval, budget, tokens]
deciders: [joel]
consulted: [pi session 2026-02-22]
supersedes: []
superseded-by: []
---

# ADR-0096: Budget-Aware Memory Retrieval Policy

## Update (2026-02-22)

- Initial implementation slice landed:
  - `joelclaw recall` now supports `--budget lean|balanced|deep|auto`
  - budget plan controls rewrite enablement, fetch depth, and inject cap behavior
  - recall OTEL metadata now includes budget selection diagnostics
  - memory context prefetch now supports budget-profile-based fetch scaling
- ADR status remains `proposed` until quality/latency validation gates are met.

## Context

ADR-0077 deferred budget-aware retrieval. ADR-0078 established token-cost pressure as a system concern. Current memory retrieval uses mostly fixed behavior (rewrite attempts, fetch depth, inject caps), which is suboptimal across contexts:

- simple recalls overpay in latency and token cost,
- complex recalls may under-search,
- no explicit budget policy exists for operators or agents.

Budget-aware retrieval is needed to trade off quality/latency/cost intentionally.

## Decision

Introduce a shared retrieval budget policy with three profiles:

1. `lean` — minimal cost/latency
2. `balanced` — default
3. `deep` — higher quality effort for hard queries

All memory retrieval paths must declare or infer a profile, then apply profile-specific limits for rewrite/search/ranking/injection.

## Policy Contract

### Profile matrix (initial)

- **lean**
  - query rewrite: disabled by default
  - candidate fetch: low
  - trust-pass: strict
  - injected memories: 3-5
- **balanced**
  - query rewrite: single attempt
  - candidate fetch: medium
  - trust-pass: standard
  - injected memories: 6-10
- **deep**
  - query rewrite: full fallback chain
  - candidate fetch: high
  - trust-pass: permissive with diagnostics
  - injected memories: up to configured max

Budget metadata must be visible in CLI JSON and OTEL events.

## Implementation Plan

### 1) Shared policy module

- `packages/system-bus/src/memory/retrieval-budget.ts` (new)
- `packages/cli/src/commands/recall.ts` (consume policy)
- `packages/system-bus/src/memory/context-prefetch.ts` (consume policy)

### 2) CLI/API profile controls

Add profile selection and auto mode:

- `--budget lean|balanced|deep|auto`
- optional `--max-latency-ms` and `--max-inject`

Files:

- `packages/cli/src/commands/recall.ts`

### 3) Auto profile inference

Infer budget from query complexity + caller context + optional cost mode.

- `packages/system-bus/src/memory/retrieval-budget.ts`
- `packages/system-bus/src/inngest/functions/check-email.ts` (and other prefetch callers)

### 4) Observability + governance

Emit profile and budget diagnostics:

- profile selected
- rewrite attempts
- candidate count
- injected count
- latency

Files:

- `packages/cli/src/commands/recall.ts`
- `packages/system-bus/src/observability/*`
- `packages/cli/src/commands/inngest.ts` (health/reporting surfaces)

## Acceptance Criteria

- [x] Every retrieval path emits `budget_profile` and budget diagnostics in OTEL.
- [x] `joelclaw recall --budget <profile>` deterministically changes retrieval behavior.
- [x] Lean profile reduces latency/cost for simple queries without catastrophic quality loss.
- [ ] Deep profile improves difficult-query hit quality compared to balanced baseline.
- [x] Default `auto` profile is explainable in output (`why this profile was selected`).

## Verification Commands

- `bunx tsc --noEmit -p packages/system-bus/tsconfig.json`
- `bunx tsc --noEmit -p packages/cli/tsconfig.json`
- `bun test packages/cli/src/commands/recall.test.ts`
- `joelclaw recall "redis lock pattern" --budget lean --json`
- `joelclaw recall "cross-session memory dedupe failure mode" --budget deep --json`
- `joelclaw otel search "budget_profile|memory.recall" --hours 24`

## Non-Goals

- Per-provider billing reconciliation in this ADR.
- Changing memory storage backend.
- Knowledge-graph retrieval.

## Consequences

### Positive

- Predictable quality/cost/latency tradeoffs.
- Better defaults for autonomous agents under variable workloads.
- Strong foundation for future global budget controls.

### Negative / Risks

- Mis-tuned profile defaults can degrade relevance.
- More policy surface to maintain and test.

## References

- ADR-0077: Memory System — Next Phase
- ADR-0078: Opus Token Reduction
- ADR-0095: Typesense-Native Memory Categories (dependency for domain-aware budgeting)

## More Information

### 2026-02-22 validation snapshot

Budget corpus run (6 queries, `--limit 5`, lean vs deep):
- lean average latency: ~618ms
- deep average latency: ~5375ms

Observed behavior:
- Lean consistently disables rewrite and returns quickly.
- Deep consistently enables rewrite and higher fetch depth.
- Auto mode surfaces explicit selection reason in output/OTEL (`budgetRequested`, `budgetApplied`, `budgetReason`).
- Context prefetch now emits dedicated OTEL budget diagnostics (`memory.context_prefetch.completed`) with `budget_profile`, fetch depth, and filter/drop metrics.
- Added daily ADR evidence capture loop (`system/memory-adr-evidence-capture`) so `memory/adr-evidence.daily.captured` records rolling budget diagnostics across a 7-day window.
- Quality uplift from deep over baseline is mixed in this corpus; not yet consistently better.

Remaining acceptance gaps:
- Deep-quality superiority gate is not yet met.

## Status

Proposed (pending deep-quality evidence gate).
