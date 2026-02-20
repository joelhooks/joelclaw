---
type: adr
status: proposed
date: 2026-02-20
tags: [adr, memory, architecture]
deciders: [joel]
supersedes: []
---

# ADR-0077: Memory System — Next Phase

## Status

proposed

## Context

The memory system (ADR-0021) has been running in production since 2026-02-14. Six days of continuous operation have proven the core pipeline and revealed where to invest next.

### What's Built and Running

| Component | Status | Details |
|-----------|--------|---------|
| **Observer** (Phase 1) | ✅ Operational | `observe.ts` — extracts structured observations from session transcripts on compaction/shutdown. Haiku model. Segment-aware distillation. |
| **Qdrant storage** | ✅ 1,343 points | 768-dim nomic-embed-text-v1.5 vectors. Semantic search verified. |
| **Reflector** (Phase 2) | ✅ Operational | `reflect.ts` — condenses observations into MEMORY.md proposals. Stages in Redis. |
| **Promotion** (Phase 3) | ✅ Operational | `promote.ts` — approved proposals merge into MEMORY.md. Todoist-as-review-surface. |
| **Auto-triage** (ADR-0068) | ✅ Operational | `proposal-triage.ts` + `batch-review.ts` — LLM batch review, auto-promote/reject. Only `needs-review` creates Todoist tasks. Eliminated 50+ junk tasks per compaction. |
| **Friction** (Phase 4) | ⚠️ Deployed, unproven | `friction.ts` — daily cron queries Qdrant clusters. First run: 10 patterns from 227 observations. Has not yet produced actionable friction-fix tasks. |
| **Recall tool** | ✅ Operational | pi-tools `recall` command — semantic search over Qdrant. Used by agents mid-session. |
| **Daily log** | ✅ Operational | `~/.joelclaw/workspace/memory/YYYY-MM-DD.md` — observations appended per session. |
| **Session briefing** | ✅ Operational | MEMORY.md + daily log + slog auto-injected at session start. |

### What's Not Built (from Joel's design diagrams, 2026-02-20)

Joel sent architecture diagrams via Telegram capturing a comprehensive vision for the memory system's next evolution. Key concepts not yet implemented:

**Retrieval Intelligence:**
- Score Decay — `final_score = raw_score × exp(-0.01 × days_since_created)` for time-weighted relevance
- Tiered Search — category summaries first (fast), vector search fallback (thorough)
- Query Rewriting — LLM rewrites the last 5 messages into an optimal search query before retrieval
- Dual Search — parallel vector similarity + knowledge graph traversal, merged scoring

**Storage Intelligence:**
- Write Gate — validate facts before storing (verifiable? useful? conflicting?)
- Dedup at write time — cosine sim > 0.85 → merge, keep fresher wording, bump confidence
- Strength tags — EXPLICIT (0.9), IMPLIED (0.7), INFERRED (0.5) confidence levels
- Sentiment tags — emotional context when facts were stated

**Maintenance:**
- Nightly job — merge similar items, boost recently-accessed, extract from unprocessed resources
- Weekly job — regenerate category summaries, archive old items, cluster insights
- Monthly job — rebuild embeddings, full reindex, cold archive, health report
- Cron Fallback — check job timestamps on heartbeat, run if overdue

**Feedback Loops:**
- Echo/Fizzle — track which injected memories get referenced in responses (+0.1 priority) vs ignored (-0.05)
- Behavior Loop — extract corrections/preferences as lessons, load on every session start
- Trust Pass — validate memory sets before returning (conflict detection, confidence thresholds, staleness tags)

**Advanced (future):**
- Categories — per-topic markdown summaries (work.md, health.md, preferences.md)
- Domain TTLs — per-category retention (work: 90d, preferences: 180d, health: 365d)
- Forward triggers — detect temporal signals ("next Friday"), preload context on that date
- Cross-agent memory sharing — SharedMemory REST API with domain relevance filters
- Knowledge graphs — entity relationships, graph-based retrieval
- Budget-aware retrieval — reduce operations under cost constraints
- Memory Agent — dedicated class abstracting all memory operations

