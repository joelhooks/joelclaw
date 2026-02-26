# ADR-0131: Unified Channel Intelligence Pipeline

- **Status**: accepted
- **Date**: 2026-02-24
- **Related**: ADR-0123 (request-scoped routing), ADR-0124 (Discord thread sessions), ADR-0130 (Slack channel)

## Context

JoelClaw now operates across 5+ channels: Telegram, Discord (with threads/forum), Slack (30+ channels via Socket Mode), iMessage, and Redis events. Each channel generates a high-volume message stream. Currently:

- Discord thread forking is broken — all threads route to the trunk session with no scoped context
- Slack channels are connected but messages only reach the gateway when Joel DMs or @mentions
- No cross-channel search, classification, or triage exists
- No catalog of channels/threads/topics for the agent to reason about

## Decision

Build a unified channel intelligence pipeline that ingests, classifies, indexes, and routes messages across all channels.

### Architecture

```
Channel streams (Slack, Discord, Telegram, etc.)
  → Ingest (normalize + index to Typesense)
    → Classify (Haiku — signal/context/noise + topic tags)
      → Route (signal → gateway session, context → digest, noise → drop)
        → Catalog (Convex — channels, threads, topics, participants)
```

### Storage Split

**Typesense** — `channel_messages` collection
- Full-text search across all channel messages
- Fields: `id`, `channel_type` (slack/discord/telegram), `channel_id`, `channel_name`, `thread_id`, `user_id`, `user_name`, `text`, `timestamp`, `classification` (signal/context/noise), `topics[]`, `urgency` (high/normal/low), `source_url`
- Retention: 90 days, then archive to cold storage
- Query patterns: "what's been discussed in #project-gremlin this week", "any urgent messages I missed"

**Convex** — channel catalog (reactive, UI-queryable)
- `channelCatalog` table: `channelType`, `channelId`, `name`, `purpose`, `activityLevel` (active/moderate/quiet/dead), `lastMessageAt`, `keyParticipants[]`, `topicClusters[]`, `messageCount30d`, `signalRatio`
- `threadCatalog` table: `channelType`, `channelId`, `threadId`, `topic`, `status` (active/stale/resolved), `participants[]`, `messageCount`, `lastMessageAt`, `linkedResources[]`
- Updated by periodic sweep (Inngest cron) not real-time — catalog is a summary, not a mirror

### Classification (Haiku)

Every inbound message gets classified by Claude Haiku (cheap, fast, ~$0.001/msg):

```typescript
type MessageClassification = {
  level: 'signal' | 'context' | 'noise'
  topics: string[]           // e.g. ['deployment', 'gremlin', 'bug']
  urgency: 'high' | 'normal' | 'low'
  actionable: boolean        // does this need a response?
  summary?: string           // one-line summary for digests
}
```

- **signal**: Actionable, interesting, or directly relevant. Routes to gateway session.
- **context**: Useful background. Batched into periodic digests.
- **noise**: Routine, automated, or irrelevant. Indexed but not surfaced.

### Discord Thread Intelligence

Replaces the broken thread forking (ADR-0124):

1. Each Discord thread gets a `threadCatalog` entry in Convex
2. Thread messages are classified with thread-scoped context (the classifier sees thread history, not just individual messages)
3. Thread topic is auto-detected and updated as conversation evolves
4. Routing decision per-message: continue in thread context, escalate to trunk, or cross-reference with other channels
5. Thread naming (`thread.setName()`) driven by classified topic

### Slack Passive Monitoring

Extends ADR-0130:

1. Bot uses user-scoped delegation to read all accessible channels
2. All messages ingested to Typesense — no filtering at ingest
3. Classification runs on every message (Haiku is cheap enough)
4. Only `signal` messages surface to Joel via gateway (DM or Telegram)
5. `context` messages batched into periodic channel digests for Joel
6. Channel catalog auto-populates from message patterns

### Privacy Boundary

**This pipeline is Joel-only intelligence. JoelClaw does NOT participate in Slack channels.**

