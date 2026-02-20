---
status: proposed
date: 2026-02-20
decision-makers: ["@joelhooks"]
consulted: []
informed: []
---

# ADR-0077: Full Agent Memory Build — In Order

## Status

proposed

## Context

Building a comprehensive agent memory system requires careful orchestration of multiple subsystems. Each component builds upon the previous ones, and the order of implementation is crucial for system stability and effectiveness.

This ADR documents the build order for the full agent memory system as captured from Joel's design notes.

## Decision

We will implement the agent memory system in the following order:

### 1. Memory Storage

**Build first:** Checkpoint module
- After every event turn, serialize `{user_input, tool_calls, llm_output, internal_state}` into a Postgres table keyed by `session_id + turn_number`
- Add a replay endpoint that reconstructs state at any turn and recovers from the last saved checkpoint after a crash

**Resources subsystem:**
- Create an append-only Resources table with columns: `{id, raw_content, content_type, content_at, conversation_id, created_at}`
- Never allow updates on this table
- Add an index on `created_at` for time-range queries
- Every downstream extraction must reference back to `resource_id` — this is the audit trail

**Items subsystem:**
- Build an extraction pipeline that takes each new message and presses it to an LLM with the prompt: "Extract every atomic fact from this message. One fact per line. No opinions, no filler."
- Store each as a row (`{fact, confidence, created_at, source_resource_id}`
- On confirmation from another source, add `confidence += 0.1`
- On contradiction: `-0.2`

**Write Gate subsystem:**
- Before inserting any item, run three checks:
  1) Is this a verifiable fact, not an opinion (score: 0..1)?
  2) Is it useful or is it chatter (`confidence > 0.7`)?
  3) Conflict → reject and log the rejection reason
- Never store raw transcripts

**Dedup subsystem:**
- Before inserting a new item, compute cosine similarity against all items in the same session
- If any match exists > 0.85, don't create a new item — instead update the existing item's text with the fresher wording, bump its confidence by +0.05, and update its timestamp
- Log the merge

**Categories subsystem:**
- Create one markdown summary file per category: `work.md`, `health.md`, `preferences.md`
- When a new item is stored, identify its category, fetch the current summary, then prompt the LLM:
  - "Here is the current summary and a new fact. Rewrite the full summary incorporating the new fact and resolving any contradictions. Output only the updated summary."
- Save the result
- Archive the old version with a timestamp

**Strength subsystem:**
- During fact extraction, add a second LLM pass:
  - "For each fact, classify how EXPLICITLY it was stated EXPLICITLY (directly said), IMPLIED (suggested but not stated), or INFERRED (derived from context)."
- Set starting confidence based on strength: 
  - explicit → 0.9
  - implied → 0.7
  - inferred → 0.5
- Store the strength tag alongside each item

**Sentiment subsystem:**
- During extraction, also tag each fact with emotional context: "Classify the emotional context of each fact when it was stated: frustrated, excited, uncertain, neutral."
- Store the tag
- During retrieval, use sentiment as a weight modifier — match the user's current emotional tone to stored sentiment for better contextual relevance

### 2. Memory Intelligence

**Rewrite Query:**
- Before any memory lookup, take the last 5 messages and pass them to the LLM with:
  - "Given this conversation context, write the most effective search query to retrieve relevant memories from storage. Design the query string, nothing else."
- Use the rewritten query for all vector and graph searches downstream
- Never pass the raw user message to your DB

**Score Decay:**
- After retrieving memory candidates, score each one:
  - `final_score = raw_score × exp(-0.01 × days_since_created)`
- This means a 0.9-relevance fact from 3 days ago outranks a 0.85-relevance fact from 200 days ago
- Sort by final_score descending
- Only pass the top-scoring results forward
- Tune the 0.01 decay constant per domain if needed

**Tiered:**
- Route every query through two tiers:
  - Tier 1 — search Category summaries (fast, only top 3)
  - Tier 2 — only if Tier 1 is insufficient, run vector search over raw items
- Merge results with source attribution
- Log which tier answered to track hit rate split over time

**Inject:**
- Hard cap at 10 memories per turn
- After scoring and ranking, track which facts were injected as: "~ [fact_text] (confidence: 0.X; age: Nd_category_work)"
- Inject this block into the system prompt immediately before the user's message
- Track which of the 10 the agent actually references in its response — this feeds the echo/fizzle loop later

**Dual Search:**
- On every retrieval, fire two parallel queries:
  - vector similarity search using embeddings
  - fact text + graph traversal starting from entities in the query
- Merge results: deduplicate by entity, compute final_score = (semantic_score × 0.5) + (graph_proximity_score × 0.5)
- Return the top N unified results to the agent

**Domain TTLs:**
- Replace the flat 90-day prune with per-category TTLs:
  - Work facts → 90d
  - Preferences → 180d
  - Health → 365d
- Hobbies → 60d
- Relationships → 180d
- Use these as the prune threshold in your weekly job instead of a single cutoff
- Make TTLs configurable per deployment so teams can tune for their domain

### 3. Memory Behaviors

