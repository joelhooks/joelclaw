---
status: withdrawn
date: 2026-02-18
deciders: Joel
tags:
  - architecture
  - tasks
  - cli
  - joelclaw
related:
  - "[[0045-task-management-ports-and-adapters]]"
---

# ADR-0046: TypeScript Things CLI via joelclaw Tasks Subcommand

## Context

ADR-0045 established the Ports and Adapters pattern for task management. Phase 1 calls for a Things adapter. We've validated that `arthursoares/things-cloud-sdk` works — Go binary built, auth verified, inbox/projects/areas accessible.

However, shelling out to a Go binary from TypeScript has friction:
- Requires Go toolchain for builds
- Two separate repos/languages to maintain
- No type safety at the boundary
- Process spawning overhead per call
- Error handling is string parsing

The joelclaw CLI (`~/Code/joelhooks/joelclaw-cli/`) is an Effect-based TypeScript CLI that already has the response envelope, HATEOAS patterns, and Effect service layer (see `Inngest`, `Pds` services). Adding a `Tasks` Effect service and `joelclaw tasks` subcommand keeps everything in one language, one build, one binary.

## Decision

Implement `joelclaw tasks` as a **TypeScript subcommand** with a `Tasks` Effect service that:

1. **Calls the Things Cloud API directly** from TypeScript (HTTP client, same protocol the Go SDK reverse-engineered)
2. **Implements the `TaskPort` interface** from ADR-0045 as an Effect service
3. **Follows cli-design patterns** — HATEOAS JSON, contextual next_actions, error+fix responses
4. **Uses agent-secrets** for credentials (same pattern as `Pds` service)

### Command Tree

```
joelclaw tasks                    # Overview: today count, inbox count, recent changes
joelclaw tasks today              # List today's tasks
joelclaw tasks inbox              # List inbox (needs triage)
joelclaw tasks add "title" [opts] # Create a task
joelclaw tasks complete <uuid>    # Mark done
joelclaw tasks projects           # List projects
joelclaw tasks areas              # List areas
joelclaw tasks search "query"     # Search across all tasks
joelclaw tasks move <uuid> <schedule> # Move to today/inbox/someday/upcoming
joelclaw tasks sync               # Full sync, report changes
```

### Effect Service

```typescript
// src/tasks.ts
export class Tasks extends Effect.Service<Tasks>()("Tasks", {
  effect: Effect.gen(function* () {
    // Lease credentials from agent-secrets
    // Initialize Things Cloud HTTP client
    // Session management (like Pds service)
    return {
      today: () => Effect.tryPromise(...),
      inbox: () => Effect.tryPromise(...),
      create: (task: CreateTaskInput) => Effect.tryPromise(...),
      complete: (uuid: string) => Effect.tryPromise(...),
      projects: () => Effect.tryPromise(...),
      areas: () => Effect.tryPromise(...),
      search: (query: string) => Effect.tryPromise(...),
      move: (uuid: string, schedule: Schedule) => Effect.tryPromise(...),
      sync: () => Effect.tryPromise(...),
    }
  })
}) {}
```

### Things Cloud Protocol (from SDK reverse-engineering)

Key findings from `arthursoares/things-cloud-sdk`:
- **Endpoint**: `https://cloud.culturedcode.com`
- **Auth**: Basic auth or session-based (verify endpoint, then history CRUD)
- **Client header**: `things-client-info` — base64-encoded device metadata, mimics `ThingsMac/32209501`
- **UUIDs**: Base58-encoded (Bitcoin alphabet). Standard UUID strings crash Things.app.
- **Items**: Event-sourced — all mutations are immutable Items pushed/pulled through Histories
- **Schedule field (`st`)**: 0=Inbox, 1=Anytime/Today, 2=Someday/Upcoming
- **Status field (`ss`)**: 0=Pending, 2=Canceled, 3=Completed

### Where It Lives

```
~/Code/joelhooks/joelclaw-cli/src/
├── tasks.ts              # Tasks Effect service (Things Cloud HTTP client)
├── commands/
│   └── tasks.ts          # joelclaw tasks subcommand tree
```

## Alternatives Considered

### A: Shell Out to Go Binary

Keep `things-cli` as the adapter, spawn processes from TypeScript. Simpler initially but:
- Two languages, two build systems
- String parsing for errors
- No Effect integration
- Process overhead per command

### B: Port Go SDK to TypeScript

Rewrite the full Go SDK (sync engine, state aggregation) in TypeScript. Too much work upfront — the HTTP protocol is what matters. State and sync can come later.

### C: Use Go Binary for Now, Port Later

Start with shell-out adapter, replace with native TypeScript later. Pragmatic but means throwaway work. The HTTP protocol is well-documented in the Go source — better to go direct.

## Consequences

### Positive
- Single language, single build, single binary for all joelclaw CLI commands
- Full Effect integration (errors, retries, service composition)
- Type safety at every boundary
- Same patterns as Pds service (proven)
- HATEOAS responses out of the box

### Negative
- Must reverse-engineer the HTTP protocol from Go source (well-documented in `client.go`, `histories.go`)
- No persistent sync engine initially (Go SDK has SQLite-backed sync — we'd add this later)
- Things Cloud API is unofficial — same risk regardless of language

### Follow-up Tasks
- [ ] Implement `Tasks` Effect service with Things Cloud HTTP client
- [ ] Implement `joelclaw tasks` command tree
- [ ] Add to root command's subcommands + command tree
- [ ] Test: verify, list histories, read items, create task, complete task
- [ ] Wire credentials via agent-secrets
- [ ] Update AGENTS.md tool inventory
