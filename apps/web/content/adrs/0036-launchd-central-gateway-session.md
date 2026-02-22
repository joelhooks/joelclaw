---
status: superseded
date: 2026-02-17
decision-makers: Joel Hooks
consulted: Claude (pi session 2026-02-17)
informed: All agents operating on this machine
superseded-by:
  - "[ADR-0038 — Embedded pi gateway daemon](0038-embedded-pi-gateway-daemon.md)"
related:
  - "[ADR-0003 — Build joelclaw instead of deploying OpenClaw](0003-joelclaw-over-openclaw.md)"
  - "[ADR-0018 — Pi-native gateway with Redis event bridge](0018-pi-native-gateway-redis-event-bridge.md)"
  - "[ADR-0035 — Central + satellite session routing](0035-gateway-session-routing-central-satellite.md)"
credits:
  - "OpenClaw gateway-daemon.ts + launchd-plist.ts — the always-on launchd pattern, plist generation, and SIGUSR1 restart-with-drain approach are directly adapted from OpenClaw's macOS gateway implementation"
---

# Run central gateway session as a launchd-managed daemon

## Context and Problem Statement

ADR-0035 established a central + satellite routing model where one "gateway" session receives all heartbeats and system events. But that session needs to actually exist — it must be always-on, survive reboots, and auto-restart on crash.

### How OpenClaw Does It

OpenClaw runs its gateway as a **launchd LaunchAgent** (`bot.molt.gateway`):

- `RunAtLoad: true` — starts on user login
- `KeepAlive: true` — restarts on crash
- The gateway daemon (`gateway-daemon.ts`) is a standalone Node.js process
- It owns the pi session, manages WebSocket connections from TUI clients, handles SIGUSR1 for graceful restart with task drain
- The macOS app installs/updates the plist via `openclaw gateway install`
- Logs to `/tmp/openclaw/openclaw-gateway.log`
- `openclaw tui` attaches to the running gateway over WebSocket — you never run pi directly, you connect to the daemon

**Key difference**: OpenClaw's gateway IS a Node.js process that embeds pi as a library (`createAgentSession()`). It doesn't need a terminal — it's headless by design.

### Our Constraint

pi is a TUI application. It expects an interactive terminal with proper PTY dimensions. We can't just `launchd → pi` because there's no terminal. We need a PTY provider between launchd and pi.

## Decision

Use **launchd + tmux** to run the central gateway session:

```
launchd (com.joel.gateway)
  → gateway-start.sh
    → tmux new-session -d -s gateway -x 120 -y 40 "GATEWAY_ROLE=central pi"
    → wait loop (poll tmux session existence every 5s)
    → exit when pi/tmux dies → launchd restarts
```

### Components

| Component | Path | Purpose |
|-----------|------|---------|
| LaunchAgent plist | `~/Library/LaunchAgents/com.joel.gateway.plist` | Auto-start on login, restart on crash |
| Startup script | `~/.joelclaw/scripts/gateway-start.sh` | Manages tmux session lifecycle |
| tmux session | `gateway` (detached) | Provides PTY for pi's TUI |
| Pi extension | `~/.pi/agent/extensions/gateway/index.ts` | Registers as `gateway` in Redis when `GATEWAY_ROLE=central` |
| Boot prompt | `~/Vault/BOOT.md` | Injected on startup to orient the central session |

### Why tmux Over zellij

Zellij (0.43.1, already installed) doesn't support `-- command` syntax for running a command in a new session. tmux's `new-session -d -s name command` is purpose-built for headless daemon sessions. Both provide PTYs; tmux has the simpler scripting model for this use case.

### Attach / Detach

```bash
# Attach to the central session (view/interact)
tmux attach -t gateway

# Detach without killing (Ctrl-B, D)

# Check if running
tmux has-session -t gateway && echo "running" || echo "dead"

# View recent output without attaching
tmux capture-pane -t gateway -p | tail -20
```

### Environment

The central session runs with `GATEWAY_ROLE=central` which causes the gateway extension to:
1. Register as `gateway` (not `pid-XXXX`) in `joelclaw:gateway:sessions`
2. Inject `~/Vault/BOOT.md` as the first user message on startup
3. Receive ALL gateway events (heartbeats + task completions + system alerts)

## Considered Options

### Option 1: zellij session (rejected)

Already installed, but `zellij --session name -- command` isn't supported. Would need layout files or `zellij run` after session creation — more complex scripting for no benefit.

### Option 2: Headless pi mode (not available)

pi has `--print` for one-shot non-interactive use, but no persistent headless daemon mode. The TUI is integral to pi's architecture. Future pi versions may support this.

### Option 3: OpenClaw-style embedded pi (rejected for now)

OpenClaw embeds pi as a library via `createAgentSession()`. This gives full headless operation but requires building a custom gateway process. Contradicts ADR-0003 (build on pi directly). Revisit if pi adds a library/headless mode.

### Option 4: launchd + tmux (chosen)

Minimal approach. tmux is a well-understood PTY provider. The script is ~30 lines. launchd handles restart. The tradeoff is an extra process (tmux server) but it's negligible overhead.

## Consequences

### Positive

- Central session survives reboots, crashes, and terminal closures
- `tmux attach -t gateway` lets Joel inspect/interact with the operations console anytime
- Pattern matches OpenClaw's proven launchd daemon approach (credit: OpenClaw `src/daemon/launchd-plist.ts`)
- No custom gateway process needed — pure pi with an extension

### Negative

- tmux installed as new dependency (3.6a, ~2MB)
- Extra process layer (tmux server) between launchd and pi
- `tmux capture-pane` output is limited to scrollback buffer size (default 2000 lines)
- Pi updates require restarting the tmux session (not automatic like OpenClaw's SIGUSR1 restart)

### Follow-up Tasks

- [ ] Add `joelclaw gateway attach` CLI command (wraps `tmux attach -t gateway`)
- [ ] Add `joelclaw gateway restart` CLI command (kills tmux session, launchd restarts)
- [ ] Consider SIGUSR1 graceful restart like OpenClaw (drain pending events before restart)
- [ ] Update BOOT.md with kubectl-compatible health checks (not bare `redis-cli`)
- [ ] Suppress HEARTBEAT_OK responses in central session (filter like OpenClaw does)
- [ ] Add pi version check to startup script (auto-update before launching)

## Implementation

### Affected Paths

| File | Change |
|------|--------|
| `~/Library/LaunchAgents/com.joel.gateway.plist` | New launchd plist |
| `~/.joelclaw/scripts/gateway-start.sh` | New startup script |
| `~/.pi/agent/extensions/gateway/index.ts` | Boot prompt injection for central role |
| `~/Vault/BOOT.md` | Central session boot instructions |

### Verification

- [x] `tmux has-session -t gateway` returns 0 (session exists)
- [x] `kubectl exec redis-0 -- redis-cli smembers joelclaw:gateway:sessions` includes `gateway`
- [x] `tmux capture-pane -t gateway -p` shows pi TUI output
- [x] Heartbeat events route to `gateway` session only (not satellites)
- [ ] launchd restarts after `tmux kill-session -t gateway`
- [ ] Session survives macOS reboot
