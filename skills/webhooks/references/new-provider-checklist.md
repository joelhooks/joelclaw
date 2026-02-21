# Adding a New Webhook Provider — Full Checklist

Step-by-step for wiring a new external service's webhooks into the joelclaw gateway.

## 1. Create Provider Adapter

`packages/system-bus/src/webhooks/providers/{provider}.ts`

Implement the `WebhookProvider` interface from `../types.ts`:

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookProvider, NormalizedEvent } from "../types";

/** Map provider event types → normalized event names */
const EVENT_MAP: Record<string, string> = {
  "provider.event_type": "normalized.name",
};

function getSecret(): string {
  const secret = process.env.MY_PROVIDER_WEBHOOK_SECRET;
  if (!secret) throw new Error("MY_PROVIDER_WEBHOOK_SECRET env var required");
  return secret;
}

export const myProvider: WebhookProvider = {
  id: "my-provider",
  eventPrefix: "my-provider",

  verifySignature(rawBody: string, headers: Record<string, string>): boolean {
    const signature = headers["x-my-provider-signature"];
    if (!signature) return false;

    const secret = getSecret();
    // Adjust algorithm (sha1/sha256) and encoding (hex/base64) per provider docs
    const computed = createHmac("sha256", secret).update(rawBody).digest("hex");

    try {
      return timingSafeEqual(
        Buffer.from(signature, "hex"),
        Buffer.from(computed, "hex"),
      );
    } catch {
      return false;
    }
  },

  normalizePayload(
    body: Record<string, unknown>,
    _headers: Record<string, string>,
  ): NormalizedEvent[] {
    const type = body.type as string | undefined;
    if (!type) return [];

    const mappedName = EVENT_MAP[type];
    if (!mappedName) return [];

    return [{
      name: mappedName,
      data: {
        // Extract meaningful fields — don't just pass the raw body
        id: String(body.id ?? ""),
        // ... provider-specific fields
      },
      idempotencyKey: `my-provider-${type}-${body.id ?? Date.now()}`,
    }];
  },
};
```

### Signature Algorithm Cheat Sheet

| Provider | Algorithm | Input | Encoding | Header |
|----------|-----------|-------|----------|--------|
| Todoist | SHA256 | rawBody | base64 | `x-todoist-hmac-sha256` |
| Front (Rules) | SHA1 | JSON.stringify(JSON.parse(rawBody)) | base64 | `x-front-signature` |
| Vercel | SHA1 | rawBody | hex | `x-vercel-signature` |
| GitHub | SHA256 | rawBody | hex with `sha256=` prefix | `x-hub-signature-256` |
| Stripe | SHA256 | `${timestamp}.${rawBody}` | hex | `stripe-signature` (structured `t=,v1=`) |

⚠️ **Gotcha**: Some providers sign a transformed body (Front signs compact JSON, Stripe prepends timestamp). Always read the provider's docs carefully.

## 2. Register Route

In `src/webhooks/server.ts`:

```typescript
import { myProvider } from "./providers/my-provider";
providers.set(myProvider.id, myProvider);
```

Webhook URL becomes: `POST /webhooks/my-provider`

## 3. Create Notify Functions

`src/inngest/functions/{provider}-notify.ts`

Follow the pattern from `todoist-notify.ts`:

```typescript
import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";

export const myProviderEventNotify = inngest.createFunction(
  { id: "my-provider-event-notify", name: "MyProvider → Gateway: Event" },
  { event: "my-provider/event.type" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;

    // Optional: enrich with API calls
    const context = await step.run("enrich-context", async () => {
      // Fetch additional data from provider API if needed
      return { /* enriched fields */ };
    });

    const agentPrompt = await step.run("build-prompt", () => {
      return [
        `## 📌 Provider Event`,
        "",
        `**Summary**: ${event.data.summary}`,
        `Context and next-action guidance for the agent.`,
      ].join("\n");
    });

    const result = await step.run("notify-gateway", async () => {
      if (!gateway) return { pushed: false, reason: "no gateway context" };

      return await gateway.notify("my-provider.event.type", {
        prompt: agentPrompt,
        ...event.data,
        ...context,
      });
    });

    return {
      status: result.pushed ? "notified" : "skipped",
      result,
    };
  }
);
```

### 3-step pattern (enrich → build-prompt → notify)

All notify functions follow this pattern:
1. **enrich-context** — optional API call to get extra data the webhook didn't include
2. **build-prompt** — create human-readable markdown prompt for the gateway agent
3. **notify-gateway** — push to gateway with structured data + prompt

## 4. Register Functions

Export from `src/inngest/functions/index.ts`:

```typescript
export { myProviderEventNotify } from "./my-provider-notify";
```

Add to the active role list in `src/inngest/functions/index.host.ts` (or `index.cluster.ts` for cluster-owned functions):

```typescript
// in src/inngest/functions/index.host.ts
import { myProviderEventNotify } from "./my-provider-notify";