- JoelClaw never responds to other users in Slack channels
- JoelClaw never responds to @mentions from anyone other than Joel
- All channel data is private context for Joel — never surfaced publicly
- The only public-facing content JoelClaw produces is on joelclaw.com
- Slack insights are delivered to Joel via DM (Slack/Telegram/Discord) — never posted back to monitored channels
- DMs between Joel and JoelClaw are private conversation, same as Telegram

### Privilege Metadata & Publishing Gate

**All Slack-sourced content is privileged by default.** (See also: egghead-slack skill)

Ingest metadata must include:
```typescript
type IngestMetadata = {
  source: 'slack' | 'discord' | 'telegram' | 'imessage' | 'redis'
  privileged: boolean          // true for all Slack content
  channelId: string
  channelName?: string
  threadId?: string
  userId?: string
  userLabel?: string
  passiveIntel: boolean        // true for non-Joel messages
}
```

**Publishing rules:**
- Discovery pipeline MAY ingest privileged content (index, classify, store in Vault)
- Discovery pipeline MUST NOT auto-publish privileged content to joelclaw.com or any public surface
- Publishing privileged content requires **explicit Joel approval** — no exceptions
- The `privileged` flag propagates through the entire pipeline: ingest → classify → discovery → publish
- Loom links, screenshots, files, and URLs shared in Slack are privileged regardless of content

This prevents the failure mode where passive Slack intel triggers discovery → auto-publish of private/sensitive content.

### Haiku Pre-Filter (Gateway Intel Conditioning)

**Problem:** Raw Slack messages hitting the gateway session burn context tokens and create noise. A 6-message excited thread ("NO WAY" / "This is huge!" / "Yep!" / "No more video PRs" / "at least not the manual ones" / "Yep. So nice") should be one digest line, not six separate context injections.

**Solution:** Interpose a Haiku (or equivalent cheap/fast model) pre-filter between Slack ingest and gateway delivery:

```
Slack message stream
  → Batch by channel+thread (5-min window or N messages, whichever first)
  → Haiku summarize + classify batch
    → signal: condensed summary → gateway session (one message, not N)
    → context: batched into periodic digest
    → noise: indexed only, never surfaces
```

**Haiku pre-filter contract:**
- Input: batch of messages from same channel/thread within time window
- Output: `{ level, summary, topics[], urgency, actionable, participants[], privileged }`
- Cost target: <$0.002 per batch (Haiku is ~$0.25/M input tokens)
- Latency target: <2s per batch
- **Slack is the main channel for making money and feeding family** — high-signal messages (money, launches, action items, decisions, creator needs) MUST be promoted to `signal` with high urgency. The pre-filter must be tuned for business sensitivity, not just conversational signal.

**What gets promoted to signal (always):**
- Revenue/payment/billing mentions
- Launch dates, deadlines, shipping announcements
- Creator requests or blockers (Antonio, Kent, Artem, etc.)
- Action items directed at Joel or his team
- Hiring, contracts, partnership discussions
- Anything mentioning DNS, deploy, production, outage

**Gateway delivery format:**
```
[slack:#creators] Kent announced automated video pipeline for course-builder.
Artem and Kent celebrating — no more manual video PRs. (6 messages condensed)
```

Instead of 6 raw messages polluting the context window.

### Inngest Functions

- `channel/message.received` → normalize + index to Typesense + emit classification event
- `channel/message.classified` → route based on classification
- `channel/catalog.update` → cron (hourly) updates channel/thread catalog in Convex
- `channel/digest.generate` → cron (configurable) generates channel digests from `context` messages
- `channel/ingest.backfill.started`/`channel/ingest.backfill.completed` → orchestrated backfill lifecycle over active channel sets

### Inngest Skill Requirements (explicit)

This ADR implementation must be driven by the existing Inngest skill set:

- `inngest-events` for canonical event contracts and payload fields
- `inngest-steps` in handlers (`step.run`, `step.sendEvent`, `step.invoke`) for classify/route/route-score sub-steps
- `inngest-flow-control` for `concurrency` + `throttle` on bulk backfill and taxonomy/classification workers
- `inngest-durable-functions` for idempotent backfill events with resumable state + cancellation semantics
- `inngest-monitor` for manual runs and health checks (`channel.ingest.backfill.requested`, `channel/message.received`) during migration

### OTEL

