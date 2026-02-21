---
type: adr
status: proposed
date: 2026-02-21
tags:
  - gateway
  - telegram
  - slash-commands
  - ux
  - adr
related:
  - "0042-telegram-rich-replies-and-outbound-media"
  - "0069-gateway-proactive-notifications"
  - "0070-telegram-rich-notifications"
---

# ADR-0086: Telegram Slash Commands, Channel-Aware Formatting, and Rich Interactions

## Status

proposed

## Context

The gateway Telegram channel (`packages/gateway/src/channels/telegram.ts`, 764 lines) currently supports:

- Text messages routed to pi agent sessions through the command queue
- Inbound media download for photo/voice/audio/video/document into the Inngest media pipeline
- Outbound rich messaging with HTML formatting (`<b>`, `<i>`, `<code>`, `<pre>`, `<a>`, `<blockquote>`) and optional inline keyboards
- Callback query handling for inline buttons (`telegram/callback.received`)
- Reply threading and media send helpers

Related decisions already landed:

- ADR-0042 established rich Telegram replies, outbound media, and media pipeline integration
- ADR-0069 enabled proactive non-Telegram notifications routed to Telegram
- ADR-0070 proposed inline keyboard-rich notifications, but implementation is only partial

Current implementation gap analysis:

1. **No slash command bypass path**
Quick operations such as status checks still require full LLM round-trips. Commands like `/status`, `/runs`, and `/loops` should execute directly (local checks or direct Inngest event fire) and return in under 2 seconds.

2. **Outbound routing is channel-unaware**
`packages/gateway/src/outbound/router.ts` collects text deltas and calls `send(message: string)`. The Telegram channel `send()` supports `RichSendOptions` (`buttons`, `replyTo`, `silent`, `noPreview`), but the router has no structured payload path, so button metadata is dropped.

3. **No proactive button templates in gateway event payloads**
Inngest-originated notifications (health, email, task signals) currently send plain text prompts. They cannot attach structured actions even when a notification is inherently actionable.

## Decision

### 1. Add Slash Commands That Bypass Agent Sessions

The Telegram channel will register native commands via `bot.command()` and publish command menus via `setMyCommands()`.

Priority command set:

- `/status` -> local health summary (`joelclaw` CLI, target under 1s)
- `/runs` -> recent Inngest runs (local check)
- `/loops` -> agent loop status (local check)
- `/email` -> fire email triage event (async response)
- `/tasks` -> Todoist summary (async response)
- `/cal` -> today calendar summary (async response)
- `/vault <query>` -> vault search
- `/recall <query>` -> memory search
- `/send <event> [data]` -> fire arbitrary Inngest event
- `/network` -> live network status from Convex

Execution model:

- Synchronous commands run local checks and reply immediately in Telegram
- Asynchronous commands fire Inngest events and return immediate ack plus later callback result
- No pi session round-trip for command handlers unless explicitly delegated

### 2. Make Agent Responses Channel-Aware

Three approaches were evaluated:

- **Option A: Structured response markers in text stream**
Agent emits parseable marker blocks that the outbound router strips and converts into button metadata.
- **Option B: Channel metadata in session context**
Inject Telegram capability metadata into system/prompt context so formatting choices are channel-appropriate.
- **Option C: Post-processing layer between router and channel**
Deterministic rules inspect response payloads and attach actions/templates independent of LLM formatting compliance.

**Decision:** adopt **Option C as primary** for reliability and consistent production behavior, and **Option B as secondary** to improve formatting quality. Option A is deferred.

Implementation direction:

- Extend outbound payload model from `string` to structured message envelope
- Add formatter/policy layer that maps content + source to `RichSendOptions`
- Inject channel capabilities into session context for Telegram-originated turns

### 3. Add Notification Button Templates in Gateway Event Payloads

Inngest functions that emit gateway notifications will support button definitions in payload data.

Canonical payload shape:

