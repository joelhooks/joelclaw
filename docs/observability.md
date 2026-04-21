# Observability

Canonical notes for joelclaw telemetry, OTEL events, and triage semantics.

## Health summary semantics

`packages/system-bus/src/inngest/functions/check-system-health.ts` emits `system.health.checked` after each health pass.

- `level` reflects whether the run observed any degradation at all.
  - `info` = nothing degraded
  - `warn` = one or more health surfaces degraded
- `success` is narrower than `level`.
  - `success: false` means a **critical** health surface degraded (`Redis`, `Inngest`, `Worker`, `Gateway`, `Typesense`, `Agent Secrets`) or the agent-dispatch canary is unhealthy.
  - `success: true` with `level: warn` is valid when degradation is **non-critical** only, such as `NFS Mounts`.

This split is deliberate. O11y triage escalates failed operations, so non-critical degradations must stay visible without looking like a failed health-check operation.

### Metadata contract

`system.health.checked` metadata should include:

- `degradedCount`
- `criticalDegradedCount`
- `nonCriticalDegradedCount`
- `criticalDegradedServices`
- `nonCriticalDegradedServices`
- full `services` inventory with per-service `critical` flag

That keeps dashboards honest while preventing noisy tier-3 escalations from warn-only, non-critical drift.
