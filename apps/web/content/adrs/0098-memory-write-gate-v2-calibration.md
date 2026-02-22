---
type: adr
status: proposed
date: 2026-02-22
tags: [adr, memory, write-gate, calibration, quality]
deciders: [joel]
consulted: [pi session 2026-02-22]
supersedes: []
superseded-by: []
---

# ADR-0098: Memory Write Gate V2 Calibration and Governance

## Context

ADR-0094 defines Write Gate V1: soft gate, three-state verdicts (`allow|hold|discard`), fail-open fallback, and ingest-time enforcement. V1 establishes policy and metadata but not ongoing calibration.

Without calibration:

- useful observations can be over-held or over-discarded,
- gate drift can silently degrade recall quality,
- operators lack a deterministic tuning loop.

## Decision

Adopt a formal V2 calibration loop for write-gate quality.

V2 adds:

1. **Ground-truth sampling** of `hold` and `discard` outcomes.
2. **Feedback integration** from downstream signals (recall usage, promotion outcomes, manual corrections).
3. **Versioned threshold tuning** with canary rollout and rollback.
4. **Explicit SLOs** for gate quality and fallback rates.

## Calibration Contract

### Core metrics

- `false_hold_rate`
- `false_discard_rate`
- `gate_fallback_rate`
- `allow_precision_proxy` (downstream usefulness signal)
- `proposal_noise_rate` (post-gate)

### SLO targets (initial)

- fallback rate < 5%
- sampled false discard < 2%
- measurable reduction in proposal noise vs pre-gate baseline

### Rollout policy

- Gate policy changes must increment `write_gate_version`.
- Roll out to canary slice first.
- Auto-rollback on SLO regression.

## Implementation Plan

### 1) Sampling + audit flow

Create weekly sampled audits for hold/discard observations.

- `packages/system-bus/src/inngest/functions/memory/write-gate-audit.ts` (new)
- `packages/cli/src/commands/inngest.ts` (audit/report surface)

### 2) Feedback ingestion

Incorporate outcomes from recall usage and memory promotion into gate diagnostics.

- `packages/system-bus/src/memory/echo-fizzle.ts`
- `packages/system-bus/src/inngest/functions/memory/proposal-triage.ts`
- `packages/system-bus/src/inngest/functions/promote.ts`

### 3) Versioned tuning controls

Add centrally managed threshold config with safe rollout controls.

- `packages/system-bus/src/memory/write-gate-policy.ts` (new)
- `packages/system-bus/src/inngest/functions/observe.ts`
- `packages/system-bus/src/inngest/functions/observe-session-noted.ts`

### 4) Observability and guardrails

Emit calibration events and enforce regression alerts.

- `packages/system-bus/src/observability/*`
- `packages/system-bus/src/inngest/functions/check-system-health.ts`

## Acceptance Criteria

- [ ] Weekly audit samples are generated and reviewable.
- [ ] Gate quality metrics are emitted and queryable in OTEL.
- [ ] Policy version changes are traceable (`write_gate_version`).
- [ ] Canary policy rollout and rollback path are implemented and tested.
- [ ] Gate SLO regressions surface as actionable system-health signals.

## Verification Commands

- `bunx tsc --noEmit -p packages/system-bus/tsconfig.json`
- `joelclaw otel search "write_gate|gate_fallback|false_discard" --hours 24`
- `joelclaw inngest memory-health --hours 24 --json`
- `joelclaw runs --count 20 --hours 24`

## Non-Goals

- Replacing V1 gate semantics.
- Introducing hard-reject ingest policy.
- Graph/dual-search behavior changes.

## Consequences

### Positive

- Sustained write-gate quality instead of one-time rollout.
- Lower risk of silent memory quality regressions.
- Safer evolution of classification policy.

### Negative / Risks

- Added operational/monitoring complexity.
- Requires disciplined sample review and tuning cadence.

## References

- ADR-0094: Memory Write Gate V1
- ADR-0077: Memory System — Next Phase
- ADR-0087: Observability contract

## Status

Proposed.
