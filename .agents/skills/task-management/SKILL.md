---
name: task-management
description: "Manage tasks across providers (Things 3, Google Tasks, Vault checklists) via the TaskPort interface. Triggers on: 'add a task', 'create a todo', 'what's on my list', 'today's tasks', 'move to today', 'complete task', 'mark done', 'what do I need to do', 'prep tasks for', 'remind me to', 'task list', 'inbox', 'someday', 'upcoming', 'schedule this', or any request to create, read, update, or organize tasks. Also triggers when actionable items emerge from other work (e.g., transcribing instructions that should become tasks)."
---

# Task Management — Ports and Adapters

> **ADR-0045**: Task management is a core joelclaw capability. The `TaskPort` interface abstracts over providers. Multiple adapters can be active simultaneously.

## Architecture

```
Joel (Things app) ←→ Things Cloud ←→ ThingsAdapter ←→ TaskPort
Joel (gog CLI)    ←→ Google Tasks  ←→ GoogleTasksAdapter ←→ TaskPort
Agent (any skill) ←→                                        TaskPort
Vault checklists  ←→                   VaultAdapter    ←→ TaskPort
```

The agent always works through the port. Never call provider CLIs directly from other skills — go through task management.

## Current Adapters

### Things 3 (Primary)

Things Cloud SDK: https://github.com/arthursoares/things-cloud-sdk

```bash
# CLI binary (once built and installed)
export THINGS_USERNAME=$(secrets lease things_username --raw)
export THINGS_PASSWORD=$(secrets lease things_password --raw)

# List today's tasks
things-cli list --today --json

# Create a task
things-cli create "Task title" --when today --note "Details"

# Create with project
things-cli create "Subtask" --project <uuid> --when today

# Complete
things-cli complete <uuid>

# Batch operations (fast — one HTTP request)
echo '[
  {"cmd": "create", "title": "Task 1", "when": "today"},
  {"cmd": "create", "title": "Task 2", "when": "today"},
  {"cmd": "complete", "uuid": "abc123"}
]' | things-cli batch

# Sync and show changes
things-cli sync --json
```

#### Things Schedule Mapping
| Schedule | Things View | Use When |
|----------|-------------|----------|
| `inbox` | Inbox | Uncategorized, needs triage |
| `today` | Today | Do it today |
| `anytime` | Anytime | Ready to do, no urgency |
| `someday` | Someday | Maybe later |
| `upcoming` | Upcoming | Scheduled for a future date |

### Google Tasks

```bash
export GOG_ACCOUNT=joelhooks@gmail.com
export GOG_KEYRING_PASSWORD=$(secrets lease gog_keyring_password --raw)

# List task lists
gog tasks lists --json

# List tasks in a list
gog tasks list <tasklistId> --max 50 --json

# Add a task
gog tasks add <tasklistId> --title "Task title"

# Complete
gog tasks done <tasklistId> <taskId>
```

### Vault Checklists (Fallback)

Always available. Parse markdown checklists from Vault notes.

```bash
# Find unchecked tasks in a note
grep -n '^\- \[ \]' ~/Vault/Areas/family/kristina-surgery-march-2026.md
```

When creating tasks in Vault notes, use standard checkbox syntax:
```markdown
- [ ] Task description
- [x] Completed task
```

## Workflow Patterns

### Creating Tasks from Context

When actionable items emerge from other work (transcribed photos, meeting notes, discussions):

1. **Extract actionable items** — identify concrete tasks from the content
2. **Choose the right provider** — Things for personal tasks, Google Tasks for work, Vault for project-specific checklists
3. **Set schedule** — inbox if unsure, today if urgent, upcoming with date if scheduled
4. **Group into a project** if there are 3+ related tasks
5. **Confirm with Joel** before bulk-creating (unless explicitly asked)

### Daily Review

```bash
# What's on today
things-cli list --today --json

# What's in inbox (needs triage)
things-cli list --inbox --json

# Overdue (upcoming tasks past their date)
things-cli list --today --json | jq '.[] | select(.deadline) | select(.deadline < now)'
```

### Task from Conversation

When Joel says something like "remind me to..." or "I need to...":

1. Create the task immediately via the primary adapter
2. Confirm: "Created in Things: '<title>' → Today"
3. Continue the conversation

### Bulk Task Creation

For checklists (like surgery prep):

1. Draft the full list
2. Show Joel for approval
3. Use `things-cli batch` for one-shot creation
4. Report what was created

## Event Integration (Future — Phase 2)

Once Inngest events are wired:
- `tasks/synced` — periodic sync detected changes
- `tasks/created` — new task (from any source)
- `tasks/completed` — task done
- `tasks/moved` — schedule/project changed
- `tasks/overdue` — deadline passed

Agent can react: "You completed 'Stock beverages' — want me to check off related prep items?"

## Secrets Required

| Secret | Purpose |
|--------|---------|
| `things_username` | Things Cloud account email |
| `things_password` | Things Cloud account password |
| `gog_keyring_password` | Google Workspace CLI auth (already configured) |

## Anti-Patterns

- **Don't create tasks without confirmation** unless Joel explicitly asked ("add these as tasks").
- **Don't use provider CLIs directly from other skills.** Go through task management.
- **Don't assume Things is available.** Fall back to Vault checklists if Things auth fails.
- **Don't sync too aggressively.** Things Cloud API is unofficial — respect rate limits.

## Setup (One-Time)

```bash
# 1. Clone and build things-cloud-sdk
cd ~/Code && mkdir -p arthursoares && cd arthursoares
git clone https://github.com/arthursoares/things-cloud-sdk.git
cd things-cloud-sdk
go build -o things-cli ./cmd/things-cli/
sudo cp things-cli /usr/local/bin/  # or symlink

# 2. Store credentials
secrets add things_username   # Joel's Things account email
secrets add things_password   # Joel's Things account password

# 3. Test auth
export THINGS_USERNAME=$(secrets lease things_username --raw)
export THINGS_PASSWORD=$(secrets lease things_password --raw)
things-cli list --today
```
