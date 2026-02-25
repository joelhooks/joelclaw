---
type: adr
status: shipped
date: 2026-02-20
tags: [adr, cost, gateway, tokens, architecture, models]
deciders: [joel]
---

# ADR-0078: Opus Token Reduction Across joelclaw

## Status

accepted — Phase 0 (emergency model fix + enforcement) implemented 2026-02-20.

## Incident: $1000 in 2 Days

The gateway daemon was configured with `PI_MODEL="claude-opus-4-20250514"` — a dated snapshot ID resolving to **Opus 4** pricing ($15/$75 per MTok). The correct model is `claude-opus-4-6` ($5/$15 per MTok). This 5x output cost multiplier, combined with 50-100 events/day through Opus, burned ~$1000 in approximately 2 days.

### Immediate Fixes (2026-02-20)
1. **gateway-start.sh**: Fixed model to `claude-opus-4-6`, added `ALLOWED_MODELS` allowlist — gateway refuses to start if model not on list
2. **vip-email-received.ts**: `opus-4-1` → `opus-4-6` (was defaulting to $15/$75 tier)
3. **batch-review.ts**: bare `claude-haiku` → `claude-haiku-4-5` (explicit version)
4. **lib/models.ts**: Centralized `MODEL` registry with `assertAllowedModel()` guard, pricing comments, semantic aliases (`MODEL.OPUS`, `MODEL.SONNET`, `MODEL.HAIKU`, `MODEL.CODEX`, `MODEL.O4_MINI`, `MODEL.O3`)

### Model Enforcement Rules
1. **No dated snapshot IDs** (e.g. `claude-opus-4-20250514`) — these silently resolve to expensive legacy tiers
2. **No bare aliases** (e.g. `claude-haiku`) — always specify version
3. **All models must be in `ALLOWED_MODELS`** or the gateway won't start
4. **Use `MODEL.*` constants** from `lib/models.ts` in all Inngest functions
5. **OpenAI models included**: `gpt-5.3-codex`, `o4-mini`, `o3` — used by codex exec, agent loops, friction-fix

## Context

The joelclaw system burns Opus tokens at an alarming rate. The central gateway daemon runs `claude-opus-4-6` with `thinking:low` and every inbound event — heartbeat, media notification, email triage result, Todoist echo, content sync — gets turned into a prompt that hits Opus for inference.

### Current Token Burn Points

| Component | Model | Trigger | Frequency | Token Impact |
|-----------|-------|---------|-----------|-------------|
| **Gateway daemon** | ~~Opus 4~~ → Opus 4.6 (thinking:low) | Every non-suppressed event | ~50-100/day | **HUGE** — full session context + event prompt (5x cheaper after fix) |
| **Gateway heartbeat** | ~~Opus 4~~ → Opus 4.6 (thinking:low) | Hourly cron | 24/day | Large — reads HEARTBEAT.md checklist |
| VIP email analysis | ~~Opus 4.1~~ → Opus 4.6 | Inbound VIP email | ~5-10/day | Medium — full email analysis (5x cheaper after fix) |
| Media vision-describe | Haiku | Photo/video received | ~5/day | Small — Haiku is cheap |
| Observer (memory) | Haiku | Session compaction | ~5-10/day | Small |
| Reflector (memory) | Haiku | After observation | ~5-10/day | Small |
| Batch review (memory) | ~~bare Haiku~~ → Haiku 4.5 | Hourly | 24/day | Small |
| Email triage | Sonnet 4.6 | Hourly check | 24/day | Medium |
| Task triage | Sonnet 4.6 | Hourly heartbeat | 24/day | Medium |
| Friction analysis | Sonnet 4.6 | After reflect | ~5/day | Small |
| Meeting analysis | Sonnet | After Granola sync | ~2/day | Medium |
| Daily digest | Sonnet | Daily | 1/day | Medium |
| Email cleanup | Haiku | On demand | Rare | Small |

### The Core Problem

The gateway daemon is a **pi session running Opus**. Every event gets `buildPrompt()` → `enqueue()` → `session.prompt()`. This means:

1. **Session context grows** — pi maintains conversation history, so each prompt carries all prior context
2. **Opus processes everything** — a simple "media processed" notification costs the same as a complex triage decision
3. **No routing by complexity** — a heartbeat OK and a VIP email analysis both go through the same Opus pipeline
4. **Suppression is the only control** — events are either fully processed by Opus or fully dropped. No middle ground.

## Decision Drivers

- Opus is ~15x more expensive than Haiku per token
- Most gateway events need routing/formatting, not reasoning
- The gateway session context balloons over time (no compaction for daemon)
- Joel wants the system autonomous but cost-aware

## Considered Options

### Option A: Tiered Model Routing in Gateway

