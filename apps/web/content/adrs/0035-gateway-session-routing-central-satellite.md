---
status: implemented
date: 2026-02-17
decision-makers: Joel Hooks
consulted: Claude (pi session 2026-02-17)
informed: All agents operating on this machine
related:
  - "[ADR-0003 — Build joelclaw instead of deploying OpenClaw](0003-joelclaw-over-openclaw.md)"
  - "[ADR-0018 — Pi-native gateway with Redis event bridge](0018-pi-native-gateway-redis-event-bridge.md)"
  - "[ADR-0038 — Embedded pi gateway daemon](0038-embedded-pi-gateway-daemon.md)"
---

# Central + satellite session routing for gateway events

## Context and Problem Statement

ADR-0018 established a Redis event bridge between Inngest functions and pi sessions. The initial implementation pushed every event to a single shared `joelclaw:events:main` list. This worked for one session but breaks with multiple concurrent pi sessions — every session receives every heartbeat, events are drained by whichever session reads first (race condition), and context budgets are wasted on irrelevant notifications.

Joel often runs 3-5 pi sessions simultaneously (different terminals, different tasks). A heartbeat cron firing every 15 minutes shouldn't interrupt a coding session — it should go to the session responsible for system oversight.

### How OpenClaw Does It

OpenClaw uses a **single-session model**. One Node.js process owns the LLM session. All inputs — TUI commands, heartbeat prompts, channel messages (Telegram, Discord, WhatsApp, web) — serialize through a single `CommandLane.Main` queue into that one session.

External access works through **gateways**: the `openclaw tui` CLI attaches to the running session over WebSocket, and channel plugins (Telegram bot, Discord bot, etc.) route messages through the same queue. There's no concept of "satellite sessions" — there's one brain, many interfaces.

The heartbeat is a `setInterval` timer inside the gateway process that reads `HEARTBEAT.md`, drains an in-memory event queue, builds a prompt, and injects it. `HEARTBEAT_OK` responses are filtered/suppressed.

**Key OpenClaw pattern**: One session, many interfaces. The gateway IS the session.

### How joelclaw Diverges

joelclaw uses **pi directly** as the agent runtime — there's no separate gateway process. Each terminal window runs an independent pi session with its own conversation context, memory, and tools. This is fundamentally different from OpenClaw's single-session architecture.

The question becomes: which session gets which notifications?

## Decision

Adopt a **central + satellite** routing model for gateway events:

### Roles

| Role | Session ID | Receives | Use case |
|------|-----------|----------|----------|
| **Central** | `gateway` | ALL events (heartbeats, task completions, system alerts) | Always-on system oversight session |
| **Satellite** | `pid-{PID}` | Only events targeted via `originSession` | Working sessions that kicked off background tasks |

### Routing Rules

1. **Heartbeats** (`cron.heartbeat`) → central session only
2. **Task completions** (`loop.complete`, `loop.failed`, `media.downloaded`, `media.transcribed`) → originating session + central session
3. **System alerts** (future: disk full, service down) → central session only
4. **No active sessions** → events accumulate in legacy `joelclaw:events:main` list, drained by next session to start

### Origin Tracking

When a background task is initiated (loop start, video download, etc.), the initiating session's ID is recorded in the event payload as `originSession`. Inngest functions carry this through the pipeline and pass it to `pushGatewayEvent()` at completion.

### Registration

- Sessions register in Redis set `joelclaw:gateway:sessions` on startup (`SADD`)
- Sessions unregister on shutdown (`SREM`) and clean up their event list (`DEL`)
- `pushGatewayEvent()` reads the set and fans out to matching targets
- Stale sessions (crashed without cleanup) are detected when their PID no longer exists

### Central Session Designation

The central session is designated by setting `GATEWAY_ROLE=central` in the pi process environment. Only one session should be central at a time. If no central session exists, events fall back to the legacy `main` list.

## Considered Options

### Option 1: OpenClaw model — single session, many interfaces (rejected)

Would require building a gateway process that owns one pi session and proxies all input. Contradicts ADR-0003 (build on pi directly, not a custom gateway). Loses the multi-session workflow Joel actually uses.

### Option 2: Broadcast to all sessions (rejected)

Simple but wasteful. Every session gets every heartbeat, every loop completion. Context budgets are finite — a coding session shouldn't burn tokens on heartbeat checklists.

### Option 3: Central + satellite routing (chosen)

Clean separation of concerns. The central session is the "operations console" — always watching, always aware. Satellites are task-focused — they only hear about their own background work.

## Consequences

### Positive

- Heartbeats don't pollute coding sessions
- Background tasks notify the session that cares (the one that started them)
- Central session provides system-wide awareness without manual polling
- Graceful degradation — no central session means legacy fallback, not data loss

### Negative

- Origin tracking requires threading `originSession` through event payloads (incremental wiring work)
- Central session must be explicitly designated (not auto-elected)
- Stale session cleanup is best-effort (PID-based, no heartbeat/lease)

### Follow-up Tasks

- [ ] Wire `originSession` into `agent/loop.started` event schema and carry through pipeline
- [ ] Wire `originSession` into `pipeline/video.requested` events
- [ ] Implement stale session reaping (check if PID exists, remove if not)
- [ ] Add `GATEWAY_ROLE=central` to the always-on pi session configuration
- [ ] Filter `HEARTBEAT_OK` responses in central session (suppress from TUI, like OpenClaw does)
- [ ] Consider auto-election: first session to start becomes central if none exists

## Implementation

### Affected Paths

| File | Change |
|------|--------|
| `~/.pi/agent/extensions/gateway/index.ts` | Session registration, role-based routing, per-session channels |
| `packages/system-bus/src/inngest/functions/agent-loop/utils.ts` | `pushGatewayEvent()` fan-out with `originSession` targeting |
| `packages/system-bus/src/inngest/client.ts` | `originSession` field on loop/pipeline event types |
| `packages/cli/src/commands/gateway.ts` | Status shows active sessions, events shows per-session queues |

### Redis Schema

| Key | Type | Purpose |
|-----|------|---------|
| `joelclaw:gateway:sessions` | SET | Active session IDs (`gateway`, `pid-2026`, etc.) |
| `joelclaw:events:{sessionId}` | LIST | Per-session event queue (LPUSH, LRANGE, DEL) |
| `joelclaw:notify:{sessionId}` | PUB/SUB | Per-session wake-up channel |
| `joelclaw:events:main` | LIST | Legacy fallback when no sessions registered |

### Verification

- [x] `pushGatewayEvent()` with no `originSession` routes to `gateway` only
- [x] `pushGatewayEvent()` with `originSession` routes to origin + `gateway`
- [x] No registered sessions → events go to legacy `main` list
- [x] Extension registers on startup, unregisters on shutdown
- [x] CLI `gateway status` shows active sessions with queue depths
- [ ] Loop completion notifies originating session (requires origin wiring)
- [ ] Central session receives heartbeats, satellites do not
