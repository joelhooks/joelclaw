---
title: Redis-Backed PRD State for Agent Loops
status: implemented
date: 2026-02-14
implemented: 2026-02-15
deciders: Joel Hooks
consulted: none
informed: none
---

# ADR-0011: Redis-Backed PRD State for Agent Loops

## Context and Problem Statement

The agent loop pipeline (ADR-0005) runs a PLANNER → IMPLEMENTOR → REVIEWER → JUDGE cycle across stories defined in a PRD. Originally, loop state — which stories have passed, which are being retried, attempt counts — lived in `prd.json` on the project filesystem.

This caused real problems:

1. **Git working tree collision.** The IMPLEMENTOR runs `git add -A` to commit changes. If the JUDGE updated `prd.json` (marking a story as passed), that state change got swept into the next implementation commit. Worse, when a human edits the same repo during a loop, their changes get tangled with loop state updates.

2. **No cross-function visibility.** Each Inngest function is a separate run. State passed between functions via events has size limits and doesn't persist across retries. The JUDGE needs to read the full PRD to decide what to do, but the only shared state was a file on disk.

3. **Single loop per project.** `prd.json` is a singleton file. Running two loops on the same project would clobber each other's state.

4. **No history.** Completed loops vanish when `prd.json` is overwritten by the next loop. No way to query past loops, their stories, or their outcomes.

5. **CLI detection heuristics.** `igs loop status` had to scan candidate directories to find `prd.json` files and guess which loop was active. Fragile, slow, wrong half the time.

Redis was already running in the docker-compose stack (redis:7-alpine, port 6379, AOF persistence, 256MB LRU) as planned infrastructure for caching and ephemeral state (Project 05: Search & State).

## Decision Drivers

- Git working tree must stay clean — loop state changes should not appear in implementation commits
- Multiple loops must be trackable simultaneously
- CLI must be able to query loop status instantly without filesystem scanning
- State must survive worker restarts (Inngest replays from last step, but needs to read current PRD)
- Past loop outcomes should be queryable for retrospectives and pattern learning
- Operational simplicity — use infrastructure that's already running

## Considered Options

### Option 1: Redis hash-per-loop (chosen)

Store each loop's PRD at `agent-loop:prd:{loopId}` as a JSON string in Redis. PLANNER seeds from disk on loop start. All subsequent reads/writes go through Redis. Disk write is best-effort for human review.

### Option 2: SQLite file outside working tree

Store loop state in a SQLite database at a fixed path (e.g., `~/.local/agent-loop/state.db`). Avoids git collision but adds a new storage dependency and doesn't benefit from Redis's existing presence in the stack.

### Option 3: Inngest step state only (status quo)

Pass all state through Inngest events and step outputs. No external store. Limited by event payload size, no cross-function visibility, no queryability from CLI.

## Decision Outcome

**Option 1: Redis hash-per-loop.** Redis is already running, already persistent (AOF), already accessible from the worker process. The data model is simple: one key per loop, JSON value, 7-day TTL.

## Implementation

Already implemented in `packages/system-bus/src/inngest/functions/agent-loop/utils.ts` during v3 recovery work. Three functions form the API:

### `seedPrd(loopId, project, prdPath) → Prd`

Called by PLANNER on loop start. Reads `prd.json` from disk, writes to Redis at `agent-loop:prd:{loopId}` with 7-day TTL. Returns the PRD.

### `readPrd(project, prdPath, loopId?) → Prd`

Called by all functions. If `loopId` is provided, reads from Redis first. Falls back to disk for backward compatibility with pre-Redis loops.

### `writePrd(loopId, prd, project?, prdPath?)`

Called by JUDGE when marking stories as passed/skipped. Writes to Redis (authoritative). Also writes to disk if project path is available (best-effort, for human review).

### Redis key schema

```
agent-loop:prd:{loopId}    → JSON string (full PRD with stories, passes, metadata)
                              TTL: 7 days
```

### Client setup

```typescript
import Redis from "ioredis";

const redis = new Redis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
  lazyConnect: true,
});
```

Singleton connection, lazy connect, no auth (localhost + Tailscale only).

## Consequences

### Positive

- **Git stays clean.** Loop state changes never appear in `git add -A` commits.
- **Multi-loop.** Each loop has its own key. Five loops currently tracked in Redis simultaneously.
- **Instant CLI queries.** `igs loop status` reads from Redis — no directory scanning, no git log parsing.
- **Cross-function state.** JUDGE reads the same PRD the PLANNER seeded, regardless of Inngest replay behavior.
- **History.** Completed loops remain queryable for 7 days. Retrospective function can read past loop outcomes.

### Negative

- **Redis is a hard dependency for loops.** If Redis is down, loops can't read/write state. Mitigated by AOF persistence and `restart: unless-stopped`.
- **Disk PRD can drift.** The `prd.json` on disk is a best-effort shadow copy. If someone edits it mid-loop, the changes are ignored — Redis is authoritative. This is intentional but could confuse someone reading `prd.json` expecting it to be the source of truth.
- **No schema migration path.** PRD format changes require updating all three functions. Currently acceptable given the single-developer context.

### Comparison

| Dimension | Redis (chosen) | SQLite | Inngest-only |
|-----------|---------------|--------|-------------|
| Git isolation | ✅ Full | ✅ Full | ⚠️ Partial |
| Multi-loop | ✅ Key per loop | ✅ Row per loop | ❌ No |
| CLI queryability | ✅ Direct read | ✅ SQL query | ❌ GQL only |
| Already running | ✅ Yes | ❌ New dep | ✅ Yes |
| Crash recovery | ✅ AOF persist | ✅ File persist | ⚠️ Step replay |
| History retention | ✅ 7-day TTL | ✅ Permanent | ❌ None |
| Operational cost | Low | Medium | None |

## Verification

- `docker exec system-bus-redis-1 redis-cli keys "agent-loop:prd:*"` returns active loop keys
- `readPrd` with loopId returns data from Redis, not disk
- Modifying disk `prd.json` during a loop does not affect loop behavior
- `igs loop status` reads from Redis and displays correct story state

## References

- [ADR-0005: Durable Multi-Agent Coding Loops](0005-durable-multi-agent-coding-loops.md) — original loop architecture
- [ADR-0007: Agent Loop V2 Improvements](0007-agent-loop-v2-improvements.md) — v2 upgrade spec
- Project 05: Search & State — Redis infrastructure setup
- `packages/system-bus/src/inngest/functions/agent-loop/utils.ts` — implementation
