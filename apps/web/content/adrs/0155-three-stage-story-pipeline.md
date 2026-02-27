---
number: "155"
title: "Three-Stage Story Pipeline: Implement → Prove → Judge"
status: proposed
date: 2026-02-27
tags: [agent-loop, codex, inngest, pipeline]
supersedes: []
related:
  - "ADR-0154: Content Migration MDX to Convex"
  - "ADR-0106: Content Review Pipeline"
---

# ADR-0155: Three-Stage Story Pipeline

## Status

proposed

## Context

The existing agent-loop infrastructure (`packages/system-bus/src/inngest/functions/agent-loop/`) accumulated jank: 500+ line files, Docker sandbox management, Claude auth wrangling, retry ladders, shared state between stages, tool ranking systems. Stories frequently skip or fail due to infrastructure complexity rather than code problems.

Joel wants a clean pipeline: three independent codex calls per story, each starting fresh with no shared state except the git repo.

## Decision

Replace the multi-file agent-loop with a single Inngest function `agent/story.pipeline` that runs three stages per story:

### Stage 1: Implement

Fresh `codex exec` receives:
- Story description and acceptance criteria from PRD
- Repo context (path, test/typecheck commands)
- Any judgment from a previous failed attempt

Codex implements the feature and commits.

### Stage 2: Prove

Fresh `codex exec` receives:
- The story's acceptance criteria
- Instruction to verify the implementation: run tests, check types, lint, manually inspect behavior
- Permission to fix obvious issues and commit fixes
- Must produce a proof-of-work summary

### Stage 3: Judge

Fresh `codex exec` receives:
- The story's acceptance criteria
- The diff since before Stage 1
- The proof-of-work from Stage 2
- Instruction to pass or fail with specific reasoning

**Pass** → story marked complete, next story starts.
**Fail** → judgment written, story sent back to Stage 1 with the judgment as context. Max 3 attempts before marking as blocked.

### Architecture

```
agent/story.start event
  → agent/story.pipeline function
    → step.run("implement") — codex exec
    → step.run("prove")     — codex exec  
    → step.run("judge")     — codex exec
    → if pass: step.sendEvent("agent/story.start", next story)
    → if fail: step.sendEvent("agent/story.start", same story + judgment)
```

Single file. No Docker sandbox. No retry ladders. No tool rankings. No Claude auth. Just codex exec with good prompts.

### PRD Format

Same JSON format as existing PRDs. Stories have `id`, `title`, `description`, `acceptance_criteria`, `priority`, `depends_on`. The pipeline reads the PRD, picks the next uncompleted story by priority respecting dependencies, and runs it.

### State

- PRD stored in Redis (key: `story-pipeline:{prdId}`) with story statuses
- Each story tracks: `status` (pending/implementing/proving/judging/done/blocked), `attempts`, `lastJudgment`
- No filesystem state files, no progress.txt, no .out files

## Consequences

**Good:**
- Simple — one file, three codex calls, clear prompts
- Observable — each step is an Inngest step with full trace
- Restartable — Inngest handles retries per step
- No infrastructure baggage from old loop
- Fresh codex per stage means no accumulated context/confusion

**Bad:**
- No Docker sandbox isolation (codex runs in workspace)
- No retry ladder across tools (codex only, no Claude/pi fallback)
- Three codex calls per story = 3x the API cost vs single-pass

**Acceptable because:**
- Codex sandbox mode (workspace-write) provides sufficient isolation
- If codex can't do it, the story is probably underspecified — fix the PRD
- Cost is negligible vs quality improvement from independent verification
