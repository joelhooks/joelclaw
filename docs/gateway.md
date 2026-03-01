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

## Telegram control commands

From Telegram chat with `@JoelClawPandaBot`:

- `/stop` — aborts the active turn without killing the gateway daemon.
- `/esc` — alias for `/stop`.

Emergency-only manual control:

- `/kill` — hard stop: disables launchd service and kills the daemon process.

`/kill` is intentionally destructive. Use `/stop` or `/esc` first.

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
