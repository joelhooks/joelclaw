---
name: task-management
description: "Manage Joel's task system in Todoist. Triggers on: 'add a task', 'create a todo', 'what's on my list', 'today's tasks', 'what do I need to do', 'remind me to', 'inbox', 'complete', 'mark done', 'weekly review', 'groom tasks', 'what's next', or when actionable items emerge from other work. Also triggers when Joel mentions something he needs to do in passing — capture it."
---

# Task Management — The System That Thinks For You

Todoist is the task layer. The agent is the gardener.

## Philosophy

Three systems, one practice:

**Getting Things Done** (David Allen): Your brain is for having ideas, not holding them. Capture everything immediately. Process to next physical action. If it takes < 2 min, do it now. Weekly review is sacred.

**Shape Up** (Ryan Singer, Basecamp): Work expands to fill the time available. Set appetite (how much time is this worth?), not estimates. Projects are bets with fixed timelines, not open-ended backlogs. If it's not worth betting on, kill it.

**Tiny Habits** (BJ Fogg): Behavior change = anchor moment + tiny behavior + celebration. "After I [existing routine], I will [tiny version of new habit]." Make it stupidly small. Celebrate immediately. Let it grow naturally.

### What This Means In Practice

- **Every task is a next physical action.** Not "research X" but "spend 20 min reading the X docs." Not "fix the bug" but "reproduce the bug in a test."
- **Inbox is a capture buffer, not a todo list.** Process it to zero. Each item gets: do it (< 2 min), schedule it, delegate it, someday it, or delete it.
- **Projects have appetite.** "2 weeks, small batch" or "6 weeks, big batch." If a project has been open for 3x its appetite with no progress, it's a zombie. Kill it or re-scope.
- **Habits are anchored, not scheduled.** "After morning coffee → shoulder warm-up" not "Do exercises at 7am." The anchor is the trigger.
- **Less is more.** A clean list with 5 clear next actions beats 50 vague intentions. Ruthlessly prune. If you haven't touched it in 2 weeks and it's not scheduled, it doesn't matter.

## Todoist Adapter

### Credentials

```bash
# API token from https://app.todoist.com/app/settings/integrations/developer
# Stored in agent-secrets
export TODOIST_API_TOKEN=$(secrets lease todoist_api_token --raw)
```

### Read

```bash
todoist-cli today                    # What's due today
todoist-cli inbox                    # Needs triage
todoist-cli list                     # All active tasks
todoist-cli list --filter "p1"       # Todoist filter query (priority 1)
todoist-cli list --project ID        # Tasks in a project
todoist-cli list --label review      # Tasks with a label
todoist-cli projects                 # All projects
todoist-cli sections --project ID    # Sections in a project
todoist-cli labels                   # All labels
todoist-cli show ID                  # Task detail + comments
todoist-cli review                   # Daily standup: today, inbox, overdue, project breakdown
```

### Write

```bash
# Create a task
todoist-cli add "Title" --due today --description "Details" --project ID

# With labels, priority, deadline
todoist-cli add "Ship feature" --due "next monday" --priority 3 --labels agent,urgent --deadline 2026-03-01

# Complete
todoist-cli complete ID

# Update
todoist-cli update ID --content "New title" --due tomorrow --description "Updated notes"

# Move between projects
todoist-cli move ID --project ID

# Delete permanently
todoist-cli delete ID

# Reopen a completed task
todoist-cli reopen ID

# Create a project
todoist-cli add-project "Project Name" --color blue

# Create a section
todoist-cli add-section "Section Name" --project ID
```

### Schedule Mapping

| Todoist | GTD Context | CLI Flag |
|---------|-------------|----------|
| Inbox (no project) | Captured, not processed | (default) |
| `--due today` | Committed — doing it today | `--due today` |
| `--due "next week"` | Scheduled | `--due "next monday"` |
| No due date | Next action, no date pressure | (omit --due) |
| Label: `someday` | Maybe/later — reviewed weekly | `--labels someday` |
| `--due "every day"` | Recurring habit | `--due "every day"` |

### Structure

