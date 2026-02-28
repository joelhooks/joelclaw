# ADR-0160: Telegram Streaming UX

**Status:** Accepted  
**Date:** 2026-02-27  
**Deciders:** Joel, Panda  
**Tags:** #gateway #telegram #ux #streaming

## Context

The gateway sends AI assistant responses to Telegram only after the full response is generated. For complex queries this means 10-30 seconds of silence with just a typing indicator, then a wall of text. Modern chat UX (ChatGPT, Claude) streams tokens progressively.

## Decision

Implement progressive streaming for Telegram responses:

1. **Typing indicator** while waiting for first tokens
2. **Progressive text updates** via `sendMessage` + `editMessageText` with a cursor (`▌`)
3. **Tool status indicators** (🔧 running command…, 📖 reading file…) inline during tool calls
4. **Clean final message** with full markdown→HTML formatting on completion

### Streaming Path: Plain Text (No parse_mode)

During streaming, send **raw plain text** without `parse_mode` or entities. This avoids:
- Expensive markdown→HTML conversion on every throttled edit (~800ms)
- Broken HTML tags when truncating for the 4096 char limit
- HTML escaping issues with `<`, `>`, `&` in partial code blocks

On `finish()`, the final edit converts to HTML once for the polished message.

### Design Notes

- Throttled edits at 800ms intervals to respect Telegram rate limits
- Minimum 20 chars before first send (avoids tiny fragment → immediate edit)
- Auto-restart for multi-message turns (tool calls produce multiple message_end events)
- Overflow chunks use `TelegramConverter.chunk()` for HTML-aware splitting
- If streaming never sent a message (very short response), falls through to normal send path

## Alternatives Considered

### Entity-based formatting (Telegraf FmtString pattern)
Send `entities: MessageEntity[]` instead of `parse_mode: "HTML"`. Requires building a markdown→entities converter (offset-based formatting). More correct but significantly more code for marginal UX improvement during streaming — users don't need formatted text while it's still being typed.

### HTML during streaming
Original implementation. Works but causes issues: broken tags on truncation, conversion overhead on every edit, escape bugs with partial content.

## Consequences

- Users see response text appear progressively instead of waiting for completion
- Tool calls are visible as they happen (transparency)
- Streaming messages are unformatted; final message gets full formatting
- Module: `packages/gateway/src/telegram-stream.ts`
- Wired into daemon.ts via session event subscription
