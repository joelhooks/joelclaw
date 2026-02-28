# ADR-0162: Gateway Reactions, Replies & Social Channel Configuration

- **Status**: Accepted
- **Date**: 2026-02-28
- **Deciders**: Joel, Panda
- **Relates to**: ADR-0144 (hexagonal architecture), ADR-0120 (Discord threads), ADR-0160 (Telegram streaming)

## Context

The gateway agent responds to messages across Telegram, Discord, Slack, and iMessage but has no ability to **react** to messages — only reply with text. Reactions are a natural, lightweight acknowledgment mechanism that every chat platform supports (except iMessage via our current `imsg-rpc` daemon). The agent should use reactions contextually: 👀 on receipt, 👍 for simple acks, 🔥 for excitement, 🤔 for processing, etc.

Additionally, channel configuration is scattered across environment variables (`TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `SLACK_ALLOWED_USER_ID`, etc.) with no unified schema, no validation, and no documentation. Talon introduced `.joelclaw/talon/services.toml` as precedent for file-based config with hot-reload. Social channels should follow the same pattern.

## Decision

### 1. Reaction System

**Structured response convention.** The gateway agent includes reaction directives in its response text using a `<<react:EMOJI>>` prefix. The outbound router strips the directive and executes the reaction on the source channel before routing the text.

```
`<<react:👍>>`Got it, deploying now.
`<<react:🔥>>`
```

Rules:
- Multiple `<<react:...>>` directives allowed (first one wins per message, rest ignored)
- Empty text after stripping is valid — reaction-only responses (no text sent)
- Directive must be at the start of the response text
- Unknown/unsupported emoji silently ignored per-channel
- iMessage: no-op (tapback not available via imsg-rpc)

Per-channel API mapping:

| Channel | API | Notes |
|---------|-----|-------|
| Telegram | `bot.api.setMessageReaction(chatId, messageId, [{type:"emoji", emoji}])` | Requires messageId from inbound context |
| Discord | `message.react(emoji)` | Unicode emoji or custom guild emoji |
| Slack | `client.reactions.add({channel, timestamp, name})` | Slack emoji name without colons |
| iMessage | no-op | tapback not exposed via imsg-rpc |

### 1b. Reply-to-Message System

**Targeted replies.** The gateway agent can reply to a specific inbound message using a `<<reply:MESSAGE_ID>>` directive. The outbound router strips the directive and passes the message ID as `replyTo` context to the channel adapter.

```
`<<reply:5872>>`That's the right approach.
`<<react:👍>><<reply:5872>>`Confirmed.
```

The reply infrastructure already exists in the Telegram adapter (`reply_parameters`), Discord (thread-based), and Slack (`thread_ts`). What's missing is the agent's ability to target a specific message.

**Context injection.** When a message arrives, the inbound metadata already carries the platform message ID (e.g. `telegramMessageId`). The command queue injects this into the prompt context so the agent knows which message ID to reference:

```
[msg:5872] Hey, did the deploy finish?
```

Per-channel reply support:

| Channel | Mechanism | Notes |
|---------|-----------|-------|
| Telegram | `reply_parameters: { message_id }` | Native quote-reply, shows referenced message |
| Discord | Already thread-based | Replies are implicit within threads |
| Slack | `thread_ts` | Reply in thread |
| iMessage | Not supported | No reply-to via imsg-rpc |

Rules:
- `<<reply:ID>>` is optional — omitting it sends a normal message (current behavior)
- Can combine with `<<react:EMOJI>>` — both directives stripped before text routing
- Invalid/stale message IDs silently ignored (Telegram returns error, we catch and send without reply)
- Agent should reply when the conversation has multiple messages in flight and context matters

**System prompt addition.** The gateway agent's system prompt is updated to encourage contextual reactions and replies:
- 👀 on receipt of messages that will take time to process
- 👍 for simple acknowledgments where no text reply is needed
- 🔥 for genuinely cool/impressive things shared
- 🤔 when the request needs thought
- ✅ when a task is confirmed complete
- Use sparingly — not every message needs a reaction

### 2. Social Channel Configuration

**File-based config at `~/.joelclaw/channels.toml`** with schema validation at startup.

```toml
# ~/.joelclaw/channels.toml
# Social channel configuration for the joelclaw gateway.
# Gateway validates on startup and logs warnings for invalid config.
# Changes require gateway restart (no hot-reload — channels bind SDK clients).

[telegram]
enabled = true
bot_token_secret = "telegram_bot_token"    # agent-secrets key
user_id = 7718912466
reactions = true

[discord]
enabled = true
bot_token_secret = "discord_bot_token"     # agent-secrets key
allowed_user_id = "257596554986823681"
reactions = true

[slack]
enabled = true
bot_token_secret = "slack_bot_token"       # agent-secrets key
app_token_secret = "slack_app_token"       # agent-secrets key
allowed_user_id = "U01BCPFPG0D"
default_channel_id = "C04NM8AHJ6E"
reaction_ack_emoji = "eyes"
reactions = true

[imessage]
enabled = true
socket_path = "/tmp/imsg.sock"
reactions = false                          # tapback not supported via imsg-rpc
```

Design decisions:
- **TOML** — consistent with Talon's `services.toml`; human-readable, typed, no trailing comma drama
- **Secret references, not values** — `bot_token_secret` points to an `agent-secrets` key name; gateway resolves at startup via `secrets_lease`. Tokens never appear in config files.
- **`enabled` flag** — channels can be toggled without removing config
- **`reactions` flag** — per-channel opt-in for the reaction system
- **No hot-reload** — channel SDKs (grammy, discord.js, @slack/bolt) bind connections at startup; hot-reload would require teardown/reconnect logic that's not worth the complexity. Restart the gateway instead.
- **Schema validation** — gateway validates config at startup using a TypeScript schema (Effect Schema or Zod). Invalid config → log error + skip that channel (don't crash).
- **Fallback to env vars** — if `channels.toml` doesn't exist, gateway falls back to current `process.env` behavior for backwards compatibility during migration.

### 3. Channel Config Skill

A `channel-config` skill documents the `channels.toml` schema, valid options per channel, how secrets are resolved, and troubleshooting. Canonical source in `skills/channel-config/SKILL.md`, symlinked as usual.

## Consequences

- Gateway agent gains reaction capability across 3 of 4 channels
- Channel config moves from scattered env vars to a single validated file
- Secrets stay in `agent-secrets`, never in config files
- Config is documented as a skill — agents can read and modify it
- iMessage reactions remain unsupported until imsg-rpc gains tapback support
- Existing env var config continues to work during migration period

## Implementation Order

1. Add `react()` to `Channel` interface + implement per-channel
2. Parse `<<react:EMOJI>>` and `<<reply:ID>>` directives in outbound router
3. Inject inbound message ID into prompt context (`[msg:ID]` prefix)
4. Update gateway system prompt with reaction + reply guidance
5. Create `channels.toml` schema + loader with env var fallback
6. Migrate daemon.ts channel startup to use config loader
7. Create `telegram` skill (Telegram-specific capabilities, API patterns, troubleshooting)
8. Create `channel-config` skill (channels.toml schema, secrets, per-channel options)
9. Remove env var fallback after verification period

## Tech Debt

- Extract channel adapters from `packages/gateway/` into standalone packages (noted in streaming work, deferred until APIs stabilize)
- iMessage tapback support pending imsg-rpc enhancement
