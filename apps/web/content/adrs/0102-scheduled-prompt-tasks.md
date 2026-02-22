---
status: proposed
date: 2026-02-22
decision-makers: joel
---

# ADR-0102: Scheduled Prompt Tasks

## Context

The joelclaw system can react to events and run cron-based functions, but lacks the ability to schedule arbitrary one-off agent tasks for future execution. Use cases:

- "At 3pm, check if the deploy succeeded and summarize the logs"
- "In 2 hours, run a memory quality audit"
- "Every Monday at 9am, review open PRs and summarize blockers"
- "Tonight at midnight, refactor the webhook providers to use the new pattern"
- "Remind me to follow up with X about Y on Thursday"

These are **deferred prompts with rich context** — not simple reminders, but full agent work orders that execute autonomously at a specified time.

## Decision

### 1. Data Model — Scheduled Task

```typescript
type ScheduledTask = {
  id: string;                          // ULID (sortable by creation time)
  prompt: string;                      // The agent prompt to execute
  context: TaskContext;                 // Rich context bundle
  schedule: TaskSchedule;              // When to fire
  executor: "gateway" | "codex";       // What runs it
  model?: string;                      // Model override (optional)
  notify: "silent" | "telegram" | "webhook";  // Result delivery
  webhookUrl?: string;                 // If notify === "webhook"
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  createdAt: number;                   // epoch ms
  scheduledFor: number;                // epoch ms (next fire time)
  completedAt?: number;                // epoch ms
  result?: TaskResult;                 // Execution result
  tags?: string[];                     // For filtering/search
  cwd?: string;                        // Working directory (for codex)
};

type TaskContext = {
  files?: string[];                    // File path REFS — resolved at execution time, not stored inline
  vaultNotes?: string[];               // Vault note path REFS — claim-ticket style, resolved at fire time
  urls?: string[];                     // URL REFS — fetched at execution time for freshness
  skills?: string[];                   // Skill names to inject into executor prompt
  metadata?: Record<string, unknown>;  // Arbitrary key-value pairs (lightweight, stored inline)
  // NOTE: Context is REFS not content. The executor resolves refs at fire time.
  // This keeps scheduled tasks lightweight and context fresh.
  // If point-in-time state matters, the scheduler should explicitly
  // snapshot into metadata as a string — but this is the exception, not the default.
};

type TaskSchedule = {
  type: "absolute" | "relative" | "cron";
  at?: string;                         // ISO 8601 datetime (absolute)
  delay?: string;                      // Duration string: "2h", "30m", "1d" (relative)
  cron?: string;                       // Cron expression (recurring)
  timezone?: string;                   // Default: America/Los_Angeles
};

type TaskResult = {
  output: string;                      // Agent output (truncated)
  durationMs: number;                  // Execution time
  model: string;                       // Model that actually ran
  tokensUsed?: number;                 // If available
  error?: string;                      // If failed
};
```

### 2. Storage

- **Redis** (`joelclaw:scheduled:{id}`): Active/pending tasks as JSON. Supports list, cancel, update operations via CLI. TTL-based cleanup for completed tasks (7 days).
- **Typesense** (`scheduled_tasks` collection): Full history for search. Indexed on prompt text, tags, status, scheduledFor. Enables "find that thing I scheduled last week".
- **Inngest**: Durable execution via `step.sleepUntil()` for one-shots, cron trigger for recurring.

### 3. Execution Flow

```
Schedule task → Write to Redis + Typesense → Send Inngest event
  ↓
Inngest function receives event → step.sleepUntil(scheduledFor)
  ↓
Wake up → Resolve context (fetch files, vault notes, URLs if not snapshotted)
  ↓
Execute via chosen executor:
  - gateway: inject prompt into gateway session via Redis command queue
  - codex: spawn via system/agent.requested with prompt + context
  ↓
Collect result → Update Redis + Typesense → Notify per config
```

For cron tasks: Inngest cron trigger fires → check Redis for matching cron tasks → execute each.

### 4. CLI Interface

```bash
# Schedule tasks
joelclaw schedule "Check deploy logs and summarize" --at "2026-02-22T15:00:00" --executor codex
joelclaw schedule "Review open PRs" --cron "0 9 * * 1" --executor gateway --notify telegram
joelclaw schedule "Refactor webhook providers" --in 2h --executor codex --cwd ~/Code/joelhooks/joelclaw --skill webhooks

# Manage
joelclaw schedule list                    # Show pending tasks
joelclaw schedule list --all              # Include completed/failed
joelclaw schedule show <id>               # Full task details + result
joelclaw schedule cancel <id>             # Cancel pending task
joelclaw schedule history --hours 72      # Search recent executions

# Context attachment
joelclaw schedule "Audit this file" --in 1h --file packages/gateway/src/model-fallback.ts
joelclaw schedule "Summarize this" --at tomorrow-9am --vault-note "docs/decisions/0097*"
joelclaw schedule "Check if fixed" --in 30m --url "https://status.anthropic.com"
```

### 5. Inngest Events

```
scheduled/task.created    → Task scheduled, starts durable sleep
scheduled/task.fired      → Sleep completed, executing now
scheduled/task.completed  → Execution finished successfully
scheduled/task.failed     → Execution failed
scheduled/task.cancelled  → Task cancelled before firing
```

### 6. Conversational Scheduling

The gateway agent can schedule tasks naturally:
- Joel: "tonight at midnight, clean up the stale test fixtures"
- Agent: recognizes scheduling intent → creates task via event → confirms with details

This requires the gateway to have a tool/function that creates scheduled tasks, not just CLI.

## Consequences

- Enables deferred autonomous work — "fire and forget" agent tasks
- Cron tasks overlap with existing Inngest cron functions — cron scheduled prompts are for ad-hoc recurring work, not system infrastructure
- Context is refs-not-content (claim-ticket style) — resolved at fire time for freshness. If point-in-time state matters, explicitly snapshot into metadata
- Redis storage adds another key namespace to manage (TTL handles cleanup)
- Typesense collection adds search surface for task history
- Gateway integration enables natural language scheduling from Telegram

## Open Questions

1. Should cancelled/failed tasks auto-retry? (Probably not for one-shots, configurable for cron)
2. Max prompt size / context size limits?
3. Should tasks be able to chain? ("After this completes, schedule X")
4. Integration with Todoist? (Schedule a prompt when a Todoist task is due?)
