---
status: implemented
date: 2026-02-20
decision-makers: Joel
consulted: Agent
tags:
  - gateway
  - notifications
  - architecture
---

# ADR-0071: Notification Triage Classes

## Context

joelclaw generates dozens of events per hour — deploys, emails, task changes, memory observations, content syncs, meeting analyses. Before this decision, the gateway had a binary choice: forward to the agent session (burning tokens and attention), or suppress entirely (losing visibility).

This created two failure modes:
1. **Noise fatigue** — every `front.message.received` interrupted the agent session individually, even newsletters. Joel was seeing 50+ low-value notifications per day on Telegram.
2. **Lost signal** — suppressed events were invisible. No way to know "3 deploys succeeded today" without checking Vercel directly.

The system needed a middle tier.

## Decision

Adopt a **three-tier bias-to-action triangle** for all gateway events:

### 🔺 Tier 1: Immediate

Forward to agent session now. These need a response or represent failures that compound if delayed.

- `vercel.deploy.error` — broken deploy, act now
- `todoist.comment.added` — Joel's direct instructions
- Loop failures (`agent/loop.story.failed`)
- `cron.heartbeat` — system pulse

### 🔸 Tier 2: Batched

Accumulate in Redis, flush as a single digest on hourly cadence. Worth knowing, not worth interrupting.

- `front.message.received` — inbound emails (triage runs on schedule)
- `front.message.sent` — outbound echo
- `front.assignee.changed` — assignment changes
- `todoist.task.created` — task flow
- `todoist.task.deleted` — task removal
- `vercel.deploy.succeeded` — success is the default
- `vercel.deploy.created` — deploy started
- `vercel.deploy.canceled` — deploy canceled
- `discovery.captured` — things saved for later
- `meeting.analyzed` — Granola meeting summaries

### ⬛ Tier 3: Suppressed

Drop silently. Zero signal — echoes, telemetry, confirmations.

- `todoist.task.completed` — echo from agent's own closes
- `memory.observed` — telemetry confirmation
- `content.synced` — vault sync confirmation

## Classification Heuristic

When adding a new event type, apply this test:

1. **Would Joel act on this in the next 10 minutes?** → Immediate
2. **Would Joel want to know this happened today?** → Batched
3. **Would Joel never look at this?** → Suppressed

Default for unknown event types is **Immediate** — fail toward visibility, not silence.

## Implementation

- **Triage logic**: `packages/gateway/src/channels/redis.ts` — three `Set<string>` constants, events sorted in `drainEvents()`
- **Batch accumulation**: Redis list `joelclaw:events:batch` — batched events RPUSH'd during drain
- **Digest flush**: `flushBatchDigest()` exported from redis.ts, called by hourly timer in `heartbeat.ts`
- **Digest format**: Grouped by type with counts — "3 emails received, 2 deploys succeeded" — not individual event details. Agent acknowledges briefly.

## Consequences

- **Token savings**: ~80% reduction in gateway prompt tokens. Most Front/Vercel events no longer trigger full agent turns.
- **Telegram noise**: Hourly digest replaces per-event notifications for batched types.
- **Visibility preserved**: Nothing is truly invisible — batched events surface in the digest, suppressed events log to console.
- **New events default to immediate**: Adding a new Inngest function that pushes to gateway will forward immediately until explicitly classified. This is intentional — new capabilities should be visible until proven noisy.
- **Digest may be empty**: If no batched events occur in an hour, no digest fires. The flush is a no-op.

## Related

- [ADR-0069](0069-gateway-proactive-notifications.md) — Gateway forwards responses to Telegram
- [ADR-0070](0070-telegram-rich-notifications.md) — Telegram Bot API upgrade (rich formatting, inline keyboards)
- [ADR-0018](0018-gateway-event-bridge.md) — Gateway event bridge architecture
