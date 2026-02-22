---
status: accepted
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
  - response output aligned to JSON-only envelope (TOON result mode removed); legacy `--json/--toon` accepted as no-op for compatibility
- Validation passed:
  - `bun run validate:cli-contracts`
  - `bun test packages/cli/src/commands/contract-envelope.test.ts`
  - `cd packages/cli && bun run check-types`
- AF30-002 implemented in monorepo:
  - `packages/cli/src/commands/capabilities.ts` added (goal-oriented discoverability command)
  - `packages/cli/src/commands/capabilities.test.ts` added
  - `docs/agent-contracts/capabilities-map.md` added
  - root CLI wiring updated in `packages/cli/src/cli.ts`
  - baseline refreshed at `docs/agent-contracts/phase1-baseline.json`
- AF30-002 validation passed:
  - `cd packages/cli && bun src/cli.ts capabilities`
  - `bun test packages/cli/src/commands/capabilities.test.ts`
  - `bun run validate:cli-contracts`
- AF30-003 implemented in monorepo:
  - `packages/cli/src/commands/search.ts` hardened for deterministic collection selection
  - `packages/cli/src/commands/search.test.ts` added (predictability + semantic guard coverage)
  - `.github/workflows/agent-contracts.yml` added (contract CI gate)
  - `otel_events` now supported as a first-class collection in `joelclaw search`
- AF30-003 validation passed:
  - `cd packages/cli && bun src/cli.ts search "telegram.callback.received" --collection otel_events --limit 5`
  - `bun test packages/cli/src/commands/search.test.ts`
  - `bun run validate:cli-contracts`
- Phase-1 core command hardening completed for high-traffic set:
  - `send.ts`: invalid JSON now returns `respondError` (`INVALID_JSON` + fix)
  - `runs.ts`: `--compact` now returns terse JSON rows (no plain-text output)
  - `run` next actions now use CLI-first log commands (no raw `tail`/`docker logs` suggestions)
  - `gateway.ts`: invalid payload now returns `respondError` (`INVALID_JSON` + fix)
  - `status.ts` and `otel.ts` revalidated against JSON envelope contract
  - baseline refreshed: `docs/agent-contracts/phase1-baseline.json` (`rawOutputCommandFiles: 5`)
- Core hardening validation passed:
  - `cd packages/cli && bun src/cli.ts runs -c --count 3 --hours 1`
  - `cd packages/cli && bun src/cli.ts send test.event --data '{bad json}'`
  - `cd packages/cli && bun src/cli.ts gateway push --type test --payload '{bad json}'`
  - `cd packages/cli && bun src/cli.ts status`
  - `cd packages/cli && bun src/cli.ts otel`
  - `bun run validate:cli-contracts`
- Phase-2 scaffold implemented (dry-run-first recovery):
  - `packages/cli/src/error-codes.ts` added (canonical code list + normalizer)
  - `packages/cli/src/runbooks.ts` added (runbook registry + placeholder resolution)
  - `packages/cli/src/commands/recover.ts` added (`recover list`, dry-run preview, `--execute` phase execution)
  - `packages/cli/src/commands/recover.test.ts` and `packages/cli/src/commands/runbooks.test.ts` added
  - root CLI wiring updated in `packages/cli/src/cli.ts` (`joelclaw recover ...`)
  - capabilities map extended with deterministic recovery flow
  - baseline refreshed: `docs/agent-contracts/phase1-baseline.json` (`Commands scanned: 27`)
- Phase-2 scaffold validation passed:
  - `cd packages/cli && bun src/cli.ts recover list`
  - `cd packages/cli && bun src/cli.ts recover TYPESENSE_UNREACHABLE --phase fix --context '{"run-id":"01TEST"}'`
  - `cd packages/cli && bun src/cli.ts recover BAD_CODE`
  - `bun test packages/cli/src/commands/recover.test.ts packages/cli/src/commands/runbooks.test.ts`
  - `bun run validate:cli-contracts`
