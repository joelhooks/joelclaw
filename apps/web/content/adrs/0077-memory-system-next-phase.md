---
type: adr
status: shipped
date: 2026-02-20
tags: [adr, memory, architecture]
deciders: [joel]
supersedes: []
---

# ADR-0077: Memory System — Next Phase

## Status

implemented

## Update (2026-02-21)

- Sprint closure complete: recall/search are Typesense-backed and `joelclaw inngest memory-e2e` is green.
- Qdrant is retired from active memory ingestion and active k8s runtime.
- Remaining Qdrant references in this ADR are retained as historical audit context from the original 2026-02-21 review.
- API key resolution hardening is active for recall/search/otel via shared `typesense-auth` lease parsing (daemon outages now return actionable JSON errors, never header blobs).
- `joelclaw inngest memory-health` is live with OTEL-backed evidence (stall/error-rate/failed-runs/backlog + stale ratio when schema supports it).
- VIP memory lookup diagnostics were renamed from Qdrant-era timeout naming to Typesense memory recall naming.
- ADR-0087 observability contract is now enforced across memory stages with lifecycle OTEL events for `reflect`, `proposal-triage`, `batch-review`, `promote`, and maintenance flows (`nightly-maintenance` + weekly summary).
- Weekly governance signal added: `system/memory-weekly-maintenance-summary` emits merge/stale/triage-backlog stats into `otel_events` for CLI and dashboard diagnosis.

## Kickoff Verification (2026-02-21)

Gate checks were re-run before starting the next phase:

- `joelclaw inngest memory-e2e --wait-ms 120000 --poll-ms 1500 --json`
  - `ok: true`
  - observe run completed: `01KJ0T6H0WG805WWYY2Q5RHCRN`
  - Typesense count moved `1555 -> 1558`
  - vector query returned hits (`hitCount: 3`)
  - recall probe command returned `exitCode: 0`
- `joelclaw inngest memory-weekly --wait-ms 60000 --poll-ms 1000 --json`
  - `ok: true`
  - weekly run completed: `01KJ0T71W586B5H77S16B4E0N5`
  - OTEL evidence: `weekly-maintenance.completed = 1`, `weekly-maintenance.failed = 0`
- `joelclaw inngest memory-health --hours 24 --stall-minutes 30 --json`
  - all checks passed (`memoryStageStall`, `otelErrorRate`, `staleRatio`, `failedMemoryRuns`, `memoryBacklog`)
  - OTEL memory-stage error rate: `0.01373`
  - latest success event: `weekly-maintenance.completed` at `2026-02-21T19:18:24.483Z`
- `joelclaw inngest memory-gate --json`
  - `ok: true`
  - executes `memory-e2e` + `memory-weekly` + `memory-health` as one gate
  - latest gate run window: `2026-02-21T19:22:25.684Z -> 2026-02-21T19:22:43.742Z`
  - weekly run completed in gate: `01KJ0TEY3NGE0Q14C751T56TNW`
- `joelclaw inngest memory-schema-reconcile --json`
  - `ok: true`
  - `memory_observations` schema now includes required memory fields (`stale`, `recall_count`, `retrieval_priority`, `last_used_at`, `observation_type`, merge/supersede fields)
  - stale filter probe now succeeds (`stale:=true`)
- `joelclaw inngest memory-gate --json` (post-schema closure)
  - `ok: true`
  - gate run window: `2026-02-21T19:27:14.441Z -> 2026-02-21T19:27:32.613Z`
  - weekly run completed: `01KJ0TQR57NQ88B4DY40GZNZPW`
  - `memory-health` now reports `staleMetricSupported: true`
- Retrieval hardening tests:
  - new: `packages/cli/src/commands/recall.test.ts`
  - validates rewrite disabled/fallback/success behavior and trust-pass fallback diagnostics
  - `bun test packages/cli/src/commands/recall.test.ts` => `5 pass, 0 fail`
