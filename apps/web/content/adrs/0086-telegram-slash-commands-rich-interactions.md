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

### Command Execution Tiers

Not every command needs Opus reasoning. Three tiers based on complexity:

| Tier | Model | Latency | Use Case |
|------|-------|---------|----------|
| **Direct-execute** | None (zero LLM) | Sub-second | `/send health-check`, `/status` → shells to `joelclaw` CLI or fires Inngest event directly |
| **Light-routed** | Haiku/Sonnet | 1-3s | `/email triage`, `/tasks today` → cheap model formats the prompt, fires Inngest, summarizes result |
| **Agent-routed** | Opus (gateway session) | 5-30s | `/vault search`, `/build-command` → full reasoning, tool use, multi-step |

Command definitions declare their tier:

```typescript
type CommandDefinition = {
  // ... existing fields ...
  execution: "direct" | "light" | "agent";
  directHandler?: (args: ParsedArgs) => Promise<string>;  // direct-execute only
  lightModel?: "haiku" | "sonnet";                         // light-routed only
  inngestEvent?: string;                                   // optional: fire this event
};
```

**Direct-execute** commands bypass the pi session entirely — they run a CLI command or fire an Inngest event and return the output. Zero tokens, instant response.

**Light-routed** commands spin up a one-shot cheap model call (not the gateway session) to format/summarize. The heavy lifting is in Inngest. Cost: ~$0.001 per command.

**Agent-routed** commands go through the full gateway pi session. The agent has context, can reason, can use tools. Cost: whatever Opus costs per turn.

### Channel-Adapted Tool Rendering

Pi extensions that use TUI components (widgets, overlays, interactive prompts) don't render in headless/Telegram channels. Rather than disabling them, **translate their interactions to the native channel primitives**.

#### Pattern: Tool Adapter Registry

The gateway maintains a registry of tool adapters — channel-specific implementations that replace TUI interactions with native equivalents:

```typescript
type ToolAdapter = {
  toolName: string;
  channel: "telegram" | "voice" | "web";
  intercept: (params: unknown, resolve: (result: unknown) => void) => Promise<void>;
};

// Registry checked before tool execution in headless sessions.
// If adapter exists for current channel + tool, adapter handles it.
// If not, tool executes normally (headless fallback).
```

#### Reference Implementation: MCQ → Telegram Inline Keyboards

The `mcq` tool in pi renders numbered options in the TUI — user presses 1-4. In Telegram, this maps to inline keyboard buttons:

**What Joel sees:**
```
🗳️ Feature Design

How should we handle session rotation?
  ⭐ Recommended: Never rotate — pi compaction handles it

[1️⃣ Archive after 6h]  [2️⃣ Archive after 512KB]
[3️⃣ Never rotate ⭐]    [4️⃣ Other]
```

**How it works:**

1. Agent calls `mcq` tool with questions + options (same API as TUI version)
2. Gateway's MCQ adapter intercepts the tool call
3. For each question, sends a Telegram message with inline keyboard:
   - Each option → button with `callback_data: mcq:{questionId}:{optionIndex}`
   - Recommended option gets ⭐ suffix
   - "Other" option always appended (opens free-text reply)
4. Tool execution **suspends** — returns a promise
5. Joel taps a button → callback query fires → handler resolves the promise with the selected option
6. If Joel taps "Other" → next text message is captured as the free-text answer
7. If multiple questions, they're sent as separate messages, answered sequentially
8. Tool returns the collected answers → agent continues reasoning

**Timeout handling:** If no button press within 5 minutes, the tool returns a timeout error. Agent can re-ask or proceed with defaults.

**Message editing:** After Joel taps a button, edit the original message to show the selection inline (removes the keyboard, shows "✅ Selected: Never rotate"). Clean UX, no dangling button grids.