Every step emits structured telemetry:
- `channel.message.ingested` — channel, type, latency
- `channel.message.classified` — classification result, model, latency, cost
- `channel.message.routed` — destination (session/digest/dropped)
- `channel.catalog.updated` — channels updated, new topics detected
- `channel.digest.generated` — channels covered, message count, signal ratio

## Consequences

### Easier
- Agent has full awareness of all channel activity without token burn
- Cross-channel search ("what did X say about Y in any channel")
- Automatic channel/thread catalogs for reasoning
- Only signal messages interrupt — noise stays indexed but silent
- Discord thread context is scoped and intelligent

### Harder
- Haiku classification cost scales with message volume (~$0.001/msg)
- Typesense storage grows with all-channel indexing
- Classification accuracy needs tuning (false signal = interruptions, false noise = missed items)
- Convex catalog schema needs to handle cross-platform channel concepts

### Friction research: pdf-brain ingest (reusable pattern notes)

Current `docs-ingest` behavior (joelclaw memory pipeline) exposes concrete failure modes worth reusing as guardrails for channel backfill:

1. **Filesystem instability is real (EINTR / mount flake / transient path access failures)**
   - `validate-file` in `docs-ingest` can fail/retry on unstable NAS paths (`EINTR: interrupted system call, open '/Volumes/three-body/...'`).
   - **Channel analog:** historical message backfill must be concurrency-safe with retry cadence and mount-aware checkpoints; don’t firehose large historical windows.

2. **LLM classification is a subprocess and can timeout/fail silently**
   - `inferTaxonomyWithLlm` shells out to `pi ... --mode json` with `DOCS_TAXONOMY_TIMEOUT_MS`; taxonomy step explicitly emits `docs.taxonomy.classify.timeout` on overrun.
   - **Channel analog:** every inference run should emit timeout/safety telemetry, with fallback to lightweight heuristics when allowed.

3. **Input-path and path-alias quality is a first-class migration surface**
   - `docs-ingest` maintains `nas_path` + `nas_paths` to de-duplicate re-ingests and avoid catalog churn.
   - **Channel analog:** use stable channel/thread identity (team-wide IDs) and alias maps for renamed channels.

4. **Extraction and classification are non-deterministic quality-wise**
   - Empty-text PDF extraction and malformed LLM output both exist; pipeline emits explicit OTEL signals and can skip/update only after classification rules are met.
   - **Channel analog:** avoid assuming “every message worth classifying”; classify with confidence, and route low-confidence to digest-only unless strong signal.

5. **Throttling and backlog controls exist for a reason**
   - `docs-ingest` sets both `concurrency` and `throttle` and has dedicated backlog/janitor paths.
   - **Channel analog:** backfill should use Inngest flow-control + periodic janitor-style pass for dead-letter and repair.

## Implementation Order

**Phase 0 — Done (live today):**
- ✅ Slack passive monitoring via Socket Mode (gateway `slack.ts`)
- ✅ Raw messages delivered to gateway session as `slack-intel:` passive context
- ✅ Joel DMs get bidirectional routing, all other channels read-only
- ✅ OTEL telemetry on ingest (`slack.message.passive_ingest`)

**Phase 1 — Privilege Metadata + Publishing Gate:**
1. Add `privileged` + `source` metadata to `enqueuePrompt()` context for Slack messages
2. Propagate privilege flag through discovery pipeline
3. Add publishing gate: block auto-publish when `privileged: true`
4. Update discovery skill to respect privilege flag

**Phase 2 — Haiku Pre-Filter:**
5. Batch collector: accumulate Slack messages by channel+thread (5-min window)
6. Haiku classification function: summarize + classify batches
7. Replace raw `slack-intel:` gateway injection with condensed summaries
8. Tune signal detection for business-critical patterns (revenue, launches, blockers)

**Phase 3 — Full Pipeline:**
9. Typesense `channel_messages` collection schema + index
10. Ingest function: normalize messages from all channels → Typesense
11. Routing function: signal → session, context → batch, noise → drop
12. Convex `channelCatalog` + `threadCatalog` tables
13. Catalog update cron
14. Digest generation cron
15. Discord thread routing fix (replace broken fork with classified routing)
16. OTEL instrumentation throughout
