---
status: superseded
superseded-by: "0159-talon-k8s-watchdog-daemon"
date: 2026-02-27
tags: [infrastructure, inngest, worker, reliability]
related: [0089-single-source-deployment, 0155-three-stage-story-pipeline, 0148-k8s-resilience-policy]
---

# ADR-0156: Graceful Worker Restart — Zero-Downtime Deploy

## Context

The system-bus worker runs Inngest functions via HTTP. Inngest's execution model is **step-level stateless**: each step is a separate HTTP call, Inngest stores step output server-side, and the worker holds no inter-step state. This means Inngest natively supports worker replacement between steps.

The problem: `launchctl kickstart -k` sends SIGTERM, killing the worker process. Any step **currently executing** (mid-HTTP-request) is destroyed. The codex implement step runs 5-10 minutes — a large kill window.

On 2026-02-27, two story pipeline runs died this way. Both showed:
- Early steps (load-prd, gateway-progress, get-pre-sha) completed normally
- The `implement` step was dispatched but the worker died before responding
- Inngest showed "Unable to reach SDK URL" → "Finalization FAILED"

### Root cause analysis

Three factors combined to make this fatal:

1. **`retries: 0` on story pipeline** — We disabled Inngest retries because we handle retry logic via re-emitted events (self-healing). But Inngest's built-in retry is what saves runs from transient SDK failures. With retries: 0, a single missed HTTP call kills the run.

2. **Hard kill during long step** — The codex exec step runs 5-10 minutes. SIGTERM kills it mid-execution. The new worker starts in ~1 second, but the step is already dead.

3. **No separation between "sync new code" and "restart process"** — We restart to pick up code changes because functions are statically imported at boot. The restart is the actual dangerous operation.

### How production Inngest handles this

From Inngest docs: "Long running functions can start running on one machine and continue on another." In production:
- Deploy new version alongside old (blue/green or rolling)
- Sync Inngest to new URL → new steps route to new version
- Old instance finishes in-flight step, then dies
- Each step is idempotent — Inngest replays completed steps, only executes the next one

## Decision

### Immediate fix: Allow Inngest-level retries for SDK failures

Set `retries: 2` on the story pipeline function. This costs nothing — if a step fails because the SDK was briefly unreachable (1s restart window), Inngest retries and hits the new worker. Our self-healing retry logic (re-emitted events) handles code-level failures separately.

```typescript
{
  id: "agent/story-pipeline",
  retries: 2, // survive transient SDK failures during restart
}
```

This alone fixes the immediate problem. Worker restarts ~1s, Inngest retries after backoff, new worker handles the step.

### Phase 1: Blue/green port swap (recommended)

Since the worker is stateless between steps:

```bash
# worker-deploy.sh
NEW_PORT=3112
OLD_PORT=3111

# 1. Start new worker on alternate port
PORT=$NEW_PORT bun run src/serve.ts &
sleep 5

# 2. Sync Inngest to new URL — new step dispatches go to new worker
INNGEST_SERVE_HOST=http://192.168.5.2:$NEW_PORT \
  curl -s -X PUT http://127.0.0.1:$NEW_PORT/api/inngest

# 3. Old worker finishes its in-flight step (up to 10 min grace)
sleep 600 # or poll for completion

# 4. Kill old worker
kill $(lsof -ti :$OLD_PORT)
```

### Phase 2: Dynamic function loading (future)

Replace static imports with dynamic `import()` keyed to a generation counter. PUT `/api/reload` invalidates the module cache and re-imports functions. No process restart needed.

### Not pursuing: drain-then-restart

The original ADR draft proposed waiting for all runs to complete before restart. This is wrong — runs can take 30+ minutes across multiple steps. We don't need to wait for the whole run, only the current in-flight step (~seconds for most, ~minutes for codex). Blue/green handles this naturally.

## Consequences

### Positive
- `retries: 2` makes restart completely safe for the 99% case (1s restart window)
- Blue/green eliminates even the 1s window
- No drain wait — deploys are instant
- Aligns with how Inngest is designed to work

### Negative
- `retries: 2` means a codex step killed mid-execution will retry from scratch (5-10 min wasted, but not fatal)
- Blue/green adds port management complexity
- Need to ensure only one worker handles step execution at a time during transition

### Operational changes
- Set `retries: 2` on story-pipeline immediately
- Update `sync-system-bus` skill documentation
- Add retry count to all long-running functions (not just story-pipeline)

## Status

Proposed. Immediate fix (retries: 2) is a one-line change.
