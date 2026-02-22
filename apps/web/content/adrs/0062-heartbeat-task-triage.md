---
status: proposed
date: 2026-02-19
deciders: Joel
tags:
  - heartbeat
  - tasks
  - agency
  - gateway
  - joelclaw
---

# ADR-0062: Heartbeat-Driven Task Triage

## Context

ADR-0053 established the **Agency triage principle**: "Can I do this right now? If yes, do it." But this principle only activates when events arrive — Todoist comments, webhook fires, user messages. The agent is reactive, not proactive.

Joel has 15-20 active tasks in Todoist at any time. Some are agent-executable ("fix state aggregation"), some need human hands ("shoulder warm-up"), and some are blocked waiting for Joel to decide ("spend 30 min researching Convex"). The agent has no awareness of this backlog unless Joel explicitly asks "what's on my list."

Meanwhile, the heartbeat cron fires every 15 minutes, doing housekeeping (session pruning, trigger audit). It has idle capacity.

**The insight**: A personal AI OS that waits to be told what to do is a search engine with extra steps. A personal AI OS that scans the work queue and says "I can knock out 3 of these while you're in that meeting" is a co-pilot.

## Decision

Add a **task triage step** to the system heartbeat that:

1. **Scans open Todoist tasks** — `todoist-cli list --label agent` (agent-actionable tasks)
2. **LLM triages** each task against current system capabilities (skills, tools, access)
3. **Categorizes**: agent-can-do-now / needs-human-decision / blocked / not-agent-work
4. **Notifies gateway** with a structured prompt when actionable tasks are found

### Triage Categories

| Category | Criteria | Action |
|----------|----------|--------|
| **Agent-executable** | Agent has the skill, tool access, and context to complete this. Low risk, reversible. | Notify gateway: "I can do X. Want me to go?" |
| **Needs decision** | Agent could act but the task is ambiguous, high-stakes, or has multiple valid approaches. | Notify gateway: "Task X needs a decision: A or B?" |
| **Blocked** | Missing dependency, credential, or external action. | Notify gateway: "Task X is blocked on Y" |
| **Human-only** | Physical action, browser login, social interaction. | Skip silently. |

### Gateway Prompt Format

```markdown
## 📋 Task Triage (15-min scan)

**Ready to execute (just say go):**
- [ ] "Fix state aggregation" — I know the bug, have access to the repo, ~30min
- [ ] "Extract taxonomy concepts from slog" — slog + Qdrant both accessible

**Need your call:**
- "Spend 30 min researching Convex" — research scope is vague. For auth? For data? For both?

**Blocked:**
- "Collect 2 weeks heartbeat data" — only 6 days collected, due 2026-03-03
```

### Frequency & Throttle

- Runs inside existing 15-min heartbeat (no new cron)
- Only notifies gateway when there are actionable items (not every 15 min)
- Redis cooldown: `tasks:triage:last-notified` — don't re-notify about the same tasks within 2 hours
- LLM call: Haiku for triage (cheap, fast) — not every heartbeat, only when task list changed since last check

### What This Is NOT

- Not auto-execution. The agent proposes, Joel (or the gateway session) confirms.
- Not a scheduler. Doesn't set due dates or reorder priorities.
- Not a replacement for `todoist-cli review`. That's Joel's pull; this is the agent's push.

## Consequences

### Positive
- Agent becomes proactively useful — finds work instead of waiting for it
- Tasks labeled `@agent` get attention even when Joel forgets about them
- Gateway session gets structured, actionable prompts (not raw task dumps)
- Extends ADR-0053's agency triage from reactive to proactive

### Negative
- 15-min LLM calls add cost (~$0.01/call with Haiku, ~$1/day)
- Risk of notification fatigue if triage is too chatty (mitigated by 2h cooldown + change detection)
- LLM triage accuracy depends on task descriptions being clear

### Risks
- **Over-confidence**: Agent thinks it can do something it can't → mitigated by "just say go" pattern (human confirms)
- **Stale triage**: Task state changes between triage and execution → mitigated by re-checking at execution time
