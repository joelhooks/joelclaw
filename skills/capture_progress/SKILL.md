---
name: capture_progress
displayName: Capture Progress
description: Turn ephemeral discussion into durable truth in the right artifact. Use when Joel says "capture this", "note this", "write this down", "make this durable", "put this in the doc", or whenever a conversation conclusion should be preserved in project docs, launch plans, lat.md, ADRs, tasks, or memory.
version: 0.1.0
author: joel
tags:
  - meta
  - documentation
  - memory
  - workflow
---

# Capture Progress

Use this skill when the job is not to keep talking, but to preserve progress.

"Capture this" does **not** mean "spray raw notes somewhere." It means: take what was learned or decided, choose the canonical artifact, sharpen the wording, and make it durable.

The output should be easy to find later and useful to another agent or operator who was not present for the conversation.

## What counts as capture

Capture means converting transient conversation into one or more of:

- project truth in a working doc (`launch-plan.md`, README, runbook, spec)
- repo truth in `lat.md/`, `AGENTS.md`, or a project ADR
- system truth in joelclaw memory when the learning is cross-project and durable
- actionable follow-up in a task system when the result is "someone needs to do X later"
- operator-facing summary when the important thing is a decision, not the whole thread

Do **not** confuse capture with journaling. Capture keeps the signal and throws away the sludge.

## When to use

Trigger phrases:
- "capture this"
- "note this"
- "write this down"
- "make this durable"
- "put this in the doc"
- "this is the framing"
- "let's lock this in"
- "save that"
- "that should be in the plan"

Use proactively when:
- the user resolves an ambiguity
- a product/launch framing clicks into place
- a decision changes how future agents should reason
- a discussion produces wording good enough for the real artifact
- a repeated explanation should stop living only in chat

## The decision tree

Before writing anything, decide what kind of truth this is.

### 1. Is this project-specific and immediately actionable?
Write it into the project artifact.

Examples:
- launch messaging → `launch-plan.md`
- repo operating model → `AGENTS.md`
- project state/intent → `lat.md/*`
- implementation plan → spec/PRD/runbook in the repo

### 2. Does this change how agents should reason about the repo?
Capture it in repo truth.

Typical targets:
- `AGENTS.md`
- `lat.md/`
- ADR if the decision is durable, structural, or should act as a tie-breaker later

### 3. Is this cross-project and durable beyond the current repo?
Write it to joelclaw memory.

Good memory captures:
- preferences
- system patterns
- gotchas
- reusable operational rules

Bad memory captures:
- local draft copy
- temporary brainstorms
- raw transcript fragments

### 4. Is the result mainly a next action rather than a truth artifact?
Create or update the task, not just the docs.

### 5. Is the user really asking for wording capture?
Preserve the meaning, but rewrite for clarity.

Do not dump spoken-language filler into the canonical doc. Compress it into clean language while preserving the user's intent and voice.

## The capture workflow

1. **Identify the canonical home**
   - Ask: where should future-me look for this?
   - Prefer the existing project truth surface over inventing a new file.

2. **Extract the actual signal**
   - What changed?
   - What is now true?
   - What decision or framing should survive?

3. **Sharpen the language**
   - remove filler
   - keep the concrete claim
   - keep memorable lines when they help
   - make it legible to someone who missed the conversation

4. **Write it to the artifact**
   - update the existing section when possible
   - create a new section only when needed
   - if the change is repo-structural, add/update an ADR

5. **Update nearby truth surfaces when required**
   - if the launch doc changes the repo framing, mirror that in `lat.md`
   - if the repo operating model changes, update `AGENTS.md`
   - if the system learns a durable pattern, write memory

6. **Verify**
   - run the repo-local checks (`lat check`, tests, etc.) when the capture surface requires it
   - read back the changed section mentally: will future-you understand it in 10 seconds?

7. **Commit when files changed**
   - durable capture in tracked files should land in git

## Capture quality bar

A good capture is:
- in the right place
- short enough to scan
- precise enough to act on
- written as present truth, not conversational residue
- useful without the surrounding chat log

A bad capture is:
- raw transcript pasted into docs
- duplicated in five places
- too vague to drive action
- stored in memory when it belonged in the project doc
- stored in a project doc when it was actually a system-wide pattern

## Preferred targets by situation

### Product / launch framing
Prefer:
- current plan doc
- `lat.md/launch.md`
- `AGENTS.md` if it changes the repo's operating model

### Repo operating model
Prefer:
- `AGENTS.md`
- `lat.md/project.md`
- ADR if the change is durable and architectural

### System/process learning
Prefer:
- joelclaw memory
- skill update if it is repeatable process knowledge
- ADR if it changes architecture or canonical policy

### Good wording generated in conversation
Prefer:
- the live artifact that will actually be shipped
- not a side note about the artifact

## Rules

- Prefer **one canonical home** over duplicates.
- If the truth changes repo behavior, update the repo artifact, not just memory.
- If the truth changes system behavior, update the skill or ADR, not just the daily log.
- Keep the user's meaning; improve the wording.
- Do not create new files just because you can. Extend the existing truth surface first.
- If the user says "capture this" and the right destination is ambiguous, resolve the ambiguity quickly instead of silently choosing a bad home.
- If you changed tracked files, commit them.

## Examples

### Example: launch framing
User: "On YouTube, you watch Antonio code. In the workshop, you learn how to code like Antonio."

Capture:
- add the phrasing to `launch-plan.md`
- mirror the durable positioning into `lat.md/launch.md`
- commit

### Example: repo priority change
User: "The point of this repo is to get the launch doc shipped."

Capture:
- update `AGENTS.md`
- update `lat.md/project.md`
- add ADR if this is a durable repo-level tie-breaker
- commit

### Example: cross-project preference
User: "capture this means make it durable, not just noted"

Capture:
- add or update the `capture_progress` skill
- optionally write memory if the pattern should be globally recalled
- commit
