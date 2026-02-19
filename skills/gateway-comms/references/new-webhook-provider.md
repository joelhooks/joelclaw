# Adding a New Webhook Provider

Checklist for wiring a new external service's webhooks into the gateway notification pipeline.

## 1. Create Provider

`packages/system-bus/src/webhooks/providers/{provider}.ts`

Implement the `WebhookProvider` interface from `../types.ts`:

```typescript
export const myProvider: WebhookProvider = {
  name: "my-provider",
  verifySignature(rawBody: string, headers: Record<string, string>): boolean { /* HMAC check */ },
  normalizePayload(body: Record<string, unknown>, headers: Record<string, string>): NormalizedEvent[] {
    // Map provider-specific payload to one or more normalized events
    // eventName format: "{provider}/{action}" e.g. "todoist/comment.added"
    return [{ eventName: `my-provider/${body.action}`, data: { /* extracted fields */ } }];
  },
};
```

## 2. Register Route

In `src/webhooks/server.ts`, add to the route map:

```typescript
import { myProvider } from "./providers/my-provider";
webhookRoutes.set("my-provider", myProvider);
```

URL will be: `POST /webhooks/my-provider`

## 3. Create Notify Functions

`src/inngest/functions/my-provider-notify.ts` — one function per event type:

```typescript
export const myProviderEventNotify = inngest.createFunction(
  { id: "my-provider-event-notify", name: "MyProvider → Gateway: Event" },
  { event: "my-provider/event.type" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    await step.run("notify-gateway", async () => {
      if (!gateway) return;
      await gateway.notify("my-provider.event", {
        message: `📌 Human-readable: ${event.data.summary}`,
        ...event.data,
      });
    });
    return { status: "notified" };
  }
);
```

## 4. Register Functions

- Export from `src/inngest/functions/index.ts`
- Add to the functions array in `src/serve.ts`

## 5. Store Secrets

```bash
secrets add my_provider_webhook_secret --value "..."
```

Add to `~/Code/system-bus-worker/packages/system-bus/start.sh`:

```bash
MY_SECRET=$(secrets lease my_provider_webhook_secret --ttl 24h 2>/dev/null)
[ -n "$MY_SECRET" ] && export MY_PROVIDER_WEBHOOK_SECRET="$MY_SECRET"
```

## 6. Deploy

```bash
cd ~/Code/system-bus-worker && git pull
joelclaw worker restart
joelclaw refresh          # REQUIRED — Inngest won't retroactively trigger
```

## 7. Expose Public URL (if needed)

```bash
tailscale serve --bg --https 443 http://localhost:3111
tailscale funnel --bg --https 443 http://localhost:3111
```

Public URL: `https://panda.tail7af24.ts.net/webhooks/{provider}`

⚠️ Point Funnel directly at worker, not through Caddy (body-drop bug).

## 8. Verify

```bash
# Manual test with correct HMAC
BODY='{"event":"test"}'
HMAC=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)
curl -X POST http://localhost:3111/webhooks/my-provider \
  -H "Content-Type: application/json" \
  -H "X-My-Provider-Signature: $HMAC" \
  -d "$BODY"

# Check Inngest received it
joelclaw runs -n 3

# Check gateway got it
tail -5 /tmp/joelclaw/gateway.log
```
