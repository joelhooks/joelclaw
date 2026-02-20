---
status: proposed
date: 2026-02-20
decision-makers: ["@joelhooks"]
consulted: []
informed: []
---

# ADR-0079: Memory System Behaviors

## Status

proposed

## Context

The memory system requires sophisticated behaviors beyond storage and retrieval. These behaviors include temporal processing, trust validation, cross-agent coordination, and continuous learning loops. This ADR documents the behavioral patterns captured from Joel's design notes.

## Decision

We will implement the following memory system behaviors:

### Core Scheduled Behaviors

#### Nightly (Run at 2am)
1. Find item pairs with cosine sim > 0.85 → merge into one, keep highest confidence
2. Any item accessed today → boost retrieval_priority by +0.1
3. Scan all resources from today that have no extracted items → run the extraction pipeline on them
4. Log: merged_count, promoted count, extracted count

#### Weekly (Run Sunday 1am)  
1. For every category, re-generate the summary file from scratch using only active items
2. All items with last_accessed > 90 days → set status to archived
3. Cluster archived items by semantic similarity → for each cluster, generate one high-level insight sentence
4. Log: summaries rebuilt, items archived, insights created

#### Monthly (Run 1st of month)
1. Rebuild all vector embeddings using your latest embedding model version — old embeddings drift
2. Full re-index of all search indices  
3) Items with zero access in 6+ months → move to cold archive
4) Generate a health report: total active items, stale items distribution, growth trend

#### Cron Fallback
- Store `last_run_at` timestamp for every scheduled job (nightly, weekly, monthly)
- On every agent heartbeat or session start, check: is any job overdue?
- If yes, run it immediately before proceeding  
- Never assume cron executed — this is the difference between "works in dev" and "works in production"

### Trust & Validation Behaviors

#### Trust Pass
Before returning any memory set to the agent, run a validation pass:
1. Scan for conflicting claims within the set — if found, surface the higher-confidence one → flag both, surface the higher-confidence one
2) Any item with confidence < 0.3 → tag as [uncertain]
3) Items not confirmed by any source days → tag [stale]
- Attach these trust tags to every result the agent reads

#### Echo/Fizzle
After each agent response, evaluate: which of the injected memories were actually referenced in the output (heuristic: keyword overlap):
- For each used memory: retrieval_priority += 0.1
- For each injected but ignored memory: priority -= 0.05
- Run this automatically post-response
- Over time, surface what's useful, let surface sink
- This is the compounding moat

#### Behavior Loop
Whenever the user corrects the agent or the agent makes a mistake, immediately extract the correction as a patterned write it to a lessons file:
- "User prefers X over Y"
- "Don't do Z in this context"
- Load the lessons file into context on every session start
- This improves agent behavior over time, not just memory retrieval

### Architecture Components

#### Memory Agent
- Create a dedicated MemoryAgent class that owns all memory operations: reads, writes, searches, health, scheduling, index maintenance
- The main agent never touches memory directly — it calls `memory_agent.query("topic")` and gets back clean, resolved, trust-scored facts
- All memory complexity is abstracted behind this single interface

#### Cross-Agent
Build a SharedMemory service with REST endpoints APIs:
- Every agent writes to its discoverer's memory (subdomain: `charlie.panda.shared.memory`)
- Any agent can query across all agents' memories with a domain relevance filter — off-domain results get penalized in scoring
- Add write rate limiting (max N writes/min per agent) to prevent flooding

#### Forward
- Scan every incoming message for temporal signals: "explicit dates", "next week", "Friday", "in 6 months"
- When detected, auto-create a FutureTrigger record: `{trigger_date, original_message, context, memory_ids_to_preload}`
- Run a daily check: if any trigger_date = today → inject those memories into the agent's context before the user even sends a message

### Operational Behaviors

#### Session Flush
- Add a hard rule: at end of every session, write anything in working memory or pending state to long-term storage
- Run the extraction pipeline on any unprocessed conversation turns
- Memory only exists if it's been written down
- If the session crashes, the cron fallback catches anything missed on next heartbeat

#### Budget-Aware
- Track cost-per-retrieval (embedding calls, LLM rewrites, DB queries)
- When running under budget constraints, automatically reduce the inject limit from 10 to 5, skip the Dual Search path, and rely on Tiered retrieval only
- Penalize expensive memories that went unused in the echo/fizzle scoring
- Log cost-per-turn for optimization

#### Domain TTLs
Replace the flat 90-day prune with per-category TTLs:
- Work facts → 90d
- Preferences → 180d
- Health → 365d  
- Hobbies → 60d
- Relationships → 180d
- Use these as the prune threshold in your weekly job instead of a single cutoff
- Make TTLs configurable per deployment so teams can tune for their domain

## Implementation Phases

1. **Phase 1: Core Behaviors** — Nightly, Weekly, Monthly jobs with Cron Fallback
2. **Phase 2: Trust Layer** — Trust Pass, validation tags, confidence thresholds
3. **Phase 3: Learning Loop** — Echo/Fizzle scoring, Behavior Loop corrections
4. **Phase 4: Architecture** — Memory Agent abstraction, Session Flush
5. **Phase 5: Cross-Agent** — SharedMemory service, rate limiting, domain filters
6. **Phase 6: Advanced** — Forward triggers, Budget-Aware optimizations

## Consequences

- **Positive**: Memory system becomes self-maintaining and self-improving
- **Positive**: Trust validation prevents bad data from corrupting agent responses
- **Positive**: Echo/fizzle creates a feedback loop that improves relevance over time
- **Positive**: Cross-agent memory enables collaborative intelligence
- **Negative**: Significant operational complexity with multiple scheduled jobs
- **Negative**: Trust validation and echo/fizzle tracking add latency to every query

## References

- ADR-0077: Full Agent Memory Build Order
- ADR-0078: Memory Intelligence Features
- ADR-0021: Agent Memory System (original design)

## Notes

These behaviors transform the memory system from a passive store into an active, learning system that improves with use. The echo/fizzle loop is particularly important as it creates a compounding advantage — the more the system is used, the better it becomes at surfacing relevant memories.