type: adr
status: shipped
date: 2026-02-25
tags: [adr, backups, inngest, pi, o11y]
deciders: [joel]
related: ["0088-nas-backed-storage-tiering", "0089-single-source-inngest-worker-deployment", "0137-codex-prompting-skill-router"]
---

# ADR-0138: Self-Healing NAS Backup Orchestrator

## Status

shipped

## Context

Backup jobs for Typesense and Redis run as Inngest functions and currently must:

- classify failures predictably when transport or infra flakes occur,
- retry with a bounded strategy that includes delay jitter and budget caps,
- switch between local mount paths and SSH remote copy fallback,
- and expose a central, inspectable config surface for operator tuning.

Additional system-wide SDK reachability failures also required durable remediation and guarded worker restart behavior.

A previous ad-hoc approach handled domain-specific symptoms, but this led to duplicated logic and inconsistent operator controls.

## Decision

Adopt a durable, first-class self-healing architecture with these canonical rules:

- Keep transport and retry knobs configurable from `~/.joelclaw/system-bus.config.json` with environment variable overrides.
- Centralize all cross-domain self-healing on a shared event contract and router flow:
  - canonical event: `system/self.healing.requested`
  - canonical completion: `system/self.healing.completed`
  - router action policy: `retry`, `pause`, `escalate`
  - bounded budgets from config + policy and deterministic scheduling with `sendEvent`/`step.sleep`.
- Route backup failures through `system/backup.failure.router`:
  - emit `system/backup.retry.requested` with explicit target + context
  - retry via bounded exponential backoff
  - escalate after budget exhaustion
- Keep backup functions (`system/backup.typesense`, `system/backup.redis`) subscribed to both cron triggers and retry requests.
- Apply the same architecture to SDK reachability and worker lifecycle incidents:
  - `system/self-healing.investigator` scans failed runs + detects `Unable to reach SDK URL`
  - guarded worker restart path replaces unsafe launchd kickstart behavior
  - remediation emits self-healing telemetry for traceability and repeatable recovery
- Instrument each routing/transfer decision in OTEL and include model metadata, transport mode, retry attempts, and incident context.
- Use this as the canonical self-healing decision plane for any future domain that needs durable remediation.

This ADR is the canonical self-healing architecture for system-wide remediation.
Future domains (log ingestion, Redis/queue, webhook delivery, gateway sessions, etc.) dispatch into this flow using domain payloads for route-specific context.

Proposed reusable contract:

- Event: `system/self.healing.requested`
- Required fields:
  - `sourceFunction` (string)
  - `targetComponent` (string)
  - `problemSummary` (string)
  - `attempt` (number)
  - `retryPolicy` (`maxRetries`, `sleepMinMs`, `sleepMaxMs`, `sleepStepMs`)
  - `evidence` (e.g. log files, Redis keys, event IDs, query snippets)
  - `playbook` (skills, restart/kill/defer/notify actions, links, runbook references)
- Optional fields:
  - `context` (rich domain context object)
  - `owner` (team/user routing key)
  - `deadlineAt` (ISO timestamp)
  - `fallbackAction` (`escalate`, `manual`)
- Router output: one of
  - `retry` (schedule via step sleep + `sendEvent`)
  - `pause` (bounded hold and recheck)
  - `escalate` (route to manual intervention queue)

## Decision Outcome

1. Add shared config loader in `packages/system-bus/src/lib/backup-failure-router-config.ts`.
2. Drive router/transport knobs from `~/.joelclaw/system-bus.config.json` and env overrides.
3. Extend CLI with `joelclaw nas config [show|init]` for operator visibility and initialization.
4. Add a documented template at `packages/system-bus/system-bus.config.example.md` with all supported keys.
5. Introduce shared self-healing model contracts and route-specific adapters under `system/self.healing.requested`.
6. Implement the SDK reachability investigator + guarded launchd-restart path as the canonical non-backup flow under this ADR.
7. Keep existing event names and transport safety checks while moving behavior from informal notes to explicit architecture.

## Priority Rollout (Canonical)

