---
title: Friction auto-fix — bias towards action
status: accepted
accepted: 2026-02-19
date: 2026-02-19
deciders: Joel Hooks
consulted: Claude (pi session 2026-02-19)
informed: All agents operating on this machine
related:
  - "[ADR-0021 — Comprehensive agent memory system](0021-comprehensive-agent-memory-system.md)"
  - "[ADR-0026 — Background agent dispatch](0026-background-agent-dispatch.md)"
---

# ADR-0065: Friction Auto-Fix — Bias Towards Action

## Context and Problem Statement

ADR-0021 Phase 4 (Friction) detects recurring friction patterns from Qdrant observations and creates Todoist tasks for Joel to review. The pipeline works — 10 patterns detected on first successful run — but it only **reports**. Joel must manually read each pattern, decide what to do, and either fix it himself or ask an agent.

This violates the system's core "bias towards action" / "can I JFDI?" ethos: no human should be in the loop for improvements the system can make autonomously.

## Decision

Friction patterns trigger **autonomous fix attempts** via background agents. Every fix is committed on a named branch, merged with `--no-ff` (single revert target), and Joel is notified via gateway with the commit SHA and revert command.

### Pipeline

```
friction analysis → N patterns
  → for each pattern:
    → create branch friction-fix/{patternId}
    → dispatch codex agent with focused prompt
    → verify commits exist
    → merge --no-ff to main (single revert target)
    → notify gateway: "Fixed: {title}. Revert: git revert {sha}"
    → comment + complete Todoist task
```

### Revertability contract

Every friction fix MUST be revertable with a single `git revert {sha}`. This is enforced by:
- Each fix on its own branch
- `--no-ff` merge creates one merge commit regardless of how many commits the agent made
- Gateway notification always includes the revert command
- Todoist task comment records the SHA

### What agents can and cannot fix

Agents attempt ALL friction patterns. Not all are code-fixable — some are process issues, some require Joel's judgment. The agent is instructed to:
- Make minimal, focused changes for automatable fixes → status: `fixed`
- Document the issue in code comments if unsure → status: `documented`
- Report inability to fix if the pattern is purely procedural → status: `skipped`

### Flow control

- Concurrency: 1 (one fix at a time, prevents conflicts)
- Throttle: inherits from friction analysis (daily cron or manual)
- Fan-out: each pattern gets its own `memory/friction.fix.requested` event

## Consequences

**Good:**
- System self-improves daily without human intervention
- Joel is always informed, never blocked
- Every change is one `git revert` away from undone
- Friction patterns that keep recurring despite fixes signal deeper architectural issues

**Risks:**
- Agent may make incorrect fixes → mitigated by revertability + gateway notification
- Multiple fixes in one day could conflict → mitigated by concurrency: 1, sequential execution
- Agent may not understand the codebase well enough → mitigated by focused prompts with evidence, typecheck before commit

**Neutral:**
- Todoist tasks become records of what was fixed, not approval gates
- Gateway becomes the primary notification channel for friction fixes
