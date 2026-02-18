---
name: task-management
description: "Manage Joel's task system in Things 3. Triggers on: 'add a task', 'create a todo', 'what's on my list', 'today's tasks', 'what do I need to do', 'remind me to', 'inbox', 'complete', 'mark done', 'weekly review', 'groom tasks', 'what's next', or when actionable items emerge from other work. Also triggers when Joel mentions something he needs to do in passing — capture it."
---

# Task Management — The System That Thinks For You

Things 3 is the task layer. The agent is the gardener.

## Philosophy

Three systems, one practice:

**Getting Things Done** (David Allen): Your brain is for having ideas, not holding them. Capture everything immediately. Process to next physical action. If it takes < 2 min, do it now. Weekly review is sacred.

**Shape Up** (Ryan Singer, Basecamp): Work expands to fill the time available. Set appetite (how much time is this worth?), not estimates. Projects are bets with fixed timelines, not open-ended backlogs. If it's not worth betting on, kill it.

**Tiny Habits** (BJ Fogg): Behavior change = anchor moment + tiny behavior + celebration. "After I [existing routine], I will [tiny version of new habit]." Make it stupidly small. Celebrate immediately. Let it grow naturally.

### What This Means In Practice

- **Every task is a next physical action.** Not "research X" but "spend 20 min reading the X docs." Not "fix the bug" but "reproduce the bug in a test."
- **Inbox is a capture buffer, not a todo list.** Process it to zero. Each item gets: do it (< 2 min), schedule it (today/upcoming), delegate it, someday/maybe it, or trash it.
- **Projects have appetite.** "2 weeks, small batch" or "6 weeks, big batch." If a project has been open for 3x its appetite with no progress, it's a zombie. Kill it or re-scope.
- **Habits are anchored, not scheduled.** "After morning coffee → shoulder warm-up" not "Do exercises at 7am." The anchor is the trigger.
- **Less is more.** A clean list with 5 clear next actions beats 50 vague intentions. Ruthlessly prune. If you haven't touched it in 2 weeks and it's not scheduled, it doesn't matter.

## Things 3 Adapter

### Credentials

```bash
# New account (Feb 2026)
export THINGS_USERNAME=$(secrets lease things_username_new --raw)
export THINGS_PASSWORD=$(secrets lease things_password_new --raw)
```

**⚠️ NEVER purge areas.** `action=2` on `Area3` items corrupts the history and crashes Things 3 iOS. Trash areas instead. Learned the hard way — see slog 2026-02-18.

### Read

```bash
things-cli list --today        # What's on today
things-cli list --inbox        # Needs triage
things-cli list                # Everything active
things-cli projects            # All projects
things-cli areas               # All areas
things-cli show <uuid>         # Single item detail
things-cli list --project NAME # Tasks in a project
things-cli list --area NAME    # Tasks in an area
```

### Write

```bash
# Create a task
things-cli create "Title" --when today --note "Details" --project <uuid>

# Batch (one HTTP call — use for 3+ items)
echo '[
  {"cmd":"create","title":"Task 1","when":"today","project":"<uuid>"},
  {"cmd":"create","title":"Task 2","when":"anytime"},
  {"cmd":"complete","uuid":"<uuid>"}
]' | things-cli batch

# Complete
things-cli complete <uuid>

# Move
things-cli move-to-today <uuid>
things-cli edit <uuid> --when someday

# Trash (not purge!)
things-cli trash <uuid>
```

### Schedule Mapping

| Value | Things View | GTD Context |
|-------|-------------|-------------|
| `inbox` | Inbox | Captured, not processed |
| `today` | Today | Committed — doing it today |
| `anytime` | Anytime | Next action, no date pressure |
| `someday` | Someday | Maybe/later — reviewed weekly |
| `upcoming` | Upcoming | Scheduled for specific date |

### Structure

| Concept | Things | Rule |
|---------|--------|------|
| Area | Area | Long-lived responsibility. Never "done." Max 5-7. |
| Project | Project | Finite goal with appetite. Has a "done" state. |
| Task | To-do | Next physical action. Concrete, verb-first. |
| Habit | Repeating to-do | Anchored to a routine, not a time. |

Current areas: **joelclaw**, **Family**, **Health**, **Writing**

## Agent Behaviors

### Capture Immediately

When Joel says anything implying a task — "I need to...", "remind me to...", "we should...", "don't forget..." — capture it:

```bash
things-cli create "The thing Joel said" --when inbox
```

Then confirm: **"Captured → Inbox: 'The thing Joel said'"**

Don't ask permission to capture. Ask permission before scheduling or assigning to a project. Capturing is free.

### Process Inbox (GTD)

When asked to review or when inbox has items:

For each item, decide ONE of:
1. **Do it** — takes < 2 min? Just do it now. Complete the task.
2. **Schedule it** — `--when today` or `--scheduled YYYY-MM-DD`
3. **Delegate it** — note who, move to anytime with a waiting-for tag
4. **Someday/maybe** — `--when someday`
5. **Trash it** — not worth doing. `things-cli trash <uuid>`

Present as a batch decision: "Inbox has 4 items. Here's my triage..."

### Create Tasks From Work

When actionable items emerge from other activities (transcribed photos, calendar events, project planning):

1. Extract concrete next actions (verb-first, specific)
2. Group into a project if 3+ related
3. Use `things-cli batch` for efficiency
4. Report what was created

### Weekly Review Prompt

When Joel asks for weekly review, or on a nudge:

1. Show today + inbox counts
2. Flag zombie projects (no activity in 2+ weeks)
3. Flag tasks without next actions
4. Flag someday items worth promoting
5. Ask: "What's the one thing that would make this week a win?"

### Keep It Clean

- **Max 7 items on Today.** More than that = overcommitted. Push overflow to anytime.
- **Inbox should be zero** after processing. Not "low" — zero.
- **Complete or kill.** No task should exist for more than 2 weeks without progress unless it's in Someday.
- **Project names are outcomes.** "Ship task integration" not "Task stuff."

## Fallback: Vault Checklists

If Things auth fails, use Vault markdown checklists:

```markdown
- [ ] Task description
- [x] Completed task
```

Google Tasks via `gog` is available as secondary adapter but Things is primary.

## Anti-Patterns

- **Never purge areas** — corrupts Things Cloud history permanently
- **Don't create vague tasks** — "Look into X" is not a next action. "Spend 15 min reading X docs" is.
- **Don't let inbox accumulate** — if it has > 10 items, triage before adding more
- **Don't over-organize** — tags, headings, and sub-projects add friction. Keep it flat until complexity demands structure.
- **Don't sync too aggressively** — Things Cloud API is unofficial, respect it
