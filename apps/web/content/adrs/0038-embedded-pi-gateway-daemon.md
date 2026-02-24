---
status: shipped
date: 2026-02-17
decision-makers: Joel Hooks
consulted: Claude (pi session 2026-02-17)
informed: All agents operating on this machine
related:
  - "[ADR-0003 — Build joelclaw instead of deploying OpenClaw](0003-joelclaw-over-openclaw.md)"
  - "[ADR-0018 — Pi-native gateway with Redis event bridge](0018-pi-native-gateway-redis-event-bridge.md)"
  - "[ADR-0035 — Central + satellite session routing](0035-gateway-session-routing-central-satellite.md)"
  - "[ADR-0036 — launchd central gateway session](0036-launchd-central-gateway-session.md)"
  - "[ADR-0037 — Layered watchdog](0037-gateway-watchdog-layered-failure-detection.md)"
supersedes:
  - "[ADR-0036 — launchd central gateway session (tmux + pi extension)](0036-launchd-central-gateway-session.md)"
credits:
  - "OpenClaw gateway-daemon.ts — the embedded pi session pattern, command queue serialization, channel plugin architecture, and heartbeat runner are directly adapted from OpenClaw's implementation"
  - "Pi SDK (mariozechner) — createAgentSession(), AgentSession, SessionManager APIs"
---

# Embed pi as a library in a joelclaw gateway daemon

## Context and Problem Statement

The current central gateway session (ADR-0036) runs pi inside tmux, managed by launchd. A gateway extension injects events via `sendUserMessage()`. This works for Redis-based notifications but has fundamental limitations:

1. **No mobile access** — Joel currently SSH's into the Mac Mini from Termius on his phone to interact with pi. This works but fights the medium (tiny keyboard, no streaming, terminal rendering issues).

2. **No multi-channel routing** — Replies stay inside the pi TUI. There's no way to route a response to Telegram, Slack, or a native app. The agent can receive events but can't talk back through the channel that asked.

3. **No streaming** — `sendUserMessage()` is fire-and-forget. The extension can't stream LLM deltas to external clients.

4. **TMux PTY hack** — Pi is a TUI app that needs a terminal. The tmux wrapper adds complexity and an extra process layer. OpenClaw solved this by embedding pi as a library — no terminal needed.

5. **Extension limitations** — The gateway extension can inject prompts and drain events, but it can't control the session lifecycle, model selection, compaction, or routing.

### What We Want

Talk to the agent from anywhere:
- **Telegram** — Send a message from your phone, get a response
- **Native iOS/macOS app** — Purpose-built UI (future, on roadmap)
- **WebSocket** — Attach from any terminal (like `openclaw tui`)
- **Redis bridge** — Inngest events still flow in (existing infrastructure)
- **All inputs serialize through one session** — Same conversation, same memory, same context

### How OpenClaw Does It

OpenClaw's gateway daemon (`src/macos/gateway-daemon.ts`) is a standalone Node.js process that:

1. **Embeds pi** via `createAgentSession()` from `@mariozechner/pi-coding-agent`
2. **Serializes all inputs** through a `CommandQueue` with lanes — TUI, heartbeat, Telegram, Discord, etc. all go through one queue into one pi session
3. **Routes replies back** through channel-specific outbound adapters (Telegram HTML chunks, Discord markdown, WhatsApp formatting, etc.)
4. **Streams deltas** to connected WebSocket clients (TUI, mobile app)
5. **Runs as a launchd daemon** — `KeepAlive: true`, no terminal needed
6. **Manages channels** via a plugin system — each channel implements `ChannelPlugin` (config, gateway lifecycle, outbound adapter, status probes)

The TUI (`openclaw tui`) is a WebSocket client that connects to the running daemon — it doesn't run pi directly.

## Decision

Build a **joelclaw gateway daemon** that embeds pi as a library, replacing the current tmux + extension approach. Start with Telegram as the first external channel.

### Architecture

```
launchd (com.joel.gateway)
  → joelclaw-gateway daemon (Node.js)
    ├── createAgentSession() — owns the LLM conversation
    ├── CommandQueue — serializes all inputs
    ├── HeartbeatRunner — periodic checklist (setInterval)
    ├── Channels:
    │   ├── Redis — Inngest event bridge (existing)
    │   ├── Telegram — grammY bot (first external channel)
    │   ├── iMessage — imsg-rpc Unix socket sidecar (FDA-scoped helper)
    │   ├── WebSocket — TUI attach + future native app
    │   └── (future: Slack, web)
    ├── OutboundRouter — route replies to source channel
    └── Watchdog — heartbeat staleness detection (ADR-0037)
```

### Session Ownership

