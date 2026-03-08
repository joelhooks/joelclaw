# job-monitor — Pi Extension Design

## Purpose

Pi extension that monitors **two asynchronous job surfaces** inside one persistent widget:

1. followed Inngest runs (`inngest_send`, `inngest_runs`)
2. the ADR-0217 runtime substrate (`runtime_jobs_monitor`) backed by `joelclaw jobs status`

The runtime monitor is transitional by design: it centres the real workload layer (`Redis queue` + `Restate` + `Dkron`) while still showing live Inngest truth until migration is finished.

## Design goals

- **Operator-first**: one glance should answer “is the runtime healthy enough to take work right now?”
- **Asynchronous**: monitor in the background without blocking the session
- **Report back**: emit OTEL on state changes and send follow-up summaries when runtime state changes or the monitor stops/times out
- **TUI-native**: widget stays visible in pi sessions and uses pi-tui-friendly compact summaries

## Config

```ts
const POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_S = 300;
const DEFAULT_RUNTIME_MONITOR_INTERVAL_S = 5;
const DEFAULT_RUNTIME_MONITOR_TIMEOUT_S = 0; // until stopped
const DEFAULT_JOBS_LOOKBACK_HOURS = 1;
const DEFAULT_JOBS_RUN_COUNT = 10;
const COMPLETED_LINGER_MS = 15_000;
const WIDGET_KEY = "job-monitor";
```

## Tools

### `inngest_send`

Unchanged purpose: send an Inngest event and optionally follow its runs.

### `inngest_runs`

Unchanged purpose: inspect tracked run state for followed Inngest work.

### `runtime_jobs_monitor`

Parameters:
- `action` — `start|status|stop` (default `start`)
- `interval` — poll interval in seconds (default `5`)
- `timeout` — stop after N seconds, `0` means run until stopped
- `report` — send follow-up summaries on state changes / stop (default `true`)

Flow:
1. `start` spins up a background poller
2. each poll runs `joelclaw jobs status --hours 1 --count 10`
3. widget updates from the latest runtime snapshot
4. on state change, emit OTEL `runtime.monitor.*`
5. if `report=true`, send `runtime-jobs-monitor-update` follow-up messages
6. `stop` clears the poller and sends a final summary

## CLI dependency

The runtime monitor depends on:

```bash
joelclaw jobs status [--hours <n>] [--count <n>]
```

That command is the canonical JSON operator snapshot for:
- queue / Redis
- Restate runtime
- Dkron scheduler
- transitional Inngest health + recent runs

## Widget

The widget is split into two stacked regions:

1. **runtime monitor header**
   - overall status icon (`healthy|degraded|down|starting|stopped|timeout`)
   - elapsed time + poll cadence
   - queue depth / active pause count / Restate / Dkron / Inngest status line
   - compact overall summary line
2. **active run list**
   - followed Inngest runs below the runtime block
   - keeps the existing icons for running/completed/failed/cancelled runs

If neither region has anything visible, the widget returns `[]` and disappears.

## OTEL contract

The extension emits these actions through `joelclaw otel emit`:

- `runtime.monitor.started`
- `runtime.monitor.state_changed`
- `runtime.monitor.stopped`
- `runtime.monitor.timeout`

Component/source:
- `source=gateway`
- `component=job-monitor`

## Follow-up messages

Custom type:
- `runtime-jobs-monitor-update`

Message payload includes:
- monitor id
- status
- elapsed time
- checkedAt
- summary
- queue depth
- active pause count
- Restate / Dkron / Inngest status
- optional error
- reason (`started|state_changed|stopped|timeout`)

Delivery:
- `deliverAs: "followUp"`
- trigger on state changes and final stop/timeout summaries

## Race handling

The runtime poller uses a `monitorId` guard so an in-flight poll cannot overwrite a newer monitor instance or emit stale follow-up messages after a stop/timeout.

## Dependency contract

`@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` remain runtime dependencies. The loader imports this extension by absolute file path, so missing local runtime deps still break extension startup.
