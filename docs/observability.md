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

## CLI emission

Use `--metadata` for JSON context on manual OTEL events. The CLI does not have an `--attributes` flag.

```bash
joelclaw otel emit "task.completed" \
  --source system \
  --component skills \
  --success true \
  --metadata '{"session":"NimbleBadger","task":"install wzrrd-publish skill"}'
```

### Metadata contract

`system.health.checked` metadata should include:

- `degradedCount`
- `criticalDegradedCount`
- `nonCriticalDegradedCount`
- `criticalDegradedServices`
- `nonCriticalDegradedServices`
- full `services` inventory with per-service `critical` flag

That keeps dashboards honest while preventing noisy tier-3 escalations from warn-only, non-critical drift.

## Talon worker supervision

Talon must not supervise the host system-bus worker when the canonical `com.joel.system-bus-worker` LaunchDaemon is loaded. The worker LaunchDaemon lives in the `system` bootstrap domain, so Talon checks both the current `launchctl list <label>` path and `launchctl print system/<label>` before deciding to start its internal worker supervisor. Dynamic `launchd.*` service probes also check `launchctl list`, `launchctl print system/<label>`, and `launchctl print gui/$(id -u)/<label>` so system LaunchDaemons like `com.joel.gateway` do not look dead from Talon's user LaunchAgent domain. If this detection regresses, Talon and `worker-supervisor` will fight over `localhost:3111`, producing repeated `EADDRINUSE`, SIGTERM/SIGKILL churn, and Inngest runs stuck at `Unable to reach SDK URL` or `RUNNING`.
