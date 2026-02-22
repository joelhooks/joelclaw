---
status: shipped
date: 2026-02-19
deciders: joel
consulted: []
informed: []
supersedes: []
---

# ADR-0068: Memory Proposal Auto-Triage Pipeline

## Context

The memory reflection pipeline (ADR-0021) generates proposals from session observations and queues them for human review. In practice, this creates an unbounded backlog (88+ pending) that never gets reviewed because:

- Most proposals are factual observations that don't need human judgment
- Many are duplicates across sessions (same insight observed 3+ times)
- Instruction-text artifacts leak into proposals ("Add after...", "Replace...")
- No priority signal — trivial version bumps sit next to critical debugging insights
- Review is one-at-a-time via `joelclaw review` — tedious, low-value

The result: proposals accumulate, nothing gets promoted, MEMORY.md stagnates, and the system learns nothing from its own observations.

## Decision

Replace the flat review queue with a three-tier auto-triage pipeline:

### Tier 1: Auto-Action (no human needed)

**Auto-promote** when ALL of:
- Contains a date reference (factual, timestamped)
- References a specific tool, file, command, or config
- Does not conflict with an existing MEMORY.md entry (embedding similarity < 0.85)
- Is not a preference/opinion statement

Examples: tool installed, config changed, bug found + fix documented, new service deployed.

**Auto-reject** when ANY of:
- >85% embedding similarity to existing MEMORY.md entry (duplicate)
- >85% similarity to another pending proposal (dedup)
- Content starts with instruction text ("Add after", "Replace", "Expand", "Consolidate")
- References a superseded ADR or removed tool
- Is a raw `- (YYYY-MM-DD)` line (leaked format)

**Auto-merge** when:
- 2+ proposals target the same MEMORY.md section with overlapping content
- Keep the most comprehensive version, discard others

### Tier 2: Batched Human Review (weekly)

Proposals that survive Tier 1 but aren't auto-promotable:
- Preference changes ("Joel wants X instead of Y")
- Architectural opinions
- New conventions or hard rules
- Anything ambiguous

Presented as a batch (5-10 items) via gateway digest:
- Grouped by MEMORY.md section
- Each has a recommendation (promote/reject) with reasoning
- Joel confirms or overrides per-item
- 2-minute weekly task, not 20-minute daily grind

### Tier 3: MEMORY.md Hygiene (monthly)

- Flag entries referencing old tool versions, completed projects, or superseded ADRs
- Propose removals/updates as a batch
- Prevents MEMORY.md from growing unbounded

### Weekly Digest

Gateway message every Monday:
```
Memory Triage: 12 auto-promoted, 8 auto-rejected, 3 merged, 5 need your call:
1. [Conventions] "Repos should use X pattern" — recommend: promote
2. [Hard Rules] "Never do Y in Z context" — recommend: promote
3. [Joel] "Prefers A over B" — recommend: review (new preference)
4. [Patterns] "Z pattern works for W" — recommend: reject (already covered)
5. [System Architecture] "Service X moved to Y" — recommend: promote
```

### Implementation

1. New Inngest function `memory/proposal-triage` triggered by `memory/proposal.created`
2. Runs embedding similarity against MEMORY.md entries (Qdrant `memory_observations`)
3. Classifies into auto-promote / auto-reject / auto-merge / needs-review
4. Auto-actions execute immediately with audit log
5. Needs-review proposals accumulate for weekly digest
6. `joelclaw review` updated to show batched, grouped proposals with recommendations
7. Weekly cron `memory/digest.triage` sends the summary via gateway

### Backlog Cleanup

Run the 88 pending proposals through the same triage on deploy. Expected outcome: ~50 auto-rejected (duplicates + instruction text), ~25 auto-promoted (factual observations), ~13 needing actual review.

## Consequences

- MEMORY.md stays current without human bottleneck
- Proposals stop accumulating — the queue drains itself
- Joel only sees genuinely ambiguous items (5-10/week)
- Embedding similarity requires Qdrant `memory_observations` to have indexed MEMORY.md entries (Phase 5 dependency, can use text similarity as fallback)
- Risk: auto-promote writes something wrong. Mitigation: git history on ~/Vault, weekly digest shows what was auto-promoted for spot-checking.