P0
- `system-bus` and `joelclaw gateway` worker control plane: guard rails around restarts, safe re-registration, and run-level dedupe.
- Event-router and Inngest execution path resilience: prevent lost callbacks and duplicate remediation loops on run failures.
- NAS backup domains (`system/backup.typesense`, `system/backup.redis`): bounded transport/retry remediation with mount and remote-copy fallbacks.

P1
- `gateway` provider adapters (Telegram/iMessage/Discord/email/webhooks): reconnect, session rebind, and queue drain recovery.
- Redis-backed event bridge and transient state stores: broker liveness checks, stale-lock cleanup, and reconnect backoff.
- Observability pipeline (`otel_events` + tracing ingest): fail-closed telemetry sinks and health gates for missing event writes.

P2
- Search/index and content-serving surfaces (`Typesense`, Convex projections): query fallback strategies and index rebuild playbooks.
- External dependencies (LLM providers, third-party APIs): model/provider fallback and route-specific error budgets.
- K8s edge services (colima/talos/ingress paths): soft restart/reconcile flow with controlled escalation.

Non-goals for this ADR
- Full autonomous model-level diagnosis is not the first-class control path.
- Human review remains the final escalation channel for unresolved policy loops.

## Execution TODO (Actionable Backlog)

P0 (Do now)
- [ ] Enforce guarded worker restart path for all ingress sync and sync recovery codepaths.
  - Validate: no raw `launchctl kickstart` invocations in sync/control loops.
  - Artifact: `infra/launchd/com.joel.system-bus-sync.plist`, `packages/system-bus` restart handler.
- [ ] Ensure `system/self-healing.investigator` is a first-class route target for `system/self.healing.requested` and emits `system/self.healing.completed`.
  - Validate: event schema includes `sourceFunction`, `targetComponent`, `attempt`, `retryPolicy`, `playbook`, `evidence`.
- [ ] Add deterministic backoff and jitter policy validation for backup router and investigator loops.
  - Validate: bounded `maxRetries` and `sleepMs` ranges enforced from config and env.
- [ ] Implement canonical `pause` path for transient infra outages before `retry`.
  - Validate: pause emits completion event with reason and wait duration.
- [ ] Add P0 runbook fields to payload contract (`links`, `restart`, `kill`, `defer`, `notify`).
  - Validate: all P0 routes pass non-empty `playbook` context.

P1 (execute next)
- [ ] Add Redis/bridge health checks and stale-run reconciliation for session bridge queues.
  - Validate: queue health signal appears in periodic OTEL and triggers `pause` when unstable.
- [ ] Add OTEL health circuit for missing telemetry writes during recovery loops.
  - Validate: emits an explicit telemetry gap event when traces fail to persist.
- [ ] Add provider session rebind/retry paths for Telegram/iMessage/email/webhook adapters.
  - Validate: retries use bounded cooldown and escalate via `system/self.healing.completed` status `escalated`.

P2 (planned)
- [ ] Add index/search fallback and rebuild plan for Typesense/Convex incidents.
  - Validate: recoverable route triggers a deferred rerun with explicit backoff.
- [ ] Add `0138` execution tasks into operator task list (`task-management`) for each P1/P2 domain.
- [ ] Add ADR status telemetry dashboard for shipped self-healing actions and escalation rate.
  - Validate: dashboard shows completion/escalation counts by domain.

Done Criteria
- [ ] All TODO items above are linked to code or operational verification events.
- [ ] Every executed item has corresponding `system/self.healing.completed` telemetry with action and outcome.
- [ ] At least one real remediation run demonstrates `retry -> pause -> escalate` behavior for a synthetic transient fault.

## Consequences

### Positive
- Reliable backup recovery behavior is configurable, bounded, and observable.
- Failure-handling behavior is durable (event-driven) instead of in-process heuristics.
- Ops can tune retry windows and mounts without code edits.

### Negative
- More operational complexity: two decision layers (LLM + policy) need monitoring and periodic recalibration.
- Additional config surface adds potential misconfiguration risk; requires template usage and env override discipline.

### Risks
- If the configured model IDs are disallowed by the allowlist, router startup or invocation fails.
- Hard transport failures (bad NAS networking) can still escalate correctly, but with potential delayed recovery.
