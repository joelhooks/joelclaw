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