```ts
{
  type: "system.health.degraded",
  payload: {
    prompt: "## 🚨 Health Degradation\n- ❌ Redis: down",
    buttons: [
      [{ text: "🔄 Restart", action: "restart:redis" }],
      [{ text: "🔇 Mute 1h", action: "mute:redis:3600" }]
    ]
  }
}
```

Gateway behavior:

- Preserve existing text-only compatibility
- If `buttons` exist, pass through to Telegram `send()` as inline keyboard rows
- Keep callback handling centralized in `telegram/callback.received`

### 4. Deliver in Four Phases

1. **Phase 1: Slash Commands (highest value, lowest risk)**
Implement `/status`, `/runs`, `/loops` with direct local execution and Telegram replies.

2. **Phase 2: Notification Button Templates**
Extend gateway event ingestion and outbound send path to honor payload button definitions.

3. **Phase 3: Channel-Aware Formatting**
Introduce post-processing formatter (Option C) and add channel capability context injection (Option B).

4. **Phase 4: Async Command Responses**
Add `/email`, `/tasks`, `/cal` async workflows using event fire + callback delivery.

## Consequences

### Positive

- Fast operational commands without LLM latency/cost
- Rich interactions become reliable in production (buttons actually render)
- Proactive alerts become actionable from Telegram without terminal context switching
- Cleaner separation between command execution, formatting policy, and agent conversation

### Negative

- More gateway complexity: command registry, formatter layer, and structured payload contracts
- Additional testing burden across sync/async command flows and callback lifecycle
- Potential command/event authorization risks if `/send` is not tightly scoped
- Slight drift risk between LLM-composed text and deterministic button attachment rules

## Implementation Plan

### Phase 1: Slash Commands

- Update `packages/gateway/src/channels/telegram.ts`:
  - Register native command handlers with `bot.command(...)`
  - Add command menu sync with `bot.api.setMyCommands(...)`
  - Implement `/status`, `/runs`, `/loops` local command executors
- Add minimal command execution helpers (shell wrappers with timeout + output formatting)
- Add tests for command authorization and happy-path responses

### Phase 2: Notification Button Templates

- Update gateway event-to-Telegram path in `packages/gateway/src/daemon.ts`
- Define shared payload typing for notification buttons
- Pass `buttons` into Telegram `send(chatId, message, options)`
- Add backward-compatible handling for existing plain-text events

### Phase 3: Channel-Aware Formatting

- Extend `packages/gateway/src/outbound/router.ts` to route structured outbound envelopes
- Add post-processing formatter/policy module for Telegram action attachment (Option C)
- Add channel capability context injection for Telegram-originated prompts (Option B)
- Add tests validating deterministic button attachment and no regression for console/other channels

### Phase 4: Async Command Responses

- Add async command handlers for `/email`, `/tasks`, `/cal`, `/vault`, `/recall`, `/send`, `/network`
- Fire Inngest events with correlation IDs and return immediate ack message
- Deliver async completion back into originating Telegram thread/chat
- Add timeout/error UX for long-running commands

## Verification

- [ ] `/status`, `/runs`, `/loops` return direct Telegram responses without creating pi session turns
- [ ] Event payloads with `buttons` render inline keyboards in Telegram
- [ ] Callback actions from proactive notifications emit `telegram/callback.received`
- [ ] Outbound router can pass structured options to Telegram sender
- [ ] Telegram-originated agent replies include channel context-aware formatting improvements
- [ ] ADR-0070 status is updated to `partially-implemented`

## ADR Updates

This ADR updates ADR-0070 from `proposed` to `partially-implemented` to reflect that rich Telegram send and callback infrastructure exist, while channel-aware routing and reliable button propagation are still incomplete.

## Credits

Slash command shape and Telegram native command registration patterns are informed by OpenClaw references:

- `~/Code/openclaw/openclaw/src/telegram/bot-native-commands.ts`
- `~/Code/openclaw/openclaw/src/telegram/button-types.ts`
