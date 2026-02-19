---
type: adr
status: implemented
date: 2026-02-18
tags: [gateway, tui, websocket, pi-sdk]
---

# ADR-0049: Gateway TUI via WebSocket

## Status

Accepted

## Context

The joelclaw gateway daemon (`com.joel.gateway`) runs a headless pi session via `createAgentSession()` from the pi SDK. It accepts messages through Redis pub/sub and Telegram channels, but there is **no way to interact with it from a terminal**.

This creates several problems:

1. **No visibility** — when the gateway hangs (e.g., a bash tool call running `find` for 12+ minutes with no timeout), there's no way to see what it's doing without reading raw log files and process tables.
2. **Health checks lie** — `joelclaw gateway status` reported "healthy" while the session was stuck mid-stream on a hung tool call. It only checks Redis connectivity and process existence, not session state.
3. **No attach workflow** — unlike OpenClaw which has `openclaw tui` connecting to a gateway via WebSocket, joelclaw requires finding terminal tabs or reading session JSONL files manually.
4. **Bash commands hang forever** — the pi bash tool accepts an optional `timeout` parameter, but the LLM doesn't always specify one. In a headless daemon with no human watching, a single hung command blocks all subsequent messages.

### OpenClaw Reference

OpenClaw solves this with a clean client-server split (credit: openclaw/openclaw `src/tui/gateway-chat.ts`):
- Gateway exposes a WebSocket server
- `openclaw tui` connects as a `GatewayChatClient`
- Protocol supports: `chat.send`, `chat.abort`, `chat.history`, `sessions.list`, `sessions.patch`, `status`
- TUI is just another channel — the gateway remains the single session owner

## Decision

### 1. WebSocket Server in Gateway Daemon

Add a WebSocket server to the gateway daemon that exposes the pi session for TUI attachment. The server:

- Listens on a configurable port (default: `3018`, stored in `/tmp/joelclaw/gateway.ws.port`)
- Streams session events (text deltas, tool calls, tool results, turn boundaries) to connected clients
- Accepts prompts from connected TUI clients (routed through the existing command queue)
- Exposes session state: `isStreaming`, `currentToolCalls`, `sessionId`, `model`, `uptime`
- Supports `abort` to cancel the current generation
- Single-writer: only one TUI client can send prompts at a time (but multiple can observe)

### 2. `joelclaw tui` CLI Command

New subcommand that launches a terminal UI connected to the gateway via WebSocket:

```bash
joelclaw tui                    # connect to local gateway
joelclaw tui --url ws://...     # connect to remote gateway
joelclaw tui --observe          # read-only mode (watch without sending)
```

The TUI:
- Shows live streaming responses (text deltas as they arrive)
- Shows tool call execution (command, output, timing)
- Allows sending prompts via text input
- Shows session metadata in a status bar (model, uptime, queue depth, streaming state)
- Supports `/abort` to cancel current generation
- Supports `/status` to show detailed gateway health
- Gracefully reconnects on disconnect

### 3. Default Bash Timeout Extension

Add a pi-tools extension (`bash-timeout/index.ts`) that intercepts `tool_call` events for the bash tool and injects a default timeout when the LLM doesn't specify one:

- Default: 120 seconds (configurable via `PI_BASH_DEFAULT_TIMEOUT` env var)
- Only applies when `event.input.timeout` is `undefined`
- Mutates `event.input.timeout` directly (same object reference passed to tool execute)
- Logs when a default timeout is applied

### 4. Deep Health Checks

Enhance `joelclaw gateway status` and the gateway-debug skill to check:

- Process existence (PID file + `kill -0`)
- Redis connectivity
- **Session streaming state** — is the agent mid-stream? For how long?
- **Stuck tool calls** — are there child processes of the gateway PID that have been running too long?
- **Command queue depth** — are messages piling up?
- **Last successful response** — when did the gateway last complete a turn?
- **Error rate** — count of "Agent is already processing" errors in gateway.err

## Consequences

- Gateway daemon grows a WebSocket dependency (lightweight — `ws` package or Bun native WebSocket)
- TUI is "just another channel" — same pattern as Telegram, no special session ownership
- Bash timeout extension prevents the entire class of "hung forever" bugs that caused today's outage
- Health checks become meaningful — they detect the actual failure mode (stuck streaming) not just "is process alive"
- Future: the WS server could support multiple named sessions, remote access via Tailscale

## Implementation Notes

### WebSocket Protocol (Minimal)

```
Client → Server:
  { type: "prompt", text: "...", source: "tui" }
  { type: "abort" }
  { type: "status" }

Server → Client:
  { type: "text_delta", delta: "..." }
  { type: "tool_call", id: "...", name: "bash", input: {...} }
  { type: "tool_result", id: "...", content: [...] }
  { type: "turn_end" }
  { type: "status", data: { streaming: bool, model: "...", uptime: N, ... } }
  { type: "error", message: "..." }
```

### Gateway Session File

The gateway should use a **stable, predictable session file** so the TUI can also load history on connect:

```
~/.pi/agent/sessions/--Users-joel--/gateway-session.jsonl
```

Currently it creates a new session file each restart. Pin it to a stable path via `SessionManager.open()`.

## Related

- ADR-0038: Gateway daemon architecture
- OpenClaw `src/tui/gateway-chat.ts` — reference implementation (credit: openclaw/openclaw)
- pi SDK `createAgentSession()` — headless session API
- pi extensions `tool_call` event — input mutation for timeout injection
