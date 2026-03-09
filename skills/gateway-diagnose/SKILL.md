---
name: gateway-diagnose
displayName: Gateway Diagnose
description: "Diagnose gateway failures by reading daemon logs, session transcripts, Redis state, and OTEL telemetry. Full Telegram path triage: daemon process → Redis channel → command queue → pi session → model API → Telegram delivery. Use when: 'gateway broken', 'telegram not working', 'why is gateway down', 'gateway not responding', 'check gateway logs', 'what happened to gateway', 'gateway diagnose', 'gateway errors', 'review gateway logs', 'fallback activated', 'gateway stuck', or any request to understand why the gateway failed. Distinct from the gateway skill (operations) — this skill is diagnostic."
version: 1.1.5
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

Start with `diagnose` to find the failure layer. It now reports disabled launchd state for `com.joel.gateway` explicitly (instead of a generic process failure), and distinguishes `redis_degraded` from a truly dead gateway. Use `review` to understand what the gateway was doing when it broke. Only drop to manual log reading (below) when the CLI output isn't enough.

## Autonomous Monitor (cross-channel)

Gateway health is now checked automatically by Inngest function `check/gateway-health` on heartbeat fan-out event `gateway/health.check.requested`.

What it monitors:
- **General gateway failure**: critical `joelclaw gateway diagnose` layers (`process`, `cli-status`, `e2e-test`, `redis-state`)
- **Specific channel degradation**: OTEL severe action counts for `telegram-channel`, `discord-channel`, `imessage-channel`, `slack-channel`

What it does:
- Tracks failure streaks in Redis to suppress one-off noise
- Auto-restarts gateway on sustained general failure (cooldown-protected)
- Sends immediate Telegram alert only on sustained unresolved failures
- Emits OTEL with component `check-gateway-health`, action `gateway.health.checked`

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

### Layer -1: Substrate health (Colima + k8s)

```bash
colima status --json
kubectl get nodes -o wide
kubectl get pods -n joelclaw redis-0 inngest-0
```

**Failure patterns:**
- `colima is not running` or kubectl EOF/refused → gateway/Redis symptoms are secondary. Bring Colima back first.
- Node not `Ready` or core pods not `Running` → fix cluster substrate before touching gateway.

### Layer 0: Process Health

```bash
# Is launchd service disabled?
launchctl print-disabled gui/$(id -u) | rg "com\\.joel\\.gateway"

# Exact launchd service state (+ pid, last exit code)
launchctl print gui/$(id -u)/com.joel.gateway

# Is daemon process running outside launchd?
ps aux | grep "/packages/gateway/src/daemon.ts" | grep -v grep

# Optional PID file cross-check (missing PID file is non-fatal)
cat /tmp/joelclaw/gateway.pid
```

**Failure patterns:**
- `"com.joel.gateway" => disabled` → launchd service disabled (`joelclaw gateway enable` or `joelclaw gateway restart` to recover)
- launchctl service missing + no daemon process → gateway down
- launchd PID differs from PID file → stale PID file (degraded, not fatal)
- daemon process alive but launchd service missing/disabled → manual run or launchd drift

### Layer 1: CLI Status

```bash
joelclaw gateway status
```

**Check:**
- `mode` — `normal` vs `redis_degraded`
- `degradedCapabilities` — explicit list of what Redis loss is breaking
- `sessionPressure` — context %, compaction age, session age, next action, next threshold summary, thread counts, fallback state/activations/failures, pressure reasons, alert state
- `supersession` — latest-wins interruptibility state for human turns (active superseded request, last source/time/drop count, batching window, pending sources, last batch flush)
- `operatorTracing` — canonical Telegram operator action ack/dispatch/completion/timeout summary across callbacks + direct commands
- `callbackTracing` — compatibility alias for the same snapshot while older surfaces catch up
- `channels` — reusable runtime health/ownership snapshots for Telegram, Discord, iMessage, and Slack
- `channelHealth` — summarized degraded/muted channel state plus last degrade/recover event
- `activeSessions` — should have `gateway` with `alive: true`
- `pending: 0` — if >0, messages are backing up (session busy or stuck)

