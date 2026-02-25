---
type: adr
status: proposed
date: 2026-02-25
tags: [adr, backups, inngest, pi, o11y]
deciders: [joel]
related: ["0088-nas-backed-storage-tiering", "0089-single-source-inngest-worker-deployment", "0137-codex-prompting-skill-router"]
---

# ADR-0138: Self-Healing NAS Backup Orchestrator

## Status

proposed

## Context

Backup jobs for Typesense and Redis run as Inngest functions and currently must:

- classify failures predictably when transport or infra flakes occur,
- retry with a bounded strategy that includes delay jitter and budget caps,
- switch between local mount paths and SSH remote copy fallback,
- and expose a central, inspectable config surface for operator tuning.

The existing ad-hoc logic was sufficient but under-documented as an architectural decision.

## Decision

Adopt a durable, first-class "backup failure healing" flow with these rules:

- Keep transport constants configurable from `~/.joelclaw/system-bus.config.json` with environment variable overrides.
- Route failures through an Inngest function `system/backup.failure.router` that emits `system/backup.retry.requested`.
- Keep router behavior governed by an LLM decision contract (`retry`, `pause`, `escalate`) plus bounded retries.
- Allow the router to choose delay and target via model output, with local fallback defaults if model output is unavailable.
- Keep backup functions (`system/backup.typesense`, `system/backup.redis`) subscribed to both cron triggers and retry requests.
- Instrument each routing/transfer decision in OTEL and include model metadata, transport mode, and retry attempts.

This is explicitly intended to become a reusable pattern for global system self-healing.
Future failure domains (log ingestion, Redis/queue, webhook delivery, gateway sessions, etc.) should dispatch into the same durable diagnostic flow.

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

## Update (2026-02-25)

- Generalized follow-on adopted in [ADR-0139](0139-self-healing-sdk-investigator.md): SDK reachability investigator + guarded worker restart path for non-backup domains.

## Decision Outcome

1. Add shared config loader in `packages/system-bus/src/lib/backup-failure-router-config.ts`.
2. Drive router/transport knobs from `~/.joelclaw/system-bus.config.json`.
3. Extend CLI with `joelclaw nas config [show|init]` for operator visibility and initialization.
4. Add a documented template at `packages/system-bus/system-bus.config.example.md` with all supported keys.
5. Keep existing event names and transport safety checks while formalizing behavior as an ADR and moving from informal notes to explicit architecture.
6. Introduce a shared self-healing event model and route-specific adapters (starting with backup) under a future `system/self.healing.requested` flow.

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
