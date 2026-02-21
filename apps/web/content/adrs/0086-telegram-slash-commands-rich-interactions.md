---
type: adr
status: partially-implemented
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
  execution: "direct" | "light" | "agent";
  directHandler?: (args: ParsedArgs) => Promise<string>;
  lightModel?: "haiku" | "sonnet";
  inngestEvent?: string;
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

#### Command Execution Tiers

Not every command needs Opus reasoning. Three tiers:

| Tier | Model | Latency | Use Case |
|------|-------|---------|----------|
| **Direct-execute** | None (zero LLM) | Sub-second | `/send health-check`, `/status` → shells to `joelclaw` CLI or fires Inngest event directly |
| **Light-routed** | Configurable per command (Haiku or Sonnet) | 1-3s | `/email triage`, `/tasks today` → cheap model formats prompt, fires Inngest, summarizes result |
| **Agent-routed** | Gateway session model (configurable, default Opus) | 5-30s | `/vault search`, `/build-command` → full reasoning, tool use, multi-step |

**Direct-execute** commands bypass the pi session entirely — run a CLI command or fire an Inngest event and return the output. Zero tokens, instant.

**Light-routed** commands spin up a one-shot cheap model call (not the gateway session). The `lightModel` field sets which model per command. Heavy lifting happens in Inngest.

**Agent-routed** commands go through the full gateway pi session with whatever model is currently configured.

#### Execution Model

1. Registers with `bot.command()` for Telegram menu integration
2. Parses args (positional or via button grid)
3. **Direct:** runs `directHandler`, sends result to Telegram
4. **Light:** builds prompt, calls cheap model, sends result
5. **Agent:** enqueues to command queue, agent processes normally

#### Button Grid Menus (argsMenu)

When a command has `argsMenu` and the user sends it without arguments, render an inline keyboard:

```
User: /send
Bot: Choose event to send:
     [🏥 Health Check] [🔄 Network Update]
     [📧 Email Triage] [📝 Content Sync]
     [🧠 Memory Review] [🔧 Friction Fix]
```

Each button's `callback_data` is the full command text — on tap, it's enqueued as if the user typed it.

#### Skill-Derived Commands

