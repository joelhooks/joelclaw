---
status: shipped
date: 2026-02-23
deciders: joel
tags:
  - gateway
  - architecture
  - channels
---

# ADR-0123: Request-Scoped Channel Routing

## Context

The gateway daemon runs a single shared pi session that receives messages from 6+ channels: Telegram, Discord, iMessage, Redis events, CLI, and webhooks. Each message has a `source` string (e.g., `telegram:<chat-id>`, `discord:<channel-id>`, `imessage:<phone-or-handle>`).

Currently, `currentSource` is a **module-global variable** in `command-queue.ts` that gets set when a message is dequeued and cleared after the response completes. This worked when there was one channel (Telegram + Redis). With 6+ channels, it breaks:

- If a Discord message arrives while a Telegram response is mid-generation, `currentSource` gets overwritten
- Tool calls (MCQ, notify) read `getCurrentSource()` at call time — which may return the wrong channel
- The outbound router uses `getCurrentSource()` to decide where to send responses — wrong source = wrong channel
- MCQ overrides (Discord buttons vs Telegram inline keyboards) dispatch based on source prefix — stale source = wrong UI

This has been observed in practice: MCQ calls from Discord falling through to the terminal handler, responses routing to the wrong channel.

## Decision

Replace the global `currentSource` with **request-scoped source context** threaded through the entire request lifecycle.

### Design

**1. Request object carries source**

Each entry in the command queue already has a `source` field. Instead of copying it to a global, keep it on the request object and pass it through the processing pipeline.

```typescript
// command-queue.ts
type ActiveRequest = {
  id: string;
  source: string;
  enqueuedAt: number;
  prompt: string;
};

let activeRequest: ActiveRequest | undefined;

export function getActiveSource(): string | undefined {
  return activeRequest?.source;
}
```

**2. Serial processing guarantee**

Pi processes one prompt at a time. Enforce this: do NOT dequeue the next message until the current request's response is fully delivered, including all tool call completions. The priority queue (ADR-0104) already respects this — formalize it.

**3. Tool calls inherit request source**

When the gateway's `withChannelMcqOverride` intercepts a tool call, it reads from `getActiveSource()` instead of `getCurrentSource()`. Since processing is serial, the active request is always the one that triggered the tool call.

**4. Outbound router reads active request source**

`outbound/router.ts` reads `getActiveSource()` for response routing. Falls back to `"console"` only if no active request (e.g., proactive notifications from Inngest events — those use explicit source from the event payload).

**5. Proactive notifications use explicit source**

Gateway middleware's `notify/alert/progress` already take a target channel. These bypass the request context entirely — they specify their destination explicitly. No change needed.

### Migration

1. Rename `currentSource` → `activeRequest` in `command-queue.ts`
2. Update `getCurrentSource()` → `getActiveSource()` (keep old name as deprecated alias temporarily)
3. Update `outbound/router.ts` to use `getActiveSource()`
4. Update MCQ overrides to use `getActiveSource()`
5. Add guard: `dequeue()` returns null if `activeRequest` is still set (prevents interleaving)
6. Add OTEL event on source mismatch detection (request source ≠ expected channel)

### Non-goals

- Session-per-channel isolation (too expensive, unnecessary if serial processing holds)
- Parallel message processing (pi is inherently serial)
- Channel-specific agent personality (all channels share one agent identity)

## Consequences

- **Positive**: Responses always route to the correct channel. MCQ renders in the right UI. No more cross-channel confusion.
- **Positive**: Minimal code change — replacing one global with a request-scoped equivalent.
- **Positive**: OTEL mismatch events catch regressions early.
- **Negative**: Messages queue up if one channel's response is slow (already true today, just formalized).
- **Risk**: If serial guarantee breaks (e.g., pi adds parallel tool execution), source tracking needs to become truly request-scoped via AsyncLocalStorage or similar.
