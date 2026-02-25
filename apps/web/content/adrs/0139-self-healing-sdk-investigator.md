---
type: adr
status: accepted
date: 2026-02-25
tags: [adr, self-healing, o11y, inngest, launchd]
deciders: [joel]
related: ["0090-o11y-triage-loop", "0138-self-healing-backup-orchestrator", "0089-single-source-inngest-worker-deployment"]
---

# ADR-0139: Generalize Self-Healing with an SDK Reachability Investigator

## Status

accepted

## Context

`system/content-sync` failures with `Unable to reach SDK URL` were not always a bad function implementation.
Two independent failure modes were interacting:

1. Hard worker boot failure (syntax/parse errors) made callback URLs unreachable.
2. `com.joel.system-bus-sync` used raw `launchctl kickstart -k ...com.joel.system-bus-worker` on git ref updates, which could restart the worker during active runs and drop finalization callbacks.

ADR-0138 already defined a backup-domain self-healing router. We need the same pattern at system level for SDK reachability incidents.

## Decision

1. Replace unsafe sync-agent restart behavior with guarded CLI restart logic:
   - `com.joel.system-bus-sync` now runs `joelclaw inngest restart-worker --register` instead of raw `launchctl kickstart`.
   - Keep active-run guard and cooldown semantics from existing CLI + o11y restart handler.
2. Add a generalized self-healing investigator function:
   - New function: `system/self-healing.investigator`
   - Triggers: cron every 10 minutes + manual `system/self.healing.requested`
   - Behavior: scan recent failed runs, inspect run output, detect `Unable to reach SDK URL`, apply guarded restart remediation via existing restart-worker auto-fix handler, and emit OTEL telemetry.
3. Formalize event contracts so backup and generic self-healing share typed events:
   - `system/self.healing.requested`
   - `system/self.healing.completed`
   - `system/backup.failure.detected`
   - `system/backup.retry.requested`

## Consequences

### Positive
- Self-healing is no longer backup-only; SDK reachability regressions get continuous investigation.
- Worker restarts are guarded against active runs instead of unconditional launchd kickstarts.
- Self-healing decisions become observable and queryable in OTEL.

### Negative
- More moving parts: investigator cron + Redis dedupe + run detail probes.
- Partial remediation remains bounded to restart/register recovery; deeper root-cause fixes still need agent/human follow-up.

### Risks
- If `joelclaw run` output format changes, investigator parsing can degrade.
- Repeated SDK errors from upstream Inngest outages may trigger noisy remediation attempts (mitigated by cooldown + dedupe).
