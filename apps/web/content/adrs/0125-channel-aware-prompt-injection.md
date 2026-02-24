# ADR-0125: Channel-Aware Prompt Injection & Platform Formatting

- **Status**: proposed
- **Date**: 2026-02-24
- **Related**: ADR-0124 (thread-forked sessions), ADR-0120 (Discord threads), ADR-0086 (Telegram slash commands)

## Context

The gateway serves responses across multiple platforms (Telegram, Discord, iMessage, CLI, Redis) but currently has no mechanism to adapt output formatting per channel. Discord supports embeds, buttons, threads, and rich markdown. Telegram supports inline keyboards, HTML/markdown, and slash commands. iMessage is plain text. The agent doesn't know which platform it's talking to unless told.

Additionally, Discord lacks the slash command infrastructure that Telegram already has (ADR-0086).

## Decision

### 1. Channel Context Injection

Intercept every user turn entering a gateway session and prepend a **channel context block** to the prompt:

```
---
Channel: discord (thread: #koko-shadow-executor)
Date: Monday, February 24, 2026 at 10:30 PM PST
Platform capabilities: embeds, buttons, threads, reactions, code blocks, file attachments
Formatting guide: See below
---
```

This block is injected by the gateway before the message reaches the pi session, so every response is channel-aware without the agent needing to remember.

### 2. Platform Formatting Cheat Sheets

Maintain a per-platform formatting reference that gets injected with the channel context:

#### Discord Cheat Sheet (Components V2 — March 2025+)
- Use **Components V2 containers** for structured responses (accent color, sections, separators)
- Use **Sections** for text + accessory (button or thumbnail), up to 3 text items per section
- Use **TextDisplay** for markdown-formatted text blocks within containers
- Use **MediaGallery** for image collections
- Use **Separators** for visual dividers between content blocks
- Use **buttons** for actionable choices (ButtonBuilder in ActionRow, inside containers)
- Use **code blocks** with language hints for technical output
- Max message length: 2000 chars (use containers/attachments for longer)
- 40 component limit per message (up from 25)
- Flag: `MessageFlags.IsComponentsV2` required
- Reactions for lightweight acknowledgment
- Thread replies to keep context grouped
- **No markdown tables** — use container sections or code blocks instead
- Legacy embeds still work but Components V2 is strictly better for layout control

#### Telegram Cheat Sheet
- Use **inline keyboards** for choices/actions
- HTML formatting: `<b>`, `<i>`, `<code>`, `<pre>`
- Max message length: 4096 chars
- Use `/commands` for structured interactions
- Reply markup for interactive flows

#### iMessage Cheat Sheet
- Plain text only — no formatting
- Keep messages short (phone screen)
- Use line breaks for structure
- No interactive elements

#### CLI Cheat Sheet
- Full markdown supported
- Code blocks with syntax highlighting
- No interactive elements beyond MCQ
- No length limit (terminal scrollback)

### 3. Discord Slash Commands

Mirror the Telegram slash command set (ADR-0086) for Discord:

| Command | Description |
|---------|-------------|
| `/status` | System health summary |
| `/recall <query>` | Search agent memory |
| `/runs` | Recent Inngest runs |
| `/session` | Current session info |
| `/restart` | Restart gateway session |
| `/health` | Quick health check |
| `/schedule <prompt>` | Schedule a deferred task |
| `/loop` | Agent loop status |

Implementation: Register as Discord Application Commands (guild-scoped). Route through the same command handler as Telegram but with Discord-native response formatting.

### 4. Injection Point

The injection happens in the gateway's message processing pipeline:

```
User message arrives
  → Identify channel (discord/telegram/imsg/cli/redis)
  → Prepend channel context + date + cheat sheet
  → Forward to pi session
  → Response comes back (already platform-formatted)
  → Deliver via channel-native transport
```

For branch sessions (ADR-0124), the channel context is injected once at session creation and refreshed on each turn (date updates).

## Consequences

- Every agent response is platform-native without manual prompting
- Consistent UX across channels — embeds on Discord, keyboards on Telegram, plain text on iMessage
- Cheat sheets are maintainable as standalone docs (update once, all sessions benefit)
- Slight token overhead per turn (cheat sheet injection), but small relative to conversation context
- Discord gets first-class interactive capabilities matching Telegram
- New channels can be added by writing a cheat sheet + registering in the injection map

## Implementation

1. Create `packages/gateway/src/formatting/` with per-platform cheat sheet files
2. Add `injectChannelContext()` to gateway message pipeline (before pi session)
3. Register Discord slash commands via Discord Application Commands API
4. Route Discord slash commands through existing command handler (with format adaptation)
5. Add cheat sheet hot-reload (watch files, no restart needed)
