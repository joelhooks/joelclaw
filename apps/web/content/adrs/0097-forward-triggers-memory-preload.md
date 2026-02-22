---
type: adr
status: proposed
date: 2026-02-22
tags: [adr, memory, temporal, triggers, preload]
deciders: [joel]
consulted: [pi session 2026-02-22]
supersedes: []
superseded-by: []
---

# ADR-0097: Forward Triggers for Time-Based Memory Preload

## Context

ADR-0077 deferred forward triggers as an advanced memory capability. The system currently retrieves memory reactively; it does not proactively surface relevant context when a previously stated time-bound condition arrives (e.g., "next Friday", "after the meeting", "tomorrow morning").

This creates avoidable misses:

- temporal commitments are remembered only if explicitly queried,
- recurring workflows lose continuity,
- reminders and preload context are delayed until after user prompts.

## Decision

Implement forward triggers as a Typesense + Inngest temporal layer:

1. Detect temporal intents during memory ingest/reflection.
2. Normalize to `due_at` + trigger window + scope.
3. Persist trigger records and schedule durable fire events.
4. On fire, preload scoped memory context and emit actionable notification/context bundle.

Forward triggers augment memory retrieval; they do not replace task management systems.

## Trigger Contract

Each forward trigger stores:

- `trigger_id`
- `source_observation_id`
- `due_at` (ISO timestamp)
- `temporal_phrase` (original text)
- `scope` (`category_id`, session/project hints)
- `confidence` (0..1)
- `status` (`scheduled|fired|cancelled|expired`)
- `dedupe_key`

## Implementation Plan

### 1) Temporal extraction + normalization

- deterministic parser first (date/time libraries), LLM assist for ambiguous phrasing
- confidence-scored output

Files:

- `packages/system-bus/src/memory/forward-triggers.ts` (new)
- `packages/system-bus/src/inngest/functions/observe.ts`
- `packages/system-bus/src/inngest/functions/reflect.ts`

### 2) Storage + scheduling

Persist trigger records and schedule fire events through Inngest.

Files:

- `packages/system-bus/src/inngest/functions/memory/forward-trigger-register.ts` (new)
- `packages/system-bus/src/inngest/functions/memory/forward-trigger-fire.ts` (new)

### 3) Fire-time preload

At trigger fire:

- query category/project-scoped memory,
- produce compact preload bundle,
- notify gateway and/or enqueue event for relevant check function.

Files:

- `packages/system-bus/src/memory/context-prefetch.ts`
- `packages/system-bus/src/inngest/functions/check-system-health.ts` (or dedicated dispatcher)

### 4) Ops + diagnostics

Expose trigger health and lifecycle via CLI and OTEL.

Files:

- `packages/cli/src/commands/inngest.ts`
- `packages/system-bus/src/observability/*`

## Acceptance Criteria

- [ ] Temporal phrases produce normalized trigger records with confidence.
- [ ] Scheduled triggers fire once with dedupe protection.
- [ ] Fired triggers generate preload context containing scoped relevant memories.
- [ ] Trigger lifecycle is diagnosable from OTEL (`scheduled`, `fired`, `failed`, `expired`).
- [ ] Low-confidence or ambiguous trigger candidates are logged and safely handled.

## Verification Commands

- `bunx tsc --noEmit -p packages/system-bus/tsconfig.json`
- `joelclaw otel search "forward-trigger|memory.preload" --hours 24`
- `joelclaw runs --count 20 --hours 24`
- `joelclaw run <run-id>`

## Non-Goals

- Replacing Todoist/task-management semantics.
- Full calendar automation in V1.
- Cross-agent network broadcasting.

## Consequences

### Positive

- Memory becomes proactively useful, not only query-driven.
- Better continuity for time-bound commitments.
- Strong temporal substrate for future planning loops.

### Negative / Risks

- Ambiguous time expressions can generate false triggers.
- Trigger noise if confidence/filters are weak.
- Additional lifecycle monitoring required.

## References

- ADR-0077: Memory System — Next Phase
- ADR-0095: Typesense-Native Memory Categories (scope dependency)
- ADR-0040: Google Workspace via gogcli (adjacent temporal context source)

## Status

Proposed.