- `joelclaw inngest memory-gate --json` (post-refresh stabilization)
  - `ok: true`
  - gate run window: `2026-02-21T19:39:22.987Z -> 2026-02-21T19:39:37.238Z`
  - weekly run completed: `01KJ0VDVWMA12FSHHRRRZXPB25`
- Echo/fizzle production evidence:
  - run: `01KJ0RRBHSK7XBNV21QNEBEW14` (`Track Memory Echo/Fizzle`, status `COMPLETED`)
  - trigger event: `01KJ0RRB9RN15PV67WKTZHST86` (`memory/echo-fizzle.requested`)
  - OTEL includes `echo-fizzle.started` and `echo-fizzle.completed` in last 24h

Phase kickoff was logged via slog:
- `slog write --action "memory.phase.kickoff" --tool "codex" --detail "0077 next phase kickoff after green checks: memory-e2e, memory-weekly, memory-health" --reason "gate checks passed"`
- `slog write --action "memory.phase.gate-added" --tool "joelclaw inngest" --detail "Added and validated memory-gate command (memory-e2e + memory-weekly + memory-health)" --reason "0077 next-phase kickoff automation"`

## Update (2026-02-22)

### Audit-to-actuals (ADR-0077)

- Rollout status: **implemented**
- P0 completed:
  - `voice/call.completed` now flows into memory via `voice-call-completed`.
  - `session/observation.noted` now flows into memory via `observe-session-noted`.
  - Telegram memory button callbacks now support `memory:approve:{proposalId}` and `memory:reject:{proposalId}`.
- P1 completed:
  - Added shared memory prefetch helper `packages/system-bus/src/memory/context-prefetch.ts` and wired it into `check-email`, `meeting-analyze`, `summarize`, and `o11y-triage`.
  - Fixed memory search field mismatch for `/api/typesense` memory route (`observation_type` + `source`).
  - Added bounded gateway memory enrichment in `packages/gateway/src/channels/redis.ts` for human messages.
  - Archived the full audit as `docs/notes/2026-02-22-memory-integration-audit.md`.
  - Removed orphaned `packages/system-bus/src/memory/behavior-loop.ts`.
- Remaining next steps:
  - Validate scoring/tuning of retrieval results in real traffic.
  - Confirm Telegram callback handling for approve/reject in production dashboards and error rates.
  - Continue audit-based closure of any residual memory quality gaps.
  - Write gate implementation is split to ADR-0094 (proposed) for independent rollout and verification.
  - Remaining deferred memory-vision slices are now tracked in ADR-0095 through ADR-0100 (categories, budget-aware retrieval, forward triggers, write-gate calibration, knowledge-graph substrate, dual search).

### Evidence and provenance

- Commit: `559e018` (`feat(memory): implement full memory integration audit findings (ADR-0077)`).
- Inngest deployment validation: `curl -X PUT http://127.0.0.1:3111/api/inngest` returned `{"message":"Successfully registered","modified":true}`.
- Audit archival path: `~/Vault/docs/notes/2026-02-22-memory-integration-audit.md`.
- Operational log entry: `slog write --action deploy --tool memory ...` written at `2026-02-22T00:30:09.735Z`.
- ADR status impact: no ADR status regressions detected; no existing ADR was superseded by this implementation.

## Next Phase Plan (2026-02-21 to 2026-03-07)

### Objective

Improve memory quality after migration hardening: better retrieval precision, real usage feedback loops, and explicit memory health controls.

### Cross-Cutting O11y Requirements (ADR-0087)

All memory-phase changes in this ADR must satisfy the implemented observability contract from ADR-0087:

1. **Canonical event contract only**: memory functions emit via `packages/system-bus/src/observability/{otel-event.ts,emit.ts,store.ts}` (no ad-hoc logging as primary signal).
2. **Required emission points**: for `observe`, `reflect`, `proposal-triage`, `batch-review`, `promote`, `echo-fizzle`, and maintenance flows:
   - start
   - success (with duration + counts)
   - failure (with structured error + retry context)
