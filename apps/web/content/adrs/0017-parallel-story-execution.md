---
status: proposed
date: 2026-02-14
decision-makers: Joel Hooks
---

# ADR-0017: Parallel Story and Subtask Execution in Agent Loops

## Context and Problem Statement

The current agent loop (ADR-0015) is rigidly sequential: one story at a time, one agent per step, pipeline flow. The planner picks the next unpassed story, the chain runs plan→test→implement→review→judge, and only then does the planner pick the next story.

This is slow. A 5-story PRD runs 5 sequential chains. Each chain includes tool spawns (codex/claude) that take 2-10 minutes. A loop that could finish in 15 minutes takes 45+ because independent work is serialized.

The Inngest event bus already supports fan-out — emitting N events from one step is native. The infrastructure for parallel execution exists; the constraint is in the planner logic and the assumption that stories are a sequential queue.

### Two dimensions of parallelism

**Inter-story**: Stories that don't share files can run simultaneously. If LOOP-3 touches `review.ts` and LOOP-4 touches `judge.ts`, there's no reason to wait.

**Intra-story**: A single story can be decomposed into subtasks. "Rewrite reviewer as evaluator" could be: (A) remove test-writing code, (B) add evaluation prompt, (C) wire structured output. If these touch different functions within the file or different files, parallel workers can handle them with a merge gate.

### Prior art

`joelhooks/swarm-tools` (`packages/opencode-swarm-plugin/src/swarm-decompose.ts`) implements dependency-aware parallel subtask planning:
- Decomposer creates subtasks with `dependencies: number[]` and `files: string[]` (exclusive locks)
- File conflict detection prevents two workers from touching the same file
- Verification gates at fan-in points
- Worker handoffs with contract validation

## Decision

Extend the planner to be a **decomposer/scheduler** that decides parallelism strategy at two levels.

### Level 1: Inter-story parallelism

The planner analyzes all pending stories and builds a dependency graph:

```typescript
interface StoryNode {
  id: string;
  files: string[];           // files this story will touch (predicted by LLM or declared in PRD)
  dependsOn: string[];       // story IDs that must complete first
  parallelGroup?: number;    // stories in same group can run simultaneously
}
```

Stories with no file overlap and no dependency edges get assigned to the same parallel group. The planner emits test events for all stories in the current group simultaneously.

**File prediction**: The planner (LLM) reads the story + codebase and predicts which files will be modified. This is imperfect — the implementation plan in the PRD can also declare files explicitly per story.

### Level 2: Intra-story parallelism (subtask decomposition)

For large stories, the planner can decompose into subtasks:

```typescript
interface Subtask {
  id: string;               // e.g., "LOOP-3.a"
  parentStory: string;      // "LOOP-3"
  description: string;
  files: string[];           // exclusive file lock
  dependsOn: string[];       // subtask IDs
}
```

Each subtask gets its own test→implement chain. A merge gate collects results before review evaluates the whole story.

**When to decompose**: Not every story benefits. The planner should decompose when:
- Story touches 3+ files with independent changes
- Story has clearly separable concerns (e.g., "remove old code" + "add new code" + "wire together")
- Estimated implementation time > 5 minutes

Single-file stories or tightly coupled changes should NOT be decomposed.

### Execution model

```
plan (decompose + schedule)
  ├── story A (group 1) ──→ test → implement → ┐
  ├── story B (group 1) ──→ test → implement → ├── merge gate → review → judge
  │                                             ┘
  └── story C (group 2, depends on A) ──→ [waits] ──→ test → implement → review → judge
```

Each parallel worker runs in a **Docker sandbox** (ADR not yet written, but `docker sandbox run` is available). Each sandbox gets its own clone at the loop branch HEAD. Workers commit to feature branches (`agent-loop/{loopId}/{storyId}` or `agent-loop/{loopId}/{storyId}/{subtaskId}`).

The merge gate:
1. Checks out the main loop branch
2. Merges each worker's branch
3. Runs typecheck + tests on the merged result
4. If merge conflicts exist, falls back to sequential re-implementation of the conflicting subtask

### File-level locks

Extends ADR-0016's claim system to file scope:

```
agent-loop:filelock:{loopId}:{filepath} = {storyId}:{runToken}   NX EX 1800
```

Workers must acquire locks on their declared files before starting. If a lock is held by another story/subtask, the worker waits or the planner reschedules.

### Planner prompt evolution

The planner prompt changes from "pick next story" to:

1. Read all pending stories
2. For each, predict affected files (or read from PRD `files` field)
3. Build dependency graph (file overlap = implicit dependency)
4. Identify parallel groups
5. For stories in current group, optionally decompose into subtasks
6. Emit fan-out events with file assignments and lock instructions