Interpretation:
- `mode: redis_degraded` means the daemon/session can still be usable while the Redis bridge is sick.
- Do not call that a full outage unless process/session layers are also failing.
- `joelclaw gateway diagnose` now emits a dedicated `session-pressure` layer so pressure risk is inspectable even when Redis/process layers are healthy.
- `interruptibility` tells you whether a newer human message already superseded the stale turn, and whether direct human channels are currently sitting inside the short batching window before dispatch, so a brief pause can be intentional instead of another silent failure.
- `operator-tracing` tells you whether Telegram operator callbacks and direct commands are acking, completing, failing, or timing out honestly, with route + trace id surfaces for the last completed/failed/timed-out action. Queued Telegram agent commands now stay open until the downstream gateway turn really finishes, and external callback-route consumers can now close traces via Redis trace-result handoff instead of being marked done at publish time.
- `channel-health` tells you whether a channel is intentionally owner/passive/fallback, truly connected, or quietly half-dead. It now also shows muted known issues and the last degrade/recover event. Telegram `fallback` with `leaseEnabled=false` is expected when poll leasing is disabled locally; do not call that degraded by itself — but if polling is actually down and only retrying after `getUpdates` conflicts, diagnose now marks that contract degraded instead of pretending fallback is healthy.
- `channel-healing` tells you whether the watchdog currently has a restart policy armed, what the degraded streak/cooldown is, whether the last heal attempt succeeded or blew up, and what manual repair summary/commands apply when the policy is `manual`. Muted degraded channels should now read as manual repair too — if you still see `restart` on a muted broken channel, the contract is lying.

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
| `Authentication failed for "anthropic"` | Prompt rejected before model stream starts | Anthropic OAuth expired/missing (`/login anthropic` required) |
| `getUpdates ... 409: Conflict` / `telegram.channel.start_failed` with `conflict=true` | Telegram long-poll contention | Another bot process is polling the same token. Gateway retries with backoff; with lease enabled, check `telegram.channel.poll_owner.*` to confirm owner/passive transitions |
| `no streaming tokens after Ns` | Timeout — prompt dispatched but no response | Model API latency/outage, or session not ready |
| `session still streaming, retrying` | Drain loop retry (3 attempts, 2s each) | Turn taking longer than expected |
| `watchdog: session appears stuck` | No turn_end for 10+ minutes while idle waiter is pending | Hung tool call or model hang |
| `watchdog.idle_waiter.timeout` | `turn_end` never arrived within 5-minute idle safety valve | Drain lock released and stale stuck state cleared |
| `watchdog: stuck recovery timed out` | Abort did not recover session within 90s grace | Triggers self-restart via graceful shutdown |
| `watchdog: session appears dead` | 3+ consecutive prompt failures | Triggers self-restart via graceful shutdown |
| `Reached the max retries per request limit` / `MaxRetriesPerRequestError` | Redis command queue flushed after reconnect churn | Transport flap between gateway and Redis (localhost:6379 forward), unhandled promise path in mode/tick calls |
| `langfuse-cost: cannot load optional dependency 'langfuse'; telemetry disabled.` | Pi extension optional dependency unavailable | Observability degraded only — not a gateway delivery blocker; treat as secondary unless tracing is required |
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
**Exception:** if `gateway status` reports `mode: redis_degraded`, `diagnose` should skip this layer on purpose because the Redis bridge path is the degraded surface.

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

# Autonomous-turn attribution (classification → dispatch → forward)
joelclaw otel search "events.triaged" --hours 6
joelclaw otel search "events.dispatched.background_only" --hours 6
joelclaw otel search "response.generated.background_source" --hours 6
joelclaw otel search "outbound.console_forward" --hours 6
joelclaw otel search "outbound.console_forward.suppressed_policy" --hours 6
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

### 0. Substrate outage (Colima/k8s down)

**Symptoms:** `joelclaw gateway status` fails with Redis connection closed, kubectl refuses/EOF, Redis listener may still exist locally.
**Cause:** Colima VM stopped or cluster not ready; gateway failure is downstream, not root.
**Fix:** Start Colima, wait for node `Ready`, verify `redis-0`/`inngest-0`, then retest gateway.

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

### 2a. Provider auth expired (looks like "gateway is alive but mute")

**Symptoms:** `Authentication failed for "anthropic"`, queued events never get a response, `gateway test` sticks in queue.
**Cause:** Anthropic OAuth token expired or missing in pi auth state.
**Fix:** Re-auth with `pi` (`/login anthropic`), restart gateway, then re-run `joelclaw gateway test`. If failures continue, verify provider quota/plan limits.