## Decision

Implement the next phase in three increments, building on what's proven. Each increment is independently valuable.

### Increment 1: Retrieval Quality (highest impact, lowest risk)

These improve what agents get back when they query memory. No storage changes needed.

1. **Score Decay** — Add time-based decay to Qdrant search results. Modify the `recall` tool and any retrieval path to apply `final_score = raw_score × exp(-0.01 × days_since_created)`. Recent relevant facts outrank old relevant facts.

2. **Query Rewriting** — Before Qdrant search, pass the query + recent conversation context through Haiku to produce an optimized search query. The raw user question ("what was that Redis thing?") becomes a targeted query ("Redis SETNX deduplication pattern for Inngest functions").

3. **Inject Cap** — Hard limit of 10 memories per retrieval. Already informally followed; make it explicit in the recall tool.

### Increment 2: Storage Quality (reduces noise over time)

These improve what goes INTO memory. Builds on the existing observer pipeline.

4. **Dedup at observation time** — Before storing a new observation in Qdrant, check cosine similarity against recent points. If > 0.85, merge: keep the fresher wording, bump confidence metadata. Prevents the same insight from appearing 5+ times across sessions.

5. **Nightly maintenance** — Inngest cron (2 AM): scan today's observations, merge duplicates, identify orphaned resources with no extractions. Log stats. This is a simple extension of what friction.ts already does with Qdrant queries.

6. **Staleness tagging** — Observations older than 90 days with zero recall hits get tagged `stale` in Qdrant metadata. The recall tool deprioritizes stale results.

### Increment 3: Feedback Loop (the compounding moat)

These create the virtuous cycle that makes memory better with use.

7. **Echo/Fizzle tracking** — After each agent response, heuristically detect which recalled memories were referenced. Boost priority for used memories (+0.1), penalize ignored ones (-0.05). Over time, useful memories surface; irrelevant ones sink. This is the most valuable long-term feature.

8. **Behavior Loop** — When the user corrects the agent, extract the correction pattern and write it to a lessons section in MEMORY.md. Load on every session start. Already partially implemented via friction detection — this formalizes it.

### Not Yet (deferred until increments 1-3 prove out)

- **Categories / per-topic summaries** — requires defining the category taxonomy first. May emerge naturally from friction analysis.
- **Knowledge graphs** — needs a graph database (Neo4j or similar). Big investment, unclear ROI at current scale.
- **Cross-agent sharing** — only one agent system (joelclaw). Premature.
- **Forward triggers** — interesting but low-frequency. Calendar integration (ADR-0040, gogcli) already covers most temporal awareness.
- **Budget-aware** — needs per-function token tracking first (see ADR-0078).
- **Dual Search** — vector search alone is performing well at 1,343 points. Graph traversal adds value at 10K+ points.
- **Write Gate** — the auto-triage pipeline (ADR-0068) already filters proposals. Adding a gate at observation time risks losing raw data.

## Consequences

### Positive
- Retrieval quality improves immediately (score decay, query rewriting)
- Storage noise reduces over time (dedup, maintenance, staleness)
- Echo/fizzle creates compounding advantage — the system gets smarter with use
- Each increment is independently deployable and testable

### Negative
- Echo/fizzle detection is heuristic — may be noisy initially
- Nightly maintenance adds another cron job to monitor
- Query rewriting adds latency to recall (one Haiku call per query)

## References

- ADR-0021: Agent Memory System (canonical spec, all phases)
- ADR-0068: Memory Proposal Auto-Triage Pipeline
- ADR-0078: Opus Token Reduction (budget-aware retrieval dependency)
- Joel's memory architecture diagrams (Telegram, 2026-02-20) — the aspirational vision captured as photos

## Notes

The diagrams Joel sent capture a comprehensive vision with 31 pieces across 3 phases. This ADR prioritizes the 8 pieces that improve the *existing* running system, using the infrastructure that's already proven. The remaining 23 pieces are documented here as deferred items — they're not rejected, just not next.

"Phase 1 and 2 are solid, Phase 3 is still being built. But the longer you work with it the more you see, they're not separate... it's all one system."