### Event chain changes

```
agent/loop.plan      → emits N × agent/loop.test (one per story/subtask in parallel group)
agent/loop.test      → (unchanged per worker)
agent/loop.implement → (unchanged per worker, but scoped to declared files)
agent/loop.merge     → NEW: collects completed workers, merges branches, runs integration checks
agent/loop.review    → evaluates merged result (whole story, not individual subtasks)
agent/loop.judge     → (unchanged, but evaluates merged diff)
```

### Concurrency changes

Current Inngest concurrency is `key: event.data.project, limit: 1` per function. This must change to:
- Plan: `limit: 1` per loopId (only one planner at a time)
- Test/Implement: `limit: N` per loopId (configurable, default 3)
- Review/Judge: `limit: 1` per loopId (serialized evaluation)
- Merge: `limit: 1` per loopId

## Consequences

* Good, because independent stories execute simultaneously — loop wall-clock time drops proportionally
* Good, because intra-story decomposition handles large stories that currently time out or produce messy single-agent diffs
* Good, because Docker sandboxes provide natural isolation — each worker gets a clean clone
* Good, because file locks make collision explicit and manageable instead of silent
* Bad, because merge conflicts add a new failure mode that doesn't exist in sequential execution
* Bad, because file prediction by LLM is imperfect — wrong predictions cause unnecessary serialization (conservative) or missed conflicts (dangerous)
* Bad, because more moving parts: merge gate, file locks, branch-per-worker, fan-in coordination
* Bad, because subtask decomposition adds planner complexity — the planner now makes more decisions that can be wrong
* Neutral: sequential execution remains the default for stories with overlapping files or explicit dependencies — this is additive, not a rewrite

## Implementation Plan

* **Affected paths**: `plan.ts` (major rewrite — decomposer logic), `utils.ts` (file lock helpers, merge helpers), new `merge.ts` function, `review.ts` and `judge.ts` (evaluate merged diff), Inngest concurrency config
* **Dependencies**: None new. Docker sandbox, git branching, Redis locks all exist.
* **Patterns to follow**: ADR-0016 lease/claim pattern extended to files. swarm-tools decompose pattern for DAG building.
* **Patterns to avoid**: Don't make parallelism mandatory — sequential must remain the default for tightly coupled stories. Don't decompose stories with < 3 files. Don't predict files when the PRD declares them explicitly.

### Prerequisite ADRs

- ADR-0016 (idempotency guards) — claim/lease infrastructure this builds on
- Docker sandbox ADR (not yet written) — isolation model for parallel workers

### Stories (rough)

1. Add `files` field to PRD story schema — optional, planner can predict if not declared
2. Planner builds dependency graph from file overlap
3. Planner emits parallel group fan-out (inter-story)
4. Merge gate function (`agent/loop.merge`) — collect branches, merge, integration test
5. File-level Redis locks in utils.ts
6. Intra-story subtask decomposition (planner prompt + schema)
7. Concurrency config changes for parallel test/implement

### Verification

- [ ] PRD with 2 independent stories (no file overlap) → both execute simultaneously
- [ ] PRD with 2 dependent stories (shared files) → run sequentially
- [ ] Merge gate detects and handles merge conflict gracefully
- [ ] File lock prevents two workers from touching the same file
- [ ] Story with 3+ files decomposes into subtasks that run in parallel
- [ ] Sequential fallback works when all stories share files
- [ ] Wall-clock time for 4-story independent PRD < 2× single-story time

## Alternatives Considered

* **Fan-out without file locks**: Simpler but collision-prone. Two workers editing the same file silently produce conflicts at merge time. File locks make the constraint explicit.
* **Branch-per-story only (no subtask decomposition)**: Simpler, handles inter-story parallelism. But large stories that touch many files remain single-agent bottlenecks. Can start here and add intra-story later.
* **Worker pool model (fixed N workers)**: Instead of event-driven fan-out, maintain a pool of N workers that pull tasks. More complex lifecycle management, doesn't leverage Inngest's native fan-out.

## More Information

- [ADR-0015](0015-loop-architecture-tdd-roles.md) — TDD role separation (the sequential chain this parallelizes)
- [ADR-0016](0016-loop-idempotency-guards.md) — idempotency guards (prerequisite claim/lease infrastructure)
- [ADR-0011](0011-redis-backed-loop-state.md) — Redis state (extended with file lock keys)
- `joelhooks/swarm-tools` — decompose pattern with DAG + file locks + verification gates (credit: studied for planner design)
- Phased rollout: ship inter-story parallelism first (stories 1-4), add intra-story decomposition later (stories 5-6)
