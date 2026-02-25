---
type: adr
status: proposed
date: 2026-02-24
tags: [adr, gateway, operations, noise-reduction]
deciders: [joel]
related: ["0038-embedded-pi-gateway-daemon", "0104-gateway-priority-message-queue", "0131-unified-channel-intelligence-pipeline"]
---

# ADR-0134: System Sleep Mode

## Status

proposed

## Context

The gateway processes events continuously — Slack messages, heartbeats, subscription updates, batch digests, webhook notifications. When Joel is heads-down on focused work (egghead ops, coding, calls), these events burn context tokens and fragment attention without adding value.

Current state: every event hits the gateway session immediately. There's no way to say "I'm busy, queue this for later."

### Pain Points

- Slack channel intel arrives as individual messages, each consuming a turn
- Heartbeats and batch digests fire on schedule regardless of activity
- Subscription updates (Simon Willison, etc.) arrive whenever content is published
- All of this competes for context window with actual work

## Decision

Add a **sleep/wake toggle** that queues non-critical events for batch delivery on wake.

### Mechanics

**Sleep activation:**
- `joelclaw sleep` CLI command (or Telegram `/sleep`)
- Sets Redis key `system:sleep` = `{ since: ISO8601, reason?: string }`
- Optional duration: `joelclaw sleep --for 2h` sets a TTL

**During sleep:**
- Gateway middleware checks `system:sleep` before delivering events
- **Queued** (stored in Redis list `sleep:queue`): Slack messages, subscription updates, batch digests, book downloads, non-critical webhook events
- **Pass-through** (always delivered): VIP DM escalations (ADR-0132), deploy failures, system health alerts, direct Telegram messages from Joel
- Each queued item stored as JSON: `{ event, timestamp, source, summary? }`

**Wake:**
- `joelclaw wake` CLI command (or Telegram `/wake`, or TTL expiry)
- Deletes `system:sleep` key
- Reads all items from `sleep:queue`
- Synthesizes a single **curated digest** using pi inference:
  - Groups by source (Slack, subscriptions, system)
  - Highlights actionable items
  - Summarizes noise into counts ("14 Slack messages across 6 channels, nothing actionable")
  - Surfaces anything that looks time-sensitive
- Delivers digest as one gateway message
- Clears the queue

### Event Classification

| Category | During Sleep | Examples |
|----------|-------------|----------|
| Critical | Pass-through | VIP DM (ADR-0132), deploy failure, system health alert |
| From Joel | Pass-through | Telegram message, Discord message from Joel |
| Operational | Queued | Heartbeat, batch digest, subscription update |
| Intelligence | Queued | Slack channel messages, webhook events |
| Background | Queued silently | Book downloads, docs ingest, content sync |

### Gateway Middleware Change

In `packages/system-bus/src/inngest/middleware/gateway.ts`:

```typescript
async function shouldDeliver(eventName: string): Promise<boolean> {
  const sleepState = await redis.get("system:sleep");
  if (!sleepState) return true; // not sleeping

  // Always deliver critical events
  const PASSTHROUGH = [
    "vip/",           // VIP escalations
    "deploy.failed",  // Deploy failures  
    "system/health",  // Health alerts
    "telegram/",      // Direct from Joel
    "discord/",       // Direct from Joel
  ];
  
  if (PASSTHROUGH.some(p => eventName.startsWith(p))) return true;
  
  // Queue everything else
  await redis.rpush("sleep:queue", JSON.stringify({
    event: eventName,
    timestamp: new Date().toISOString(),
    data: /* event summary */,
  }));
  
  return false;
}
```

### Wake Digest Example

```
🌅 Wake Digest — slept 2h14m (3:00 PM → 5:14 PM)

Slack (18 messages, 7 channels):
- #G01NK427ZE2: Kent confirmed EpicWeb pricing (40%→20%), Nicoll replying to customers
- #G01J1QVJVNE: Purchase bug resolved, licenses showing correctly
- #C0211NSK3TP: Matt testing video upload fix from PR #261
- 4 other channels: routine, nothing actionable

Subscriptions (2):
- Simon Willison: "Linear walkthroughs" — agent code documentation pattern
- (1 other, low signal)

System (5):
- 2 deploys succeeded
- 1 heartbeat OK
- DDIA downloaded to pdf-brain
- 14 docs queued for ingest

No action needed on any queued item.
```

## Implementation

1. Add `system:sleep` Redis key management to gateway middleware
2. Add `sleep` and `wake` commands to `joelclaw` CLI
3. Add pass-through classification in gateway event bridge
4. Build wake digest synthesis using `infer()` utility (pi sessions)
5. Add Telegram `/sleep` and `/wake` slash commands
6. Optional: auto-sleep during calendar events (future)

## Consequences

### Positive
- Focused work sessions without context pollution
- Wake digest is higher signal than real-time drip (synthesis > raw events)
- Reduces gateway token burn during inactive periods
- Joel controls when to engage with system noise

### Negative
- Risk of missing time-sensitive items if classification is wrong
- Wake digest synthesis adds ~30s latency on wake
- Another Redis key to manage (but simple — single key + list)

### Risks
- VIP DM arrives during sleep but isn't classified as pass-through → missed escalation. Mitigation: ADR-0132 escalation ladder runs independently of sleep state.
- Very long sleep accumulates large queue → wake digest truncation. Mitigation: cap queue at 200 items, oldest items get count-only summary.
