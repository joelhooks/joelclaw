---
name: gateway-comms
description: "SUPERSEDED by the 'gateway' skill. Use that instead. This skill remains for reference only — gateway middleware API, pushGatewayEvent(), webhook provider checklist."
---

# Gateway Communication

Push events to the gateway daemon (always-on pi session) from Inngest functions, CLI, or new webhook providers.

## Gateway Middleware (Inngest Functions)

Every Inngest function receives `gateway` via middleware (ADR-0035). Cast to access it:

```typescript
async ({ event, step, ...rest }) => {
  const gateway = (rest as any).gateway as GatewayContext | undefined;

  await step.run("notify", async () => {
    if (!gateway) return;
    await gateway.notify("my.event.type", {
      message: "Human-readable summary for the pi agent",
      key: "structured-data",
    });
  });
}
```

| Method | Purpose | Routing |
|--------|---------|---------|
| `gateway.progress(msg, extra?)` | Pipeline/loop progress | Origin session + central gateway |
| `gateway.notify(type, payload?)` | Notifications (task done, webhook) | Origin session + central gateway |
| `gateway.alert(msg, extra?)` | System warnings (disk, service down) | Central gateway only |

Import type: `import type { GatewayContext } from "../middleware/gateway";`

## Low-Level: pushGatewayEvent()

For functions outside the middleware or needing direct control:

```typescript
import { pushGatewayEvent } from "./agent-loop/utils";

await pushGatewayEvent({
  type: "video.downloaded",
  source: "inngest/video-download",
  payload: { message: "Downloaded: My Talk", path: "/path/to/file.mp4" },
  originSession: event.data.originSession, // optional: route to requester
});
```

## CLI Commands

```bash
joelclaw gateway status                              # Sessions + queue depths
joelclaw gateway push --type <type> [--payload JSON]  # Push to all sessions
joelclaw gateway test                                 # E2E test event
joelclaw gateway events                               # Peek pending events
joelclaw gateway drain                                # Clear all queues
joelclaw gateway restart                              # Roll daemon + clean Redis
joelclaw tui                                          # Attach to gateway WebSocket
```

## Redis Key Patterns

| Key | Purpose |
|-----|---------|
| `joelclaw:gateway:sessions` | SET of active session IDs |
| `joelclaw:events:{sessionId}` | LIST of pending events per session |
| `joelclaw:notify:{sessionId}` | PUB/SUB channel triggering drain |
| `joelclaw:events:main` | Legacy fallback (no sessions registered) |

Session IDs: `"gateway"` (central daemon), `"telegram:{chatId}"`, or custom origin IDs.

## Adding a New Webhook Provider

See [references/new-webhook-provider.md](references/new-webhook-provider.md) for the full checklist.

## Gotchas

- **`joelclaw refresh` after deploy** — Inngest won't trigger functions for events sent before registration. Always refresh after restarting the worker with new functions.
- **Caddy drops Funnel POST bodies** — Tailscale Funnel → Caddy produces `bytes_read: 0`. Point Funnel directly at worker `:3111` for webhook endpoints.
- **HMAC key confusion** — Todoist "Verification token" ≠ signing key. The `client_secret` is the HMAC key per their docs.
- **Gateway context is `any` cast** — TypeScript doesn't know about middleware-injected context. Always cast: `(rest as any).gateway as GatewayContext | undefined`.
- **Always null-check gateway** — Functions can run without a gateway session. Guard with `if (!gateway) return;`.

## Key Files

| File | Purpose |
|------|---------|
| `packages/system-bus/src/inngest/middleware/gateway.ts` | Middleware — injects `gateway` |
| `packages/system-bus/src/inngest/functions/agent-loop/utils.ts` | `pushGatewayEvent()` |
| `packages/gateway/src/channels/redis.ts` | Daemon-side: subscribe, drain, prompt build |
| `packages/gateway/src/command-queue.ts` | FIFO queue → pi `session.prompt()` |
| `packages/system-bus/src/webhooks/server.ts` | Hono webhook server |
| `packages/system-bus/src/webhooks/providers/` | Provider implementations |
| `packages/cli/src/commands/gateway.ts` | CLI subcommands |
