# Gateway Operations & Monitoring

Canonical notes for the always-on gateway daemon (`packages/gateway`) and its automated health checks.

## Manual CLI checks

```bash
joelclaw gateway status
joelclaw gateway diagnose --hours 1 --lines 120
joelclaw gateway test
joelclaw gateway events
joelclaw gateway restart
joelclaw gateway known-issues
joelclaw gateway mute imessage --reason "imsg-rpc reconnect instability"
joelclaw gateway unmute imessage
```

Use `diagnose` first; it runs process/Redis/log/e2e/model checks in one pass.

## Gateway operator steering cadence

The gateway role prompt (`roles/gateway.md`) requires proactive steering check-ins during active work:

- one short check-in at start
- another every ~60–120 seconds while work is still active
- never more than 2 autonomous actions in a row without a check-in
- immediate check-in on state changes (delegated, blocked, recovered, done)
- if behavior looks frenzy/noisy, stop and request steering before continuing

Keep updates concise for mobile Telegram reading.

## Availability-first posture (ADR-0189 related)

Gateway operation is orchestration-first, not execution-first:

- stay highly available and interruptible
- avoid heads-down implementation/research in the gateway session
- delegate heavy work immediately, then monitor + report progress
- keep check-ins frequent while delegated tasks are running
- include/suggest required skills in delegation prompts for domain work

If the gateway starts doing long solo work, that is a role failure and should be corrected immediately.

## Message-class triage and operator routing (ADR-0189 related)

Gateway handles two distinct inbound classes:

1. **User/operator messages** (Joel direct chat)
2. **System/automation messages** (`## 🔔`, `## 📋`, `## ❌`, `## ⚠️`, `## VIP`)

Routing rule:

- do **not** forward all system traffic to operator
- escalate to operator only for high-signal/action-required states (blocked flows, repeated unresolved failures, security/safety concerns, or explicit decision points)
- low-signal/transient system chatter is triaged/logged/monitored without operator interruption

This keeps operator channel high signal while preserving autonomous handling.

## Role resolution (gateway/system/interactive)

Gateway sessions run with `GATEWAY_ROLE=central`. System sessions can set `JOELCLAW_ROLE=system` (or another role alias). The `identity-inject` extension resolves the role file in this order:

1. `JOELCLAW_ROLE_FILE` env override (explicit path)
2. `JOELCLAW_ROLE` alias (maps `system` → `~/.joelclaw/roles/system.md`, `<name>` → `~/.joelclaw/roles/<name>.md`)
3. `~/.joelclaw/roles/gateway.md` when `GATEWAY_ROLE=central`
4. fallback to `~/.joelclaw/ROLE.md`

If the selected role file is missing, it falls back to `ROLE.md`.

## Telegram reply routing guard

The daemon now captures the active source at `message_start`/delta time and reuses it on `message_end` if `getActiveSource()` is missing.

- goal: prevent `source: "console"` fallback for Telegram-origin turns
- impact: avoids short Telegram replies being dropped by console-channel suppression rules
- telemetry: `daemon.response.source_fallback_console` warns if fallback still occurs

## Interrupt controls by channel

Telegram chat (`@JoelClawPandaBot`):

- `/stop` — aborts the active turn without killing the gateway daemon.
- `/esc` — alias for `/stop`.

iMessage chat (plain text):

- `stop` or `/stop` — aborts the active turn.
- `esc` or `/esc` — alias for stop.

Emergency-only manual control (Telegram only):

- `/kill` — hard stop: disables launchd service and kills the daemon process.

`/kill` is intentionally destructive. Use stop/esc first.

## Automated monitoring

Heartbeat fan-out now includes:

- event: `gateway/health.check.requested`
- function: `check/gateway-health`
- source file: `packages/system-bus/src/inngest/functions/check-gateway-health.ts`

### What it checks

1. **General gateway health (critical layers)** via `joelclaw gateway diagnose`
   - `process`
   - `cli-status`
   - `e2e-test`
   - `redis-state`

2. **Channel-specific degradation** from OTEL events in `otel_events`
   - `telegram-channel`
   - `discord-channel`
   - `imessage-channel`
   - `slack-channel`

### Automated behavior

- Tracks per-incident streaks in Redis (noise suppression)
- Auto-restarts gateway on sustained general failure (cooldown-protected)
- Alerts on sustained unresolved failure/degradation
- Supports muted channel known-issues list; muted channels are still probed + logged, but excluded from channel alert notifications
- Emits OTEL event:
  - component: `check-gateway-health`
  - action: `gateway.health.checked`

## Redis keys used by monitor

- `gateway:health:monitor:general-streak`
- `gateway:health:monitor:general-alert-cooldown`
- `gateway:health:monitor:restart-cooldown`
- `gateway:health:monitor:channel-streak:<channel>`
- `gateway:health:monitor:channel-alert-cooldown`
- `gateway:health:muted-channels` (JSON array of channel IDs)
- `gateway:health:mute-reasons` (JSON object mapping channel → reason)

## Related files

- `packages/system-bus/src/inngest/functions/heartbeat.ts`
- `packages/system-bus/src/inngest/functions/check-gateway-health.ts`
- `packages/cli/src/commands/gateway.ts`
- `packages/gateway/src/daemon.ts`
- `skills/gateway-diagnose/SKILL.md`
