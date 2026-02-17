---
status: implemented
date: 2026-02-17
decision-makers: Joel Hooks
consulted: Claude (pi session 2026-02-17)
informed: All agents operating on this machine
related:
  - "[ADR-0018 — Pi-native gateway with Redis event bridge](0018-pi-native-gateway-redis-event-bridge.md)"
  - "[ADR-0035 — Central + satellite session routing](0035-gateway-session-routing-central-satellite.md)"
  - "[ADR-0036 — launchd central gateway session](0036-launchd-central-gateway-session.md)"
credits:
  - "Classic 'who watches the watchmen' pattern — layered failure detection with independent monitoring planes"
---

# Layered watchdog for gateway heartbeat failure detection

## Context and Problem Statement

The central gateway session (ADR-0036) receives heartbeats from an Inngest cron every 15 minutes. But if Inngest itself goes down — the server crashes, the worker dies, Redis becomes unreachable, or k8s restarts pods — the cron never fires. The absence of heartbeats IS the signal, but nothing detects that absence.

This is the "who watches the watchmen" problem. The monitoring system can't monitor itself.

## Decision

Three independent failure detection layers, each catching a different class of failure:

### Layer 1: Extension Watchdog (catches Inngest/worker failures)

A `setInterval` timer inside the gateway extension that runs every 5 minutes. Tracks `lastHeartbeatTs` — the last time a `cron.heartbeat` event was drained. If 30 minutes (2x the 15-min interval) pass with no heartbeat, injects a `⚠️ MISSED HEARTBEAT` alarm into the central session with triage steps.

**Independence**: Runs inside pi's Node.js process. Only depends on pi being alive. Does NOT depend on Inngest, the worker, or Redis (once the initial connection is established). Catches: worker crash, Inngest server down, cron misconfiguration, Redis pub/sub failure.

**Behavior**:
- Sets `lastHeartbeatTs = Date.now()` on boot (grace period for first heartbeat)
- Resets `lastHeartbeatTs` on every received heartbeat event
- Fires alarm once per missed window (`watchdogAlarmFired` flag)
- Resets alarm flag when a heartbeat successfully arrives (auto-recovery)

### Layer 2: launchd Tripwire (catches everything-is-on-fire)

A separate launchd timer (`com.joel.gateway-tripwire`) that runs independently every 30 minutes. Checks if a heartbeat timestamp exists in a local file (`/tmp/joelclaw/last-heartbeat.ts`). If the file is stale or missing, sends a notification via `osascript` (macOS notification center) and optionally a webhook.

**Independence**: Pure launchd + bash. Does NOT depend on pi, Redis, Inngest, k8s, or any of the joelclaw stack. Catches: pi crash, Redis down, entire k8s namespace gone, extension failed to load.

**Implementation**: Future — not built yet. The extension watchdog covers most failure modes. The launchd tripwire is the nuclear option for when pi itself is dead.

### Layer 3: Central Session Runs System Check on Heartbeat

When the central session receives a heartbeat, it runs the `joelclaw-system-check` skill (reads `~/Vault/HEARTBEAT.md`). This means the health check logic lives in pi's conversation context, not in Inngest. Inngest just sends the ping; pi decides what to check.

**Why**: Inngest functions shouldn't know about kubectl, test suites, disk space, etc. The central session has full tool access. Keep the intelligence where the tools are.

## Failure Matrix

| Failure | Layer 1 (extension watchdog) | Layer 2 (launchd tripwire) | Layer 3 (system check) |
|---------|-----|-----|-----|
| Inngest worker crash | ✅ Detects (no heartbeat) | ✅ Detects (stale file) | ❌ Never runs |
| Inngest server down | ✅ Detects | ✅ Detects | ❌ Never runs |
| Redis down | ⚠️ May detect (depends on when Redis died) | ✅ Detects | ❌ Never runs |
| k8s namespace gone | ✅ Detects | ✅ Detects | ❌ Never runs |
| Pi crash (central) | ❌ Dead | ✅ Detects | ❌ Dead |
| Extension failed to load | ❌ Never started | ✅ Detects | ❌ Never started |
| Worker running but cron misconfigured | ✅ Detects | ✅ Detects | ❌ Never runs |
| Everything healthy | ✅ Silent | ✅ Silent | ✅ Runs checks |

## Consequences

### Positive

- No single point of failure in monitoring
- Extension watchdog is zero-config (built into the extension)
- Alarm includes triage steps — the central session can self-heal (restart worker, check pods)
- Auto-recovery: alarm resets when heartbeats resume

### Negative

- Three layers = more complexity to reason about
- False positives possible during system updates (k8s rolling restart, worker deploy)
- Layer 2 (launchd tripwire) not yet implemented — currently two layers only

### Follow-up Tasks

- [x] Extension watchdog implemented (5-min check interval, 30-min threshold)
- [ ] Build launchd tripwire (`com.joel.gateway-tripwire`) — bash script + osascript notification
- [ ] Extension writes `/tmp/joelclaw/last-heartbeat.ts` on each heartbeat for tripwire to read
- [ ] Consider healthchecks.io or similar external ping for off-machine monitoring
- [ ] Tune watchdog threshold as operational experience grows

## Implementation

### Affected Paths

| File | Change |
|------|--------|
| `~/.pi/agent/extensions/gateway/index.ts` | Watchdog timer, lastHeartbeatTs tracking, alarm injection |
| `~/Vault/HEARTBEAT.md` | Central session checks reference this |
| `~/Library/LaunchAgents/com.joel.gateway-tripwire.plist` | Future: independent launchd timer |
| `~/.joelclaw/scripts/gateway-tripwire.sh` | Future: stale-heartbeat checker |

### Watchdog Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Heartbeat interval | 15 min | Inngest cron `*/15 * * * *` |
| Watchdog threshold | 30 min (2x) | Allow one missed heartbeat before alarm |
| Watchdog check interval | 5 min | Frequent enough to catch quickly, infrequent enough to not waste cycles |
| Alarm behavior | Fire once, reset on next heartbeat | Prevents alarm spam during extended outages |

### Verification

- [x] Watchdog starts on central session boot
- [x] `lastHeartbeatTs` resets on each heartbeat drain
- [x] `watchdogAlarmFired` prevents duplicate alarms
- [x] `/gateway-id` command shows watchdog status and last heartbeat time
- [ ] Alarm fires correctly after 30min with no heartbeat (test by stopping worker)
- [ ] Alarm auto-clears when heartbeats resume
