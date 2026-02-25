---
status: shipped
date: 2026-02-21
deciders: joel
---

# ADR-0090: Autonomous O11y Triage Loop

## Update (2026-02-22)

- `content_sync.completed` now reports `success: true` when sync work completes but commit/push is intentionally skipped by the safety gate.
- `content_sync.completed + changes_not_committed` is no longer treated as a tier-1 auto-fix path; it is now tier-2 signal only (no auto-commit mutation from triage).
- `restartWorker` auto-fix gained a cooldown guard to prevent repeated `launchctl kickstart` loops from cascading into SDK callback instability.
- `restartWorker` now checks recent Inngest runs before kickstart and skips restart when RUNNING/QUEUED work is active, reducing restart-induced finalization drops.
- `restartWorker` now stamps cooldown immediately after successful `kickstart`, even if post-restart health probing fails, to stop rapid retry thrash.
- Root cause found for recurring `No function ID found in request`: Inngest archived app rows did **not** archive their functions in SQLite (`functions.archived_at` stayed null), so orphan cron functions (`system-bus-*` IDs) kept triggering.
- Operational remediation applied: offline SQLite maintenance on `data-inngest-0` archived orphan functions tied to archived apps; after restart, no new orphan UUID runs appeared on the next `*/15` tick.
- Follow-up hardening: restart guards now ignore legacy non-host slugs (`system-bus-*` vs `system-bus-host-*`) and UUID-only function names so stale archived metadata cannot block safe worker restarts.
- 2026-02-25 regression: recurring `Unable to reach SDK URL` in `system/content-sync` traced to local worker boot failure caused by a malformed regex in `packages/system-bus/src/inngest/functions/nas-backup.ts` (`/input/output/.../` parsed as invalid flags). Fixing it to `/input\/output/.../` restored `http://127.0.0.1:3111` reachability.
- 2026-02-25 follow-up: transient SDK failures persisted when launchd agent `com.joel.system-bus-sync` issued raw `launchctl kickstart -k ...com.joel.system-bus-worker` on `.git/refs/heads/main` updates (`WatchPaths`, `ThrottleInterval=10`). Mid-run kickstarts can still drop finalization callbacks.

## Context

ADR-0087 shipped the observability pipeline — structured events flow to Typesense, Convex mirrors critical state, CLI and web surfaces exist. But nothing watches the data proactively. The agent scans otel_events during heartbeats, but only when prompted. Failures accumulate silently between heartbeats, and the agent has no framework for deciding what deserves attention vs. what to handle quietly.

Joel's constraint: be proactive, improve the system, and don't be annoying about it. Escalations must arrive with a full triage and a codex-ready solution — never just "something broke."

## Decision

Implement a three-tier autonomous triage loop that scans otel_events on a 15-minute cron, classifies failures against a known-patterns registry, and responds at the appropriate tier.

### Tier 1: Auto-Fix (Silent)

Agent detects, fixes, emits `auto_fix.applied` otel event. Joel never sees it unless he looks.

Examples:
- Transient Telegram bot_not_started → ignore (self-heals)
- Command queue already-processing races → ignore
- Probe/test events (`probe.emit`) → ignore
- Worker health critical failure (`check-system-health`) → guarded restart with cooldown

Implementation: Each auto-fix is a named handler function. The triage loop matches `{component, action, error}` tuples against a handler registry. If a handler exists and succeeds, tier 1. If it fails, promote to tier 2.

### Tier 2: Note + Batch (Daily Digest)

Novel or non-urgent issues. Agent writes a memory observation with category `o11y-triage` and includes it in the daily digest. Joel sees a summary in his morning check-in or when he asks.

Examples:
- New error type appears for the first time
- Latency creep (p95 duration_ms up >2x vs 24h baseline)
- Intermittent failures (<3 in 30min, not sustained)
- Function success rate drops below 95% but above 80%

### Tier 3: Escalate (Telegram + Todoist Task, Codex-Ready)

Sustained failures, data loss risk, or anything the agent can't auto-fix. **Every tier 3 escalation creates two artifacts:**

**A. Todoist task** (the tracking artifact) in the "Agent Work" project with:
1. **Title**: short problem summary
2. **Description** containing:
   - **What broke** — component, action, error message, first occurrence, count
   - **Impact** — what's not working for Joel as a result
   - **Root cause analysis** — agent's best diagnosis from logs, recent deploys, config changes
   - **Proposed fix** — specific file paths, code changes, config tweaks
   - **Codex prompt** — a ready-to-dispatch prompt. Must be specific enough that codex can execute without further context
   - **Rollback** — what to do if the fix makes things worse
3. **Priority**: p1 (data loss / sustained outage) or p2 (degraded but functional)
4. **Labels**: `o11y, escalation`

**B. Telegram message** (the alert) — terse summary + Todoist task link + inline keyboard: `[Approve Fix] [Snooze 4h] [View Task]`

The task is the source of truth. Telegram is just the push notification. When the fix is applied (by codex or manually), the agent completes the task.

Examples:
- Typesense unreachable >10min (after auto-fix retry failed)
- Memory pipeline completely stalled (0 observations in 30min during active session)
- Worker crash loop (>3 restarts in 15min)
- Data loss signal (Convex dual-write errors sustained)

### Known-Patterns Registry

