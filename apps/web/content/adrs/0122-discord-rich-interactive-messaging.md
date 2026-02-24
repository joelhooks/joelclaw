---
status: accepted
date: 2026-02-23
deciders: joel, panda
tags: [gateway, discord, ui]
depends-on: [ADR-0120]
---

# ADR-0121: Discord Rich & Interactive Messaging

## Context

ADR-0120 added thread-based conversations. But the Discord channel still only sends plain text. Discord is an interactive application platform — embeds, buttons, select menus, file attachments, stateful message updates. The gateway should use all of it.

[discordjs-react](https://github.com/AnswerOverflow/discordjs-react) provides a React reconciler for Discord — JSX components that render to Discord messages with stateful re-rendering on interaction. Button clicks trigger React state updates → message edits. This enables genuinely interactive Discord UIs.

## Decision

### Layer 1: Rich Envelope Rendering

Extend `OutboundEnvelope` with Discord-native structures:

- **Embeds** — colored cards with title, description, fields, images, footer, timestamp
- **Components** — buttons (Primary/Secondary/Success/Danger/Link), select menus, action rows
- **Files** — send file attachments inline
- **Reactions** — add emoji reactions to sent messages

The Discord channel's `send()` renders these using discord.js builders (`EmbedBuilder`, `ActionRowBuilder`, `ButtonBuilder`, `StringSelectMenuBuilder`).

Agent text responses get auto-formatted: long responses become embeds with proper markdown, code blocks stay as code blocks, structured output (lists, status updates) get field layouts.

### Layer 2: Interactive Components (discordjs-react)

For stateful interactive UIs, use `@answeroverflow/discordjs-react`:

- `DiscordJSReact` instance created alongside the Discord client
- Pre-built components: approval flows, selection prompts, status dashboards, loop monitors
- React state management → automatic message updates on interaction
- Renderer lifecycle managed (max instances, deactivation of old renderers)

### Interaction Routing

All Discord interactions (button clicks, select changes) route back through the gateway:

1. User clicks button / selects option in Discord
2. discordjs-react handles the interaction → component re-renders
3. If the interaction needs agent input, enqueue a prompt: `"[Discord interaction] User clicked 'Approve' on: {context}"`
4. Agent response routes back to the thread

### Component Library

Pre-built components in `packages/gateway/src/discord-ui/components/`:

- `AgentResponse` — formats agent text as embeds with proper Discord markdown
- `Approval` — yes/no with callback, updates message on click
- `SelectPrompt` — dropdown choices, enqueues selection to agent
- `StatusCard` — live-updating status embed (processing → done → error)
- `TaskList` — interactive task items with checkboxes
- `CodeBlock` — syntax-highlighted code in embeds
- `LoopMonitor` — live view of agent loop progress

## Consequences

- Discord becomes a first-class interactive UI surface, not just a text pipe
- Agent can trigger rich interactive UIs via structured output
- Button/select interactions are stateful — messages update in place
- Gateway gains React + react-reconciler as runtime dependencies (acceptable — bun handles JSX natively)
- Component library grows organically as use cases emerge