Route events to different models based on complexity:

- **Pass-through** (no LLM): Media descriptions, task echoes, content sync — just format and forward to Telegram. No inference needed.
- **Haiku**: Heartbeat checks, simple triage, acknowledgments
- **Sonnet**: Email summaries, meeting analysis, multi-event digests  
- **Opus**: Only for complex decisions requiring full context — VIP emails, ambiguous requests, multi-step reasoning

Implementation: Add a `routeEvent()` function before `buildPrompt()` that classifies events and either (a) formats directly for Telegram without LLM, (b) uses a lightweight pi session, or (c) falls through to the Opus session.

### Option B: Gateway as Dumb Router + Smart Workers

Strip all LLM inference from the gateway daemon. Make it a pure event router:

- Gateway receives events, formats them, forwards to Telegram — no `session.prompt()` at all
- Complex decisions stay in Inngest functions (which already use appropriate models)
- Telegram user messages → fire Inngest event → function handles with right model → gateway.notify() delivers response

This is the logical endpoint of "heartbeat as pure fan-out" (existing pattern).

### Option C: Session Compaction for Gateway

Keep Opus but add session compaction to the gateway daemon to prevent context growth. Reduce heartbeat frequency. Batch more events.

## Proposed Decision

**Option B (Gateway as Dumb Router)** with elements of Option A as a migration path.

### Rationale

The gateway daemon already has the "bias-to-action triangle" (IMMEDIATE / BATCHED / SUPPRESSED). The missing tier is **PASS-THROUGH** — events that need delivery but not inference.

Most `gateway.notify()` calls from Inngest functions already contain fully-formed messages (the media-process function formats the description, the email triage formats the summary). The gateway just needs to deliver them to Telegram, not re-analyze them with Opus.

### Migration Path

1. **Phase 1: Pass-through delivery** — Events with a `payload.message` field get formatted and sent directly to Telegram. No `session.prompt()`. This covers `gateway.notify()`, `gateway.progress()`, `gateway.alert()`.

2. **Phase 2: Heartbeat demotion** — Heartbeat system checks already run as independent Inngest functions. Gateway heartbeat becomes: receive results, format summary, send to Telegram. Haiku at most.

3. **Phase 3: Telegram → Inngest** — User messages from Telegram fire an Inngest event instead of hitting `session.prompt()`. A dedicated function handles the conversation with the appropriate model. Response flows back via `gateway.notify()`.

4. **Phase 4: Remove Opus from gateway** — Gateway runs without an LLM session. Pure event router + Telegram delivery.

### What Stays on Opus

- Interactive pi sessions (this terminal, SSH sessions) — user is present, Opus quality matters
- VIP email analysis (already a separate function, can stay Opus or drop to Sonnet)

### What Moves to Cheaper Models

- All gateway event processing → pass-through (no LLM)
- Heartbeat → pass-through or Haiku
- Telegram conversations → Sonnet (good enough for most interactions)

## Consequences

### Positive
- Dramatic cost reduction (estimated 80-90% of gateway token spend eliminated)
- Gateway becomes faster (no waiting for Opus inference per event)
- Gateway becomes more reliable (fewer failure modes, no session state issues)
- Clear separation: routing ≠ reasoning

### Negative
- Telegram conversations lose Opus-level reasoning (mitigated: can escalate to Opus for complex queries)
- More code in gateway for formatting/routing logic
- Migration requires careful testing of each event type

### Risks
- Some events may need more intelligence than pass-through — need escape hatch to LLM
- Telegram conversation quality may noticeably degrade on Sonnet vs Opus

## Research: OpenClaw Token Optimization Patterns

OpenClaw (~/Code/openclaw/openclaw) manages token costs across a multi-channel agent platform. Relevant patterns from their codebase and git history (credit: Peter Steinberger / OpenClaw contributors):

### 1. Heartbeat Model Override (`heartbeat.model`)
OpenClaw lets you run heartbeats on a **different, cheaper model** than the session primary. Config: `agents.defaults.heartbeat.model: "anthropic/claude-haiku"`. The main session keeps Opus for user interactions; heartbeats use Haiku. This is exactly what joelclaw needs — the gateway's hourly heartbeat doesn't need Opus.

*Commit: `4200782a5` — "fix(heartbeat): honor heartbeat.model config for heartbeat turns"*

### 2. Heartbeat Transcript Pruning
When a heartbeat run produces `HEARTBEAT_OK` (no action needed), OpenClaw **truncates the transcript back** to pre-heartbeat size. Zero-information exchanges are pruned from history, preventing context window pollution from routine checks.

*Commit: `e9f2e6a82` — "fix(heartbeat): prune transcript for HEARTBEAT_OK turns"*