### 2b. Embedded pi dependency skew breaks configured model recovery

**Symptoms:** fallback or recovery probes emit `model_fallback.probe_failed` / `fallback.model_not_found` with `pi model not found: openai-codex/gpt-5.4`, even though `pi --version` on the machine already supports GPT-5.4.
**Cause:** the gateway daemon imports `@mariozechner/pi-ai` / `@mariozechner/pi-coding-agent` from `packages/gateway/package.json`, and that package can lag behind the machine `pi` binary. Machine CLI truth and embedded daemon runtime truth are not the same thing.
**Fix:** check both `pi --version` and the versions pinned in `packages/gateway/package.json`. If the package is stale, upgrade the embedded gateway deps and reinstall workspace packages. Also verify the daemon tracks fallback primary state from the live `session.model`, not only the requested gateway config.

### 2c. Resumed session model drift keeps the gateway on the wrong model after restart

**Symptoms:** `joelclaw gateway status` looks healthy, but behavior/latency does not match the Redis-configured gateway model; recent logs show fallback swaps against an unexpected model; the daemon may restart and still come back on the last fallback/manual model.
**Cause:** pi session resume preserves `session.model` state. If daemon startup blindly trusts the resumed session model, a previous fallback/manual switch can override Redis config on the next boot and silently skew fallback logic plus session-pressure context-window math.
**Fix:** compare Redis gateway config (`joelclaw:gateway:config`) to the live session model after restart. Startup should reconcile the resumed session back to the requested primary model before fallback control initializes. If diagnostics show `requested` vs `actual` drift or `model.reconciled_on_startup`, treat that as a real runtime issue, not a cosmetic mismatch.

### 3. Stuck Tool Call

**Symptoms:** Watchdog fires after 10 min, session stuck.
**Cause:** A tool call (bash, read, etc.) hanging indefinitely while the queue is still waiting for `turn_end`.
**Fix:** Watchdog auto-aborts once, then self-restarts after a 90s recovery grace if no `turn_end`/next-prompt signal arrives. If `turn_end` never arrives but idle waiter releases at 5 minutes, expect `watchdog.idle_waiter.timeout` instead (no restart). If restarts still loop, run `joelclaw gateway diagnose --hours 2 --lines 240` and inspect `watchdog.session_stuck.recovery_timeout` telemetry.

### 4. Redis Disconnection / redis_degraded mode

**Symptoms:** `gateway status` reports `mode: redis_degraded`, degraded capabilities are listed, Redis-dependent commands/E2E are degraded or skipped, but direct conversation may still work.
**Cause:** Redis pod restart, port-forward drop, localhost wiring drift, or reconnect churn.
**Fix:**
- Treat daemon availability and Redis health separately.
- Keep using direct channel interaction if process/session layers are healthy.
- Check `kubectl get pods -n joelclaw`, port listeners, and OTEL for `redis-channel.runtime.mode.changed` / reconnect signals.
- Confirm recovery back to `mode: normal` without requiring a daemon restart.

### 4a. Redis retry-rejection storm

**Symptoms:** `gateway.err` floods with `Reached the max retries per request limit`, `daemon.unhandled_rejection`, and repeated OTEL emit warnings.
**Cause:** Redis reconnect churn caused pending command promises to flush as `MaxRetriesPerRequestError` (historically mode reads + heartbeat tick paths).
**Fix:**
- Verify transport first (`lsof -iTCP:6379`, `kubectl get pods -n joelclaw redis-0`).
- Confirm reconnect stabilization in `gateway.log` (`[gateway:redis] started`).
- If flood persists after reconnect, restart gateway once and check for fresh `mode.read.failed` / `mode.write.failed` OTEL before escalating.

### 4b. Langfuse extension optional dependency warning

**Symptoms:** `gateway.err` repeats `langfuse-cost: cannot load optional dependency 'langfuse'; telemetry disabled.`
**Cause:** `langfuse` package unavailable to the gateway pi extension runtime (often cache or install drift).
**Fix:** Treat as observability degradation, not message-path outage. Clear pi SDK cache/reload extension when tracing is needed, but prioritize substrate/model/Redis checks first.

### 4c. Telegram polling ownership conflict