3. **Dual sink policy**:
   - full event stream to Typesense `otel_events`
   - warn/error/fatal mirror to Convex `contentResources` (`otel_event`) using rolling window controls.
4. **Required metadata keys** on memory events (when available):
   - `sessionId`
   - `dedupeKey`
   - `eventId`
   - `runId`
   - `proposalId`
   - `observationCount`
   - `proposalCount`
   - `retryLevel`
5. **Queryable diagnosis requirement**: any incident in memory pipeline must be diagnosable via:
   - `joelclaw otel list`
   - `joelclaw otel search`
   - `joelclaw otel stats`
   without direct pod log grepping.
6. **Escalation requirement**: sustained memory failure/stall signals feed `check-system-health` error-rate evaluation and honor fatal immediate Telegram path.

O11y acceptance gates for this phase:
- Synthetic failure in one memory stage appears in `otel_events` with required metadata.
- Warn/error event is visible in `/system/events` and via `joelclaw otel search` within one polling cycle.
- Memory pipeline stall (`no successful memory stage events for >30 minutes`) is detectable from `otel_events` queries.

### Kickoff Execution Slice (2026-02-21 to 2026-02-24)

Execution order:

1. Retrieval Quality V2 regression hardening
   - add/extend tests for rewrite fallback + trust-pass output in:
     - `packages/cli/src/commands/recall.ts`
     - `packages/system-bus/src/memory/retrieval.ts`
   - verify OTEL metadata includes rewrite + trust-pass diagnostics:
     - `query`
     - `rewrittenQuery`
     - `filtersApplied`
     - `droppedByTrustPass`
2. Echo/Fizzle production wiring validation
   - verify non-synthetic trigger path and usage-score writes in:
     - `packages/system-bus/src/memory/echo-fizzle.ts`
     - `packages/system-bus/src/inngest/functions/vip-email-received.ts`
   - require OTEL evidence (`echo-fizzle.started|completed|failed`) discoverable via:
     - `joelclaw otel search "echo-fizzle" --hours 24`
3. Memory health schema + threshold closure
   - add `stale` field support in memory schema migration path so stale ratio is not `staleMetricSupported=false`
   - keep `memory-health` and `check-system-health` thresholds aligned in:
     - `packages/cli/src/commands/inngest.ts`
     - `packages/system-bus/src/inngest/functions/check-system-health.ts`

Exit criteria for kickoff slice:
- `memory-e2e`, `memory-weekly`, and `memory-health` stay green for two consecutive runs.
- One real (non-synthetic) `memory/echo-fizzle` run is visible in OTEL with full metadata.
- stale ratio is derived from schema field support (no fallback warning path).

Kickoff slice progress (as of 2026-02-21):
- ✅ Memory health schema + threshold closure: stale ratio now reads from schema-backed `stale` field (`staleMetricSupported: true`).
- ✅ Repeatable gate command added: `joelclaw inngest memory-gate`.
- ✅ Retrieval regression hardening tests added for rewrite fallback + trust-pass diagnostics (`packages/cli/src/commands/recall.test.ts`).

### Workstream 1: Retrieval Quality V2

Scope:
- Add query rewriting for `joelclaw recall` with deterministic fallback when rewrite fails.
- Add trust-pass filtering in retrieval to de-prioritize low-confidence or stale results.
- Extend recall JSON diagnostics (`rewrittenQuery`, `filtersApplied`, `droppedByTrustPass`).

Acceptance:
- `joelclaw recall "what was that redis thing" --json` includes a populated rewrite field.
- Recall output is still valid when rewrite fails (fallback path covered by tests).
- P95 recall latency remains within local interactive bounds.
- Retrieval execution emits contract-compliant otel events with `query`, `rewrittenQuery` (if set), and filter diagnostics metadata.

### Workstream 2: Echo/Fizzle Activation

Scope:
- Wire recall injection and response events so `memory/echo-fizzle` runs on real sessions.
- Store and update usage signals per memory item (`recall_count`, `last_used_at`, usage score).
- Apply usage signal as a ranking factor in recall.

