---
name: runtime-monitor
displayName: Runtime Monitor
description: "Monitor ADR-0217 real workloads across Redis queue, Restate, Dkron, and transitional Inngest using joelclaw CLI plus the pi TUI monitor extension. Use when asked to monitor jobs, watch runtime health, keep an eye on async work, run a workload dashboard, or report back on system state. Always pair with `pi-tui-design` for TUI work and `system-architecture` for topology truth."
version: 0.1.0
author: Joel Hooks
tags: [runtime, monitor, queue, restate, dkron, inngest, tui, adr-0217]
---

# Runtime Monitor

Use this skill when the task is **real workload monitoring**, not vague status-checking.

The canonical operator surfaces are:

- `joelclaw jobs status`
- `joelclaw queue depth`
- `joelclaw queue control status`
- `joelclaw queue observe`
- `joelclaw restate status`
- `joelclaw restate cron status`
- pi extension tool: `runtime_jobs_monitor`

## Load order

Before doing runtime monitor work:

1. load `system-architecture`
2. load `pi-tui-design` if you are building or changing the monitor widget/TUI
3. load `joelclaw` for CLI operator flows

## What to use when

### First glance

```bash
joelclaw jobs status --hours 1 --count 10
```

This is the **first operator answer** to:
- can the system take more work right now?
- is the queue/runtime layer healthy?
- is Dkron alive?
- is Inngest still healthy during transition?

### Queue-specific investigation

```bash
joelclaw queue depth
joelclaw queue control status --hours 1
joelclaw queue observe --hours 1
joelclaw queue stats --since <iso|ms>
```

Use these once `jobs status` tells you the queue layer is the interesting bit.

### Runtime substrate investigation

```bash
joelclaw restate status
joelclaw restate cron status
joelclaw runs --count 20 --hours 1
```

Use these when the top-level surface says Restate, Dkron, or transitional Inngest needs a closer look.

## Async pi monitor

The loaded pi extension at `packages/pi-extensions/inngest-monitor/index.ts` exposes:

- `runtime_jobs_monitor`
- `inngest_send`
- `inngest_runs`

### Start

```json
{"action":"start","interval":5,"report":true}
```

Effects:
- polls `joelclaw jobs status` in the background
- paints a persistent TUI widget
- emits OTEL on runtime state changes
- sends hidden follow-up summaries when the runtime state changes or the monitor stops/times out

### Status

```json
{"action":"status"}
```

Returns the latest runtime snapshot:
- overall status/summary
- queue depth
- active pause count
- Restate / Dkron / Inngest state

### Stop

```json
{"action":"stop"}
```

Stops the background poller and sends a final follow-up summary.

## Rules

- `joelclaw jobs status` is the aggregated truth surface; do **not** rebuild the same picture by hand unless the command is wrong.
- If `jobs status` is noisy or misleading, fix it first. Don’t teach agents to ignore a lying operator surface.
- For TUI work, prefer compact status blocks with explicit severity and short summaries. No decorative sludge.
- During transition, Inngest stays visible but must not dominate the runtime story when Restate + queue + Dkron are the real workload path.
- Report earned truth only. If the monitor compiles but hasn’t been dogfooded, say that.