**Nightly:**
- Run at 2am:
  1) Find item pairs with cosine sim > 0.85 → merge into one, keep highest confidence
  2) Scan all extracted items from today → boost retrieval_priority by +0.1
  3) Scan all resources from today that have no extracted items → run the extraction pipeline on them
  4) Log: merged_count, promoted count, extracted count

**Weekly:**
- Run Sunday 1am:
  1) For every category, re-generate the summary file from scratch using only active items
  2) All items accessed > 90 days → set status to archived
  3) Cluster archived items by semantic similarity → for each cluster, generate one high-level insight sentence
  4) Log: summaries rebuilt, items archived, insights created

**Cron Fallback:**
- Store `is_last_run_at` timestamp for every scheduled job (nightly, weekly, monthly)
- On every agent heartbeat or session start, check:
  - "Is any job overdue?"
- If yes, run it immediately before proceeding
- Never assume cron executed
- This is the difference between "works in dev" and "works in production"

**Monthly:**
- Run 1st of month:
  1) Rebuild all vector embeddings using your latest embedding model version — old embeddings drift
  2) Full re-index of all search indices
  3) Items with zero access in 6+ months → move to cold archive
  4) Generate a health report: total active items, stale items distribution, growth trend

## Additional Behaviors

### Trust Pass
- Before returning any memory set to the agent, run a validation pass:
  1) Scan for conflicting claims within the set — flag both
  2) Flag unconfirmed claims → flag high, surface the higher-confidence one
  3) Any item with confidence < 0.3 → tag as [uncertain]
- Items not confirmed by any since days → tag [stale]
- Attach these trust tags to every result the agent reads

### Echo/Fizzle
- After each agent response, evaluate: which of the injected memories were actually referenced in the output (heuristic: each used memory: retrieval_priority += 0.1)
- For each injected but ignored memory: priority -= 0.05
- Run this automatically post-response
- Over time, surface what's useful, let surface sink
- This is the compounding moat

### Memory Agent
- Create a dedicated MemoryAgent class that owns all memory operations: reads, writes, searches, health, scheduling, index maintenance
- The main agent never touches memory directly — it calls `memory_agent.query("topic")` and gets back clean, resolved, trust-scored facts
- All memory complexity is abstracted behind this single interface

### Cross-Agent
- Build a SharedMemory service with REST endpoints:
  - APIs: Every agent writes to its discoverer's memory (subdomain: `joelclaw.shared.memory`) domain)
- Any agent can query across all agents' memories with a domain relevance filter — off-domain results get penalized in scoring
- Add write rate limiting (max N writes/min per agent) to prevent flooding

### Forward
- Scan every incoming message for temporal signals: "explicit dates", "next week", "Friday", "in 6 months"
- When detected, auto-create a FutureTrigger record:
  - {trigger_date, original_message, context_memory_ids_to_preload}
- Run a daily check: if any trigger_date = today → inject those memories into the agent's context before the user even sends a message

### Session Flush
- Add a hard rule: at end of every session, write anything in working memory or pending state to long-term storage
- Run the extraction pipeline on any unprocessed conversation turns
- Memory only exists if it's been written down
- If the session crashes, the cron fallback catches anything missed on next heartbeat

### Behavior Loop
- Whenever the user corrects the agent or the agent makes a mistake, immediately extract the correction as a patterned write it to a lessons file:
  - "User prefers X over Y", "Don't do Z in this context"
- Load the lessons file into context on every session start
- This improves agent behavior over time, not just memory retrieval

### Budget-Aware
- Track cost-per-retrieval (embedding calls, LLM rewrites calls, DB queries)
- When running under budget constraints, automatically reduce the inject limit from 10 to 5, skip the Dual Search path, and rely on Tiered retrieval only
- Penalize expensive memories that went unused in the echo/fizzle scoring
- Log cost-per-turn for optimization

## Implementation Phases

1. **Phase 1: Storage Core** — Checkpoint, Resources, Items tables with basic CRUD
2. **Phase 2: Intelligence Layer** — Write Gate, Dedup, Categories, Strength, Sentiment
3. **Phase 3: Retrieval** — Rewrite Query, Score Decay, Tiered, Inject
4. **Phase 4: Advanced Search** — Dual Search with vector + graph
5. **Phase 5: Behaviors** — Nightly, Weekly, Monthly, Cron Fallback
6. **Phase 6: Trust & Learning** — Trust Pass, Echo/Fizzle, Behavior Loop
7. **Phase 7: Scale** — Memory Agent, Cross-Agent, Forward triggers, Budget-Aware

Each phase builds on the previous one. The system remains functional at each phase completion.

## Consequences

- **Positive**: Structured build order ensures each component has required dependencies
- **Positive**: Clear phases allow incremental deployment and testing
- **Positive**: Memory system becomes progressively more intelligent without breaking existing functionality
- **Negative**: Full system requires significant implementation effort
- **Negative**: Later phases may reveal design issues in earlier phases requiring refactoring

## References

- ADR-0021: Agent Memory System (original 4-layer design)
- ADR-0068: Memory Pipeline Auto-Triage

## Notes

This ADR is based on Joel's handwritten design notes from 2026-02-20.