**All 34+ skills are auto-registered** at startup. The registry scans `~/.agents/skills/` (like OpenClaw's `listSkillCommandsForAgents()`). Skills with `command:` frontmatter in SKILL.md get customized registration (args, choices, execution tier). Skills without it get a default agent-routed entry.

**To prevent menu flooding**, skills live behind a `/skills` meta-command that renders a button grid of all available skills. The top-level `/` menu stays curated (~10 core commands):

```
User: /skills
Bot: Available skills:
     [📧 email_triage] [📹 video_ingest] [📋 task_management]
     [🔍 recall]       [💬 imsg]         [🌐 defuddle]
     [📦 aa_book]      [⚙️ k8s]          [🔐 pds]
     ... (paginated if needed)
```

Tapping a skill button either opens its arg menu or enqueues it as a prompt.

```yaml
# In SKILL.md frontmatter (optional — skills without this still get registered)
command:
  name: email_triage
  description: Triage email inbox
  execution: light
  lightModel: sonnet
  args:
    - name: scope
      choices: [inbox, starred, unread]
```

#### Built-in Commands (Top-Level Menu)

| Category | Commands | Tier |
|---|---|---|
| **ops** | `/status`, `/runs`, `/loops`, `/network` | direct |
| **search** | `/vault <query>`, `/recall <query>`, `/email` | agent |
| **tools** | `/send <event>`, `/tasks`, `/cal`, `/skills` | direct / agent |
| **session** | `/help`, `/commands`, `/compact`, `/reset` | direct |
| **options** | `/model`, `/thinking`, `/verbose` | direct |
| **meta** | `/build_command <description>` | agent (codex-delegated) |

### Gateway Configuration via Telegram

Adopt OpenClaw's channel config commands. All config persists in Redis (`joelclaw:gateway:config`) and survives restarts.

#### /model — Switch Gateway Model

```
User: /model
Bot: Current model: claude-opus-4-6
     [Opus 4]  [Sonnet 4]  [Haiku 4.5]
```

Updates the gateway session model. Validates against the ALLOWED_MODELS list from `gateway-start.sh`. Persists in Redis.

#### /thinking — Adjust Thinking Level

```
User: /thinking
Bot: Current thinking: low
     [None]  [Low]  [Medium]  [High]
```

#### /verbose — Toggle Verbose Mode

```
User: /verbose
Bot: Verbose mode: OFF → ON
     (Agent will include reasoning and tool output in responses)
```

#### Status Display — Pinned Message

A **pinned message** at the top of the chat shows current gateway state. Updated whenever config changes or on significant state transitions:

```
🤖 joelclaw gateway
├ Model: opus-4-6 · Thinking: low
├ Uptime: 4h12m · Session: 847 entries
├ Queue: 0 · Codex tasks: 1 running
└ Last heartbeat: 2m ago ✅
```

Updated via `bot.api.editMessageText()` on:
- Model/thinking/verbose changes
- Heartbeat results (periodic refresh)
- Codex task start/complete
- Gateway restart

The message ID is stored in Redis (`joelclaw:gateway:pinned_message_id`). On first boot, `bot.api.sendMessage()` + `bot.api.pinMessage()` creates it.

### Codex Delegation via Worktrees

When the gateway delegates coding to codex (per `~/.joelclaw/gateway/AGENTS.md`), it uses git worktrees for isolation:

#### Worktree Lifecycle

```
1. Gateway creates worktree:
   git worktree add /tmp/joelclaw-worktrees/{task-id} -b codex/{task-id} main

2. Codex runs in the worktree:
   codex exec --cwd /tmp/joelclaw-worktrees/{task-id} "prompt..."

3. Gateway reviews the diff:
   cd /tmp/joelclaw-worktrees/{task-id} && git diff main

4. Gateway reports diff summary to Joel via Telegram

5. On approve: merge to main, push, sync worker
   git checkout main && git merge codex/{task-id}

6. Cleanup:
   git worktree remove /tmp/joelclaw-worktrees/{task-id}
   git branch -d codex/{task-id}
```

#### /build_command — Self-Extending Command System

```
User: /build_command Add a /weather command that fetches current weather for Austin TX

Gateway → codex (in worktree):
  "Create a new command definition in packages/gateway/src/commands/
   Name: weather, Category: tools, Execution: direct
   directHandler fetches weather from wttr.in and formats for Telegram.
   Follow the defineChatCommand() pattern from registry.ts.
   Must compile clean."

Gateway reviews diff → sends summary to Telegram:
  "✅ Codex added /weather command (direct-execute, wttr.in API)
   +45 lines in commands/weather.ts, +2 lines in registry.ts
   [👀 View Diff] [✅ Merge] [❌ Discard]"

Joel taps [✅ Merge] → gateway merges worktree, restarts to pick up new command
```

### Channel-Aware Formatting

**Post-processing layer** — deterministic rules between the outbound router and Telegram channel that attach buttons based on content patterns:

- Health check results → `[🔄 Restart Worker] [📋 Full Details]`
- Email notifications → `[📦 Archive] [⭐ Flag]`
- Loop completions → `[📊 Results] [🔁 Re-run]`
- Memory proposals → `[✅ Approve] [❌ Reject]`

**Channel context injection** — inject channel metadata into the pi session prompt for Telegram-originated turns:

```
[Channel: telegram | Format: HTML (b/i/code/pre/a/blockquote) | Max: 4096 chars | Supports: inline-keyboards, reply-threading, voice-notes]
```

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

### Channel-Adapted Tool Rendering

Pi extensions that use TUI components (widgets, overlays, interactive prompts) don't render in headless/Telegram channels. Rather than disabling them, **translate their interactions to the native channel primitives**.

#### Pattern: Tool Adapter Registry

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
5. Joel taps a button → callback query fires → handler resolves the promise
6. If Joel taps "Other" → next text message captured as free-text answer
7. Multiple questions sent sequentially, answered one at a time
8. Tool returns collected answers → agent continues

**Timeout:** 5 minutes, no cancel button. Timeout returns error, agent can re-ask or proceed with defaults.

**Message editing:** After selection, edit original message to show `✅ Selected: Never rotate` and remove keyboard. No dangling button grids.

```typescript
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

    let text = `<b>${params.title ?? "Question"}</b>\n\n${q.question}`;
    if (q.recommended && q.recommendedReason) {
      text += `\n  ⭐ Recommended: ${q.options[q.recommended - 1]}\n  <i>${q.recommendedReason}</i>`;
    }

    const msg = await sendTelegram(chatId, text, {
      buttons: [buttons.slice(0, 2), buttons.slice(2)],
    });

    const answer = await new Promise<string>((res) => {
      const timeout = setTimeout(() => {
        pendingMcqs.delete(qId);
        res("timeout");
      }, 300_000);
      pendingMcqs.set(qId, { resolve: res, timeout });
    });

    await editMessage(msg.message_id, `${text}\n\n✅ <b>${answer}</b>`);
    answers[qId] = answer;
  }

  resolve({ content: [{ type: "text", text: JSON.stringify(answers) }], details: answers });
}

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (data.startsWith("mcq:")) {
    const [, qId, indexStr] = data.split(":");
    const pending = pendingMcqs.get(qId);
    if (!pending) return ctx.answerCallbackQuery({ text: "Expired" });

    clearTimeout(pending.timeout);
    pendingMcqs.delete(qId);

    if (indexStr === "other") {
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

| Pi Tool | TUI Behavior | Telegram Adapter |
|---------|-------------|-----------------|
| **mcq** | Numbered options, press 1-4 | Inline keyboard buttons |
| **confirm** | y/n prompt | Two-button keyboard [✅ Yes] [❌ No] |
| **file_picker** | File browser overlay | Numbered list of files as buttons |
| **progress** | TUI progress bar widget | Edited message: `⬛⬛⬛⬜⬜ 60%` |

No adapter = tool runs headless with text-only output. Graceful degradation.

## Implementation Phases

1. **Phase 1: Command registry + menu sync** — `defineChatCommand()`, `bot.command()` handlers, `setMyCommands()`. Start with `/status`, `/help`, `/commands`, `/send` (with argsMenu). Pinned status message.
2. **Phase 2: Execution tiers** — direct-execute for CLI commands, light-routed with configurable model, agent-routed for complex tasks
3. **Phase 3: Config commands** — `/model`, `/thinking`, `/verbose` with Redis persistence and pinned message updates
4. **Phase 4: Skill-derived commands** — scan all skills at startup, `/skills` button grid submenu, auto-register from SKILL.md frontmatter
5. **Phase 5: MCQ tool adapter** — reference implementation of channel-adapted tool rendering, inline keyboards, callback resolution, message editing
6. **Phase 6: Worktree codex flow** — `/build_command`, worktree lifecycle, diff review in Telegram, merge/discard buttons
7. **Phase 7: Channel-aware formatting** — post-processor rules + channel context injection
8. **Phase 8: Notification button templates** — extend gateway event payloads, pass buttons through
9. **Phase 9: Outbound envelope** — structured outbound with buttons, formatting hints

## Consequences

### Positive
- Agent reasoning on every agent-routed command — can combine, contextualize, compose
- Skills automatically get slash commands — zero gateway code per skill
- Button grids eliminate typo-prone argument entry
- Three execution tiers — right model for the job, instant for simple commands
- Gateway model/thinking configurable from phone, persists in Redis
- Interactive tools work across channels — MCQ in Telegram is better UX than in terminal
- Tool adapter pattern is reusable — one pattern, many tools, many channels
- Self-extending: `/build_command` creates new commands via codex
- Worktree isolation prevents codex from touching main until reviewed
- Pinned status message provides at-a-glance system state
- Same architecture as OpenClaw — proven across Telegram + Discord

### Negative
- Agent-routed commands have Opus latency (but direct-execute and light-routed are fast)
- Command registry adds infrastructure (~300 lines)
- Must keep menu synced on bot startup
- Tool adapters add per-tool, per-channel implementation burden (opt-in)
- MCQ callback flow requires pending-promise bookkeeping and timeout management
- Worktree lifecycle needs cleanup discipline (stale worktrees if merge/discard not completed)
- Pinned message can go stale if edit fails silently

### ADR Updates
- ADR-0070: updated to `partially-implemented`

## Credits

- **OpenClaw** — command registry architecture, `defineChatCommand()` pattern, `argsMenu` button grids, skill-derived commands, Telegram menu sync, agent-routed execution model, channel config commands. Reference: `src/auto-reply/commands-registry.data.ts`, `src/telegram/bot-native-commands.ts`, `src/auto-reply/skill-commands.ts`, `src/config/telegram-custom-commands.ts`
