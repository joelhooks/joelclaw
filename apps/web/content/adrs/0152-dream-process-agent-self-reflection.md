---
status: proposed
date: 2026-02-26
deciders: Joel Hooks
consulted: Claude (pi session 2026-02-26)
informed: All agents operating on this machine
credit: Sean Grove
related:
  - "[ADR-0021 — Comprehensive agent memory system](0021-agent-memory-system.md)"
  - "[ADR-0065 — Friction auto-fix](0065-friction-auto-fix.md)"
  - "[ADR-0094 — Memory write gate](0094-memory-write-gate-soft-llm.md)"
  - "[ADR-0020 — Observational memory pipeline (superseded)](0020-observational-memory-pipeline.md)"
---

# ADR-0152: Dream Process — Agent Self-Reflection Loop

## Context and Problem Statement

The system currently has two feedback mechanisms:

1. **Observational memory** (ADR-0021) — extracts facts and observations from conversations, stores them in Qdrant. Records *what happened*.
2. **Friction auto-fix** (ADR-0065) — detects recurring friction patterns and dispatches background agents to fix them. Patches *code*.

Neither captures **meta-patterns about how the system itself operates**. The memory pipeline records "Joel prefers X" but not "the agent keeps making the same mistake in context Y." Friction auto-fix patches code but doesn't update the behavioral instructions (SOUL.md, AGENTS.md, skills) that shape how agents approach problems.

Sean Grove's insight: the system should have a "dream process" — a periodic self-reflection loop where the agent reviews its own interactions, identifies what worked and what didn't, and feeds prescriptive behavioral changes back into itself. Not recording facts. Changing how it thinks.

### What exists today

| Layer | Records | Changes |
|-------|---------|---------|
| Memory (ADR-0021) | Facts, preferences, state | Qdrant observations |
| Friction (ADR-0065) | Recurring code problems | Git commits on branches |
| **Dream (this ADR)** | **Meta-patterns, behavioral failures** | **Skills, SOUL.md, AGENTS.md, prompts** |

## Decision

### Dream process overview

A durable Inngest function runs on two triggers:

1. **Post-session** (`session/completed` event) — immediate reflection on what just happened
2. **Daily cron** (e.g., 6 AM) — pattern analysis across the day's sessions, OTEL events, slog entries, and loop outcomes

Each trigger runs a different reflection pass:

**Post-session reflection** (fast, narrow):
- Input: session transcript + OTEL telemetry for that session
- Question: "What went well? What went wrong? What should change?"
- Output: immediate behavioral amendment candidates

**Daily reflection** (slow, broad):
- Input: all sessions from the past 24 hours, OTEL event stats, slog entries, loop outcomes, friction patterns
- Question: "What meta-patterns emerge? What systemic improvements would make tomorrow better than today?"
- Output: strategic behavioral amendment candidates

### Output types

The dream process produces **prescriptive changes**, not observations:

| Output | Target | Risk | Gate |
|--------|--------|------|------|
| New MEMORY.md observation | `~/.joelclaw/workspace/memory/MEMORY.md` | Low | Auto-apply |
| SOUL.md behavioral amendment | `~/.joelclaw/SOUL.md` | Medium | Auto-apply, notify Joel |
| Skill update (existing) | `~/Code/joelhooks/joelclaw/skills/*/SKILL.md` | Medium | Auto-apply on branch, notify Joel |
| New skill proposal | `skills/` | High | Propose only, Joel approves |
| AGENTS.md rule change | `~/.pi/agent/AGENTS.md` | High | Propose only, Joel approves |
| Prompt pattern change | Various | High | Propose only, Joel approves |

### Risk gates

Low-risk changes (MEMORY.md observations) auto-apply — same as current memory pipeline.

Medium-risk changes (SOUL.md, existing skills) auto-apply but notify Joel via gateway with a diff and one-command revert: `git revert <sha>`.

High-risk changes (AGENTS.md, new skills, prompt patterns) are proposals only — written to a staging area (`~/.joelclaw/workspace/dream/proposals/`) and surfaced to Joel for approval. This follows the same pattern as ADR-0094's memory write gate.

