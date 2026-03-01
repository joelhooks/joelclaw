---
name: gateway-diagnose
displayName: Gateway Diagnose
description: "Diagnose gateway failures by reading daemon logs, session transcripts, Redis state, and OTEL telemetry. Full Telegram path triage: daemon process → Redis channel → command queue → pi session → model API → Telegram delivery. Use when: 'gateway broken', 'telegram not working', 'why is gateway down', 'gateway not responding', 'check gateway logs', 'what happened to gateway', 'gateway diagnose', 'gateway errors', 'review gateway logs', 'fallback activated', 'gateway stuck', or any request to understand why the gateway failed. Distinct from the gateway skill (operations) — this skill is diagnostic."
version: 1.0.2
author: Joel Hooks
tags: [joelclaw, gateway, diagnosis, logs, telegram, reliability]
---

# Gateway Diagnosis

Structured diagnostic workflow for the joelclaw gateway daemon. Runs top-down from process health to message delivery, stopping at the first failure layer.

**Default time range: 1 hour.** Override by asking "check gateway logs for the last 4 hours" or similar.

## CLI Commands (use these first)

```bash
# Automated health check — runs all layers, returns structured findings
joelclaw gateway diagnose [--hours 1] [--lines 100]

# Session context — what happened recently? Exchanges, tools, errors.
joelclaw gateway review [--hours 1] [--max 20]
```

Start with `diagnose` to find the failure layer. Use `review` to understand what the gateway was doing when it broke. Only drop to manual log reading (below) when the CLI output isn't enough.

## Artifact Locations

| Artifact | Path | What's in it |
|----------|------|-------------|
| **Daemon stdout** | `/tmp/joelclaw/gateway.log` | Startup info, event flow, responses, fallback messages |
| **Daemon stderr** | `/tmp/joelclaw/gateway.err` | Errors, stack traces, retries, fallback activations — **check this first** |
| **PID file** | `/tmp/joelclaw/gateway.pid` | Current daemon process ID |
| **Session ID** | `~/.joelclaw/gateway.session` | Current pi session ID |
| **Session transcripts** | `~/.joelclaw/sessions/gateway/*.jsonl` | Full pi session history (most recent by mtime) |
| **Gateway working dir** | `~/.joelclaw/gateway/` | Has `.pi/settings.json` for compaction config |
| **Launchd plist** | `~/Library/LaunchAgents/com.joel.gateway.plist` | Service config, env vars, log paths |
| **Start script** | `~/.joelclaw/scripts/gateway-start.sh` | Secret leasing, env setup, bun invocation |
| **Tripwire** | `/tmp/joelclaw/last-heartbeat.ts` | Last heartbeat timestamp (updated every 15 min) |
| **WS port** | `/tmp/joelclaw/gateway.ws.port` | WebSocket port for TUI attach (default 3018) |

## Diagnostic Procedure

Run these steps in order. Stop and report at the first failure.

### Layer 0: Process Health

```bash
# Is the daemon running?
launchctl list | grep gateway
ps aux | grep gateway | grep -v grep

# What's the PID and uptime?
cat /tmp/joelclaw/gateway.pid
# Compare PID to launchctl list output — mismatch = stale PID file
```

**Failure patterns:**
- PID mismatch between launchctl and PID file → daemon restarted, PID file stale
- Exit code non-zero in launchctl → crash loop, check gateway.err
- Process not running but launchctl shows it → zombie, `launchctl kickstart -k`

### Layer 1: CLI Status

```bash
joelclaw gateway status
```

**Check:**
- `redis: "connected"` — if not, Redis pod is down
- `activeSessions` — should have `gateway` with `alive: true`
- `pending: 0` — if >0, messages are backing up (session busy or stuck)

### Layer 2: Error Log (the money log)

```bash
# Default: last 100 lines. Adjust for time range.
tail -100 /tmp/joelclaw/gateway.err
```

**Known error patterns:**