- Phase-2 completion tranche implemented (top-20 coverage + recovery wiring):
  - expanded runbook registry to canonical top 20 error codes in `packages/cli/src/runbooks.ts`
  - enforced runbook completeness (`diagnose`, `fix`, `verify`, `rollback` all non-empty) via `runbooks.test.ts`
  - `respondError` and stream `emitError` now auto-append `recover` next action when a runbook exists (`packages/cli/src/response.ts`, `packages/cli/src/stream.ts`)
  - o11y auto-fix handlers now declare runbook mapping metadata (`packages/system-bus/src/observability/auto-fixes/index.ts`)
  - o11y triage emits runbook-backed recovery hints (`recoverCommand`, `runbookCommands`) using shared resolver (`packages/system-bus/src/observability/recovery-runbooks.ts`, `packages/system-bus/src/inngest/functions/o11y-triage.ts`)
- Phase-2 completion tranche validation passed:
  - `cd packages/cli && bun run check-types`
  - `bun test packages/cli/src/commands/contract-envelope.test.ts packages/cli/src/commands/recover.test.ts packages/cli/src/commands/runbooks.test.ts packages/cli/src/commands/capabilities.test.ts`
  - `cd packages/cli && bun src/cli.ts send test.event --data '{bad json}'`
  - `cd packages/cli && bun src/cli.ts recover list`
  - `cd packages/cli && bun src/cli.ts recover MEMORY_HEALTH_FAILED --phase rollback`
  - `bun run validate:cli-contracts`
  - `cd packages/system-bus && bunx tsc --noEmit`
- Phase-2 o11y alignment tranche implemented:
  - focused integration test added: `packages/system-bus/src/inngest/functions/o11y-triage.test.ts` asserts `auto_fix.applied` metadata includes `runbookCode` + `recoverCommand`
  - shared runbook event resolver expanded: `packages/system-bus/src/observability/recovery-runbooks.ts` (`resolveRunbookPlanForEvent`, normalized code fallback)
  - tier2 escalation payloads now include runbook metadata (`runbookCode`, `runbookPhase`, `recoverCommand`, `runbookCommands`) in `session/observation.noted`
  - tier3 escalation context now carries runbook metadata through Todoist description, Telegram message/payload, and OTEL telemetry (`triage.telegram_sent`, `triage.telegram_rate_limited`, `triage.escalated`)
- Phase-2 o11y alignment validation passed:
  - `bun test packages/system-bus/src/inngest/functions/o11y-triage.test.ts`
  - `cd packages/system-bus && bunx tsc --noEmit`
  - live trigger (no dedicated CLI invoke surface yet): `POST /v0/gql invokeFunction(functionSlug: "system-bus-host-check/o11y-triage")`
  - `joelclaw otel search "auto_fix.applied" --hours 1` shows metadata keys including `runbookCode`, `runbookPhase`, `recoverCommand`, `runbookCommands`
  - `joelclaw otel search "joelclaw recover" --hours 1` returns the emitted `auto_fix.applied` event, confirming runbook recovery command is queryable
- Phase-2 CLI path-hardening follow-up implemented:
  - added compatibility subcommand `joelclaw inngest sync-worker [--restart] [--wait-ms]` to align with operational command contract in AGENTS docs.
  - `Inngest.health` worker probing now uses resilient endpoint fallback (`$INNGEST_WORKER_URL`, `$INNGEST_WORKER_URL/health`, `$INNGEST_WORKER_URL/api/inngest`) and robust response parsing to prevent transient false `worker unreachable` path errors.
  - `joelclaw inngest restart-worker` and `joelclaw inngest sync-worker --restart` now include active-run guards: restarts are skipped when RUNNING/QUEUED runs exist unless `--force` is passed.
- Phase-2 CLI path-hardening validation passed:
  - `cd packages/cli && bunx tsc --noEmit -p tsconfig.json`
  - `cd packages/cli && bun src/cli.ts inngest sync-worker --help`
  - `joelclaw send system/network.update -d '{"source":"restart-guard-test"}'`
  - `joelclaw inngest sync-worker --restart` (expected: `restartSkippedDueToActiveRuns: true` while runs active)
  - `joelclaw inngest restart-worker` (expected: `skippedDueToActiveRuns: true` while runs active)
  - `joelclaw status`
  - `joelclaw inngest status`
