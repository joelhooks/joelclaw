# Gateway Operations & Monitoring

Canonical notes for the always-on gateway daemon (`packages/gateway`) and its automated health checks.

## Manual CLI checks

```bash
joelclaw gateway status
joelclaw gateway diagnose --hours 1 --lines 120
joelclaw gateway test
joelclaw gateway events
joelclaw gateway restart
```

Use `diagnose` first; it runs process/Redis/log/e2e/model checks in one pass.

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
- Emits OTEL event:
  - component: `check-gateway-health`
  - action: `gateway.health.checked`

## Redis keys used by monitor

- `gateway:health:monitor:general-streak`
- `gateway:health:monitor:general-alert-cooldown`
- `gateway:health:monitor:restart-cooldown`
- `gateway:health:monitor:channel-streak:<channel>`
- `gateway:health:monitor:channel-alert-cooldown`

## Related files

- `packages/system-bus/src/inngest/functions/heartbeat.ts`
- `packages/system-bus/src/inngest/functions/check-gateway-health.ts`
- `packages/cli/src/commands/gateway.ts`
- `packages/gateway/src/daemon.ts`
- `skills/gateway-diagnose/SKILL.md`
