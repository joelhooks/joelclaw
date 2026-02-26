---
status: deferred
date: 2026-02-23
deciders: joel, panda
tags: [gateway, discord, ui, interactive]
depends-on: [ADR-0120]
---

# ADR-0122: Discord Rich & Interactive Messaging via discordjs-react

## Context

ADR-0120 added thread-based Discord conversations. But the channel only sends plain text. Discord is an interactive application platform — embeds, buttons, select menus, stateful message updates. React components make an excellent substrate for composable, interactive Discord UIs. MCQs (multiple-choice questions) are the first concrete use case: the agent needs Joel to choose between options, and Discord renders that as interactive buttons that update in place.

[discordjs-react](https://github.com/AnswerOverflow/discordjs-react) provides a React reconciler for Discord — JSX components render to Discord messages with stateful re-rendering on interaction. `useState` in a button handler actually updates the Discord message.

## Decision

### New package: `@joelclaw/discord-ui`

Separate monorepo package (`packages/discord-ui/`) isolates React + react-reconciler + discordjs-react deps from the gateway's core. Gateway imports via workspace dependency.

Two entry points:
- `@joelclaw/discord-ui` — .ts API surface (no jsx required by consumer). Runtime init, async render helpers.
- `@joelclaw/discord-ui/jsx` — .tsx entry point for consumers with jsx configured. Direct component imports.
- `@joelclaw/discord-ui/components` — component library re-exports + discordjs-react primitives.

### Component Library

Initial components:
- **McqFlow** — Sequential multiple-choice with buttons, recommended badges, auto-select timeout
- **AgentResponse** — Rich embed formatting for agent text output with optional action buttons
- **StatusCard** — Live-updating status embed (processing → done → error) with cancel button
- **Approval** — Yes/No confirmation with in-place update
- **SelectPrompt** — Dropdown selection menu with descriptions

Re-exports discordjs-react primitives (Embed, Button, ActionRow, Select, Option, Link) for custom components.

### MCQ Adapter

Parallel to the existing Telegram MCQ adapter. When the agent calls the MCQ tool from a `discord:*` source:

1. Discord MCQ adapter intercepts (via unified `withChannelMcqOverride`)
2. Renders `McqFlow` component to the thread via `renderMcqToChannel()`
3. User clicks buttons → React state updates → message edits in place
4. Answers resolve back to the agent as tool result

### Gateway Integration

- `initDiscordUI(client)` called after Discord login
- `registerDiscordMcqAdapter(fetchChannel)` registers the adapter
- Dynamic import of `@joelclaw/discord-ui` keeps React out of gateway's startup bundle
- MCQ tool override renamed from `withTelegramMcqOverride` → `withChannelMcqOverride` (handles both Telegram + Discord)

## Implementation Plan

- **New**: `packages/discord-ui/` — package with components, runtime, helpers
- **Modified**: `packages/gateway/src/daemon.ts` — init discord-ui, register adapter, unified MCQ override
- **Modified**: `packages/gateway/src/channels/discord.ts` — expose getClient(), fetchChannel()
- **New**: `packages/gateway/src/commands/discord-mcq-adapter.ts` — Discord MCQ adapter
- **Verification**: @mention bot in Discord server → agent calls MCQ tool → interactive buttons appear in thread → clicking resolves answer back to agent

## Non-goals

- Slash commands (we're not a traditional bot)
- Public bot distribution
- Replacing Telegram channel (Discord is additive)

## Consequences

- Discord becomes a first-class interactive UI surface
- MCQs render as interactive buttons instead of plain text
- Component library grows organically (loop monitors, task lists, dashboards)
- React + react-reconciler added as runtime deps (isolated to discord-ui package)
- Bun handles JSX natively at runtime; TypeScript boundary managed via .ts/.tsx split
