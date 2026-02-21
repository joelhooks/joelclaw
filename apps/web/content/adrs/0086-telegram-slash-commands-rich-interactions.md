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

The gateway Telegram channel (`packages/gateway/src/channels/telegram.ts`, 764 lines) supports text messages, inbound media, outbound rich messages with inline keyboards (ADR-0070), callback queries, and reply threading. But three gaps prevent Telegram from being a productive operational interface:

1. **No slash commands** — every interaction requires a full LLM round-trip, even quick ops like `/status`
2. **Channel-unaware agent session** — the pi session generates plain markdown; ADR-0070's inline buttons never appear because the outbound router only passes strings
3. **No proactive button templates** — Inngest notifications push plain text, can't attach action buttons

OpenClaw has a mature command system that solves all three. Rather than reinvent, we adopt their architecture directly.

## Decision

### Adopt OpenClaw's Command Registry Pattern

Credit: OpenClaw (`src/auto-reply/commands-registry.data.ts`, `src/telegram/bot-native-commands.ts`, `src/auto-reply/skill-commands.ts`).

#### Command Registry

A centralized `CommandDefinition` registry at `packages/gateway/src/commands/registry.ts`:

```typescript
type CommandDefinition = {
  key: string;                          // unique id
  nativeName: string;                   // telegram /slash_name
  description: string;                  // shown in menu
  category: "ops" | "search" | "system" | "session";
  args?: CommandArgDefinition[];        // typed args
  argsMenu?: "auto" | { arg: string; title?: string };  // button grid
  execute: "direct" | "agent" | "inngest";  // execution model
  handler?: (args: CommandArgs) => Promise<CommandResult>;  // for direct commands
  inngestEvent?: string;                // for inngest commands
};

type CommandArgDefinition = {
  name: string;
  description: string;
  type: "string" | "number";
  required?: boolean;
  choices?: Array<string | { value: string; label: string }>;
  captureRemaining?: boolean;
};

type CommandResult = {
  text: string;
  buttons?: InlineButton[][];
  silent?: boolean;
};
```