**joelclaw equivalent**: The gateway daemon never prunes its session. Every heartbeat acknowledgment accumulates in context, making subsequent Opus calls progressively more expensive.

### 3. Session Pruning (Cache-TTL Aware)
OpenClaw prunes **old tool results** from in-memory context before each LLM call. Two levels:
- **Soft-trim**: Keep head + tail of oversized tool results, insert `...`
- **Hard-clear**: Replace entire tool result with `[Old tool result content cleared]`

Configurable per-tool (`tools.allow`/`tools.deny`), with TTL-aware triggering to avoid re-caching full history when Anthropic prompt cache expires.

*Defaults: keepLastAssistants=3, softTrim maxChars=4000, hardClear enabled*

**joelclaw equivalent**: The gateway session never trims tool results. Long bash outputs, file reads, and API responses persist in full across the entire session lifetime.

### 4. Image Dimension Reduction
OpenClaw reduced default image max dimension from 2000px to **1200px**. Vision tokens scale with image size — smaller images = fewer tokens with sufficient detail for most use cases.

*Commit: `5ee79f80e` — "fix: reduce default image dimension from 2000px to 1200px"*

**joelclaw equivalent**: media-process sends images to Haiku (already cheap), but if the gateway ever processes images directly, this matters.

### 5. Skill Path Compaction
Replace absolute home directory in skill `<location>` tags with `~`. Saves ~5-6 tokens per path × 90+ skills = **400-600 tokens per system prompt**.

*Commit: `4f2c57eb4` — "feat(skills): compact skill paths with ~ to reduce prompt tokens"*

**joelclaw equivalent**: The gateway's pi session loads all skills into the system prompt with full absolute paths. Direct savings opportunity.

### 6. Bootstrap File Truncation
System prompt workspace files (`AGENTS.md`, `MEMORY.md`, etc.) are truncated at configurable limits:
- Per-file: `bootstrapMaxChars` (default: 20,000)
- Total: `bootstrapTotalMaxChars` (default: 150,000)

**joelclaw equivalent**: AGENTS.md alone is ~15K chars. MEMORY.md is growing. No truncation in gateway.

### 7. Compaction Reserve Tokens Floor
Minimum 20,000 tokens reserved for compaction summaries. Prevents compaction from producing too-small summaries that lose critical context.

### 8. Cron Usage Tracking
OpenClaw has `scripts/cron_usage_report.ts` — parses JSONL run logs to produce per-job, per-model token usage reports with input/output/cache breakdowns. Essential for identifying which cron jobs are most expensive.

**joelclaw equivalent**: No per-function token tracking. We can't currently measure which Inngest functions or gateway events cost the most.

### 9. Active Hours Window
`agents.defaults.heartbeat.activeHours: { start: "09:00", end: "22:00" }` — heartbeats only run during waking hours. No overnight token burn for a system nobody's watching.

**joelclaw equivalent**: Heartbeat runs 24/7. Sleep mode exists but is manual. Active hours would eliminate ~8 hours of heartbeat token spend automatically.

### 10. Cache Warming via Heartbeat Interval
If Anthropic cache TTL is 1h, setting heartbeat to 55min keeps the prompt cache warm — subsequent requests are cache reads (cheap) instead of cache writes (expensive). OpenClaw documents this explicitly in their token-use guide.

**joelclaw equivalent**: Not leveraging prompt caching at all. The gateway daemon doesn't configure `cacheRetention` or align heartbeat timing with cache TTL.

### 11. Model Fallback Chain
OpenClaw has a full model failover system — on 429/503/timeout, it falls to the next model in the chain. Subagent spawns can override the model. Context overflow errors are specifically excluded from fallback (switching to a smaller-context model on overflow would be counterproductive).

*Commit: `b8f66c260` — "Agents: add nested subagent orchestration controls and reduce subagent token waste"*

## Summary: Applicable Techniques for joelclaw

| Technique | Effort | Impact | Phase |
|-----------|--------|--------|-------|
| Pass-through delivery (no LLM for formatted events) | Medium | **Huge** | 1 |
| Heartbeat model demotion (Opus → Haiku) | Low | **High** | 1 |
| Active hours window (no overnight heartbeat) | Low | Medium | 1 |
| Heartbeat transcript pruning (HEARTBEAT_OK → prune) | Medium | Medium | 2 |
| Session pruning (trim old tool results) | Medium | Medium | 2 |
| Skill path compaction (~ instead of /Users/joel) | Low | Small | 1 |
| Bootstrap file truncation | Low | Small | 1 |
| Per-function token tracking | Medium | Diagnostic | 2 |
| Prompt cache warming (align heartbeat with TTL) | Low | Medium | 2 |
| Gateway → dumb router (full Opus removal) | High | **Huge** | 3 |
