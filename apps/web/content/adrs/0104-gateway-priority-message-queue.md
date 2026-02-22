---
status: proposed
date: 2026-02-22
decision-makers: Joel
---

# ADR-0104: Gateway Priority Message Queue

## Context

The gateway processes inbound messages FIFO from a single Redis Stream (`joelclaw:gateway:messages`). All message types — human Telegram messages, heartbeat events, batch digests, probe events, media notifications — compete equally for agent attention.

This causes:
1. **Human messages queued behind automated noise** — Joel sends a Telegram message but the agent is busy processing a heartbeat checklist or batch digest.
2. **Conversational context loss** — automated events interleave with human exchanges, causing the agent to lose the thread and repeat itself.
3. **Token waste** — low-value probes and routine heartbeats consume the same processing budget as high-value human requests.

Gateway session review (Feb 20–22) showed: 8 heartbeats/hour, duplicate probe events, Joel's messages delayed behind automated processing, and the agent asking about `content-strategy` three times because automated events broke the conversational flow.

### References
- *Serverless Architectures on AWS* (Ch.3): Priority queue pattern — fan-out by priority level with separate processing paths.
- *Site Reliability Engineering* (Google, Ch.21): Queue management, CoDel algorithm, LIFO for load shedding, starvation prevention.
- *Database Internals*: Priority queue re-sorts on insertion; highest priority at head.

## Decision

Implement a **multi-tier priority queue** in the gateway message store with starvation prevention.

### Priority Tiers

| Tier | Priority | Sources | Behavior |
|------|----------|---------|----------|
| P0 — Critical | Immediate | Human Telegram messages, `/` commands | Always processed next. Preempts queued lower-priority items. |
| P1 — Actionable | High | Gateway alerts (`friction-fix`, `deploy.failed`), callback queries | Processed after P0 drains. |
| P2 — Informational | Normal | Heartbeat results, batch digests, discovery captures, deploy succeeded | Processed after P1 drains, with starvation cap. |
| P3 — Noise | Low | Probe events (`test.gateway-e2e`), `media.processed` session dumps | Coalesced and batch-processed. Auto-acked if older than 60s. |

### Starvation Prevention

- **Aging promotion**: P2/P3 messages older than 5 minutes promote one tier.
- **Minimum drain rate**: Process at least 1 lower-priority message per 3 P0 messages (weighted fair queuing).
- **Coalescing**: Multiple P3 events within 60s collapse into a single summary message.
- **Auto-ack**: P3 events older than 60s are auto-acknowledged without agent processing.

### Message Deduplication

- Hash (source + content prefix) for inbound messages.
- Exact duplicates within 30s window are dropped with XDEL.
- Prevents the "push changes" ×3 and "let's do 1 at a time" ×2 patterns.

### Implementation

1. **Priority field on inbound messages** — `message-store.ts` assigns priority at persist time based on source classification.
2. **Priority-aware drain** — `drain()` in the gateway extension reads P0 first, then P1, P2, P3 with the starvation/aging rules.
3. **Redis implementation** — Use sorted sets (`ZADD`) with composite score (priority × 1e12 + timestamp) instead of plain streams for the priority queue. Keep the stream for persistence/replay.
4. **OTEL instrumentation** — Emit `message.queued`, `message.promoted`, `message.coalesced`, `message.auto_acked` events with priority and wait time.

### Classification Rules

```typescript
function classifyPriority(msg: InboundMessage): Priority {
  if (msg.source.startsWith('telegram:')) return Priority.P0
  if (msg.source === 'callback_query') return Priority.P0
  if (msg.event?.match(/deploy\.failed|friction-fix/)) return Priority.P1
  if (msg.event?.match(/test\.|media\.processed/)) return Priority.P3
  return Priority.P2
}
```

## Consequences

### Positive
- Human messages always get immediate attention.
- Automated noise doesn't break conversational flow.
- Token budget shifts from heartbeat processing to productive work.
- Starvation prevention ensures no message class is permanently ignored.

### Negative
- Adds complexity to message store (sorted set + stream dual storage).
- Priority classification rules need maintenance as new event types appear.
- Aging promotion could still surface stale content during busy periods.

### Risks
- Mis-classification of a critical automated event as P3 could delay response. Mitigation: default to P2 for unknown event types.
- Redis sorted set operations are O(log N) vs O(1) for streams. At gateway message volumes (~100/hour), this is negligible.

## Related

- ADR-0103: Gateway Session Isolation
- ADR-0038: Embedded Pi Gateway Daemon
- ADR-0018: Pi-native Gateway with Redis Event Bridge