Three execution models (extending OpenClaw's pattern):

| Model | Path | Latency | Use case |
|---|---|---|---|
| `direct` | Command handler runs locally, returns result | <2s | `/status`, `/runs`, `/loops`, `/network` |
| `agent` | Prompt routed to pi session (OpenClaw's default) | 5-30s | `/vault`, `/recall` (agent can reason about results) |
| `inngest` | Fires event, acks immediately, callback delivers result | 5-60s | `/email`, `/tasks`, `/cal` |

#### Button Grid Menus (from OpenClaw)

When a command has `argsMenu` and the user sends it without arguments, render an inline keyboard:

```
User: /send
Bot: Choose event to send:
     [🏥 Health Check] [🔄 Network Update]
     [📧 Email Triage] [📝 Content Sync]
     [🧠 Memory Review] [🔧 Friction Fix]
```

Each button's `callback_data` is the full command text (e.g., `/send system/health.check`). On tap, processed as if typed. Same pattern as OpenClaw's `argsMenu: "auto"`.

#### Command Set

**Phase 1 — Direct (bypass agent):**

| Command | Description | Execute |
|---|---|---|
| `/status` | System health summary | `direct` — shells to `joelclaw status` |
| `/runs` | Recent Inngest runs | `direct` — shells to `joelclaw runs` |
| `/loops` | Agent loop status | `direct` — shells to `joelclaw loop status` |
| `/network` | Live network status | `direct` — reads from Convex |
| `/help` | List available commands | `direct` |
| `/send <event>` | Fire Inngest event | `direct` — with argsMenu for common events |

**Phase 2 — Agent-routed:**

| Command | Description | Execute |
|---|---|---|
| `/vault <query>` | Vault search | `agent` — agent summarizes results |
| `/recall <query>` | Memory search | `agent` — agent contextualizes |

**Phase 3 — Async via Inngest:**

| Command | Description | Execute |
|---|---|---|
| `/email` | Email triage summary | `inngest` → `check/email-triage` |
| `/tasks` | Todoist summary | `inngest` → fires event, callback delivers |
| `/cal` | Today's calendar | `inngest` → fires event, callback delivers |

#### Menu Sync

On bot startup, call `bot.api.setMyCommands()` with all registered commands. Telegram shows the `/` menu autocomplete.

### Channel-Aware Formatting

**Post-processing layer (Option C)** — a formatter between the outbound router and the Telegram channel that attaches buttons based on content patterns:

- Health check results → `[🔄 Restart Worker] [📋 Full Details]`
- Email notifications → `[📦 Archive] [⭐ Flag] [📝 Reply Later]`
- Loop completions → `[📊 Results] [🔁 Re-run]`
- Memory proposals → `[✅ Approve] [❌ Reject]`

Rules are deterministic — don't depend on LLM cooperation.

**Channel context injection (Option B)** — inject channel metadata into the pi session prompt for Telegram-originated turns:

```
[Channel: telegram | Format: HTML (b/i/code/pre/a/blockquote) | Max: 4096 chars | Supports: inline-keyboards, reply-threading, voice-notes]
```

This nudges the agent toward compact HTML formatting instead of long markdown.

### Notification Button Templates

Inngest functions include button definitions in gateway event payloads:

```typescript
await pushGatewayEvent({
  type: "system.health.degraded",
  payload: {
    prompt: "## 🚨 Health Degradation\n- ❌ Redis: down",
    buttons: [
      [{ text: "🔄 Restart", action: "restart:redis" }],
      [{ text: "🔇 Mute 1h", action: "mute:redis:3600" }]
    ]
  }
});
```

Gateway extracts `buttons` from payload, passes to `telegram.send()` as `RichSendOptions`.

### Outbound Router Evolution

Extend the router from `send(string)` to `send(envelope)`:

```typescript
type OutboundEnvelope = {
  text: string;
  buttons?: InlineButton[][];
  silent?: boolean;
  replyTo?: number;
  format?: "html" | "markdown" | "plain";
};
```

The formatter layer sits between the router's text collection and the channel's send, transforming `string → OutboundEnvelope` based on channel + content rules.

## Implementation Phases

1. **Phase 1: Command registry + direct commands** — `/status`, `/runs`, `/loops`, `/network`, `/help`, `/send`. Menu sync. Button grids for `/send`.
2. **Phase 2: Notification button templates** — extend gateway event payloads, pass buttons through to Telegram
3. **Phase 3: Channel-aware formatting** — post-processor rules + channel context injection
4. **Phase 4: Agent-routed commands** — `/vault`, `/recall` through pi session
5. **Phase 5: Async Inngest commands** — `/email`, `/tasks`, `/cal` with callback delivery

## Consequences

### Positive
- Fast operational commands without LLM cost/latency
- Buttons actually render in production (not just tests)
- Telegram becomes a real ops dashboard, not just a text pipe
- Pattern is proven in OpenClaw across Telegram + Discord
- Button grids eliminate typo-prone argument entry
- Deterministic post-processing is more reliable than hoping the LLM formats correctly

### Negative
- Command registry adds ~300 lines of infrastructure
- Must keep menu synced on bot startup (but this is one API call)
- Callback data limited to 64 bytes — need compact action encoding
- Two execution paths (direct vs agent) adds routing complexity

## Credits

- **OpenClaw** — command registry architecture, `defineChatCommand()` pattern, `argsMenu` button grids, skill-derived commands, Telegram menu sync. Reference: `src/auto-reply/commands-registry.data.ts`, `src/telegram/bot-native-commands.ts`, `src/auto-reply/skill-commands.ts`, `src/telegram/button-types.ts`
- ADR-0070 — inline keyboard infrastructure (partially implemented, to be completed by this ADR)
- ADR-0042 — rich Telegram replies and media
- ADR-0069 — proactive gateway notifications
