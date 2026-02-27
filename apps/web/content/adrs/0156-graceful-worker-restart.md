---
status: proposed
date: 2026-02-27
tags: [infrastructure, inngest, worker, reliability]
related: [0089-single-source-deployment, 0155-three-stage-story-pipeline, 0148-k8s-resilience-policy]
---

# ADR-0156: Graceful Worker Restart — Drain Before Kill

## Context

The system-bus worker runs Inngest functions, some of which execute long-running codex steps (5-10 minutes per stage). The current deploy workflow is:

```
git push → worker clone git reset --hard → launchctl kickstart -k → curl PUT /api/inngest
```

`launchctl kickstart -k` sends SIGTERM immediately. Any in-flight Inngest runs that have steps dispatched but not yet executed become orphans. Inngest server retries reaching the SDK URL for 30-140s, then gives up with "Unable to reach SDK URL". The step shows as "Finalization FAILED".

On 2026-02-27, this killed 2 story pipeline runs (CFP-1 attempt 2, CFP-2 attempt 1) — both had dispatched their `implement` step (codex exec) but the worker died before execution began. All 3 CFP-1 attempts were wasted on infrastructure failures, not code bugs.

### Why this is critical now

Before ADR-0155 (story pipeline), the longest worker functions ran <30 seconds. A hard restart had minimal blast radius — at worst, a cron check or webhook handler retried. Now codex stages run 5-10 minutes each, and a single story pipeline takes 15-30 minutes across 3 stages. Any restart during that window destroys the entire run and burns an attempt.

## Decision

Replace hard kill with a **drain-then-restart** protocol.

### Phase 1: Pre-restart drain check (immediate)

Before any restart, check for in-flight runs:

```bash
# worker-restart.sh (replaces raw kickstart -k)
RUNNING=$(joelclaw runs --count 50 | jq '[.result.runs[] | select(.status == "RUNNING")] | length')
if [ "$RUNNING" -gt 0 ]; then
  echo "⚠️  $RUNNING runs in flight. Waiting for drain..."
  # Poll every 30s, timeout after 20 minutes
  for i in $(seq 1 40); do
    sleep 30
    RUNNING=$(joelclaw runs --count 50 | jq '[.result.runs[] | select(.status == "RUNNING")] | length')
    [ "$RUNNING" -eq 0 ] && break
    echo "  Still $RUNNING running (${i}/40)..."
  done
  if [ "$RUNNING" -gt 0 ]; then
    echo "❌ Drain timeout. $RUNNING runs still active. Force kill with --force or wait."
    exit 1
  fi
fi
launchctl kickstart -k gui/$(id -u)/com.joel.system-bus-worker
sleep 5
curl -s -X PUT http://127.0.0.1:3111/api/inngest
echo "✅ Worker restarted clean"
```

Add `--force` flag to bypass drain for emergencies.

### Phase 2: SIGTERM handler in worker (next)

The worker process should trap SIGTERM and:
1. Stop accepting new step executions from Inngest (respond 503 to new dispatches)
2. Let current step executions complete (they're in-process, can't be interrupted safely)
3. Exit cleanly after current steps finish or after a grace period (5 minutes)

```typescript
// In serve.ts
let draining = false;

process.on("SIGTERM", () => {
  console.log("[worker] SIGTERM received, draining...");
  draining = true;
  // Inngest SDK doesn't expose drain API yet — use timeout
  setTimeout(() => {
    console.log("[worker] Grace period expired, exiting");
    process.exit(0);
  }, 5 * 60 * 1000); // 5 min grace
});
```

### Phase 3: Hot reload without restart (future)

Explore Bun's `--hot` or module-level reload to swap function implementations without killing the process. This eliminates the restart problem entirely but requires investigation into Inngest SDK compatibility.

## Consequences

### Positive
- No more orphaned runs from restarts
- Story pipeline attempts aren't wasted on infrastructure failures
- Deploy workflow becomes safe-by-default

### Negative
- Deploys take longer when runs are active (up to 20 min drain wait)
- Phase 2 SIGTERM handler adds complexity to worker lifecycle
- `--force` escape hatch means discipline is still required

### Operational change
- Replace all `launchctl kickstart -k` in scripts and muscle memory with `worker-restart.sh`
- The `sync-system-bus` skill must be updated to use the new script
- Gateway notifications should fire when drain starts/completes

## Status

Proposed. Phase 1 is implementable today.