| Concept | Todoist | Rule |
|---------|---------|------|
| Project | Project | Finite goal with appetite. Has a "done" state. Archive when complete. |
| Section | Section | Group within a project. Optional — keep flat until complexity demands it. |
| Task | Task | Next physical action. Concrete, verb-first. |
| Habit | Recurring task | `--due "every day"` or `"every friday at 5pm"`. Anchored to routine. |
| Context | Label | Lightweight tags: `review`, `agent`, `someday`, `waiting`. |

### Todoist Filters (Pro)

Todoist's filter syntax is powerful. Use via `todoist-cli list --filter`:

```bash
todoist-cli list --filter "today | overdue"     # Due today or overdue
todoist-cli list --filter "p1 & !#Inbox"        # Priority 1, not in inbox
todoist-cli list --filter "no date"             # Floating tasks
todoist-cli list --filter "@review"             # Label: review
todoist-cli list --filter "assigned to: me"     # My tasks
todoist-cli list --filter "created before: -14d"  # Stale tasks
```

## Agent Behaviors

### Capture Immediately

When Joel says anything implying a task — "I need to...", "remind me to...", "we should...", "don't forget..." — capture it:

```bash
todoist-cli add "The thing Joel said"
```

Then confirm: **"Captured → Inbox: 'The thing Joel said'"**

Don't ask permission to capture. Ask permission before scheduling or assigning to a project. Capturing is free.

### Process Inbox (GTD)

When asked to review or when inbox has items:

For each item, decide ONE of:
1. **Do it** — takes < 2 min? Just do it now. Complete the task.
2. **Schedule it** — `todoist-cli update ID --due today` or `--due "next monday"`
3. **Move it** — `todoist-cli move ID --project ID`
4. **Someday/maybe** — `todoist-cli update ID --labels someday`
5. **Delete it** — not worth doing. `todoist-cli delete ID`

Present as a batch decision: "Inbox has 4 items. Here's my triage..."

### Create Tasks From Work

When actionable items emerge from other activities (transcribed photos, calendar events, project planning):

1. Extract concrete next actions (verb-first, specific)
2. Assign to the right project
3. Add descriptions with context (ADR refs, links, acceptance criteria)
4. Report what was created

### Weekly Review

When Joel asks for weekly review, or triggered by the recurring Friday task:

```bash
todoist-cli review
```

Then:
1. Process inbox to zero
2. Flag zombie projects (no activity in 2+ weeks)
3. Flag overdue tasks — reschedule or kill
4. Flag floating tasks (no due date) — still relevant?
5. Ask: "What's the one thing that would make next week a win?"

### Keep It Clean

- **Max 7 items due today.** More than that = overcommitted. Push overflow.
- **Inbox should be zero** after processing. Not "low" — zero.
- **Complete or kill.** No task should linger more than 2 weeks without progress unless labeled `someday`.
- **Project names are outcomes.** "Ship task integration" not "Task stuff."
- **Descriptions matter.** Every task gets enough context that you can pick it up cold.

### "Could the agent just do this?"

Before creating a task, ask: **could joelclaw do this right now?** If yes, do it and create a completed task as a record. Tasks are for humans; agents execute.

- **Agent does it**: code changes, research, file operations, API calls, calendar updates
- **Agent drafts, Joel reviews**: writing in Joel's voice, design decisions
- **Joel only**: physical actions (shopping, exercise), phone calls, editorial taste

## Fallback: Vault Checklists

If Todoist auth fails, use Vault markdown checklists:

```markdown
- [ ] Task description
- [x] Completed task
```

Google Tasks via `gog` is available as secondary adapter.

## Anti-Patterns

- **Don't create vague tasks** — "Look into X" is not a next action. "Spend 15 min reading X docs" is.
- **Don't let inbox accumulate** — if it has > 10 items, triage before adding more
- **Don't over-organize** — labels and sections add friction. Keep it flat until complexity demands structure.
- **Don't duplicate** — check existing tasks before creating. Use `todoist-cli list --filter` to search.
- **Don't put agent context in task titles** — keep titles human-readable. Put ADR refs and technical details in the description.

## Credits

- David Allen — Getting Things Done
- Ryan Singer — Shape Up (Basecamp)
- BJ Fogg — Tiny Habits
- Todoist / Doist — official API and SDK