**Symptoms:** Telegram inbound appears noop; `gateway.err` shows `getUpdates ... 409: Conflict`; OTEL shows `telegram.channel.start_failed` and `telegram.channel.retry_scheduled`.
**Cause:** Another bot process is polling the same token at the same time (phone/desktop Telegram clients are not Bot API pollers).
**Fix:**
- Check ownership lifecycle: `joelclaw otel search "telegram.channel.poll_owner" --hours 1`.
- Confirm one instance acquires owner lease (`telegram.channel.poll_owner.acquired`) while others go passive (`telegram.channel.poll_owner.passive`).
- If contention still persists with lease enabled, there is a non-cooperative external poller using the same token.
- Verify recovery signals (`telegram.channel.polling_recovered`) once external contention stops.

### 5. Compaction During Message Delivery

**Symptoms:** "already processing" after a successful turn_end.
**Cause:** Auto-compaction triggers after turn_end, session enters streaming state again before drain loop processes next message.
**Fix:** The idle waiter should block until compaction finishes. If not, this is a pi SDK gap.

### 6. False duplicate suppression (channel preamble collision)

**Symptoms:** user reports "it ignored my message" while queue dedup events fire.
**Current behavior (post-fix):** both store-level and queue-level dedup hash the normalized message body (channel preamble stripped), so false positives should be rare.
**How to verify:** inspect OTEL metadata on `queue.dedup_dropped` / `message.dedup_dropped` (`dedupHashPrefix`, `strippedInjectedContext`, `promptLength`, `normalizedLength`). If normalized lengths differ materially from expected user payload, dedup normalization is wrong.
**Fix path:** keep dedup enabled, tune normalization + telemetry first. Remove dedup only if telemetry proves systemic false drops and no safe normalization exists.

### 7. Background console-forward suppression (human-gated guard)

**Symptoms:** autonomous/internal responses are no longer pushed to Telegram, while normal channel replies still work.
**Cause:** policy gate suppresses console forwarding when attribution is internal + background + no active/captured/recovered source context.
**How to verify:**
- `outbound.console_forward.suppressed_policy` events present
- paired with `response.generated.background_source` events
- no corresponding `outbound.console_forward.sent` for the same turn
**Fix path:** adjust attribution capture/recovery before relaxing policy. If legitimate user replies are suppressed, inspect `hasActiveSource`, `hasCapturedSource`, `recoveredFromRecentPrompt`, and recent source age metadata.

## Fallback Controller State

The gateway has a model fallback controller (ADR-0091) that swaps models when the primary fails:

- **Threshold:** 120s timeout for first token, or 3 consecutive prompt failures (configurable)
- **Fallback model:** `openai-codex/gpt-5.4` (daemon remaps legacy Anthropic fallback configs to codex at startup)
- **No-op guard:** if primary and fallback resolve to the same provider/model, fallback swapping is disabled for that session to avoid fake swap/recover noise
- **Recovery:** Probes primary model every 10 minutes
- **OTEL events:** `model_fallback.swapped`, `model_fallback.primary_restored`, `model_fallback.probe_failed`, `fallback.model.remapped`, `fallback.disabled.same_model`
- **Operator alerting:** model failures ping the default channel (Telegram) with 2-minute dedupe window per reason/source. Alert telemetry: `model_failure.alert.sent`, `model_failure.alert.suppressed`, `model_failure.alert.failed`

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
| `packages/model-fallback/src/controller.ts` | Timeout tracking, fallback swap, recovery probes |
| `packages/gateway/src/channels/redis.ts` | Event batching, prompt building, sleep mode |
| `packages/gateway/src/channels/telegram.ts` | Bot polling, message routing |
| `packages/gateway/src/heartbeat.ts` | Tripwire writer only (ADR-0103: no prompt injection) |

## ADR anchors

- **ADR-0213** — gateway session lifecycle guards and anti-thrash constraints
- **ADR-0146** — Langfuse cost/observability integration (optional tracing should not break runtime path)

## Related Skills

- **[gateway](../gateway/SKILL.md)** — operational commands (restart, push, drain)
- **[joelclaw-system-check](../joelclaw-system-check/SKILL.md)** — full system health (broader scope)
- **[k8s](../k8s/SKILL.md)** — if Redis/Inngest pods are the problem
