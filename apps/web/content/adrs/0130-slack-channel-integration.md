# ADR-0130: Slack Channel Integration

- **Status**: proposed
- **Date**: 2026-02-24
- **Related**: ADR-0123 (channel routing), ADR-0124 (Discord thread sessions), ADR-0125 (channel-aware prompts)

## Context

Joel uses Slack daily across multiple workspaces. JoelClaw needs full Slack awareness — monitoring channels, responding to mentions/DMs, threading, reactions — matching or exceeding Discord and Telegram channel capabilities.

We have both tokens:
- Bot token (`slack_bot_token`, xoxb-*) — full bot scopes, read-only to all channels
- App token (`slack_app_token`, xapp-*) — Socket Mode for real-time events

## Decision

Add Slack as a full gateway channel using Socket Mode for real-time event delivery.

### Capabilities

- **Socket Mode** — real-time message events via WebSocket (no public URL needed)
- **Channel monitoring** — read-only awareness of all channels Joel is in
- **DM support** — direct messages to/from the bot
- **Thread support** — reply in threads, create threads
- **Reactions** — send and receive emoji reactions (same tier 1/2 model as Discord ADR-0124)
- **Mention response** — respond when @mentioned in channels
- **Rich formatting** — Slack Block Kit for structured responses
- **File sharing** — receive and send files/images

### Architecture

```
Slack Socket Mode (xapp-*)
  → packages/gateway/src/channels/slack.ts
    → Message parsing + channel routing
      → Gateway session (trunk or thread-forked per ADR-0124 model)
```

### Channel Handler Shape

Following the existing pattern in `packages/gateway/src/channels/`:

```typescript
// packages/gateway/src/channels/slack.ts
import { App } from '@slack/bolt'

export async function startSlackChannel(config: SlackConfig) {
  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
  })

  // Message handler
  app.message(async ({ message, say, client }) => {
    // Route to gateway session
  })

  // Mention handler
  app.event('app_mention', async ({ event, say }) => {
    // Respond to @mentions in channels
  })

  // Reaction handler
  app.event('reaction_added', async ({ event }) => {
    // Tier 1 deterministic + tier 2 intent-parsed
  })

  await app.start()
}
```

### Dependencies

- `@slack/bolt` — Slack's official framework (Socket Mode + Web API)
- Secrets: `slack_bot_token`, `slack_app_token` (both in agent-secrets)

### Channel Awareness

The bot has read access to all of Joel's channels. This enables:
- Passive monitoring of channel activity (surface interesting discussions)
- Context about what's happening across workspaces
- Ability to reference recent Slack conversations when relevant
- Channel directory awareness (who's in which channels)

### Formatting

Slack uses Block Kit (not markdown). The gateway's channel-aware prompt injection (ADR-0125) should include Slack-specific formatting instructions:
- Use Block Kit JSON for structured content
- Code blocks with triple backticks work
- No Discord-style embeds or components
- Thread replies via `thread_ts`
- Mention users with `<@USER_ID>`

## Consequences

### Easier
- Joel can interact with JoelClaw from Slack (primary work tool)
- Bot has full context of Joel's Slack activity
- Socket Mode means no public endpoint needed (works behind NAT)

### Harder
- Another channel to maintain in the gateway
- Slack's rate limits are stricter than Discord/Telegram
- Block Kit formatting is more complex than markdown
- Multi-workspace support would need additional tokens (v2 concern)

## Implementation

1. `pnpm add @slack/bolt` in `packages/gateway`
2. Create `packages/gateway/src/channels/slack.ts`
3. Wire into gateway daemon startup
4. Add channel-specific prompt formatting (ADR-0125)
5. Test DM + mention + thread + reaction flows
6. Add to gateway status/health checks
