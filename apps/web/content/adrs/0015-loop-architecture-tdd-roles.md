---
title: "Loop architecture: TDD flow with separated roles"
status: shipped
date: 2026-02-14
implemented: 2026-02-15
deciders: Joel Hooks
supersedes: ADR-0013
---

# ADR-0015: Loop Architecture — TDD Flow with Separated Roles

## Context and Problem Statement

The current agent loop (ADR-0005) has a backwards flow: implement → write tests → check results. This causes systemic failures:

1. **Blind test writing** — The reviewer writes tests from acceptance criteria without seeing the implementation. Tests assume specific signatures, mock patterns, and internal structure that the implementor didn't produce.
2. **Rubber-stamp judge** — The judge checks `testsFailed === 0 && typecheckOk`. That's a CI gate, not a judge. It can't detect test gaming, stubs, or intent violations.
3. **Role overload** — The reviewer is simultaneously test writer, test runner, and evaluator. Three jobs, one agent, no separation of concerns.
4. **Two agents coordinating through a keyhole** — The implementor and reviewer must agree on implementation details without sharing context. This is the core failure mode.

Evidence: In the ADR-0013 loop (judge-v3), JUDGE-3 ("Wire llmEvaluate into judge.ts") failed all 3 attempts because the reviewer kept writing tests that assumed internal structure the implementor didn't produce. JUDGE-1 and JUDGE-2 passed only after retries.

## Decision

Restructure the loop into five distinct roles with a TDD flow.

### Roles

| Role | Input | Output | Does NOT do |
|------|-------|--------|-------------|
| **Planner** | ADR + context files | PRD (stories + acceptance criteria) | Write code or tests |
| **Test Writer** | ADR + PRD story | Minimal acceptance test suite | Implement anything |
| **Implementor** | Test files + story + feedback | Code that passes the tests | Write or modify tests |
| **Reviewer** | Diff + tests + test results | 4-question evaluation notes | Make pass/fail decision |
| **Judge** | All notes + evidence | Pass/fail with reasoning | Write code or tests |

### Flow

```
plan → test → implement → review → judge
                ↑                    |
                └── retry (on fail) ─┘
```

### Test Writer

Writes the acceptance test suite BEFORE implementation. This is TDD — tests are the spec. The test writer:

- Reads the ADR and PRD story (acceptance criteria)
- Writes minimal tests that capture **intent and outcomes**, not implementation details
- Tests should verify observable behavior, not internal structure
- Commits test files before implementation begins

### Implementor

Receives the test files as input. Writes code to make them pass. This is standard TDD — the tests already exist, the implementor's job is to satisfy them. On retry, receives feedback from the reviewer/judge about what's wrong.

### Reviewer

Does NOT write tests or run them (the harness does that). Instead, evaluates the implementation by answering four questions:

1. **Are there new tests?** — Did the test writer actually produce test files?
2. **Do tests test real implementations?** — Not stubs, not `expect(true).toBe(true)`
3. **Are tests truthful?** — Not gaming (hardcoded returns, no-op implementations)
4. **Does test + implementation accomplish the story intent?** — Maps back to ADR acceptance criteria

Outputs structured notes with evidence for each question.

### Judge

Receives: reviewer notes, test results, implementation diff, acceptance criteria, ADR context. Compares all evidence and makes a final pass/fail with specific reasoning. This is the only role that makes the verdict.

The judge does NOT rubber-stamp test results. A passing test suite with a stub implementation is a FAIL. A passing test suite with honest code that doesn't match the ADR intent is a FAIL.

### Event Chain

```
agent/loop.plan      → picks next story, emits test
agent/loop.test      → writes acceptance tests, commits, emits implement
agent/loop.implement → writes code, commits, emits review
agent/loop.review    → evaluates 4 questions, emits judge
agent/loop.judge     → pass/fail verdict, emits plan (next story) or implement (retry)
```

### Retry Behavior

On judge FAIL:
- Feedback flows to implementor (not test writer — tests are the stable spec)
- Retry ladder: codex → claude → codex (configurable)
- If same tests fail 3 times with same pattern, flag for human review
- Judge can recommend "rewrite tests" if tests themselves are the problem (escalation, not default)

## Consequences

### Positive

- TDD flow means implementor always has a concrete target
- No blind coordination between agents — tests are the shared contract
- Reviewer evaluates quality instead of generating artifacts
- Judge has structured evidence (reviewer notes) instead of just pass/fail counts
- Each role has one job — easier to debug, easier to improve individually

### Negative

- One more step per story (test writer) — adds ~60-90s per story
- Test writer can still write bad tests — but now that's a single point of failure we can fix, not a distributed coordination problem
- More Inngest functions to maintain

## Implementation Stories

### LOOP-1: Add test writer function
Create `agent/loop.test` Inngest function. Receives story + ADR context. Spawns tool (claude/codex) with prompt to write acceptance tests from criteria. Commits test files. Emits `agent/loop.implement`.

### LOOP-2: Restructure event chain
Change plan.ts to emit `agent/loop.test` instead of `agent/loop.implement`. Change implement.ts to emit `agent/loop.review` (no change). Change review.ts to be evaluation-only (no test writing). Change judge.ts to consume reviewer notes.

### LOOP-3: Reviewer evaluation prompt
Replace the test-writing prompt in review.ts with a 4-question evaluation prompt. Reviewer reads diff, test files, test results, and answers: (1) new tests exist? (2) substantive? (3) truthful? (4) intent satisfied? Outputs structured JSON notes.

### LOOP-4: Judge consumes reviewer notes
Update judge.ts to receive reviewer evaluation notes. LLM judge compares reviewer notes + test results + diff against acceptance criteria. Produces verdict with specific reasoning referencing the reviewer's findings.

### LOOP-5: Wire llmEvaluate into judge with reviewer notes
Integrate the llmEvaluate helper (from JUDGE-1/JUDGE-2, already landed) into the new judge flow. Pass reviewer notes as additional context to the LLM evaluation prompt.

## References

- [ADR-0005](0005-durable-multi-agent-coding-loops.md) — original loop architecture
- [ADR-0013](0013-llm-judge-evaluation.md) — LLM judge (superseded by this ADR's broader restructuring)
- [AgentCoder](https://arxiv.org/abs/2312.13010) — independent test generation insight (kept: test writer is independent; changed: tests come BEFORE implementation)
