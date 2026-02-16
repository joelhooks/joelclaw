---
title: Planner generates PRD from goal
status: implemented
date: 2026-02-14
implemented: 2026-02-15
deciders: Joel Hooks
---

# ADR-0012: Planner Generates PRD from Goal

## Context and Problem Statement

The agent loop requires a hand-crafted `prd.json` before it can start. Writing PRDs is the bottleneck — each one requires understanding the codebase, scoping stories to be small enough for a single tool invocation, writing testable acceptance criteria, and formatting as JSON. This takes 10-30 minutes of human effort per loop.

The planner function (ADR-0005) currently does no thinking. It reads the PRD from Redis, finds the next unpassed story, and dispatches. It completes in under a second. Meanwhile, the human is doing the hard cognitive work of decomposition and scoping — exactly the kind of work an LLM is good at.

## Decision

Add an optional `goal` field to the `agent/loop.start` event. When `goal` is present and `prdPath` is absent, the planner spawns an LLM to generate the PRD before dispatching.

### Event schema change

```typescript
"agent/loop.start": {
  data: {
    loopId: string;
    project: string;
    // Existing: read PRD from file
    prdPath?: string;
    // New: generate PRD from goal
    goal?: string;
    context?: string[];  // file paths to read as input (ADRs, docs, issues)
    maxStories?: number; // cap generated stories (default: 6)
    // ... existing fields unchanged
  }
}
```

### Planner flow

```
goal provided?
  ├─ yes → step: "generate-prd"
  │         - read CLAUDE.md, project structure, context files
  │         - spawn claude with goal + context
  │         - parse output as PRD JSON
  │         - seed to Redis
  │         - continue to story dispatch
  │
  └─ no → existing flow (read prdPath, seed to Redis)
```

### CLI

```bash
# New: goal-driven
igs loop start -p ~/Code/project \
  --goal "add Redis client module with typed helpers" \
  --context ~/Vault/docs/decisions/0011-redis-backed-loop-state.md

# Existing: file-driven (still works)
igs loop start -p ~/Code/project --prd prd.json
```

### PRD generation prompt

The planner prompt instructs the LLM to:

- Read the goal and context files
- Examine the project structure (package.json, src/ layout, existing tests)
- Generate 3-6 small stories with IDs, titles, descriptions, acceptance criteria
- Each story should be completable by a single tool invocation (codex/claude)
- Acceptance criteria must be verifiable by typecheck + tests
- Output valid JSON matching the existing PRD schema

### Guardrails

- `maxStories` caps generation (default 6, hard max 10)
- Generated PRD is logged to progress.txt for human review
- If generation fails, the loop stops with a clear error — no silent fallback
- Human can still provide `prdPath` to bypass generation entirely

## Consequences

### Positive

- Loop startup goes from 10-30 min human effort to a one-liner
- Goals can reference ADRs, issues, or docs as context — the LLM does the decomposition
- Planner becomes the "thinking" step it was always named for

### Negative

- LLM-generated stories may be poorly scoped, causing more retries
- Adds ~30-60s to loop start for the generation step
- Generated acceptance criteria may not be as precise as hand-crafted ones

### Mitigations

- Start with claude (best at structured output) for generation
- Include examples of good PRDs in the prompt (few-shot)
- Keep `prdPath` as an escape hatch for cases where human-crafted PRDs are better

## References

- [ADR-0005](0005-durable-multi-agent-coding-loops.md) — planner role definition
- [ADR-0011](0011-redis-backed-loop-state.md) — Redis PRD storage (generated PRDs seed the same way)
