---
status: proposed
date: 2026-02-22
decision-makers: joel
consulted: pi session (2026-02-22)
supersedes: []
---

# ADR-0093: Agent-Friendly Navigation Contract (AGENT-FIRST 30)

## Context

JoelClaw has strong capabilities (Inngest workflows, gateway, memory, OTEL, CLI surfaces), but agent UX is still inconsistent:

- Discovery is fragmented across commands, skills, and ADRs.
- Command contracts are mostly consistent but not enforced by a single CI gate.
- Recovery from failures is not uniformly deterministic (`error -> runbook -> verify -> rollback`).
- Memory/context routing is implemented in several places, but still uneven across decision-heavy functions.
- Navigation can be surprising (example: `joelclaw search` against `otel_events` can fail with embedded params parsing errors while `joelclaw otel` succeeds).

Goal: make joelclaw extremely **agent-friendly, navigable, predictable, and obvious**.

## Decision

Adopt a 30-day architecture program in three strict phases:

1. **CLI contracts & discovery** (foundation)
2. **Deterministic error runbooks & recovery**
3. **Memory/context routing standardization**

The order is mandatory: no broad memory routing expansion until command contracts and recovery behaviors are deterministic.

## Update (2026-02-22)

Phase 1 kickoff started.

- AF30-001 implemented in monorepo:
  - `scripts/validate-cli-contracts.ts` added (baseline drift validator)
  - `docs/agent-contracts/phase1-baseline.json` generated
  - envelope helpers/validator added in `packages/cli/src/response.ts`
  - contract test added at `packages/cli/src/commands/contract-envelope.test.ts`
  - root script `validate:cli-contracts` added in `package.json`
- Validation passed:
  - `bun run validate:cli-contracts`
  - `bun test packages/cli/src/commands/contract-envelope.test.ts`
  - `cd packages/cli && bun run check-types`

## Design Contract

1. **CLI-first discoverability**: an agent must find the right next command in 1 call.
2. **Stable command envelope**: all commands conform to the canonical response schema.
3. **Deterministic failure handling**: every known failure maps to machine-readable runbook steps.
4. **Bounded context injection**: memory prefetch is policy-driven, traceable, and budgeted.
5. **No silent failure**: all degraded/failure paths emit OTEL with actionable metadata.

## Implementation Plan

### Phase 1 (Days 1–10): CLI contracts + navigation

**Deliverables**

- Add canonical contract validation for all CLI commands:
  - `packages/cli/src/response.ts`
  - `packages/cli/src/commands/*.ts`
  - `packages/cli/src/schema.ts`
- Add discoverability surface:
  - `packages/cli/src/commands/capabilities.ts` (new)
  - map goals -> command templates -> prerequisites -> next actions
- Add contract tests:
  - `packages/cli/src/commands/*.test.ts` (new where missing)
  - enforce envelope shape + required `next_actions` quality
- Add CI gate:
  - `.github/workflows/agent-contracts.yml` (new)

**Acceptance criteria**

- 100% CLI commands return canonical envelope (`ok`, `command`, `result|error`, `next_actions`).
- 0 commands missing actionable `next_actions`.
- `joelclaw capabilities` can enumerate major operational flows (status, runs, gateway, otel, memory).

### Day 1 Execution Checklist (Phase 1 kickoff)

- [ ] Baseline command-surface + contract drift inventory
  - inspect:
    - `packages/cli/src/cli.ts`
    - `packages/cli/src/commands/*.ts`
    - `packages/cli/src/response.ts`
  - artifact:
    - `docs/agent-contracts/phase1-baseline.json` (new)
- [ ] Add contract validator scaffold (failing-first)
  - `scripts/validate-cli-contracts.ts` (new)
  - `package.json` script: `validate:cli-contracts` (new)
- [ ] Reproduce and pin current navigation failure as regression test
  - failing command to codify:
    - `joelclaw search "telegram.callback.received" --collection otel_events --limit 5`
  - expected behavior:
    - deterministic success or structured recoverable error envelope (never raw Typesense parser failure)
  - test file:
    - `packages/cli/src/commands/search.test.ts` (new)
- [ ] Upgrade first high-traffic command set to strict contract quality
  - `packages/cli/src/commands/status.ts`
  - `packages/cli/src/commands/runs.ts`
  - `packages/cli/src/commands/gateway.ts`
  - `packages/cli/src/commands/otel.ts`
  - `packages/cli/src/commands/send.ts`

### First 3 PR-sized stories (Phase 1)

#### Story AF30-001 — CLI Contract Harness + Baseline

**Goal**: make contract drift visible and testable before broad refactors.

