---
status: proposed
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

Task management is integral to a personal AI operating system. Joel uses Things 3 on Mac/iPhone/iPad as his primary task app. Google Tasks exists via `gog` CLI. Apple Reminders is available. Future providers are likely.

Currently tasks live in silos — the agent has no awareness of what Joel needs to do, and Joel has no way to delegate task creation/management to the agent. The surgery prep checklist (ADR-0044 context, Vault note created 2026-02-18) is a concrete example: the agent transcribed post-op care instructions from photos but had no way to create actionable tasks from them.

An agent that can't manage tasks is an agent that can't manage life.

## Decision

Implement task management as a **core joelclaw capability** using the **Ports and Adapters** (hexagonal) pattern:

1. **Define a `TaskPort` interface** — provider-agnostic operations for task CRUD, project/area organization, and sync.
2. **Implement adapters** for each backend — starting with Things Cloud, then Google Tasks, with the architecture supporting n+1 providers.
3. **Co-management** — both Joel (via native apps) and the agent (via the port) read and write to the same task state. Bidirectional sync, not one-way push.
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
  listAreas(): Promise<Area[]>
  listTags(): Promise<Tag[]>
  moveToProject(taskId: string, projectId: string): Promise<void>

  // Scheduling
  moveToToday(taskId: string): Promise<void>
  moveToUpcoming(taskId: string, date: Date): Promise<void>
  moveToSomeday(taskId: string): Promise<void>
  moveToInbox(taskId: string): Promise<void>

  // Sync
  sync(): Promise<Change[]>
  getState(): TaskState
}

interface TaskFilter {
  inbox?: boolean
  today?: boolean
  project?: string
  area?: string
  tag?: string
  completed?: boolean
  search?: string
}

// Provider-agnostic domain types
interface Task {
  id: string
  title: string
  notes?: string
  schedule: 'inbox' | 'today' | 'anytime' | 'someday' | 'upcoming'
  scheduledDate?: Date
  deadline?: Date
  completed: boolean
  completedDate?: Date
  projectId?: string
  areaId?: string
  tags: string[]
  checklistItems: ChecklistItem[]
  createdAt: Date
  updatedAt: Date
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
| **ThingsAdapter** | Things Cloud API | First priority | Via [things-cloud-sdk](https://github.com/arthursoares/things-cloud-sdk) — Go CLI with persistent sync engine, 40+ semantic change types. Build `things-cli`, call from TypeScript. |
| **GoogleTasksAdapter** | Google Tasks API | Second | Via `gog tasks` CLI (already installed). Flat structure — map projects/areas to task lists. |
| **VaultAdapter** | Markdown checklists | Fallback | Always available. Parse `- [ ]` / `- [x]` from Vault notes. No external dependency. |
| **AppleRemindersAdapter** | Apple Reminders | Future | Via AppleScript or Shortcuts. Native iOS/macOS integration. |

### Agent Integration

- **joelclaw CLI**: `joelclaw tasks today`, `joelclaw tasks add "..."`, `joelclaw tasks complete <id>`
- **Pi skill**: natural language — "add prep tasks for Kristina's surgery", "what's on my list today", "move that to someday"
- **Inngest events**: `tasks/synced` (with changes), `tasks/created`, `tasks/completed` — agent loop can react
- **Recall integration**: when agent sees task-related context (like surgery prep photos), it can create tasks directly

### Where It Lives

```
packages/system-bus/src/tasks/
├── port.ts              # TaskPort interface + domain types
├── adapters/
│   ├── things.ts        # Things Cloud adapter (shells out to things-cli)
│   ├── google-tasks.ts  # Google Tasks adapter (shells out to gog)
│   └── vault.ts         # Vault markdown adapter
├── manager.ts           # Orchestrates multiple adapters, handles sync
└── events.ts            # Inngest event schemas for task changes
```

## Alternatives Considered

### A: Google Tasks Only

Simplest — `gog` CLI already works. But Google Tasks is flat (no areas, no headings, no Today/Someday), and Joel loves Things. Forcing into one provider defeats the purpose.

### B: Things Only

Things is Joel's preferred UI, and the SDK is excellent. But hard-coding to one provider creates vendor lock-in and makes it impossible to sync tasks to/from other systems (e.g., work Google account).

### C: Build Custom Task Store

Roll our own task database (Redis/SQLite). Maximum control. But then Joel has two task systems — the custom store and whatever app he uses. Defeats co-management principle.

## Consequences

### Positive
- Agent becomes a true task co-pilot — creates, organizes, completes tasks alongside Joel
- Tasks follow Joel everywhere — Things on phone, agent on Mac Mini, both synced
- New providers are one adapter implementation away
- Event-driven: task changes trigger agent reactions automatically
- Surgery prep example becomes trivial: agent reads photos → creates tasks in Things → Joel sees them on his phone

### Negative
- Things Cloud SDK is reverse-engineered, unofficial — could break if Cultured Code changes their API
- Go binary dependency for Things adapter (need to build and ship `things-cli`)
- Sync conflicts possible when both agent and human modify simultaneously
- Things account credentials need to be in agent-secrets

### Follow-up Tasks
- [ ] Clone and build things-cloud-sdk, test auth with Joel's Things account
- [ ] Implement `TaskPort` interface and `ThingsAdapter`
- [ ] Build `joelclaw tasks` CLI subcommand
- [ ] Create task management pi skill
- [ ] Wire sync engine to Inngest events
- [ ] Implement `GoogleTasksAdapter` via gog
- [ ] Create recall skill (ADR-0046?) that fans out across memory sources on vague references

## Implementation Plan

### Phase 1: Things Adapter + CLI (first)
1. Clone `arthursoares/things-cloud-sdk` to `~/Code/arthursoares/things-cloud-sdk`
2. Build `things-cli` binary
3. Store Things credentials in agent-secrets
4. Implement `TaskPort` interface in `packages/system-bus/src/tasks/port.ts`
5. Implement `ThingsAdapter` that shells out to `things-cli --json`
6. Add `joelclaw tasks` subcommand tree: `today`, `inbox`, `add`, `complete`, `projects`, `sync`

### Phase 2: Event-Driven Sync
1. Inngest cron function: periodic sync via Things adapter
2. Emit `tasks/synced` events with semantic changes
3. Agent can react to changes (completions, reschedules, new tasks)

### Phase 3: Multi-Adapter
1. Implement `GoogleTasksAdapter` via `gog tasks`
2. Task manager orchestrates across adapters (primary + mirrors)
3. Conflict resolution strategy

### Phase 4: Skill + Recall
1. Pi skill for natural language task management
2. Recall skill for vague reference resolution (separate ADR)
