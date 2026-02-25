# ADR-0124: Discord Thread-Forked Sessions

- **Status**: proposed
- **Date**: 2026-02-24
- **Supersedes**: Partially supersedes ADR-0123 (request-scoped routing) for Discord threads
- **Related**: ADR-0120 (Discord threads), ADR-0123 (channel routing)

## Context

The gateway currently runs a single pi session shared across all channels (Telegram, Discord, iMessage, Redis, CLI). ADR-0123 proposed request-scoped source tagging to prevent cross-channel confusion, but Discord threads naturally represent **separate conversational contexts** that deserve independent agent sessions.

Joel already runs 15–20 pi sessions routinely. Spinning up per-thread sessions is operationally normal, not a scaling concern.

## Decision

Adopt a **trunk + branch session model** for Discord:

### Trunk Session (always-on)
- The primary gateway pi session — the **safety thread**
- Handles: non-thread Discord messages, Telegram, iMessage, Redis events, webhooks, CLI
- Owns: identity, policy, guardrails, system memory
- Never replaced or forked — this is the canonical control plane

### Branch Sessions (per Discord thread)
- Each Discord thread forks a **new pi session** on first message
- Inherits a **minimal context bundle** from trunk:
  - Identity files (SOUL.md, IDENTITY.md, USER.md)
  - Active policy/guardrails from AGENTS.md
  - Channel-specific formatting instructions (see ADR-0125)
- Operates independently — own context window, own conversation history
- Lifecycle:
  - **Created**: on first user message in a new Discord thread
  - **Active**: while thread has activity
  - **Idle timeout**: 24h no activity → session suspended
  - **Archived**: thread closed or idle > 72h → session terminated, summary persisted

### Session Metadata

```typescript
interface ThreadSession {
  sessionId: string
  threadId: string
  parentSessionId: string  // trunk session ID
  lineage: "trunk" | "branch"
  channel: "discord"
  createdAt: number
  lastActivity: number
  status: "active" | "idle" | "archived"
}
```

### Session Registry

- Persist active thread→session mappings in Redis: `gateway:discord:threads:{threadId}` → session metadata
- Trunk session ID persisted at `~/.joelclaw/gateway.session` (existing behavior)

## Consequences

- Clean isolation: thread conversations don't leak into each other or trunk
- Natural UX: Discord thread = conversational boundary = session boundary
- Slightly higher resource usage (more pi sessions), but within normal operational range
- Trunk session stays clean and focused on cross-channel orchestration
- Thread summaries can flow back to trunk/memory on archive (optional, not required v1)

## Prior Art

### Kimaki (remorses/kimaki) — 485★
Discord bot orchestrating OpenCode coding agents. Thread = session model:
- `/session` starts new, `/resume` continues, `/fork` branches from any message
- `/queue` chains follow-up prompts while agent is working
- `/undo` / `/redo` reverts file changes from assistant messages
- Programmatic session creation from CI/cron (`npx kimaki send`)
- Voice transcription with project-aware context
- Each Discord channel = project directory, threads = sessions within
- **Key insight**: `/fork` from any message is a killer feature — branch the conversation at any point

### CordAI (cordai.gg)
Commercial Discord agent platform:
- Thread-per-session with 15min idle timeout
- Button bars for quick-start agent flows
- Director agents that route to specialist sub-agents
- `/my-sessions list` / `/my-sessions end` for lifecycle management
- Thread triggers: auto-create threads when users message specific channels

### OpenClaw v2026.2.15 (openclaw/openclaw) — 219k★
Just shipped Discord Components V2 support (Feb 16, 2026):
- Native rich interactive prompts: buttons, selects, modals, attachment-backed file blocks
- CV2 containers with accent colors, separators, sections
- Exec approval UX via Discord buttons (approve/deny tool execution)
- Nested sub-agents (`maxSpawnDepth`, `maxChildrenPerAgent`)
- Per-channel ack reaction overrides for platform-specific emoji
- `replyToMode` settings for routing interaction results back to agent

### Discord Components V2 (March 2025)
Discord's native layout system — replaces embeds for rich content:
- **Containers**: top-level layout with accent color bars, spoiler support
- **Sections**: text + accessory (button or thumbnail), up to 3 text items
- **TextDisplay**: markdown-formatted text blocks
- **MediaGallery**: image collections
- **Separators**: visual dividers with spacing control
- **40 component limit** (up from 25)
- Flag: `MessageFlags.IsComponentsV2` (`1 << 15`)
- discord.js: `ContainerBuilder`, `TextDisplayBuilder`, `SeparatorBuilder`, `SectionBuilder`

## Slash Commands (matching Telegram)

Adopt from Kimaki's proven set + our Telegram commands:

| Command | Description | Source |
|---------|-------------|--------|
| `/status` | System health | Telegram parity |
| `/recall <query>` | Search memory | Telegram parity |
| `/runs` | Recent Inngest runs | Telegram parity |
| `/session` | Current session info | Telegram parity |
| `/restart` | Restart gateway session | Telegram parity |
| `/fork` | Branch from a message | Kimaki |
| `/queue <prompt>` | Queue follow-up while busy | Kimaki |
| `/resume` | Resume previous session | Kimaki |
| `/abort` | Stop current operation | Kimaki |

## Thread Naming

Threads auto-created by the bot get named from the first message, which is often vague. The bot MUST rename threads as the conversation focus clarifies:

- After 2-3 exchanges, call `thread.setName()` with a descriptive 3-8 word title
- Update the name if the conversation topic shifts significantly
- Same principle as `name_session` in pi — reflect what's actually being discussed
- Bot has admin permissions, so `setName()` always succeeds

## Forum Channel Support

The bot can post to Discord forum channels (`ForumChannel.threads.create()`):

- **Forum channel**: `<internal-discord-forum-channel-id>` (configured, bot has admin access)
- **Default channel**: `<internal-discord-default-channel-id>` (main text channel for general messages)
- Forum posts are structured threads with a name + initial message body
- Use for: persistent reference content (ADR reviews, system status, loop results, session summaries)
- Forum posts follow the same branch session model — each forum thread gets its own session

### Forum Posting API

```typescript
// Gateway creates forum post
const thread = await forumChannel.threads.create({
  name: 'Gremlin ADR Review — Architecture Gaps',
  message: { content: '## Review Summary\n...' },
  appliedTags: [],  // optional forum tags
})
```

## Emoji Reaction Support

Full emoji reaction support — both receiving and sending.

### Receiving Reactions (User → Bot)

The bot monitors `MessageReactionAdd` on all visible messages. Two tiers:

**Tier 1 — Deterministic reactions** (no LLM needed, instant response):

| Emoji | Action |
|-------|--------|
| 👀 | Bot acks with 👀 back — "I see you" |
| 🔄 | Regenerate/retry the bot's response |
| 🗑️ | Delete the bot's message |
| 📌 | Save message content to vault as discovery |
| 🧠 | Capture to memory (observation) |
| ✅ | Approve/confirm (existing exec approval) |
| ❌ | Cancel/reject current operation |
| 👍/👎 | Feedback signal — logged to telemetry |

**Tier 2 — Intent-parsed reactions** (LLM interprets):

Any emoji not in Tier 1 gets sent to the agent session as context:
```
Joel reacted with 🤔 to message: "[message content preview]"
```

The agent interprets the reaction in conversation context and responds appropriately. No separate Haiku call needed — the session model already has full context. Use Haiku-4.5 only if reaction parsing needs to happen outside a session (e.g., trunk is busy).

### Sending Reactions (Bot → User)

The bot can react to user messages as lightweight acknowledgment:
- 👀 — "processing your message"
- ✅ — "done"
- 🔥 — positive signal / appreciation
- ⏳ — "working on it, will take a moment"

Bot reactions replace text responses when a full reply isn't warranted.

### Implementation

```typescript
// Expand existing handleReaction in discord.ts
async function handleReaction(reaction: MessageReaction, user: User) {
  if (user.bot) return  // ignore bot reactions

  const emoji = reaction.emoji.name
  const message = reaction.message

  // Tier 1: deterministic
  switch (emoji) {
    case '🔄': return regenerateResponse(message)
    case '🗑️': return message.delete()
    case '📌': return captureDiscovery(message)
    case '🧠': return captureObservation(message)
    case '❌': return cancelOperation(message)
    case '👍': case '👎': return logFeedback(emoji, message)
    case '👀': return message.react('👀')
  }

  // Tier 2: send to agent session as context
  await routeToSession({
    type: 'reaction',
    emoji,
    messageContent: message.content?.slice(0, 200),
    messageId: message.id,
    threadId: message.channel.isThread() ? message.channel.id : undefined,
  })
}
```

## Ack-Before-Work for Thread Creation

When the bot creates or enters a new thread (including forum posts), it MUST send an immediate acknowledgment before doing any heavy work:

```
Starting thread — loading context for [topic]...
```

This prevents the "hung" perception Joel reported when thread startup is slow due to context loading.

## Implementation

1. Add `ThreadSessionManager` to gateway Discord channel handler
2. On thread message: check Redis for existing session, create if missing
3. Route thread messages to branch session instead of trunk
4. Add idle reaper (cron or lazy check on next message)
5. Store session metadata in Redis with TTL
6. Adopt Discord Components V2 for rich responses (containers, sections, buttons)
7. Register slash commands via Discord Application Commands API
8. Add `thread.setName()` call after 2-3 exchanges with descriptive title
9. Add forum channel posting support (`ForumChannel.threads.create()`)
10. Add immediate ack on thread entry/creation to prevent perceived hangs