- Phase-2 aggregate log analysis follow-up implemented:
  - `joelclaw logs analyze` added to aggregate worker stdout, worker stderr, and Inngest server logs into severity/source/component/action rollups with top signatures and sample lines.
  - `joelclaw langfuse aggregate` added for project-level cloud LLM trace rollups (cost/latency/signature trends) with project URL/ID targeting.
  - new helper tests added at `packages/cli/src/commands/logs.test.ts` and `packages/cli/src/commands/langfuse.test.ts`.
- Phase-2 aggregate log analysis validation passed:
  - `bun test packages/cli/src/commands/logs.test.ts packages/cli/src/commands/langfuse.test.ts`
  - `cd packages/cli && bunx tsc --noEmit -p tsconfig.json`
  - `cd packages/cli && bun src/cli.ts logs analyze --lines 80`
  - `cd packages/cli && bun src/cli.ts langfuse aggregate --hours 24 --bucket-minutes 60 --max-traces 300 --project-url https://us.cloud.langfuse.com/project/cmlx4cd4901lyad07ih16f95i/`
- Phase-2 invoke + finalization hardening implemented:
  - added `joelclaw inngest invoke <function-slug>` with deterministic wait/poll behavior and dispatch modes (`auto|event|invoke`) in `packages/cli/src/commands/inngest.ts`
  - `auto` dispatch prefers EVENT triggers when present (CLI-first path, no raw GQL in operator flow)
  - added explicit manual trigger for triage function (`check/o11y-triage.requested`) in `packages/system-bus/src/inngest/functions/o11y-triage.ts`
  - addressed invoked-run finalization instability by syncing active host-worker code and re-registering worker functions (eliminated repeated `Unable to reach SDK URL` during validation window)
- Phase-2 invoke + finalization hardening validation passed:
  - `cd packages/cli && bun run check-types`
  - `cd packages/system-bus && bunx tsc --noEmit`
  - `bun test packages/system-bus/src/inngest/functions/o11y-triage.test.ts`
  - `cd packages/cli && bun src/cli.ts inngest invoke system-bus-host-check/o11y-triage --data '{"reason":"cli invoke event route"}' --wait-ms 90000`
  - `cd packages/cli && bun src/cli.ts inngest invoke system-bus-host-check/o11y-triage --mode invoke --data '{"reason":"invoke mode regression check"}' --wait-ms 90000`
  - `joelclaw logs server --lines 200 --grep 'Unable to reach SDK URL'` (0 matches)
- Policy validator consolidation implemented (single shared workflow):
  - `.github/workflows/agent-contracts.yml` now runs:
    - CLI contract baseline + envelope/capabilities/search contract tests + CLI typecheck
    - LLM observability guard (`validate:llm-observability-guards`)
    - legacy worker-clone reference guard (`validate:no-legacy-worker-clone`)
  - removed dedicated workflows:
    - `.github/workflows/llm-observability-guards.yml`
    - `.github/workflows/legacy-worker-clone-guard.yml`
- Policy validator consolidation validation passed:
  - `bun run validate:cli-contracts`
  - `bun run validate:llm-observability-guards`
  - `bun run validate:no-legacy-worker-clone`
- Shared policy contract documentation added:
  - `docs/agent-contracts/README.md` now defines the canonical shared workflow contract and expected validator set to prevent scope drift.

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

- [x] Baseline command-surface + contract drift inventory
  - inspect:
    - `packages/cli/src/cli.ts`
    - `packages/cli/src/commands/*.ts`
    - `packages/cli/src/response.ts`
  - artifact:
    - `docs/agent-contracts/phase1-baseline.json` (new)
- [x] Add contract validator scaffold (failing-first)
  - `scripts/validate-cli-contracts.ts` (new)
  - `package.json` script: `validate:cli-contracts` (new)
- [x] Reproduce and pin current navigation failure as regression test
  - failing command to codify:
    - `joelclaw search "telegram.callback.received" --collection otel_events --limit 5`
  - expected behavior:
    - deterministic success or structured recoverable error envelope (never raw Typesense parser failure)
  - test file:
    - `packages/cli/src/commands/search.test.ts` (new)
- [x] Upgrade first high-traffic command set to strict contract quality
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

Accepted (execution in progress: Phase 1 complete, Phase 2 actively implementing deterministic runbooks/recovery wiring).
