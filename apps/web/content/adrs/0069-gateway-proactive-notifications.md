---
type: adr
status: shipped
date: 2026-02-19
tags:
  - gateway
  - telegram
  - notifications
  - adr
---

# ADR-0069: Gateway Proactive Telegram Notifications

## Status

implemented

## Context

The gateway daemon routes assistant responses to their originating channel — if a message came from Telegram, the response goes back to Telegram. If it came from Redis (Inngest events, heartbeats, email triage), the response only went to the console log.

This meant Joel received **zero proactive notifications**. Codex task completions, email triage actions, system alerts, and task-related updates all completed silently. Joel only saw responses when he was actively conversing via Telegram — the system had no way to reach him unprompted.

The gateway was effectively one-way for non-Telegram sources: events came in, got processed, responses disappeared into stdout.

## Decision

Forward all non-Telegram assistant responses to Telegram as proactive notifications, with a single filter: suppress `HEARTBEAT_OK` responses (and variants under 300 chars that contain the token).

The routing logic in `daemon.ts` `message_end` handler now:
1. **Telegram-sourced**: route to originating chat (unchanged)
2. **Non-Telegram-sourced**: log to console AND forward to Joel's Telegram chat, unless the response is a heartbeat OK

No message prefix or transformation — the content speaks for itself. If it's "Archived." from email triage, Joel sees "Archived." If it's a multi-paragraph codex completion summary, Joel sees that.

## Consequences

### Positive
- Joel gets notified when codex tasks complete, email is triaged, system events fire
- Gateway becomes a true bidirectional communication channel
- No new infrastructure — reuses existing Telegram bot and `sendTelegram()` function
- Heartbeat suppression prevents 4+ messages/hour of "HEARTBEAT_OK" spam

### Negative
- Todoist completion webhooks create echo storms — closing 35 junk tasks generated 35 completion notifications that all hit Telegram. This is a known issue (the Todoist webhook echo pattern) and should be addressed separately with gateway-side dedup or webhook filtering.
- Email triage "Archived." messages are low-signal — may want to batch or suppress these in a future iteration
- No message-level priority system yet — a critical system alert looks the same as an archived newsletter notification

### Future Work
- **Priority tiers**: urgent (system down) → informational (task completed) → background (archived email). Different Telegram formatting or notification settings per tier.
- **Batching**: accumulate low-priority messages and send digest every N minutes instead of individual messages
- **Dedup**: suppress Todoist completion echoes for tasks the gateway agent just closed
- **Source tagging**: prepend `[email]` `[codex]` `[system]` to help Joel scan notifications quickly

## Implementation

Single change in `packages/gateway/src/daemon.ts`, `message_end` event handler. ~10 lines added to the else branch of the Telegram routing check.

```typescript
// Forward non-telegram responses to Telegram as proactive notifications
if (TELEGRAM_TOKEN && TELEGRAM_USER_ID) {
  const trimmed = fullText.trim();
  const isHeartbeatOk = trimmed === "HEARTBEAT_OK"
    || (trimmed.includes("HEARTBEAT_OK") && trimmed.length < 300);
  if (!isHeartbeatOk) {
    sendTelegram(TELEGRAM_USER_ID, fullText).catch(/* ... */);
  }
}
```