Acceptance:
- At least one production `memory/echo-fizzle` run from non-synthetic traffic.
- Observable score updates on recalled memory documents.
- Recalled items with repeated positive usage move up in ranking over time.
- Echo/fizzle run quality is inspectable via `joelclaw otel search \"memory/echo-fizzle\" --hours 24`.

### Workstream 3: Memory Health and Governance

Scope:
- Add a `joelclaw inngest memory-health` check for backlog, stale ratio, and failed memory runs.
- Add weekly maintenance summary (merge count, stale count, triage backlog) to logs/events.
- Define alert thresholds for sustained degradation (failed runs, backlog growth, zero recall hits).
- Source memory-health status from `otel_events` as system of record (not only ad-hoc counters).

Acceptance:
- `memory-health` returns machine-readable pass/fail output with actionable next actions.
- Weekly summary event is emitted and visible in run history.
- Alert thresholds are documented and tested with synthetic failure inputs.
- `memory-health` output includes an `otelEvidence` block (query window + event counts + error-rate basis).

## Audit (2026-02-21)

Deep code audit revealed significant gaps between what was claimed and what's wired:

### Actually Working
- Observer triple-writes (Qdrant + Typesense + Convex + Redis + daily log)
- Reflect → proposal staging → triage → batch review → promote pipeline
- Friction detection + friction-fix codex agent
- Nightly maintenance + staleness tagging (Qdrant-only)
- Dedup at write time (Qdrant similarity check)

### Critical Gaps Found
1. **`recall` CLI does keyword search, not semantic** — no `vector_query` sent to Typesense despite auto-embedding being enabled. Typesense vectors sit unused
2. **Score decay implemented but never called** — `applyScoreDecay`/`rankAndCap` in `retrieval.ts` are dead code
3. **Friction + nightly maintenance still Qdrant-only** — blocks Qdrant retirement
4. **Echo/fizzle file exists but not registered** as Inngest function
5. **Convex dual-write silently swallows errors** — `catch(() => {})` masks failures
6. **`memory/proposal.triaged` and `memory/friction.fix.completed` events emitted but have no consumers**
7. **Inject cap constant exists but not enforced** in recall path
8. **Query rewriting not started**

### Qdrant Migration Status (ADR-0082)
- Observer: writes both ✅
- Recall: Typesense-only ✅ (but keyword-only, not semantic)
- Friction: Qdrant-only ❌
- Nightly maintenance: Qdrant-only ❌
- Dedup-at-write: Qdrant-only ❌
- **Qdrant cannot be retired until friction + nightly + dedup are ported**

### Sprint (2026-02-21): Fix All Gaps
Codex dispatched to implement all fixes in one pass:
1. Make recall semantic (add vector_query to Typesense call)
2. Wire score decay + inject cap into recall results
3. Port friction from Qdrant → Typesense
4. Port nightly maintenance from Qdrant → Typesense
5. Port dedup-at-write from Qdrant → Typesense
6. Register echo-fizzle as Inngest function
7. Replace silent Convex error swallowing with logging
8. Clean up dead event emissions

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

### What's Not Built (from @jumperz's 31-piece memory stack)

