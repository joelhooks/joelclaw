---
type: adr
status: proposed
date: 2026-02-20
tags: [adr, cost, gateway, tokens, architecture]
deciders: [joel]
---

# ADR-0079: Opus Token Reduction Across joelclaw

## Status

proposed

## Context

The joelclaw system burns Opus tokens at an alarming rate. The central gateway daemon runs `claude-opus-4-20250514` with `thinking:low` and every inbound event — heartbeat, media notification, email triage result, Todoist echo, content sync — gets turned into a prompt that hits Opus for inference.

### Current Token Burn Points

| Component | Model | Trigger | Frequency | Token Impact |
|-----------|-------|---------|-----------|-------------|
| **Gateway daemon** | Opus 4 (thinking:low) | Every non-suppressed event | ~50-100/day | **HUGE** — full session context + event prompt |
| **Gateway heartbeat** | Opus 4 (thinking:low) | Hourly cron | 24/day | Large — reads HEARTBEAT.md checklist |
| VIP email analysis | Opus 4.1 | Inbound VIP email | ~5-10/day | Medium — full email analysis |
| Media vision-describe | Haiku | Photo/video received | ~5/day | Small — Haiku is cheap |
| Observer (memory) | Haiku | Session compaction | ~5-10/day | Small |
| Reflector (memory) | Haiku | After observation | ~5-10/day | Small |
| Batch review (memory) | Haiku | Hourly | 24/day | Small |
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
