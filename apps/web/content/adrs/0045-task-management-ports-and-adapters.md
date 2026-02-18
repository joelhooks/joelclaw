---
status: accepted
date: 2026-02-18
deciders: Joel
tags:
  - architecture
  - tasks
  - ports-and-adapters
  - joelclaw
---

# ADR-0045: Task Management via Ports and Adapters

## Context

Task management is integral to a personal AI operating system. Joel uses Todoist on Mac/iPhone/iPad as his primary task app. Google Tasks exists via `gog` CLI. Apple Reminders is available. Future providers are likely.

Currently tasks live in silos — the agent has no awareness of what Joel needs to do, and Joel has no way to delegate task creation/management to the agent. The surgery prep checklist (Vault note created 2026-02-18) is a concrete example: the agent transcribed post-op care instructions from photos but had no way to create actionable tasks from them.

An agent that can't manage tasks is an agent that can't manage life.

### Why Todoist (Not Things Cloud)

Things 3 is a beautiful native app with a reverse-engineered, event-sourced sync protocol. On 2026-02-18, two Things Cloud accounts were corrupted in a single day:
1. **joel@egghead.io**: Area purge (`action=2` on `Area3` items) poisoned history — `own-history-keys` API endpoint is dead, no way to delete history events. Things 3 iOS crashes on sync.
2. **joelhooks@gmail.com**: Batch edits with em-dashes, unicode characters, and long notes in task descriptions crash the Things 3 iOS sync parser.

Things Cloud history is **immutable event-sourced** — there is no delete API. Once corrupted, it stays corrupted. The `things-cloud-sdk` approach (Go CLI, reverse-engineered protocol) is fundamentally fragile.

Todoist has an **official REST API**, a **maintained TypeScript SDK** (`@doist/todoist-api-typescript` v6), bearer token auth, markdown in descriptions, and proper CRUD. The Ports and Adapters pattern means we swap the adapter, keep the port interface.

## Decision

Implement task management as a **core joelclaw capability** using the **Ports and Adapters** (hexagonal) pattern:

1. **Define a `TaskPort` interface** — provider-agnostic operations for task CRUD, project organization, and sync.
2. **Implement adapters** for each backend — primary is Todoist, with architecture supporting n+1 providers.
3. **Co-management** — both Joel (via Todoist apps) and the agent (via the port) read and write to the same task state. Bidirectional sync, not one-way push.
4. **Event-driven reactivity** — task changes emit Inngest events so the agent can react (task completed → close related items, task created → suggest scheduling, recurring task missed → nudge).

### Port Interface (TypeScript)

```typescript
interface TaskPort {
  // Core CRUD
  listTasks(filter?: TaskFilter): Promise<Task[]>
  getTask(id: string): Promise<Task | null>
  createTask(task: CreateTaskInput): Promise<Task>
  updateTask(id: string, updates: UpdateTaskInput): Promise<Task>
  completeTask(id: string): Promise<void>
  deleteTask(id: string): Promise<void>

  // Organization
  listProjects(): Promise<Project[]>
  listLabels(): Promise<Label[]>
  moveToProject(taskId: string, projectId: string): Promise<void>

  // Sync
  sync(): Promise<Change[]>
}

interface TaskFilter {
  inbox?: boolean
  today?: boolean
  project?: string
  label?: string
  filter?: string      // Todoist filter syntax (Pro)
  completed?: boolean
  search?: string
}

// Provider-agnostic domain types
interface Task {
  id: string
  content: string
  description?: string
  priority: 1 | 2 | 3 | 4
  due?: Date
  dueString?: string
  isRecurring: boolean
  deadline?: Date
  completed: boolean
  projectId?: string
  sectionId?: string
  parentId?: string
  labels: string[]
  url: string
  createdAt: Date
}

interface Change {
  type: string          // e.g. 'task.created', 'task.completed', 'task.moved'
  entityId: string
  timestamp: Date
  details: Record<string, unknown>
}
```

### Adapters

| Adapter | Backend | Status | Notes |
|---------|---------|--------|-------|
| **TodoistAdapter** | Todoist REST API | ✅ Implemented | `todoist-cli` — official SDK, HATEOAS JSON, bearer token auth |
| **GoogleTasksAdapter** | Google Tasks API | Future | Via `gog tasks` CLI. Flat structure — map projects to task lists. |
| **VaultAdapter** | Markdown checklists | Fallback | Always available. Parse `- [ ]` / `- [x]` from Vault notes. No external dependency. |
| ~~ThingsAdapter~~ | ~~Things Cloud~~ | ❌ Abandoned | Event-sourced sync corrupts on unicode. Two accounts lost. |

