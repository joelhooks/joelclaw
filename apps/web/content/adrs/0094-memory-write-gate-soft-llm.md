---
type: adr
status: proposed
date: 2026-02-22
tags: [adr, memory, write-gate]
deciders: [joel]
consulted: [pi session 2026-02-22]
supersedes: []
superseded-by: []
---

# ADR-0094: Memory Write Gate V1 (Soft, LLM-First, Three-State)

## Context

ADR-0077 identified **write gate** as a deferred part of the broader memory vision. Since then, retrieval hardening and maintenance shipped, but one core quality problem remains:

- Low-signal observations still enter the pipeline.
- Reflect and proposal triage pay the downstream cost (noise, backlog, review load).
- Retrieval filtering alone is not enough because Reflect reads Redis observation summaries written during ingest.

Current constraints:

1. **No data loss** — raw observations must remain available for audit/debug.
2. **Quality lift now** — reduce noisy proposals in the next implementation slice.
3. **CLI/OTEL diagnosability** — gate behavior must be observable via existing `joelclaw otel` and memory health workflows.
4. **No new memory backend** in this slice (Typesense remains canonical).

## Decision

Adopt a **soft write gate** at memory ingest with these policies:

1. **Three-state verdict per observation**: `allow | hold | discard`.
2. **LLM-first classification** integrated into the existing observer call path (no extra classifier round-trip by default).
3. **Fail-open default**: if parse/classifier metadata is missing, store as `allow` with low confidence and explicit fallback reason.
4. **Store all observations** in `memory_observations` with write-gate metadata (audit preserved).
5. **Default downstream behavior**:
   - `allow`: eligible for Redis summary → Reflect, and default recall/prefetch.
   - `hold`: stored, but excluded from Reflect and default recall/prefetch; available for debug/fallback paths.
   - `discard`: stored for audit only; excluded from Reflect/default retrieval.

## Design Contract

### Metadata fields (per observation)

- `write_verdict`: `allow | hold | discard`
- `write_confidence`: float `0..1`
- `write_reason`: short classifier rationale
- `write_gate_version`: string (ex: `v1`)
- `write_gate_fallback`: boolean (`true` when parser/classifier fallback applied)

### Enforcement points

- **Primary enforcement**: ingest, before Redis summary write used by Reflect.
- **Secondary enforcement**: default retrieval filters in recall/context prefetch.

### Failure semantics

- Missing/malformed gate metadata MUST NOT drop data.
- In fallback mode, observation is still stored, marked `allow`, low confidence, and `write_gate_fallback=true`.
- OTEL must emit fallback counts and reasons.

## Implementation Plan

### 1) Extend observer classification output

- Update observer prompt and parser to produce gate metadata per observation item.
- Files:
  - `packages/system-bus/src/inngest/functions/observe-prompt.ts`
  - `packages/system-bus/src/inngest/functions/observe-parser.ts`

### 2) Apply gate during ingest

- In `observe.ts`, enrich observation items with verdict metadata, write all docs to Typesense, but build Redis reflection summary from `allow` only.
- In `observe-session-noted.ts`, normalize gate metadata (trusted-source default policy documented in code).
- Files:
  - `packages/system-bus/src/inngest/functions/observe.ts`
  - `packages/system-bus/src/inngest/functions/observe-session-noted.ts`

### 3) Filter default retrieval paths

- Recall defaults to `write_verdict:=allow`; optional debug/fallback expansion can include `hold`.
- Context prefetch follows same default policy.
- Files:
  - `packages/cli/src/commands/recall.ts`
  - `packages/system-bus/src/memory/context-prefetch.ts`

### 4) Schema and health wiring

- Ensure memory schema reconciliation includes write-gate fields.
- Extend memory health/weekly summaries with verdict distribution signals.
- Files:
  - `packages/cli/src/commands/inngest.ts`
  - `packages/system-bus/src/inngest/functions/memory/weekly-maintenance-summary.ts`

### 5) Tests + verification

- Add/extend tests for:
  - gate parsing/fallback behavior
  - ingest filtering into Redis/Reflect
  - recall default filter behavior
- Files:
  - `packages/system-bus/src/inngest/functions/observe.test.ts`
  - `packages/cli/src/commands/recall.test.ts`

## Acceptance Criteria

- [x] Mixed-quality observation batches persist all documents with gate metadata in Typesense.
- [x] Reflect input excludes `hold` and `discard` by default.
- [x] Default recall/prefetch exclude `hold`/`discard`; debug path can surface `hold`.
- [x] Fallback path is explicit (`write_gate_fallback=true`) and visible in OTEL.
- [x] OTEL includes verdict counts per ingest run (`allowCount`, `holdCount`, `discardCount`, `fallbackCount`).
- [ ] Proposal noise drops measurably after rollout (tracked window in OTEL/weekly summary).

## Verification Commands

- `bunx tsc --noEmit -p packages/system-bus/tsconfig.json`
- `bunx tsc --noEmit -p packages/cli/tsconfig.json`
- `bun test packages/system-bus/src/inngest/functions/observe.test.ts`
- `bun test packages/cli/src/commands/recall.test.ts`
- `joelclaw inngest memory-schema-reconcile --json`
- `joelclaw recall "redis dedupe pattern" --json`
- `joelclaw otel search "observe.store.completed|write_gate|proposal-triage" --hours 24`

## Non-Goals

- Adopting Datomic or replacing Typesense in this slice.
- Implementing knowledge graph / dual-search in this ADR.
- Hard-rejecting observations at ingest.

## Consequences

### Positive

- Immediate reduction of downstream memory noise and review burden.
- Preserves full raw evidence for audit/debug.
- Clear policy surface for future category and budget-aware retrieval work.

### Negative / Risks

- LLM classification quality can drift; fallback and telemetry must be monitored.
- Misclassification risk (useful items marked hold/discard) requires debug visibility.
- Additional schema/policy complexity across ingest and retrieval.

## References

- ADR-0077: Memory System — Next Phase
- ADR-0068: Memory Proposal Auto-Triage Pipeline
- ADR-0087: Observability contract

## More Information

### 2026-02-22 validation snapshot

- `joelclaw inngest memory-e2e --wait-ms 120000 --poll-ms 1500 --json` produced mixed write verdicts and fallback in one run (`allow=4`, `discard=1`, `fallback=1`) with persisted metadata in `memory_observations`.
- `joelclaw recall "memory-e2e-mlx5t4fl-z1sg4r" --category memory --limit 5 --json` showed default `hold` exclusion (`held_by_write_gate` in dropped diagnostics) while surfacing `allow` observations.
- `joelclaw otel search "memory.write_gate_drift.detected" --hours 2 --json` confirmed health-check alert hook emission for drift conditions.
- `joelclaw otel search "system.health.checked" --hours 1 --json` now includes `writeGateDrift` in health metadata.

Remaining acceptance gap: measurable proposal-noise reduction trend over a longer post-rollout window.

## Status

Proposed (pending long-window proposal-noise reduction evidence).
