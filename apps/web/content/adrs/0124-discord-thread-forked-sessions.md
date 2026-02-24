# ADR-0124: Discord Thread-Forked Sessions

- **Status**: proposed
- **Date**: 2026-02-24
- **Supersedes**: Partially supersedes ADR-0123 (request-scoped routing) for Discord threads
- **Related**: ADR-0120 (Discord threads), ADR-0123 (channel routing)

## Context

The gateway currently runs a single pi session shared across all channels (Telegram, Discord, iMessage, Redis, CLI). ADR-0123 proposed request-scoped source tagging to prevent cross-channel confusion, but Discord threads naturally represent **separate conversational contexts** that deserve independent agent sessions.

Joel already runs 15–20 pi sessions routinely. Spinning up per-thread sessions is operationally normal, not a scaling concern.

## Decision

Adopt a **trunk + branch session model** for Discord:

### Trunk Session (always-on)
- The primary gateway pi session — the **safety thread**
- Handles: non-thread Discord messages, Telegram, iMessage, Redis events, webhooks, CLI
- Owns: identity, policy, guardrails, system memory
- Never replaced or forked — this is the canonical control plane

### Branch Sessions (per Discord thread)
- Each Discord thread forks a **new pi session** on first message
- Inherits a **minimal context bundle** from trunk:
  - Identity files (SOUL.md, IDENTITY.md, USER.md)
  - Active policy/guardrails from AGENTS.md
  - Channel-specific formatting instructions (see ADR-0125)
- Operates independently — own context window, own conversation history
- Lifecycle:
  - **Created**: on first user message in a new Discord thread
  - **Active**: while thread has activity
  - **Idle timeout**: 24h no activity → session suspended
  - **Archived**: thread closed or idle > 72h → session terminated, summary persisted

### Session Metadata

```typescript
interface ThreadSession {
  sessionId: string
  threadId: string
  parentSessionId: string  // trunk session ID
  lineage: "trunk" | "branch"
  channel: "discord"
  createdAt: number
  lastActivity: number
  status: "active" | "idle" | "archived"
}
```

### Session Registry

- Persist active thread→session mappings in Redis: `gateway:discord:threads:{threadId}` → session metadata
- Trunk session ID persisted at `~/.joelclaw/gateway.session` (existing behavior)

## Consequences

- Clean isolation: thread conversations don't leak into each other or trunk
- Natural UX: Discord thread = conversational boundary = session boundary
- Slightly higher resource usage (more pi sessions), but within normal operational range
- Trunk session stays clean and focused on cross-channel orchestration
- Thread summaries can flow back to trunk/memory on archive (optional, not required v1)

## Implementation

1. Add `ThreadSessionManager` to gateway Discord channel handler
2. On thread message: check Redis for existing session, create if missing
3. Route thread messages to branch session instead of trunk
4. Add idle reaper (cron or lazy check on next message)
5. Store session metadata in Redis with TTL
