---
type: adr
status: proposed
date: 2026-02-19
tags:
  - gateway
  - telegram
  - notifications
  - ux
  - adr
---

# ADR-0070: Telegram Rich Notifications with Inline Keyboards

## Status

proposed

## Context

ADR-0069 added proactive Telegram notifications — the gateway now forwards system events, email triage results, and codex completions to Joel's phone. But messages are plain text dumps with no interactivity. Joel receives a notification about an email and has to switch to a terminal to act on it.

The Telegram Bot API supports rich message features we're not using:

- **Inline keyboards** — buttons attached to messages with callback data
- **HTML formatting** — `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a>`, `<blockquote>`
- **Message editing** — update sent messages (replace buttons with results)
- **Callback queries** — handle button presses with `answerCallbackQuery`
- **Silent notifications** — `disable_notification: true` for low-priority
- **Link preview control** — `disable_web_page_preview` to keep messages compact

The gateway already uses Grammy (Telegram bot framework) with webhook-based message handling. Extending it to support inline keyboards and callbacks is natural.

## Decision

### 1. Rich send function

Extend `telegram.send()` to accept options for inline keyboards, formatting, and notification priority:

```typescript
interface TelegramSendOptions {
  replyTo?: number;
  buttons?: InlineButton[][];     // rows of buttons
  silent?: boolean;               // disable_notification
  noPreview?: boolean;            // disable_web_page_preview
}

interface InlineButton {
  text: string;
  action: string;                 // callback_data (max 64 bytes)
  url?: string;                   // URL button (mutually exclusive with action)
}
```

### 2. Callback query handler

Add `bot.on("callback_query:data")` handler that:
1. Parses `callback_data` (format: `action:context`, e.g. `archive:cnv_123`)
2. Immediately calls `answerCallbackQuery` (required within 10s or button shows loading)
3. Fires an Inngest event (`telegram/callback.received`) with action + context
4. Edits the original message to show result ("✅ Archived")

### 3. Notification templates by event type

| Event Type | Format | Buttons |
|---|---|---|
| `front.message.received` (email) | Sender, subject, preview | [Archive] [Flag] [Reply Later] |
| `memory/proposal.triaged` | Section, change summary | [Approve] [Reject] |
| `codex/task.completed` | Task summary, duration | [View] |
| `system/alert` | Service, error | [Ack] [Investigate] |
| `todoist.task.completed` | (suppressed — echo) | — |

### 4. Priority tiers

| Tier | `disable_notification` | Examples |
|---|---|---|
| 🔴 urgent | `false` (audible) | System down, failed deploys |
| 🟡 actionable | `false` | Email needing reply, memory proposals |
| 🟢 informational | `true` (silent) | Receipts, archives, heartbeat OK |

## Consequences

### Positive
- Joel can act on emails, proposals, and alerts directly from Telegram
- No context-switching to terminal for routine triage
- Message editing provides visual confirmation of actions taken
- Silent notifications prevent low-priority spam from buzzing the phone
- Callback data flows through Inngest — full observability and retry semantics

### Negative
- Callback data max 64 bytes — need compact encoding for context IDs
- Must always `answerCallbackQuery` within 10s or UX degrades (loading spinner)
- Webhook now processes two update types (messages + callbacks) — slightly more complex
- Button actions are fire-and-forget from user perspective — need good visual feedback via message editing

### Future Work
- **Reaction-based triage** — use Telegram reactions (👍/👎) for quick yes/no
- **Threaded conversations** — reply to notification to add context (e.g., reply to email notification to draft response)
- **Media attachments** — send screenshots of dashboards, charts
- **Command menu** — register bot commands (`/status`, `/email`, `/tasks`) via BotFather

## Implementation Plan

Phase 1: Rich send + callback handler infrastructure
Phase 2: Email notification buttons (highest frequency, highest value)  
Phase 3: Memory proposal buttons
Phase 4: Priority tiers + silent notifications
Phase 5: System alert buttons