The daemon owns the pi session via `createAgentSession()`. This gives us:
- Full control over model, thinking level, compaction
- `session.prompt()` for synchronous prompt/response
- `session.subscribe()` for streaming deltas to channels
- `session.sendUserMessage()` with `followUp` for async injection
- Same extensions, skills, tools as interactive pi (auto-discovered from `~/.pi/agent/`)
- Persistent session file (conversation survives restart)

### Command Queue

All inputs serialize through one queue (adapted from OpenClaw's `CommandLane`):

```typescript
type QueueEntry = {
  source: ChannelId;     // "telegram:12345", "redis", "ws:abc", "heartbeat"
  prompt: string;
  replyTo?: string;      // Channel-specific reply target
  metadata?: Record<string, unknown>;
};
```

The queue drains sequentially — one prompt at a time. While the LLM is responding, new messages queue up (OpenClaw calls this the "main lane").

### Outbound Routing

When the LLM responds, the reply routes back to the channel that sent the prompt:
- **Telegram** → Format as Telegram HTML, send via grammY
- **Redis** → Push to `joelclaw:events:{sessionId}` (satellite notification)
- **WebSocket** → Stream deltas as JSON frames
- **Heartbeat** → Filter `HEARTBEAT_OK` (suppress), deliver non-OK to notification channel

### Telegram Channel (First Implementation)

```
Phone (Telegram) → Bot API → grammY handler → CommandQueue → pi session
                                                                   ↓
Phone (Telegram) ← Bot API ← Telegram outbound ← OutboundRouter ←─┘
```

- grammY bot with long polling (no webhook needed — runs on the tailnet)
- Allowlist: Joel's Telegram user ID only
- Message types: text, photos (as image attachments), voice (future: whisper transcription)
- Reply formatting: Markdown → Telegram HTML with chunk splitting (4000 char limit)
- Typing indicator while LLM is working

### WebSocket Channel (TUI Attach)

```bash
# Attach to the running daemon from any terminal
joelclaw tui

# Or from Termius on the phone
ssh joel@mac-mini "joelclaw tui"
```

Protocol: JSON frames over WebSocket (simplified from OpenClaw's protocol):
- `{type: "prompt", text: "..."}` — send a message
- `{type: "delta", text: "..."}` — streaming response chunk
- `{type: "done", fullText: "..."}` — response complete
- `{type: "status", ...}` — model, usage, session info

## Build Plan

### Phase 1: Daemon + Redis (replace current extension) ✅

- [x] Create `packages/gateway/` in monorepo
- [x] `daemon.ts` — entry point, `createAgentSession()`, launchd lifecycle
- [x] `command-queue.ts` — sequential input serialization
- [x] `channels/redis.ts` — port existing Redis bridge from extension
- [x] `heartbeat.ts` — `setInterval` runner, reads HEARTBEAT.md, watchdog (30min threshold), tripwire file
- [x] Update `com.joel.gateway` plist to run daemon directly (no tmux)
- [x] Verify: Redis events flow through pi session, responses logged

### Phase 2: Telegram ✅

- [x] `channels/telegram.ts` — grammY bot, user allowlist, text/photo/voice handlers
- [x] Outbound: markdown → Telegram HTML conversion, 4000 char chunking, typing indicator
- [x] Response routing via session.subscribe() delta collection → source channel dispatch
- [x] Bot token in `agent-secrets` (leased at startup via gateway-start.sh)
- [x] Created @JoelClawPandaBot via @BotFather
- [x] Verified: full round-trip — phone → Telegram → pi session → Telegram → phone

### Phase 3: WebSocket + TUI

- [ ] `channels/websocket.ts` — WS server on localhost (Tailscale accessible)
- [ ] `joelclaw tui` CLI command — connects to daemon WS, renders in terminal
- [ ] Stream deltas to connected clients
- [ ] Auth: Tailscale identity or simple token

### Phase 2b: iMessage Sidecar (`imsg-rpc`) ✅

- [x] Added iMessage channel client in gateway (`packages/gateway/src/channels/imessage.ts`) using JSON-RPC over `/tmp/imsg.sock`
- [x] Added dedicated LaunchAgent `com.joel.imsg-rpc` running `/Applications/imsg-rpc.app/Contents/MacOS/imsg rpc --socket /tmp/imsg.sock`
- [x] Split FDA boundary: gateway stays non-FDA; `imsg-rpc` helper owns Messages DB reads
- [x] Verified TCC attribution for launchd-spawned helper resolves to `com.steipete.imsg` and returns `authValue=2` for `kTCCServiceSystemPolicyAllFiles`
- [x] Added deterministic helper packaging flow: `~/Code/steipete/imsg/build-local.sh` now refreshes `/Applications/imsg-rpc.app` via `scripts/install-rpc-app.sh` to avoid binary drift
- [x] Verified inbound iMessage event path with OTEL events (`imessage.message.received`)

### Phase 4: Native App Foundation

- [ ] WebSocket protocol stabilized
- [ ] Session info endpoint (model, usage, messages)
- [ ] Consider React Native or Swift UI for iOS
- [ ] Consider whether to port OpenClaw's mobile node protocol

## Considered Options

### Option 1: Telegram bot on current extension (rejected as long-term)

Quick win (~1 hour) but doesn't solve the fundamental limitations. The extension can't control session lifecycle, can't stream, can't properly route replies. Would need to be rewritten anyway.

### Option 2: OpenClaw deployment (rejected — ADR-0003)

OpenClaw has everything we want, but it's a different system with different opinions about configuration, channel management, and multi-agent orchestration. We've already diverged significantly (Inngest over job queues, Qdrant over SQLite, k8s over localhost). Embedding pi directly gives us the session management without the rest.

### Option 3: Embedded pi daemon (chosen)

Best of both worlds: OpenClaw's proven architecture pattern (embedded pi, command queue, channel plugins) with joelclaw's infrastructure (Inngest, Redis, k8s, Tailscale). We own the daemon code, control the channel implementations, and can evolve at our own pace.

## Consequences

### Positive

- Talk to the agent from Telegram (phone), WebSocket (any terminal), and future native app
- Streaming responses to all channels
- No tmux PTY hack — pure headless Node.js daemon
- Same session, skills, extensions, tools as interactive pi
- Foundation for native iOS/macOS app
- Outbound delivery: agent can proactively message Joel on Telegram (not just respond)

### Negative

- More code to maintain (daemon + channels vs. extension)
- `pi` command no longer used for central session (it's embedded in the daemon)
- Need to build TUI attach for terminal access (or use Termius → `joelclaw tui`)
- Telegram bot token is a new secret to manage
- Channel-specific formatting (Telegram HTML, Discord markdown) is ongoing work

### Non-goals (for now)

- Multi-agent: one daemon = one pi session. Subagents are future work.
- Voice: Telegram voice messages → Whisper transcription is Phase 2+.
- Group chats: Bot responds only in DMs with Joel.
- End-to-end encryption: Tailscale provides transport security.

## Implementation

### Affected Paths

| Path | Change |
|------|--------|
| `packages/gateway/` | New package — daemon, channels, outbound, heartbeat |
| `~/Library/LaunchAgents/com.joel.gateway.plist` | Updated: runs daemon directly, no tmux |
| `~/.joelclaw/scripts/gateway-start.sh` | Simplified: just exec the daemon |
| `~/.pi/agent/extensions/gateway/` | Deprecated: functionality moves into daemon |
| `packages/cli/src/commands/gateway.ts` | Add `tui` subcommand for WebSocket attach |

### Dependencies

| Package | Purpose |
|---------|---------|
| `@mariozechner/pi-coding-agent` | Pi SDK — createAgentSession, tools, extensions |
| `@mariozechner/pi-ai` | Model selection (getModel) |
| `grammy` | Telegram Bot API |
| `ioredis` | Redis pub/sub bridge |
| `ws` | WebSocket server |

### Verification

- [ ] `createAgentSession()` works headless (no TUI, no terminal)
- [ ] Extensions and skills auto-discovered from `~/.pi/agent/`
- [ ] AGENTS.md loaded as system prompt context
- [ ] Heartbeat fires every 15 min, HEARTBEAT_OK filtered
- [ ] Redis events from Inngest flow through to session
- [ ] Telegram message → LLM response → Telegram reply (round-trip)
- [ ] WebSocket streaming deltas to connected client
- [ ] launchd restart on crash (KeepAlive)
- [ ] Session file persists across daemon restarts
- [ ] Satellite pi sessions still get targeted notifications

## Implementation Update (2026-02-24)

This ADR's channel architecture is now extended with a shipped iMessage sidecar path.

### Operational contract

- `imsg-rpc` is a separate user LaunchAgent with its own FDA grant surface.
- FDA is granted to the app bundle identity (`/Applications/imsg-rpc.app`, bundle id `com.steipete.imsg`), not to the gateway daemon.
- Gateway communicates only through JSON-RPC socket methods (`watch.subscribe`, `send`) on `/tmp/imsg.sock`.

### Why this matters

- Keeps the gateway process least-privileged.
- Avoids coupling iMessage permissions to Bun/Node runtime identity.
- Makes TCC behavior inspectable and reproducible with `tccd` logs and OTEL event traces.