```typescript
// packages/system-bus/src/observability/triage-patterns.ts

type Tier = 1 | 2 | 3;

interface TriagePattern {
  match: { component?: string; action?: string; error?: RegExp };
  tier: Tier;
  handler?: string;        // tier 1: auto-fix function name
  dedup_hours: number;      // suppress duplicate alerts for N hours
  escalate_after?: number;  // promote to next tier after N occurrences in window
}

const patterns: TriagePattern[] = [
  // Tier 1: Auto-fix
  { match: { action: "telegram.send.skipped", error: /bot_not_started/ }, tier: 1, handler: "ignore", dedup_hours: 1 },
  { match: { component: "command-queue", error: /already processing/ }, tier: 1, handler: "ignore", dedup_hours: 1 },
  { match: { action: "probe.emit" }, tier: 1, handler: "ignore", dedup_hours: 24 },
  {
    match: { component: "check-system-health", action: "system.health.critical_failure", error: /\bworker\b/ },
    tier: 1,
    handler: "restartWorker",
    dedup_hours: 1,
  },

  // Tier 2: Note + batch
  { match: { action: "content_sync.completed", error: /changes_not_committed/ }, tier: 2, dedup_hours: 6, escalate_after: 20 },
  { match: { action: "observe.store.failed" }, tier: 2, dedup_hours: 4, escalate_after: 10 },

  // Tier 3: Escalate immediately
  { match: { level: "fatal" }, tier: 3, dedup_hours: 1 },
];
```

Unknown patterns (no match) go through LLM classification before defaulting to tier 2.

### LLM Classification for Unknown Failures

When no pattern matches, the triage loop calls Haiku via `pi` CLI to classify:

```
pi --no-tools --no-session --no-extensions --print --mode text \
  --model anthropic/claude-haiku-4-5 \
  --system-prompt "<classification prompt>" \
  "<event details + recent context>"
```

Haiku receives the event details and recent otel context, returns a JSON response:
- `tier`: 1, 2, or 3
- `reasoning`: one sentence explaining why
- `proposed_pattern`: optional new TriagePattern entry for the registry

This keeps unknowns from silently piling up as unclassified tier 2 noise. Haiku is fast and cheap enough for the handful of unmatched events per 15min window.

### Codex as Escalation Planner (Tier 3)

When an event is classified as tier 3 (by pattern or by Haiku), the triage loop dispatches codex to generate the full escalation plan:

- Codex receives: the failing event, recent related events, relevant source files, git log
- Codex produces: root cause analysis, proposed fix (specific files + changes), ready-to-dispatch codex prompt, rollback plan
- Output goes into the Todoist task description

This means Joel gets a task with a real fix plan, not a template. The agent did the investigation.

### The "Not Annoying" Contract

1. Never alert on the same root cause twice in 24h (dedup by `{component, action, error}` hash)
2. Never alert on probe/test failures
3. Daily digest caps at 5 items — summarize if more
4. Heartbeat responses stay `HEARTBEAT_OK` unless tier 3 active
5. Silence is the signal that things are fine — no "all clear" messages
6. Tier 3 messages are terse on Telegram (problem + impact + "fix ready, approve?") with full triage in a linked vault note or thread

### Cron Schedule

- **Every 15min**: `check/o11y-triage` Inngest cron scans `otel_events` where `success:false` and `timestamp > last_scan`
- **Daily 7am PST**: Compile tier 2 items into digest observation
- **Weekly Sunday**: Review week's patterns, propose friction fixes for recurring tier 1/2 items, update patterns registry if new auto-fixes are viable

### Self-Improvement Loop

The triage loop feeds the friction pipeline:
- Tier 1 items that recur >5x/week → friction observation proposing a permanent fix
- Tier 2 items that recur → candidate for tier 1 auto-fix handler
- Tier 3 items, after fix is applied → post-mortem observation + new pattern entry so it's tier 1 next time

Goal: the patterns registry grows over time. The system gets quieter as more failures become auto-fixable.

## Implementation

### Phase 1: Triage Cron + Patterns Registry
- `packages/system-bus/src/observability/triage-patterns.ts` — pattern definitions
- `packages/system-bus/src/observability/triage.ts` — scan + classify logic
- `packages/system-bus/src/inngest/functions/o11y-triage.ts` — 15min cron function
- Seed with patterns from current known failures (the 23 failures we just audited)

### Phase 2: Auto-Fix Handlers
- `packages/system-bus/src/observability/auto-fixes/` — handler functions
- Active default handlers: `ignore`, `restartWorker` (cooldown-guarded)
- `autoCommitAndRetry` remains available but is no longer the default path for `content_sync.completed`
- Each handler emits `auto_fix.applied` otel event on success

### Phase 3: Escalation Templates
- Telegram escalation message template with inline keyboard: `[Approve Fix] [Snooze 4h] [Details]`
- Codex prompt generator that builds a dispatch-ready prompt from triage context
- Vault note generator for full post-mortem detail

## Consequences

- Failures get caught within 15 minutes, not at next heartbeat
- Joel only hears about things that need his decision
- Every escalation arrives with a solution, not just a problem
- The system gets quieter over time as patterns accumulate
- Auto-fix actions are themselves observable (dogfooding)
- Known-patterns registry becomes a living runbook

## Alternatives Considered

- **Alert on every failure**: Too noisy. Joel ignores alerts within a week.
- **Only check at heartbeat**: 30min gaps. Sustained failures go unnoticed.
- **External alerting (PagerDuty, OpsGenie)**: Overkill for single-user system. Agent IS the on-call engineer.
- **Fixed rules only (no learning)**: Misses the self-improvement loop that makes the system quieter over time.