export const hostFunctionDefinitions = [
  // ...existing functions
  myProviderEventNotify,
];
```

Update the health endpoint's `webhooks.providers` and `events` sections in `serve.ts` when introducing a new provider/event family.

## 5. Store Secrets

```bash
# Add the webhook signing secret
secrets add my_provider_webhook_secret --value "the-actual-secret"

# Optional: API token for enrichment
secrets add my_provider_api_token --value "the-api-token"
```

Add to `~/Code/joelhooks/joelclaw/packages/system-bus/start.sh`:

```bash
MY_SECRET=$(secrets lease my_provider_webhook_secret --ttl 24h 2>/dev/null)
if [ -n "$MY_SECRET" ]; then
  export MY_PROVIDER_WEBHOOK_SECRET="$MY_SECRET"
else
  echo "WARNING: Failed to lease my_provider_webhook_secret" >&2
fi
```

## 6. Deploy

```bash
# Restart + register in one command (reloads code + re-leases secrets)
joelclaw inngest restart-worker --register
```

## 7. Register Webhook URL with External Service

Public URL pattern: `https://panda.tail7af24.ts.net/webhooks/{provider}`

Tailscale Funnel must be configured:

```bash
# Already running for existing webhooks — verify:
tailscale serve status
# Should show :443 → http://localhost:3111
```

Each service has its own webhook registration process:
- **Vercel**: Dashboard → Settings → Webhooks → Create (or REST API)
- **GitHub**: Repo → Settings → Webhooks → Add webhook
- **Todoist**: App Console → Webhooks tab
- **Front**: Rules → "Trigger a webhook" action
- **Stripe**: Dashboard → Developers → Webhooks → Add endpoint

When creating the webhook, you'll get a signing secret — store it immediately with `secrets add`.

## 8. Verify E2E

```bash
# Manual test with correct HMAC
SECRET="your-webhook-secret"
BODY='{"type":"test","id":"test-123"}'

# SHA1 hex (Vercel):
HMAC=$(echo -n "$BODY" | openssl dgst -sha1 -hmac "$SECRET" -binary | xxd -p)
curl -X POST http://localhost:3111/webhooks/my-provider \
  -H "Content-Type: application/json" \
  -H "x-my-provider-signature: $HMAC" \
  -d "$BODY"

# SHA256 base64 (Todoist):
HMAC=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)
curl -X POST http://localhost:3111/webhooks/my-provider \
  -H "Content-Type: application/json" \
  -H "x-my-provider-hmac-sha256: $HMAC" \
  -d "$BODY"

# Check Inngest received events
joelclaw runs --count 3

# Check gateway got the notification
joelclaw gateway events
```

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| 401 Unauthorized | Wrong secret or encoding mismatch | Check algorithm + encoding in provider docs |
| 404 Not Found | Provider not registered in server.ts | Add to providers Map |
| Events arrive but no Inngest run | Function not registered in role list | Add to `index.host.ts` (or `index.cluster.ts`) + `joelclaw inngest restart-worker --register` |
| Inngest runs but gateway doesn't notify | No gateway session or null check | Check `joelclaw gateway status` |
| Webhook works locally but not from internet | Funnel not configured | `tailscale serve status` — verify :443 → :3111 |
| Body hash doesn't match | Caddy or proxy modifying body | Route Funnel directly to worker, not through Caddy |
| Provider auto-disables webhook | Too many failures (Front does this) | Fix the root cause, then re-enable in provider dashboard |