```typescript
// Gateway MCQ adapter (simplified)
const pendingMcqs = new Map<string, {
  resolve: (answer: string) => void;
  timeout: Timer;
}>();

async function handleMcqTool(params: McqParams, resolve: (result: unknown) => void) {
  const answers: Record<string, string> = {};

  for (const q of params.questions) {
    const qId = q.id;
    const buttons = q.options.map((opt, i) => ({
      text: `${i + 1}️⃣ ${opt}${q.recommended === i + 1 ? " ⭐" : ""}`,
      callback_data: `mcq:${qId}:${i}`,
    }));
    buttons.push({ text: "4️⃣ Other", callback_data: `mcq:${qId}:other` });

    // Build display text
    let text = `<b>${params.title ?? "Question"}</b>\n\n${q.question}`;
    if (q.recommended && q.recommendedReason) {
      text += `\n  ⭐ Recommended: ${q.options[q.recommended - 1]}\n  <i>${q.recommendedReason}</i>`;
    }

    const msg = await sendTelegram(chatId, text, {
      buttons: [buttons.slice(0, 2), buttons.slice(2)], // 2x2 grid
    });

    // Wait for callback
    const answer = await new Promise<string>((res) => {
      const timeout = setTimeout(() => {
        pendingMcqs.delete(qId);
        res("timeout");
      }, 300_000);
      pendingMcqs.set(qId, { resolve: res, timeout });
    });

    // Edit message to show selection
    await editMessage(msg.message_id, `${text}\n\n✅ <b>${answer}</b>`);
    answers[qId] = answer;
  }

  resolve({ content: [{ type: "text", text: JSON.stringify(answers) }], details: answers });
}

// In callback query handler:
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (data.startsWith("mcq:")) {
    const [, qId, indexStr] = data.split(":");
    const pending = pendingMcqs.get(qId);
    if (!pending) return ctx.answerCallbackQuery({ text: "Expired" });

    clearTimeout(pending.timeout);
    pendingMcqs.delete(qId);

    if (indexStr === "other") {
      // Next text message from this user becomes the answer
      awaitingFreeText.set(chatId, pending.resolve);
      await ctx.answerCallbackQuery({ text: "Type your answer..." });
    } else {
      const option = questions[qId].options[parseInt(indexStr)];
      pending.resolve(option);
      await ctx.answerCallbackQuery({ text: `Selected: ${option}` });
    }
  }
});
```

#### Future Tool Adapters

The same pattern applies to any interactive pi tool:

| Pi Tool | TUI Behavior | Telegram Adapter |
|---------|-------------|-----------------|
| **mcq** | Numbered options, press 1-4 | Inline keyboard buttons |
| **confirm** | y/n prompt | Two-button keyboard [✅ Yes] [❌ No] |
| **file_picker** | File browser overlay | Numbered list of files as buttons |
| **progress** | TUI progress bar widget | Edited message with progress text: `⬛⬛⬛⬜⬜ 60%` |

Not every tool translates — some are terminal-native (editor, TUI dashboards). The adapter registry gracefully degrades: no adapter = tool runs headless with text-only output.

## Implementation Phases

1. **Phase 1: Command registry + menu sync** — `defineChatCommand()`, `bot.command()` handlers, `setMyCommands()`. Start with `/status`, `/help`, `/commands`, `/send` (with argsMenu)
2. **Phase 2: Execution tiers** — direct-execute for CLI commands, light-routed with Haiku for Inngest-backed commands, agent-routed for complex tasks
3. **Phase 3: Skill-derived commands** — scan skills at startup, auto-register from SKILL.md frontmatter
4. **Phase 4: MCQ tool adapter** — reference implementation of channel-adapted tool rendering, inline keyboards, callback resolution, message editing
5. **Phase 5: Channel-aware formatting** — post-processor rules + channel context injection
6. **Phase 6: Notification button templates** — extend gateway event payloads, pass buttons through
7. **Phase 7: Outbound envelope** — structured outbound with buttons, formatting hints

## Consequences

### Positive
- Agent reasoning on every command — can combine, contextualize, compose
- Skills automatically get slash commands — zero gateway code per skill
- Button grids eliminate typo-prone argument entry
- System config controls command surface — enable/disable without code changes
- Same architecture as OpenClaw — proven across Telegram + Discord
- Three execution tiers — right model for the job, instant for simple commands
- Interactive tools work across channels — MCQ in Telegram is better UX than in terminal
- Tool adapter pattern is reusable — one pattern, many tools, many channels

### Negative
- Every agent-routed command has Opus latency (but direct-execute and light-routed are fast)
- Command registry adds infrastructure (~300 lines)
- Must keep menu synced on bot startup
- Tool adapters add a per-tool, per-channel implementation burden (but it's opt-in)
- MCQ callback flow requires pending-promise bookkeeping and timeout management

### ADR Updates
- ADR-0070: updated to `partially-implemented`

## Credits

- **OpenClaw** — command registry architecture, `defineChatCommand()` pattern, `argsMenu` button grids, skill-derived commands, Telegram menu sync, agent-routed execution model. Reference: `src/auto-reply/commands-registry.data.ts`, `src/telegram/bot-native-commands.ts`, `src/auto-reply/skill-commands.ts`, `src/config/telegram-custom-commands.ts`