### Reflection prompt structure

```
You are reviewing your own performance. You have access to:
- Session transcript(s)
- OTEL telemetry (latencies, errors, model usage)
- Slog entries (infrastructure changes)
- Loop outcomes (stories completed/failed/skipped)
- Current SOUL.md, AGENTS.md, and active skills

Questions:
1. Where did you waste Joel's time? (unnecessary clarification, wrong approach, slow response)
2. Where did you make the same mistake twice? (pattern, not incident)
3. What knowledge did you lack that you should have had? (missing skill, stale context)
4. What worked exceptionally well? (preserve and amplify)
5. What behavioral rule would have prevented today's problems?
6. What behavioral rule is no longer useful and should be pruned?

For each finding, output ONE of:
- OBSERVATION: {fact to record in MEMORY.md}
- AMEND_SOUL: {specific line to add/change in SOUL.md, with reasoning}
- AMEND_SKILL: {skill name, specific change, reasoning}
- PROPOSE_SKILL: {new skill name, description, why it's needed}
- PROPOSE_RULE: {AGENTS.md rule, reasoning}
- PRUNE: {existing rule/skill to remove, reasoning}
- NO_ACTION: {finding noted, no change needed yet, reasoning}
```

### Implementation

**Inngest function**: `packages/system-bus/src/inngest/functions/dream-reflect.ts`

Triggers:
- Event: `session/completed` (post-session pass)
- Cron: `0 6 * * *` (daily pass)

Steps:
1. `gather-context` — collect inputs (transcripts, OTEL, slog, loop data)
2. `reflect` — LLM reflection pass using the prompt structure above
3. `classify-outputs` — parse reflection into typed output actions
4. `apply-low-risk` — auto-apply MEMORY.md observations
5. `apply-medium-risk` — auto-apply SOUL.md/skill changes, commit on branch, notify gateway
6. `stage-high-risk` — write proposals to staging, notify gateway

### What the dream process does NOT do

- **Write application code** — that's friction auto-fix's job (ADR-0065)
- **Modify infrastructure** — no k8s changes, no service restarts
- **Override Joel's explicit decisions** — if Joel said "do X," dream process doesn't auto-change to "do Y"
- **Run without telemetry** — every dream cycle emits OTEL events for observability
- **Hallucinate improvements** — findings must cite specific session/event evidence

## Consequences

### Positive

- System behavior improves continuously without Joel manually updating config files
- Meta-patterns (repeated mistakes, stale context) get caught and fixed
- Skills stay current automatically — the "always keep skills updated" value becomes self-enforcing
- Gateway notification on medium-risk changes keeps Joel informed without blocking
- Append-only dream log provides evidence for what changed and why

### Negative

- LLM reflection costs tokens — need budget awareness per ADR-0096 patterns
- Bad reflections could degrade behavior — risk gates mitigate but don't eliminate
- Post-session trigger adds latency to session cleanup path

### Follow-ups

- [ ] Implement `dream-reflect.ts` Inngest function
- [ ] Add `session/completed` event emission to session lifecycle
- [ ] Create `~/.joelclaw/workspace/dream/proposals/` staging directory
- [ ] Create `~/.joelclaw/workspace/dream/log.jsonl` for dream cycle audit trail
- [ ] Add dream cycle metrics to `joelclaw otel stats`
- [ ] After 7 days: review dream log, assess quality of auto-applied changes
- [ ] After 30 days: review proposal acceptance rate, tune risk gates

## Verification

- [ ] Dream process runs on cron trigger, produces ≥1 output per cycle
- [ ] Post-session reflection fires within 5 minutes of session end
- [ ] Low-risk outputs auto-apply to MEMORY.md
- [ ] Medium-risk outputs commit on branch with gateway notification
- [ ] High-risk outputs appear in proposals directory, not auto-applied
- [ ] OTEL events emitted for each dream cycle
- [ ] Dream log is append-only and queryable
- [ ] After 7 days: ≥3 actionable self-improvements produced
- [ ] After 7 days: ≥1 improvement measurably helps agent performance