[@jumperz on X](https://x.com/jumperz/status/2024841165774717031) published a comprehensive 31-piece agent memory architecture split across 3 phases. The two diagrams below capture the full system:

#### Section 1: Memory Storage — "Full Agent Memory Build — In Order"

![[adr/jumperz-memory-storage.jpg|Full Agent Memory Build — In Order: Short-Term (checkpoint, working memory), Files (resources, items, write gate, dedup, categories, strength, sentiment), Graph (triples, conflict resolution), Episodic (episodes, episode search)]]

#### Section 2: Memory Intelligence — "Feeds Into"

![[adr/jumperz-memory-intelligence.jpg|Memory Intelligence: Retrieval (rewrite query, score decay, tiered, inject, dual search), Decay (nightly, weekly, cron fallback, domain TTLs), Advanced (trust pass, echo/fizzle, memory agent, cross-agent, forward, budget-aware), Ops (session flush, behavior loop)]]

Key concepts from that framework not yet implemented in joelclaw:

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
- **@jumperz on X** — [31-piece memory system thread](https://x.com/jumperz/status/2024841165774717031) (2026-02-20). The source architecture for this ADR's vision. Credit: jumperz.

## Notes

### Source: @jumperz's 31-Piece Memory Stack

The architecture vision comes from @jumperz's X thread, which Joel shared via Telegram. jumperz frames it as "the entire memory stack if you actually want to take your agent memory to somewhere real — from actually remembering to having an intelligence layer."

**jumperz's key insight — build order is everything:**

> "31 pieces total, split into 3 phases: core first, reliability second, then advanced last. You build from core to advanced slowly, and you test each phase before touching the next. If you try to build all 31 at once, you will break everything and you won't understand anything."

**Phase 1 (10 pieces)** — "Memory that actually works": write pipeline, read pipeline, decay, session flush, behavior loop, categories, strength tags, sentiment tags, inject limit, trust pass.

**Phase 2 (7 pieces)** — "Memory that survives": crash recovery, audit trail, dedup, conflict resolution, nightly maintenance, weekly maintenance, cron fallback.

**Phase 3 (14 pieces)** — "The ceiling": rewrite query, tiered search, dual search, episodes, episode search, trust scoring, echo/fizzle, cross-agent sharing, memory agent, forward triggers, budget-aware, domain TTLs, monthly reindexing, knowledge graphs.

> "None of Phase 3 matters until Phase 1 and 2 are solid. Phase 1 unstable means Phase 3 just amplifies the flaws. Phase 2 missing means Phase 3 is literally optimising pure garbage."

> "Personally I'm not done yet. Phase 1 and 2 are solid, Phase 3 is still being built. But the longer you work with it the more you see, they're not separate... it's all one system."

### How joelclaw Maps to jumperz's Phases

| jumperz Phase 1 (Core) | joelclaw Status |
|------------------------|-----------------|
| Write pipeline | ✅ observe.ts — extracts facts from sessions |
| Read pipeline | ✅ recall tool — Qdrant semantic search |
| Score Decay | ❌ **Increment 1 of this ADR** |
| Session Flush | ✅ session-lifecycle flushes on compaction/shutdown |
| Behavior Loop | ⚠️ Partially — friction.ts detects patterns, but no corrections→lessons pipeline |
| Categories | ❌ Deferred — taxonomy undefined |
| Strength tags | ❌ Deferred |
| Sentiment tags | ❌ Deferred |
| Inject limit | ⚠️ Informal — not enforced in code |
| Trust Pass | ❌ **Increment 1 of this ADR** (basic confidence thresholds) |

| jumperz Phase 2 (Reliability) | joelclaw Status |
|-------------------------------|-----------------|
| Crash recovery | ⚠️ Inngest retries handle transient failures, but no checkpoint/replay |
| Audit trail | ✅ Qdrant stores source metadata, daily logs are append-only |
| Dedup | ⚠️ Redis SETNX dedupe key per session, but no cross-session cosine dedup |
| Conflict resolution | ❌ **Increment 2 of this ADR** (staleness tagging) |
| Nightly maintenance | ❌ **Increment 2 of this ADR** |
| Weekly maintenance | ❌ Deferred |
| Cron fallback | ✅ Inngest cron + heartbeat checks = equivalent |

| jumperz Phase 3 (Intelligence) | joelclaw Status |
|--------------------------------|-----------------|
| Echo/Fizzle | ❌ **Increment 3 of this ADR** |
| All others | ❌ Deferred — see "Not Yet" section above |

**Assessment**: joelclaw has ~60% of Phase 1 and ~40% of Phase 2 by jumperz's framework. This ADR's 3 increments close the gaps in Phase 1 (score decay, inject cap, trust pass) and Phase 2 (dedup, nightly maintenance, staleness), then start Phase 3 (echo/fizzle). That's the right order per jumperz: "build from core to advanced slowly."
