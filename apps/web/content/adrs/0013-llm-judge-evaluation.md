---
title: LLM-powered judge evaluation
status: implemented
date: 2026-02-14
implemented: 2026-02-15
deciders: Joel Hooks
---

# ADR-0013: LLM-Powered Judge Evaluation

## Context and Problem Statement

The judge function (ADR-0005) makes pass/fail decisions based solely on whether typecheck + lint + tests succeed. It has no understanding of whether the implementation actually satisfies the acceptance criteria's intent. This creates failure modes:

1. **Test gaming** — implementor writes code that passes tests without solving the real problem (hardcoded returns, no-op implementations that happen to satisfy weak assertions)
2. **Weak tests** — reviewer writes tests that are too loose, letting bad implementations through
3. **Pattern violations** — implementation works but ignores project conventions (CLAUDE.md, AGENTS.md, existing code style)
4. **Bloat** — 200 lines when 10 would do, unnecessary files, over-engineering

The judge is named "judge" but acts as a gate. A real judge would evaluate the substance of the work.

## Decision

Add an LLM evaluation step to the judge, run after tests pass. The LLM receives:

1. **Acceptance criteria** from the PRD story
2. **Implementation diff** (`git diff` of the implementor's commit)
3. **Reviewer's test file** (what was tested)
4. **Test results** (pass counts, output)
5. **Project instructions** (CLAUDE.md / AGENTS.md excerpts)

### Prompt structure

```
You are a code review judge. Tests have passed. Your job is to determine 
whether the implementation genuinely satisfies the acceptance criteria or 
whether it gamed the tests.

## Acceptance Criteria
{criteria}

## Implementation Diff
{diff}

## Reviewer Tests
{test_file}

## Test Results
{results}

## Project Conventions
{claude_md_excerpt}

Evaluate:
1. Does the diff actually implement what the criteria ask for?
2. Is the implementation honest (not hardcoded, not no-op)?
3. Does it follow project patterns?
4. Is it proportionate (not bloated)?

Output JSON: { "verdict": "pass" | "fail", "reasoning": "..." }
If fail, explain what's wrong so the implementor can fix it.
```

### Flow change

```
Current:  tests pass → PASS
Proposed: tests pass → LLM evaluates → PASS or FAIL with reasoning
```

On LLM verdict `fail`, the judge routes back to implementor with the reasoning as feedback, same as a test failure. The retry ladder and attempt counting work the same.

### Cost control

- LLM judge only runs when tests pass (not on every attempt)
- Use a fast model (claude-haiku or gpt-4o-mini) — this is classification, not generation
- Cap diff size sent to LLM (first 3000 lines, truncate with note)
- Skip LLM judge when `--quick` flag is set (for low-stakes loops)

### Failure modes

- LLM is too strict → false fails, wasted retries. Mitigate with prompt calibration and "when in doubt, pass" instruction.
- LLM is too loose → same as current behavior, no regression
- LLM unavailable → fall back to current test-only gate

## Consequences

### Positive

- Catches test gaming and weak tests
- Catches pattern violations that tests can't express
- Judge feedback is richer than "tests failed" — gives implementor specific direction
- Raises the quality bar without requiring better test writing

### Negative

- Adds 5-15s latency per judgment (LLM call)
- Adds cost per judgment (~$0.01-0.05 per call with fast model)
- LLM may be wrong — false fails cost retries
- Prompt needs calibration per project to avoid over/under strictness

## Follow-up: Transcript Analysis on Rejection

The LLM judge evaluates the *output* (diff vs criteria). But when it rejects, the *process* matters too — why did the agent fail? The session transcript (claude JSONL, codex logs) contains the full reasoning chain: what files it read, what approach it took, where it got confused.

Proposed additional step after rejection:

```
Judge verdict: FAIL
  → step: "analyze-transcript"
  → read implementor's session JSONL (most recent by mtime in ~/.claude/projects/{project}/)
  → LLM extracts: approach taken, files consulted, point of failure, root cause
  → structured diagnosis added to retry feedback
  → next attempt gets: "Previous attempt tried X, failed because Y. Suggestion: Z."
```

This is complementary to the judge, not part of it. The judge evaluates quality; transcript analysis diagnoses process. Together they give retries real guidance instead of raw test output.

Implementation note: the loop should record the session file path at spawn time so the judge/analysis step can find it without scanning by mtime.

## References

- [ADR-0005](0005-durable-multi-agent-coding-loops.md) — judge role definition
- [AgentCoder](https://arxiv.org/abs/2312.13010) — independent test generation (reviewer), complemented by independent evaluation (judge)
- [ADR-0012](0012-planner-generates-prd.md) — planner LLM step (same pattern: adding intelligence to a previously mechanical role)
