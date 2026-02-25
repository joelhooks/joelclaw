---
status: shipped
date: 2026-02-25
decision-makers: Joel Hooks
consulted: Panda (pi session)
related:
  - "[ADR-0038 — Embedded pi gateway daemon](0038-embedded-pi-gateway-daemon.md)"
  - "[ADR-0091 — Gateway model fallback](0091-gateway-model-fallback.md)"
  - "[ADR-0037 — Layered watchdog](0037-gateway-watchdog-layered-failure-detection.md)"
---

# Gateway context overflow auto-recovery with compression summary

## Context and Problem Statement

On 2026-02-25, the gateway daemon became completely unresponsive via Telegram for hours. Every inbound message was received, persisted to the Redis stream, and "resolved" (acked) — but the actual API call failed with `400: prompt is too long: 350k tokens > 180k maximum`. The session had ballooned to 35MB / 15,276 entries.

The existing failure handling didn't catch this:
- **Model fallback (ADR-0091)** switches providers on API errors, but context overflow isn't a provider problem — every model has a context limit.
- **Watchdog (ADR-0037)** detects missing heartbeats, not silent prompt failures.
- **Compaction settings** existed (`reserveTokens: 20000, keepRecentTokens: 10000`) but couldn't keep pace with the accumulation rate, especially when every failed turn added entries without any successful output to anchor compaction.

The result was a silent black hole: messages went in, nothing came out, no alerts fired.

## Decision

Add context overflow detection and auto-recovery to the gateway command queue:

### Detection

Match `prompt is too long` or `maximum context length` in API error responses. This is distinct from model fallback errors — overflow requires session-level recovery, not model swaps.

### Two-stage recovery

1. **Stage 1 — Aggressive compaction**: On first overflow, call `session.compact()` with instructions to aggressively summarize. Re-enqueue the failed message. If the next prompt succeeds, we're recovered.

2. **Stage 2 — New session with compression summary**: If compaction doesn't fix it (second consecutive overflow), build a local compression summary from the dying session's JSONL entries, create a fresh session, inject the summary as the first message, and replay the failed message.

### Compression summary (local, no LLM)

The summary is built without an LLM call — because the whole problem is we can't reach the API with the current context. It extracts from the session entries:
- Last 5 user messages (truncated to 300 chars each)
- Last 3 assistant responses (truncated to 500 chars each)  
- Last active channel (parsed from channel headers)
- Framing text telling the agent it's recovering from an overflow

This preserves enough conversational continuity for the agent to resume without confusion, while staying well within any model's context window.

### Notification

Telegram alert sent to Joel on stage 2 recovery (new session). Includes entry count from the previous session.

### OTEL

- `queue.context_overflow.detected` — overflow error matched
- `queue.context_overflow.compacted` — stage 1 compaction attempted
- `queue.context_overflow.new_session` — stage 2 new session created (includes `hasSummary`, `summaryLength`)
- `queue.context_overflow.recovery_failed` — recovery itself threw
- `daemon.context_overflow.recovery` — summary built and delivered

## Consequences

### Prevented
- Hours-long silent gateway outages from context bloat
- Manual intervention to archive sessions and restart daemon
- Lost messages that were acked from the stream but never responded to

### Accepted tradeoffs
- The compression summary is lossy — recent messages are truncated, older context is gone entirely
- The new session loses tool state, extension state, and any in-flight context the agent was building
- Stage 1 compaction adds latency (~10-30s) before the retry
- If the LLM call for compaction itself fails (because the session is too big even for a compaction prompt), we fall through to stage 2 immediately on the next attempt

### Future improvements
- Proactive compaction when context usage approaches 70% of model limit (prevent overflow rather than recover)
- Richer compression summary that extracts file operations, tool state, and active task context
- Metrics on overflow frequency to tune compaction aggressiveness
