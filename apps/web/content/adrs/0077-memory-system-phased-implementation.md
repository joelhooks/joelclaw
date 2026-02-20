---
status: proposed
date: 2026-02-20
decision-makers: ["@joelhooks"]
consulted: []
informed: []
---

# ADR-0077: Memory System Phased Implementation — 31 Pieces in Strict Order

## Status

proposed

## Context

Building a production-grade agent memory system requires extreme discipline in implementation order. The full system contains 31 distinct pieces split into 3 phases. Each phase must be completely stable before moving to the next, or later phases will amplify earlier flaws rather than add intelligence.

This ADR supersedes ADR-0077, ADR-0078, and ADR-0079 by reorganizing the same concepts into a strict phased approach with clear phase gates.

## Decision

We will implement the agent memory system in exactly 3 phases, with mandatory stability testing between each phase.

### Phase 1: Core Functionality (10 pieces) — "Memory that actually works"

**This is the minimum viable memory system:**

1. **Write Pipeline** — Extract facts from conversations, validate, store
2. **Read Pipeline** — Query rewriting, retrieval, scoring, injection
3. **Score Decay** — Time-based relevance decay (`exp(-0.01 * days_since_created)`)
4. **Session Flush** — End of every session, flush working memory to storage
5. **Behavior Loop** — Capture corrections/preferences as lessons, load on session start
6. **Categories** — Work, health, preferences summaries, auto-updated
7. **Strength Tags** — EXPLICIT, IMPLIED, INFERRED confidence levels
8. **Sentiment Tags** — Emotional context when facts were stated
9. **Inject Limit** — Hard cap of 10 memories per turn
10. **Trust Pass** — Basic validation, confidence thresholds, conflict detection

**Phase 1 Exit Criteria:**
- [ ] Can store facts from conversations
- [ ] Can retrieve relevant facts based on context
- [ ] Facts decay appropriately over time
- [ ] No data loss between sessions
- [ ] User corrections improve future behavior
- [ ] 95%+ unit test coverage
- [ ] 7 days of stable operation

### Phase 2: Reliability & Durability (7 pieces) — "Memory that survives"

**Makes the system production-ready:**

11. **Checkpoint/Crash Recovery** — Serialize state after each turn, replay from checkpoint
12. **Audit Trail** — Append-only resource table, all extractions reference source
13. **Deduplication** — Cosine similarity > 0.85 merges items, preserves best wording
14. **Conflict Resolution** — When facts contradict, surface higher confidence + flag both
15. **Nightly Maintenance** — Merge similar items, boost accessed items, extract missed resources
16. **Weekly Maintenance** — Regenerate summaries, archive old items, cluster insights
17. **Cron Fallback** — Check job timestamps on heartbeat, run if overdue

**Phase 2 Exit Criteria:**
- [ ] System recovers from crashes without data loss
- [ ] Full audit trail from source to extraction
- [ ] No duplicate facts in storage
- [ ] Conflicts handled gracefully
- [ ] Maintenance jobs run reliably
- [ ] 30 days stable operation
- [ ] Load tested to 10x expected volume

### Phase 3: Intelligence Layer (14 pieces) — "The ceiling"

**Advanced intelligence features:**

18. **Rewrite Query** — LLM rewrites user queries for better retrieval
19. **Tiered Search** — Category summaries first, vector search fallback
20. **Dual Search** — Parallel vector similarity + knowledge graph traversal
21. **Episodes** — Group related conversations, treat as semantic units
22. **Episode Search** — Query across episode boundaries with context
23. **Trust Scoring** — Confidence decay, source verification, cross-validation
24. **Echo/Fizzle** — Track which injected memories get used, adjust priorities
25. **Cross-Agent Sharing** — SharedMemory API, domain relevance filters
26. **Memory Agent** — Dedicated class owning all memory operations
27. **Forward Triggers** — Detect temporal references, preload future context
28. **Budget-Aware** — Reduce operations under cost constraints
29. **Domain TTLs** — Per-category retention (work: 90d, health: 365d, etc.)
30. **Monthly Reindexing** — Update embeddings, rebuild indices, cold archive
31. **Knowledge Graphs** — Entity relationships, graph-based retrieval

**Phase 3 Exit Criteria:**
- [ ] Measurable improvement in retrieval quality
- [ ] Cross-agent memory sharing operational
- [ ] Cost per query optimized and tracked
- [ ] Knowledge graph improves fact connections
- [ ] 90 days stable operation
- [ ] User satisfaction metrics improved

## Critical Implementation Rules

1. **Never skip phases** — Phase 3 on unstable Phase 1 just amplifies garbage
2. **Test phase gates** — Each phase must pass ALL exit criteria before proceeding
3. **Fix forward only** — If Phase 1 breaks while building Phase 2, stop and fix Phase 1 first
4. **Measure everything** — Latency, accuracy, cost, user satisfaction at each phase
5. **Phase 2 missing = Phase 3 optimizing garbage** — Without reliability, intelligence is worthless

## Architecture Notes

- **"It's all one system"** — While built in phases, the pieces interlock into a unified whole
- **Phase 1 foundations determine Phase 3 ceiling** — Bad early decisions compound
- **Each phase is independently valuable** — Phase 1 alone is better than most memory systems
- **Time investment** — Expect 2-3 months per phase including testing

## Consequences

- **Positive**: Disciplined approach prevents fragile systems
- **Positive**: Each phase delivers value independently  
- **Positive**: Problems caught early when they're cheap to fix
- **Positive**: Clear success criteria at each stage
- **Negative**: Slower initial progress than "build everything at once"
- **Negative**: Requires extreme discipline to not jump ahead
- **Negative**: 6-9 months to full system completion

## References

- removed — content consolidated here
- removed — content consolidated here
- removed — content consolidated here
- ADR-0021: Agent Memory System (original 4-layer design)

## Notes

"Phase 1 and 2 are solid, Phase 3 is still being built. But the longer you work with it the more you see, they're not separate... it's all one system."

The phased approach is not about building separate systems — it's about building one system in the only order that actually works.