**Files**
- `packages/cli/src/response.ts`
- `scripts/validate-cli-contracts.ts` (new)
- `packages/cli/src/commands/contract-envelope.test.ts` (new)
- `package.json`
- `docs/agent-contracts/phase1-baseline.json` (new)

**Acceptance checks**
- `bun run validate:cli-contracts`
- `bun test packages/cli/src/commands/contract-envelope.test.ts`

#### Story AF30-002 — Capabilities Command (Discoverability Surface)

**Goal**: one-call discovery for agents (`goal -> commands -> next_actions -> prerequisites`).

**Files**
- `packages/cli/src/commands/capabilities.ts` (new)
- `packages/cli/src/cli.ts`
- `packages/cli/src/commands/capabilities.test.ts` (new)
- `docs/agent-contracts/capabilities-map.md` (new)

**Acceptance checks**
- `joelclaw capabilities`
- `joelclaw capabilities | jq '.result.flows | length'`
- `bun test packages/cli/src/commands/capabilities.test.ts`

#### Story AF30-003 — Predictable Search + Contract CI Gate

**Goal**: eliminate known navigation surprise and enforce contract checks on every push.

**Files**
- `packages/cli/src/commands/search.ts`
- `packages/cli/src/commands/search.test.ts` (new)
- `.github/workflows/agent-contracts.yml` (new)
- `package.json`

**Acceptance checks**
- `joelclaw search "telegram.callback.received" --collection otel_events --limit 5`
- `bun test packages/cli/src/commands/search.test.ts`
- CI workflow `agent-contracts` passes on PR

### Phase 2 (Days 11–20): deterministic recovery runbooks

**Deliverables**

- Define shared error/runbook registry:
  - `packages/cli/src/error-codes.ts` (new)
  - `packages/cli/src/runbooks.ts` (new)
- Add recovery command:
  - `packages/cli/src/commands/recover.ts` (new)
  - supports dry-run first, then execute
- Align worker auto-fix + runbook logic:
  - `packages/system-bus/src/observability/auto-fixes/*`
  - `packages/system-bus/src/inngest/functions/o11y-triage.ts`
- Require rollback + verify steps in each runbook entry.

**Acceptance criteria**

- Top 20 recurring error codes mapped to deterministic runbooks.
- Every runbook includes rollback and verification commands.
- OTEL emits for runbook start/success/failure across CLI + worker paths.

### Phase 3 (Days 21–30): memory routing standardization

**Deliverables**

- Make shared prefetch policy authoritative:
  - `packages/system-bus/src/memory/context-prefetch.ts`
- Expand to remaining high-impact functions still missing memory context:
  - `packages/system-bus/src/inngest/functions/task-triage.ts`
  - `packages/system-bus/src/inngest/functions/check-calendar.ts`
  - `packages/system-bus/src/inngest/functions/check-granola.ts`
  - `packages/system-bus/src/inngest/functions/check-loops.ts`
- Add context traceability surface:
  - `packages/cli/src/commands/inngest.ts` (extend) or `packages/cli/src/commands/memory.ts` (new)
  - expose what memory was injected, why, and filter/drop diagnostics

**Acceptance criteria**

- Decision-heavy functions use shared memory policy (no ad-hoc retrieval forks).
- Context injection remains bounded and observable (latency + quality metrics in OTEL).
- Agents can inspect memory-injection evidence from CLI without pod log grepping.

## Verification Commands

- `joelclaw status`
- `joelclaw capabilities`
- `joelclaw runs --count 20 --hours 24`
- `joelclaw otel stats --hours 24`
- `joelclaw otel search "auto_fix|runbook|recover|memory.recall" --hours 24`
- `bun test packages/cli/src/commands/recall.test.ts`
- `bun test packages/cli/src/commands/*.test.ts`

## Non-Goals

- Rewriting all existing ADRs or command names.
- Replacing CLI-first architecture with dashboard-first operations.
- Building a new memory backend.

## Consequences

### Positive

- Faster autonomous execution with less prompt thrash.
- Lower ambiguity during outages and degraded states.
- Better onboarding for any new agent/harness.

### Negative / Risks

- Requires disciplined schema/runbook maintenance.
- Up-front test and contract work before feature velocity gains.
- Temporary churn across command surfaces during migration.

## References

- ADR-0009 (joelclaw CLI naming + agent-first CLI direction)
- ADR-0018 (gateway CLI/HATEOAS operational contract)
- ADR-0058 (NDJSON streaming for temporal operations)
- ADR-0087 (observability contract)
- ADR-0090 (autonomous o11y triage loop)
- ADR-0077 (memory system next phase)

## Status

Proposed.
