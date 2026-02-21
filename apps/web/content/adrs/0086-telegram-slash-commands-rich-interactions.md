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

The gateway Telegram channel has rich infrastructure (inline keyboards, callback queries, media, reply threading) but three gaps prevent productive mobile use:

1. **No slash commands** — no `/` menu, no discoverability, no arg buttons
2. **Channel-unaware agent session** — the pi session generates plain markdown; ADR-0070's inline buttons never appear because the outbound router only passes strings
3. **No proactive button templates** — Inngest notifications push plain text, can't attach action buttons

## Decision

### Adopt OpenClaw's Command Architecture

Credit: OpenClaw (`src/auto-reply/commands-registry.data.ts`, `src/telegram/bot-native-commands.ts`, `src/auto-reply/skill-commands.ts`).

**Key principle: commands route through the agent session, not around it.** The slash command provides UX (menu, arg buttons, auth) — the agent provides reasoning. This matches OpenClaw's approach where only plugin commands bypass the agent.

#### Command Registry

A centralized registry at `packages/gateway/src/commands/registry.ts` using OpenClaw's `defineChatCommand()` pattern:

```typescript
type CommandDefinition = {
  key: string;                          // unique id
  nativeName: string;                   // telegram /slash_name
  description: string;                  // shown in menu
  category: "session" | "ops" | "search" | "tools" | "options";
  args?: CommandArgDefinition[];
  argsMenu?: "auto" | { arg: string; title?: string };
  scope: "text" | "native" | "both";
  textAliases?: string[];
};

type CommandArgDefinition = {
  name: string;
  description: string;
  type: "string" | "number";
  required?: boolean;
  choices?: Array<string | { value: string; label: string }>;
  captureRemaining?: boolean;
};
```

#### Execution Model

All commands go through the pi session as structured prompts. The agent sees `/status` and decides how to respond — using tools, CLI commands, or direct knowledge. The command handler:

1. Registers with `bot.command()` for Telegram menu integration
2. Parses args (positional or via button grid)
3. Builds a prompt string (e.g., `/status` or `/vault search term`)
4. Enqueues to the same command queue as regular messages
5. Agent processes and responds normally

This means the agent can:
- Combine command output with context ("status looks good, but I noticed the loop from earlier is still stalled")
- Use tools to fulfill the command (shell to `joelclaw status`, search Typesense, query Convex)
- Format responses appropriately for the channel

#### Button Grid Menus (argsMenu)

When a command has `argsMenu` and the user sends it without arguments, render an inline keyboard. Each button's `callback_data` is the full command text — on tap, it's enqueued as if the user typed it.

```
User: /send
Bot: Choose event to send:
     [🏥 Health Check] [🔄 Network Update]
     [📧 Email Triage] [📝 Content Sync]
     [🧠 Memory Review] [🔧 Friction Fix]
```

#### Skill-Derived Commands

Skills can declare slash commands in their SKILL.md metadata. The registry scans `~/.agents/skills/` at startup (like OpenClaw's `listSkillCommandsForAgents()`), builds command definitions, and registers them. This means adding a new skill can automatically add a new Telegram command — no gateway code changes.

```yaml
# In SKILL.md frontmatter
command:
  name: email_triage
  description: Triage email inbox
  args:
    - name: scope
      choices: [inbox, starred, unread]
```

#### System Config

Command behavior controlled via gateway config (like OpenClaw's `channels.telegram.commands`):

```typescript
// Gateway config
commands: {
  native: true,           // enable slash command menu
  nativeSkills: true,     // auto-register skill commands
  customCommands: [       // additional menu entries
    { command: "deploy", description: "Check deploy status" }
  ]
}
```

#### Built-in Commands

| Category | Commands |
|---|---|
| **ops** | `/status`, `/runs`, `/loops`, `/network` |
| **search** | `/vault <query>`, `/recall <query>`, `/email` |
| **tools** | `/send <event>`, `/tasks`, `/cal` |
| **session** | `/help`, `/commands`, `/compact`, `/reset` |
| **options** | `/model`, `/verbose` |

All route through the agent. The agent has the skills and tools to fulfill them.

### Channel-Aware Formatting

**Post-processing layer (Option C)** — deterministic rules between the outbound router and Telegram channel that attach buttons based on content patterns:

- Health check results → `[🔄 Restart Worker] [📋 Full Details]`
- Email notifications → `[📦 Archive] [⭐ Flag]`
- Loop completions → `[📊 Results] [🔁 Re-run]`
- Memory proposals → `[✅ Approve] [❌ Reject]`

**Channel context injection (Option B)** — inject channel metadata into the pi session prompt for Telegram-originated turns:

```
[Channel: telegram | Format: HTML (b/i/code/pre/a/blockquote) | Max: 4096 chars | Supports: inline-keyboards, reply-threading, voice-notes]
```

This nudges the agent toward compact formatting and awareness of available features.

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

### Outbound Router Evolution

Extend from `send(string)` to `send(envelope)`:

```typescript
type OutboundEnvelope = {
  text: string;
  buttons?: InlineButton[][];
  silent?: boolean;
  replyTo?: number;
  format?: "html" | "markdown" | "plain";
};
```

## Implementation Phases

1. **Phase 1: Command registry + menu sync** — `defineChatCommand()`, `bot.command()` handlers, `setMyCommands()`. Start with `/status`, `/help`, `/commands`, `/send` (with argsMenu)
2. **Phase 2: Skill-derived commands** — scan skills at startup, auto-register
3. **Phase 3: Channel-aware formatting** — post-processor rules + channel context injection
4. **Phase 4: Notification button templates** — extend gateway event payloads, pass buttons through
5. **Phase 5: Outbound envelope** — structured outbound with buttons, formatting hints

## Consequences

### Positive
- Agent reasoning on every command — can combine, contextualize, compose
- Skills automatically get slash commands — zero gateway code per skill
- Button grids eliminate typo-prone argument entry
- System config controls command surface — enable/disable without code changes
- Same architecture as OpenClaw — proven across Telegram + Discord

### Negative
- Every command has agent latency (but the agent is fast for simple commands)
- Command registry adds infrastructure (~300 lines)
- Must keep menu synced on bot startup

### ADR Updates
- ADR-0070: updated to `partially-implemented`

## Credits

- **OpenClaw** — command registry architecture, `defineChatCommand()` pattern, `argsMenu` button grids, skill-derived commands, Telegram menu sync, agent-routed execution model. Reference: `src/auto-reply/commands-registry.data.ts`, `src/telegram/bot-native-commands.ts`, `src/auto-reply/skill-commands.ts`, `src/config/telegram-custom-commands.ts`
