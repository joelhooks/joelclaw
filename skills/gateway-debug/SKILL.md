---
name: gateway-debug
description: "Diagnose and fix the joelclaw gateway daemon — detect hung sessions, stuck tool calls, queue backpressure, stale processes, and Telegram/Redis channel failures. Use when: 'gateway stuck', 'gateway hung', 'is gateway healthy', 'gateway not responding', 'telegram not working', 'messages not going through', 'restart gateway', 'gateway debug', 'why is the gateway stuck', or any gateway troubleshooting task."
---

# Gateway Debug — Diagnose & Fix the joelclaw Gateway Daemon

The gateway daemon (`com.joel.gateway`) runs a headless pi session via `createAgentSession()` from the pi SDK. It receives messages through Redis pub/sub and Telegram, processes them through the pi agent, and routes responses back. When it breaks, messages pile up silently.

## Quick Triage Checklist

Run these in order. Stop at the first failure.

### 1. Is the process alive?

```bash
cat /tmp/joelclaw/gateway.pid 2>/dev/null && kill -0 $(cat /tmp/joelclaw/gateway.pid) 2>/dev/null && echo "alive" || echo "DEAD"
```

If dead: `launchctl kickstart -k gui/$(id -u)/com.joel.gateway`

### 2. Is the session stuck mid-stream?

```bash
# Check for child processes of the gateway (stuck tool calls)
GATEWAY_PID=$(cat /tmp/joelclaw/gateway.pid)
pgrep -P $GATEWAY_PID -l 2>/dev/null || echo "no children (not streaming)"
```

**If there are child processes running for minutes**, the agent is stuck on a tool call. Common culprits:
- `find` over large directories (no timeout)
- `git` operations that hang on auth prompts
- Network requests to unresponsive endpoints
- `grep -r` across huge trees

**Fix**: Kill the stuck children, then restart gateway:
```bash
pkill -P $GATEWAY_PID
kill $GATEWAY_PID
# launchd will respawn
```

### 3. Is the command queue blocked?

```bash
# Check for "Agent is already processing" errors
grep -c "Agent is already processing" /tmp/joelclaw/gateway.err 2>/dev/null
```

If this count is growing, the agent is mid-stream and new messages can't get through. The command queue calls `session.prompt()` without `streamingBehavior`, so concurrent messages throw.

**Fix**: Restart the gateway (kills the stuck stream).

### 4. Check recent logs

```bash
tail -30 /tmp/joelclaw/gateway.log
echo "=== ERRORS ==="
tail -30 /tmp/joelclaw/gateway.err
```

Look for:
- `command-queue: prompt failed` — the session rejected a prompt
- `telegram send failed` — HTML parsing errors in Telegram responses
- `uncaught exception` / `unhandled rejection` — runtime crashes
- `shutting down` — recent restarts

### 5. Check the gateway session file

```bash
# Find the current session
GATEWAY_PID=$(cat /tmp/joelclaw/gateway.pid)
SESSION_ID=$(grep -o '"sessionId":"[^"]*"' /tmp/joelclaw/gateway.log | tail -1 | cut -d'"' -f4)
echo "Session ID: $SESSION_ID"

# Check session file size and last entry
ls -la ~/.pi/agent/sessions/--Users-joel--/*$SESSION_ID* 2>/dev/null
tail -1 ~/.pi/agent/sessions/--Users-joel--/*$SESSION_ID*.jsonl 2>/dev/null | python3 -m json.tool 2>/dev/null | head -20
```

If the last entry is a `message` with `toolCall` content and no matching `toolResult`, the session is stuck waiting for tool output.

### 6. Check Redis connectivity

```bash
joelclaw gateway status
```

### 7. Check Telegram channel

```bash
# Verify the bot started
grep "telegram.*started" /tmp/joelclaw/gateway.log | tail -1
# Check for send failures
grep "telegram.*failed" /tmp/joelclaw/gateway.err | tail -5
```

## Common Failure Modes

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| Gateway reports healthy but messages don't go through | Session stuck mid-stream on hung tool call | Kill children + restart gateway |
| "Agent is already processing" errors | Concurrent prompt while streaming | Restart gateway |
| Telegram messages not delivered | HTML parsing error in response | Check gateway.err for Grammy errors |
| Gateway restarts every few seconds | Crash loop — check gateway.err | Fix the crash, then restart |
| Redis connection failed | Redis pod down or port-forward broken | `kubectl get pods -n joelclaw`, check redis-0 |
| Session file growing huge | No compaction in headless mode | Restart gateway (creates new session) |

## Deep Health Check Script

Run this for a comprehensive assessment:

```bash
#!/bin/bash
echo "=== Gateway Deep Health Check ==="
GATEWAY_PID=$(cat /tmp/joelclaw/gateway.pid 2>/dev/null)

# 1. Process
if [ -z "$GATEWAY_PID" ] || ! kill -0 $GATEWAY_PID 2>/dev/null; then
  echo "❌ PROCESS: dead"
else
  UPTIME=$(ps -p $GATEWAY_PID -o etime= 2>/dev/null | xargs)
  echo "✅ PROCESS: alive (PID $GATEWAY_PID, uptime $UPTIME)"
fi

# 2. Children (stuck tool calls)
CHILDREN=$(pgrep -P $GATEWAY_PID 2>/dev/null | wc -l | xargs)
if [ "$CHILDREN" -gt 0 ]; then
  echo "⚠️  CHILDREN: $CHILDREN child processes (may be stuck)"
  pgrep -P $GATEWAY_PID -l 2>/dev/null | head -5
else
  echo "✅ CHILDREN: none (idle)"
fi

# 3. Error rate
ERRORS=$(grep -c "Agent is already processing" /tmp/joelclaw/gateway.err 2>/dev/null || echo 0)
if [ "$ERRORS" -gt 0 ]; then
  echo "⚠️  BLOCKED: $ERRORS 'already processing' errors"
else
  echo "✅ BLOCKED: no queue errors"
fi

# 4. Last response
LAST_RESPONSE=$(grep "response ready" /tmp/joelclaw/gateway.log 2>/dev/null | tail -1)
if [ -n "$LAST_RESPONSE" ]; then
  echo "✅ LAST RESPONSE: $LAST_RESPONSE"
else
  echo "⚠️  LAST RESPONSE: none found in logs"
fi

# 5. Session size
SESSION_ID=$(grep -o 'sessionId: "[^"]*"' /tmp/joelclaw/gateway.log 2>/dev/null | tail -1 | cut -d'"' -f2)
if [ -n "$SESSION_ID" ]; then
  SESSION_FILE=$(ls ~/.pi/agent/sessions/--Users-joel--/*$SESSION_ID* 2>/dev/null | head -1)
  if [ -n "$SESSION_FILE" ]; then
    SIZE=$(wc -c < "$SESSION_FILE" | xargs)
    LINES=$(wc -l < "$SESSION_FILE" | xargs)
    echo "✅ SESSION: $LINES entries, $(echo "scale=1; $SIZE/1024" | bc)KB"
  fi
fi

# 6. Model
MODEL=$(grep "model:" /tmp/joelclaw/gateway.log 2>/dev/null | tail -1)
echo "ℹ️  $MODEL"
```

## Restart Procedure

```bash
# Clean restart (preferred)
joelclaw gateway restart

# Manual restart
kill $(cat /tmp/joelclaw/gateway.pid)
# launchd respawns automatically (KeepAlive: true)

# Force restart via launchctl
launchctl kickstart -k gui/$(id -u)/com.joel.gateway

# Verify
sleep 3 && tail -5 /tmp/joelclaw/gateway.log
```

## Architecture Reference

```
launchd (com.joel.gateway)
  └─ gateway-start.sh
       └─ bun run daemon.ts
            ├─ createAgentSession() → headless pi session
            ├─ Redis channel (joelclaw:notify:gateway)
            ├─ Telegram channel (@JoelClawPandaBot)
            ├─ Command queue (serial prompt drain)
            └─ Media outbound (joelclaw:media:outbound)
```

- **PID file**: `/tmp/joelclaw/gateway.pid`
- **Stdout**: `/tmp/joelclaw/gateway.log`
- **Stderr**: `/tmp/joelclaw/gateway.err`
- **Plist**: `~/Library/LaunchAgents/com.joel.gateway.plist`
- **Start script**: `~/.joelclaw/scripts/gateway-start.sh`
- **Daemon source**: `~/Code/joelhooks/joelclaw/packages/gateway/src/daemon.ts`
- **Session files**: `~/.pi/agent/sessions/--Users-joel--/`

## Prevention: Bash Timeout Extension

ADR-0049 introduced a pi-tools extension (`bash-timeout`) that injects a default 120-second timeout on all bash tool calls when the LLM doesn't specify one. This prevents the entire class of "hung forever" bugs.

Configure via env: `PI_BASH_DEFAULT_TIMEOUT=180` (seconds).

## Related

- ADR-0038: Gateway daemon architecture
- ADR-0049: Gateway TUI via WebSocket
- Skill: [joelclaw](../joelclaw/SKILL.md) — event bus CLI
- Skill: [joelclaw-system-check](../joelclaw-system-check/SKILL.md) — full system health