| Pattern | Meaning | Root Cause |
|---------|---------|-----------|
| `Agent is already processing` | Command queue tried to prompt while session streaming | Queue is not using follow-up behavior while streaming, or session is genuinely wedged |
| `dropped consecutive duplicate` | Inbound prompt was suppressed before model dispatch | Dedup collision (often from hashing channel preamble instead of message body) |
| `fallback activated` | Model timeout or consecutive failures triggered model swap | Primary model API down or slow |
| `no streaming tokens after Ns` | Timeout — prompt dispatched but no response | Model API issue, auth failure, or session not ready |
| `session still streaming, retrying` | Drain loop retry (3 attempts, 2s each) | Turn taking longer than expected |
| `watchdog: session appears stuck` | No turn_end for 10+ minutes after prompt | Hung tool call or model hang |
| `watchdog: session appears dead` | 3+ consecutive prompt failures | Triggers self-restart via graceful shutdown |
| `OTEL emit request failed: TimeoutError` | Typesense unreachable | k8s port-forward or Typesense pod issue (secondary) |
| `prompt failed` with `consecutiveFailures: N` | Nth failure in a row | Check model API, session state |

### Layer 3: Stdout Log (event flow)

```bash
tail -100 /tmp/joelclaw/gateway.log
```

**Look for:**
- `[gateway] daemon started` — last startup time, model, session ID
- `[gateway:telegram] message received` — did the message arrive?
- `[gateway:store] persisted inbound message` — was it persisted?
- `[gateway:fallback] prompt dispatched` — was a prompt sent to the model?
- `[gateway] response ready` — did the model respond?
- `[gateway:fallback] activated` — is fallback model in use?
- `[redis] suppressed N noise event(s)` — which events are being filtered
- `[gateway:store] replayed unacked messages` — startup replay (can cause races)

### Layer 4: E2E Delivery Test

```bash
joelclaw gateway test
# Wait 5 seconds
joelclaw gateway events
```

**Expected:** Test event pushed and drained (totalCount: 0 after drain).
**Failure:** Event stuck in queue → session not draining → check Layer 2 errors.

### Layer 5: Session Transcript

```bash
# Find most recent gateway session
ls -lt ~/.joelclaw/sessions/gateway/*.jsonl | head -1

# Read last N lines of the session JSONL
tail -50 ~/.joelclaw/sessions/gateway/<session-file>.jsonl
```

Each line is a JSON object. Look for:
- `"type": "turn_end"` — confirms turns are completing
- `"type": "error"` — model or tool errors
- Long gaps between `turn_start` and `turn_end` — slow turns
- Tool call entries — what was the session doing when it got stuck?

### Layer 6: OTEL Telemetry

```bash
# Gateway-specific events
joelclaw otel search "gateway" --hours 1

# Fallback events
joelclaw otel search "fallback" --hours 1

# Queue events
joelclaw otel search "command-queue" --hours 1

# Dedup events (store-level + drain-level)
joelclaw otel search "queue.dedup_dropped" --hours 6
joelclaw otel search "message.dedup_dropped" --hours 6
```

### Layer 7: Model API Health

```bash
# Quick API reachability test (auth error = API reachable)
curl -s -m 10 https://api.anthropic.com/v1/messages \
  -H "x-api-key: test" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{}' | jq .error.type
# Expected: "authentication_error" (means API is reachable)
```

### Layer 8: Redis State

```bash
# Check gateway queue directly
kubectl exec -n joelclaw redis-0 -- redis-cli LLEN joelclaw:notify:gateway

# Check message store
kubectl exec -n joelclaw redis-0 -- redis-cli XLEN gateway:messages

# Check unacked messages (these replay on restart)
kubectl exec -n joelclaw redis-0 -- redis-cli XRANGE gateway:messages - + COUNT 5
```

## Known Failure Scenarios

### 1. Streaming race / replay overlap

**Symptoms:** `Agent is already processing`, repeated `queue.prompt.failed`, watchdog self-restarts (`watchdog:dead-session`).
**Cause:** Prompt dispatched while pi session is still streaming (turn end + compaction + replay overlap), without follow-up queue behavior.
**Fix:**
- Ensure gateway command queue dispatch uses `session.prompt(..., { streamingBehavior: "followUp" })`.
- If still failing, check for stalled turns (`watchdog.session_stuck`) and abort/restart once.
- Confirm failures stop (no new `watchdog:dead-session` in `gateway.log`).

