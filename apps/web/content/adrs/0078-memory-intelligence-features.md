---
status: proposed
date: 2026-02-20
decision-makers: ["@joelhooks"]
consulted: []
informed: []
---

# ADR-0078: Memory Intelligence Features — Feeds Into

## Status

proposed

## Context

The memory system needs intelligent features that feed into various subsystems to enhance retrieval, scoring, and behavior. This ADR documents specific memory intelligence patterns captured from Joel's design notes.

## Decision

We will implement the following memory intelligence features that feed into the broader memory system:

### 1. Rewrite Query

**Purpose**: Transform user queries into effective search queries

**Implementation**:
- Before any memory lookup, take the last 5 messages and pass them to the LLM with prompt:
  - "Given this conversation context, write the most effective search query to retrieve relevant memories from storage. Output only the query string, nothing else."
- Use the rewritten query for all vector and graph searches downstream
- Never pass the raw user message to your DB

**Feeds into**: Categories + Score Decay

### 2. Score Decay  

**Purpose**: Prioritize recent memories over old ones

**Implementation**:
- After retrieving memory candidates, score each one: `final_score = raw_score × exp(-0.01 × days_since_created)`
- This means a 0.9-relevance fact from 3 days ago outranks a 0.85-relevance fact from 200 days ago
- Sort by final_score descending
- Only pass the top-scoring results forward
- Tune the 0.01 decay constant per domain if needed

**Feeds into**: Summaries refresh, embeddings update, stale purges — retrieval compounds automatically

### 3. Tiered

**Purpose**: Fast category summaries with vector search fallback

**Implementation**:
- Route every query through two tiers:
  - Tier 1 — search Category summaries (fast, only top result) 
  - Tier 2 — only if Tier 1 is insufficient, run vector search over raw items
- Merge results with source attribution
- Log which tier answered to track hit rate split over time

**Feeds into**: retrieval compounds

### 4. Inject

**Purpose**: Hard cap memory context injection

**Implementation**:
- Hard cap at 10 memories per turn
- After scoring and ranking, track which facts the agent actually references in its response — this feeds the echo/fizzle loop later

**Feeds into**: echo/fizzle scoring

### 5. Dual Search

**Purpose**: Combine vector similarity with graph traversal

**Implementation**:
- On every retrieval, fire two parallel queries:
  - vector similarity search using embeddings
  - fact text + graph traversal starting from entities in the query
- Merge results: deduplicate by entity
- Compute final_score = (semantic_score × 0.5) + (graph_proximity_score × 0.5)
- Return the top N unified results to the agent

**Feeds into**: unified scoring

### 6. Domain TTLs

**Purpose**: Per-category retention periods

**Implementation**:
- Replace the flat 90-day prune with per-category TTLs:
  - Work facts → 90d
  - Preferences → 180d  
  - Health → 365d
  - Hobbies → 60d
  - Relationships → 180d (Use these as the prune threshold in your weekly job instead of a single cutoff)
- Make TTLs configurable per deployment so teams can tune for their domain

**Feeds into**: prune jobs

## Consequences

- **Positive**: Each feature has a clear purpose and integration point
- **Positive**: Features compound over time through their interconnections
- **Positive**: System becomes more intelligent without adding complexity to core operations
- **Negative**: Tuning parameters (decay constants, TTLs, score weights) requires ongoing monitoring
- **Negative**: Dual search adds latency that may require optimization

## References

- ADR-0077: Full Agent Memory Build Order
- ADR-0021: Agent Memory System (original design)

## Notes

These features are designed to work together — rewrite query improves both tier searches, score decay affects injection selection, echo/fizzle learns from injection results, and domain TTLs customize retention per use case.