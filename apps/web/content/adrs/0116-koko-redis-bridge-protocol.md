---
status: proposed
date: 2026-02-23
parent: ADR-0115
---

# ADR-0116: Koko Redis Bridge Protocol

## Context

Koko needs to interoperate with joelclaw's existing event infrastructure without modifying it. The TypeScript stack uses Redis in three patterns:

1. **Pub/sub** — `PUBLISH joelclaw:gateway:events` for real-time notifications
2. **List queue** — `LPUSH joelclaw:gateway:events` for persistent event delivery (drained by gateway extension)
3. **Key/value** — Various `cache:*`, `cooldown:*`, `agent-loop:*` keys for state

Koko must be a **read-only observer** initially, then graduate to **claiming specific event types** without interfering with the existing gateway drain.

## Decision

### Phase 1: Passive observer (current)

Koko subscribes to `joelclaw:gateway:events` via `Redix.PubSub`. It receives the same PUBLISH notifications the gateway gets. It logs and learns. It does **not** consume from the LPUSH list — that's the gateway's job.

```
TypeScript stack → PUBLISH → Redis → Koko (observes)
                                    → Gateway (also observes + drains list)
```

### Phase 2: Dedicated channel

When Koko is ready to claim work, it gets its own channel:

- `joelclaw:koko:events` — LPUSH queue for Koko-specific work
- `joelclaw:koko:results` — Koko writes results here for TypeScript to consume
- TypeScript functions can fan out to Koko: `LPUSH joelclaw:koko:events <payload>`

```
TypeScript stack → LPUSH joelclaw:koko:events → Koko (claims + processes)
Koko → LPUSH joelclaw:koko:results → TypeScript (reads results)
```

### Phase 3: Bidirectional events

Koko can emit events that Inngest functions react to:

- Koko publishes to `joelclaw:gateway:events` (same channel TypeScript uses)
- Or Koko POSTs directly to Inngest's event API (`POST http://localhost:8288/e/<key>`)

### Message format

Same JSON envelope as existing events:

```json
{
  "type": "event.type.here",
  "data": { ... },
  "source": "koko",
  "timestamp": "2026-02-23T21:00:00Z"
}
```

The `source: "koko"` field lets both sides distinguish Koko-originated events from TypeScript-originated ones.

### What Koko does NOT touch

- Redis keys owned by the gateway (`joelclaw:gateway:*` except pub/sub observation)
- Agent loop state (`agent-loop:*`)
- Memory proposal state (`proposal:*`)
- Cache keys (`cache:*`) — Koko builds its own cache in ETS/Cachex

## Consequences

- Zero interference with existing stack — Koko is additive only
- Clear contract for when TypeScript wants to hand work to Koko
- `source: "koko"` prevents echo loops (Koko ignores its own events)
- Dedicated channel avoids race conditions with gateway list drain