### 2. Model API Timeout

**Symptoms:** "no streaming tokens after 90s", fallback activated.
**Cause:** Primary model (claude-opus-4-6) API slow or down.
**Fix:** Fallback auto-activates. Recovery probe runs every 10 min. If persistent, check Anthropic status.

### 3. Stuck Tool Call

**Symptoms:** Watchdog fires after 10 min, session stuck.
**Cause:** A tool call (bash, read, etc.) hanging indefinitely.
**Fix:** Watchdog auto-aborts. If stuck persists, `joelclaw gateway restart`.

### 4. Redis Disconnection

**Symptoms:** Status shows redis disconnected, no events flowing.
**Cause:** Redis pod restart or port-forward dropped.
**Fix:** `kubectl get pods -n joelclaw` to verify, ioredis auto-reconnects.

### 5. Compaction During Message Delivery

**Symptoms:** "already processing" after a successful turn_end.
**Cause:** Auto-compaction triggers after turn_end, session enters streaming state again before drain loop processes next message.
**Fix:** The idle waiter should block until compaction finishes. If not, this is a pi SDK gap.

### 6. False duplicate suppression (channel preamble collision)

**Symptoms:** user reports "it ignored my message" while queue dedup events fire.
**Current behavior (post-fix):** both store-level and queue-level dedup hash the normalized message body (channel preamble stripped), so false positives should be rare.
**How to verify:** inspect OTEL metadata on `queue.dedup_dropped` / `message.dedup_dropped` (`dedupHashPrefix`, `strippedInjectedContext`, `promptLength`, `normalizedLength`). If normalized lengths differ materially from expected user payload, dedup normalization is wrong.
**Fix path:** keep dedup enabled, tune normalization + telemetry first. Remove dedup only if telemetry proves systemic false drops and no safe normalization exists.

## Fallback Controller State

The gateway has a model fallback controller (ADR-0091) that swaps models when the primary fails:

- **Threshold:** 90s timeout for first token, or 3 consecutive prompt failures (configurable)
- **Fallback model:** gpt-5.3-codex-spark (via openai-codex provider)
- **Recovery:** Probes primary model every 10 minutes
- **OTEL events:** `model_fallback.swapped`, `model_fallback.primary_restored`, `model_fallback.probe_failed`

Check fallback state in gateway.log: `[gateway:fallback] activated` / `recovered`.

## Architecture Reference

```
Telegram → channels/telegram.ts → enqueueToGateway()
Redis    → channels/redis.ts    → enqueueToGateway()
                                        ↓
                                 command-queue.ts
                                   (serial FIFO)
                                        ↓
                              session.prompt(text)
                                        ↓
                              pi SDK (isStreaming gate)
                                        ↓
                              Model API (claude-opus-4-6)
                                        ↓
                              turn_end → idleWaiter resolves
                                        ↓
                              Response routed to origin channel
```

The command queue processes ONE prompt at a time. `idleWaiter` blocks until `turn_end` fires. If a prompt is in flight, new messages queue behind it.

## Key Code

| File | What to look for |
|------|-----------------|
| `packages/gateway/src/daemon.ts` | Session creation, event handler, idle waiter, watchdog |
| `packages/gateway/src/command-queue.ts` | `drain()` loop, retry logic, idle gate |
| `packages/gateway/src/model-fallback.ts` | Timeout tracking, fallback swap, recovery probes |
| `packages/gateway/src/channels/redis.ts` | Event batching, prompt building, sleep mode |
| `packages/gateway/src/channels/telegram.ts` | Bot polling, message routing |
| `packages/gateway/src/heartbeat.ts` | Tripwire writer only (ADR-0103: no prompt injection) |

## Related Skills

- **[gateway](../gateway/SKILL.md)** — operational commands (restart, push, drain)
- **[joelclaw-system-check](../joelclaw-system-check/SKILL.md)** — full system health (broader scope)
- **[k8s](../k8s/SKILL.md)** — if Redis/Inngest pods are the problem