### Task Philosophy

Inspired by Ali Abdaal's Todoist setup — radical minimalism:

- **Labels as context** (`joelclaw`, `family`, `health`, `writing`, `review`, `someday`) — cross-cutting views across projects
- **Projects as workflow containers** — finite bets with finish lines, not categories
- **Priorities + due dates** for urgency, not complex scheduling schemes
- **Inbox zero** — capture everything, triage ruthlessly

Productivity influences: **GTD** (David Allen), **Shape Up** (Ryan Singer), **Tiny Habits** (BJ Fogg).

### Agent Integration

- **todoist-cli**: `todoist-cli today`, `todoist-cli add "..."`, `todoist-cli complete <id>`, `todoist-cli review`
- **Pi skill**: natural language — "add prep tasks for Kristina's surgery", "what's on my list today"
- **Inngest events**: `tasks/synced` (with changes), `tasks/created`, `tasks/completed`
- **"Could the agent just do this?"** — before creating a task, check if the agent can execute it now. Tasks are for humans; agents execute.

### Where It Lives

```
~/Code/joelhooks/todoist-cli/     # Standalone CLI (published to GitHub)
packages/system-bus/src/tasks/
├── port.ts                       # TaskPort interface + domain types
├── adapters/
│   ├── todoist.ts                # Todoist adapter (official SDK)
│   ├── google-tasks.ts           # Google Tasks adapter (via gog)
│   └── vault.ts                  # Vault markdown adapter
├── manager.ts                    # Orchestrates adapters, handles sync
└── events.ts                     # Inngest event schemas
```

## Alternatives Considered

### A: Google Tasks Only

Simplest — `gog` CLI already works. But Google Tasks is flat (no sections, limited priorities), and Todoist's filter syntax is far more powerful. Forcing into one provider defeats the purpose.

### B: Things Cloud Only

Beautiful UI, but the sync protocol is reverse-engineered and fragile. Two accounts corrupted in one day. Event-sourced history is immutable — can't recover from corruption.

### C: Build Custom Task Store

Roll our own task database (Redis/SQLite). Maximum control. But then Joel has two task systems. Defeats co-management principle.

## Consequences

### Positive
- Agent becomes a true task co-pilot — creates, organizes, completes tasks alongside Joel
- Tasks follow Joel everywhere — Todoist on phone, agent on Mac Mini, both synced
- New providers are one adapter implementation away
- Event-driven: task changes trigger agent reactions automatically
- Official API — no reverse-engineering, no fragile sync, proper error messages

### Negative
- Todoist Pro required for filter syntax and webhooks ($5/mo)
- Network dependency — Todoist is cloud-only (Vault adapter is offline fallback)
- Sync conflicts possible when both agent and human modify simultaneously

### Risks Mitigated
- **Provider lock-in**: Ports and Adapters pattern — swap adapter, keep interface
- **API changes**: Official SDK maintained by Doist, semver'd, TypeScript-first
- **Credential exposure**: Bearer token in agent-secrets with TTL leasing

## Implementation Status

### Phase 1: Todoist Adapter + CLI ✅
1. ✅ Built `todoist-cli` at `~/Code/joelhooks/todoist-cli/`
2. ✅ Published to GitHub with cross-platform binaries (v0.1.0)
3. ✅ Stored API token in agent-secrets
4. ✅ Full CRUD verified: add, complete, update, move, delete
5. ✅ Unicode, em-dashes, markdown in descriptions — no issues
6. ✅ Updated task-management skill for Todoist

### Phase 2: Event-Driven Sync (next)
1. Inngest cron function: poll Todoist every 5 min
2. Diff against Redis cache, emit `tasks/synced` on changes
3. Todoist webhooks (Pro) as upgrade from polling

### Phase 3: Port Interface + Manager
1. Implement `TaskPort` in `packages/system-bus/src/tasks/port.ts`
2. Wire `joelclaw tasks` subcommand to delegate to todoist-cli
3. `GoogleTasksAdapter` via `gog tasks` as secondary

### Phase 4: Reactivity
1. Agent reacts to task events (completions, missed recurring)
2. Automatic task creation from context (photos, calendar, discoveries)
