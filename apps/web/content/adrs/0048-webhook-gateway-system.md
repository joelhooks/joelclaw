---
status: accepted
date: 2026-02-18
deciders: Joel
tags:
  - architecture
  - gateway
  - webhooks
  - joelclaw
---

# ADR-0048: Webhook Gateway for External Service Integration

## Context

joelclaw receives events from the outside world through two mechanisms today:
1. **Telegram** — long-polling via the gateway extension (real-time chat, photos, voice)
2. **Inngest cron** — heartbeat, content sync, periodic checks

But the system needs to receive push notifications from external services: Todoist comments (ADR-0047), GitHub events, Vercel deploy status, Google Calendar changes, Stripe webhooks, and future integrations. Each of these services has its own webhook format, authentication scheme, and retry behavior.

Currently there's no general-purpose way for external services to push events into joelclaw. The Mac Mini sits behind Tailscale with no public endpoints. Every new integration requires a one-off poll-based cron, which adds latency and wastes API calls.

### Prior Art: OpenClaw Hooks System

OpenClaw (~/Code/openclaw/openclaw) has a mature webhook gateway (`src/gateway/hooks.ts` + `hooks-mapping.ts`) with patterns worth adopting:

**What OpenClaw does well:**
- **Hooks as a first-class gateway concept** — `POST /hooks/<path>` with bearer token auth
- **Mapping system** — declarative config maps incoming webhook payloads to internal actions via templates (`{{payload.field}}`)
- **Transform functions** — JS modules that can transform/filter webhook payloads before dispatch
- **Preset mappings** — built-in transforms for known services (Gmail preset)
- **Path-based routing** — `/hooks/todoist`, `/hooks/github`, `/hooks/vercel`
- **Rate limiting on auth failures** — 20 failures per IP per minute window
- **Session key derivation** — unique session per webhook source (`hook:todoist:{{taskId}}`)
- **Max body size enforcement** — 256KB default, configurable

**What's different for joelclaw:**
- OpenClaw dispatches webhooks to agent chat sessions. joelclaw dispatches to **Inngest events** — durable functions, not ephemeral chat.
- OpenClaw's hooks are tightly coupled to its gateway process. joelclaw needs hooks that work both as a standalone HTTP endpoint AND as an Inngest cron fallback (for services behind firewalls).
- OpenClaw handles auth per-hook globally. joelclaw needs per-provider signature verification (Todoist HMAC, GitHub SHA-256, Stripe signatures).

## Decision

Build a **webhook gateway** as a lightweight HTTP server that receives webhook POSTs from external services, validates signatures, normalizes payloads, and emits Inngest events. Dual-mode: direct webhooks when reachable, poll-based fallback when not.

### Architecture

```
External Service                joelclaw
┌─────────────┐     ┌──────────────────────────────┐
│  Todoist     │     │  Webhook Gateway              │
│  GitHub      │────▶│  (Caddy → Bun HTTP server)    │
│  Vercel      │     │                                │
│  Calendar    │     │  1. Route by path              │
│  Stripe      │     │  2. Verify signature           │
│              │     │  3. Normalize payload          │
└─────────────┘     │  4. Emit Inngest event         │
                    └──────────┬───────────────────┘
                               │
                    ┌──────────▼───────────────────┐
                    │  Inngest                      │
                    │  todoist/comment.added         │
                    │  github/push                   │
                    │  vercel/deploy.completed       │
                    │  calendar/event.updated        │
                    └──────────────────────────────┘
```

### Dual-Mode: Push + Poll

Every provider adapter supports two modes:

```typescript
interface WebhookProvider {
  id: string;                          // "todoist", "github", "vercel"
  
  // Push mode: verify and normalize incoming webhook POST
  verifySignature(req: Request): boolean;
  normalizePayload(body: unknown): NormalizedEvent[];
  
  // Poll mode: fetch changes since last check (fallback)
  poll?(since: string): Promise<NormalizedEvent[]>;
  
  // Inngest event name prefix
  eventPrefix: string;                 // "todoist", "github", "vercel"
}

interface NormalizedEvent {
  name: string;                        // "comment.added", "push", "deploy.completed"
  data: Record<string, unknown>;       // provider-agnostic payload
  idempotencyKey?: string;             // dedup across push + poll
}
```

Push and poll can run simultaneously for reliability. The `idempotencyKey` on events ensures Inngest deduplicates if both fire for the same change.

### Webhook Gateway Server

Lightweight Bun HTTP server exposed via Caddy + Tailscale Funnel:

```typescript
// packages/system-bus/src/webhooks/server.ts
Bun.serve({
  port: 3200,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;             // /webhooks/todoist
    const provider = path.split("/")[2];   // "todoist"
    
    const adapter = getProvider(provider);
    if (!adapter) return new Response("Not Found", { status: 404 });
    
    if (!adapter.verifySignature(req)) {
      return new Response("Unauthorized", { status: 401 });
    }
    
    const body = await req.json();
    const events = adapter.normalizePayload(body);
    
    for (const event of events) {
      await inngest.send({
        name: `${adapter.eventPrefix}/${event.name}`,
        data: event.data,
        ...(event.idempotencyKey ? { id: event.idempotencyKey } : {}),
      });
    }
    
    return Response.json({ ok: true, events: events.length });
  },
});
```

### Provider Adapters

#### Todoist (first)

```typescript
const todoistProvider: WebhookProvider = {
  id: "todoist",
  eventPrefix: "todoist",
  
  verifySignature(req) {
    // Todoist uses HMAC-SHA256 with client_secret
    const signature = req.headers.get("x-todoist-hmac-sha256");
    const body = await req.text();
    const expected = hmacSha256(TODOIST_CLIENT_SECRET, body);
    return timingSafeEqual(signature, expected);
  },
  
  normalizePayload(body) {
    // Todoist webhook payload: { event_name, event_data, ... }
    const { event_name, event_data } = body;
    return [{
      name: mapEventName(event_name),  // "note:added" → "comment.added"
      data: {
        taskId: event_data.item_id,
        content: event_data.content,
        postedAt: event_data.posted_at,
      },
      idempotencyKey: `todoist-${event_name}-${event_data.id}`,
    }];
  },
  
  // Poll fallback via Activity Log API
  async poll(since) {
    const activities = await todoist.getActivities({
      objectEventTypes: ["note:added", "item:completed", "item:added"],
      dateFrom: since,
      annotateNotes: true,
      annotateParents: true,
    });
    return activities.results.map(a => ({
      name: mapActivityType(a.event_type, a.object_type),
      data: normalizeActivity(a),
      idempotencyKey: `todoist-activity-${a.id}`,
    }));
  },
};
```

#### GitHub (second)

```typescript
const githubProvider: WebhookProvider = {
  id: "github",
  eventPrefix: "github",
  
  verifySignature(req) {
    // GitHub uses HMAC-SHA256 with webhook secret
    const signature = req.headers.get("x-hub-signature-256");
    const body = await req.text();
    return verifyGitHubSignature(signature, body, GITHUB_WEBHOOK_SECRET);
  },
  
  normalizePayload(body) {
    const event = req.headers.get("x-github-event"); // "push", "pull_request", etc.
    return [{
      name: event,
      data: { ...body },
      idempotencyKey: `github-${body.delivery || body.hook_id}-${Date.now()}`,
    }];
  },
};
```

#### Vercel (third)

```typescript
const vercelProvider: WebhookProvider = {
  id: "vercel",
  eventPrefix: "vercel",
  
  verifySignature(req) {
    const signature = req.headers.get("x-vercel-signature");
    return verifyVercelSignature(signature, body, VERCEL_WEBHOOK_SECRET);
  },
  
  normalizePayload(body) {
    return [{
      name: `deploy.${body.type}`,  // "deploy.ready", "deploy.error"
      data: {
        deploymentId: body.payload?.deployment?.id,
        url: body.payload?.deployment?.url,
        state: body.payload?.deployment?.readyState,
        project: body.payload?.name,
      },
      idempotencyKey: `vercel-${body.id}`,
    }];
  },
};
```

### Exposure via Caddy + Tailscale Funnel

```
# Caddyfile addition
webhooks.joelclaw.ts.net {
  reverse_proxy localhost:3200
}
```

Tailscale Funnel makes this reachable from the internet without port forwarding. Caddy handles TLS.

For services that can't reach the endpoint (or during development), the poll-based fallback runs via Inngest cron:

```typescript
inngest.createFunction(
  { id: "webhook-poll-todoist" },
  { cron: "*/2 * * * *" },
  async ({ step }) => {
    const since = await step.run("get-checkpoint", () =>
      redis.get("webhook:todoist:last-poll")
    );
    const events = await step.run("poll", () =>
      todoistProvider.poll(since || twoMinutesAgo())
    );
    for (const event of events) {
      await step.sendEvent(`emit-${event.name}`, {
        name: `todoist/${event.name}`,
        data: event.data,
        ...(event.idempotencyKey ? { id: event.idempotencyKey } : {}),
      });
    }
    await step.run("update-checkpoint", () =>
      redis.set("webhook:todoist:last-poll", new Date().toISOString())
    );
  }
);
```

### Where It Lives

```
packages/system-bus/src/webhooks/
├── server.ts                  # Bun HTTP server (port 3200)
├── types.ts                   # WebhookProvider interface, NormalizedEvent
├── providers/
│   ├── todoist.ts             # Todoist webhook + poll adapter
│   ├── github.ts              # GitHub webhook adapter
│   └── vercel.ts              # Vercel webhook adapter
├── verify.ts                  # Signature verification utilities
└── poll.ts                    # Inngest cron poll functions (fallback)
```

### Security

Adapted from OpenClaw's approach:
- **Per-provider signature verification** — HMAC-SHA256 for Todoist/GitHub, provider-specific for others
- **Rate limiting** — track auth failures per source IP, throttle after 20 failures/minute (OpenClaw's pattern)
- **Max body size** — 256KB default, reject larger payloads
- **Secrets in agent-secrets** — webhook signing secrets stored with TTL leasing
- **No query string tokens** — bearer header or provider signature only (OpenClaw explicitly blocks `?token=`)
- **Idempotency keys on all events** — safe to receive duplicates from retry-happy providers

## Alternatives Considered

### A: Poll-Only (no webhook server)

Just poll every provider via Inngest cron. Simpler — no public endpoint needed.

**Rejected** because polling adds 1-5 min latency, wastes API calls, and doesn't scale to providers without poll APIs (Vercel, Stripe). Keep poll as fallback, not primary.

### B: Inngest Webhook Proxy

Use Inngest's built-in webhook → event feature. Inngest cloud can receive webhooks and convert to events.

**Rejected** because joelclaw runs self-hosted Inngest. Would need to add a public endpoint to the Inngest server itself, which is more complex than a dedicated lightweight webhook server.

### C: Cloudflare Worker Proxy

Deploy a Cloudflare Worker that receives webhooks publicly and forwards to the Mac Mini via Tailscale.

**Good fallback** if Tailscale Funnel proves unreliable. More moving parts but better DDoS protection. Park for now.

### D: OpenClaw's hooks system directly

Fork OpenClaw's `hooks.ts` + `hooks-mapping.ts` and adapt.

**Partially adopted** — the mapping template system (`{{payload.field}}`), auth patterns, and rate limiting are excellent. But OpenClaw dispatches to agent sessions; joelclaw dispatches to Inngest events. The provider adapter pattern is joelclaw-specific.

## Consequences

### Positive
- **Real-time push** from any service with webhook support
- **Poll fallback** for development and unreachable services
- **Idempotent** — push + poll can run simultaneously without duplicates
- **Extensible** — new provider = implement `WebhookProvider` interface
- **Todoist conversations** (ADR-0047) become real-time instead of 2-min delayed
- **GitHub CI events** trigger agent reactions (deploy failures, PR reviews)
- **Vercel deploy status** feeds back into the system automatically

### Negative
- **Public endpoint** via Tailscale Funnel — attack surface (mitigated by signature verification + rate limiting)
- **New process** to manage — webhook server alongside Inngest worker and gateway
- **Provider-specific signature verification** — each provider is different (not a standard)

### Credits
- OpenClaw (~/Code/openclaw/openclaw) for the hooks architecture patterns: path-based routing, template mapping, rate limiting, body size limits, auth failure tracking
- Ali Abdaal for the "comments as conversation" pattern that motivated this

## Implementation Status

### ✅ Phase 2: Webhook Server + Tailscale Funnel (2026-02-18)
Implemented first — skipped Phase 1 polling since webhooks proved simpler.

- Webhook server as Hono sub-app mounted on worker at `/webhooks/:provider` (not separate process)
- `WebhookProvider` interface: `verifySignature()`, `normalizePayload()`, per-provider routing
- Todoist adapter: HMAC-SHA256 with `client_secret`, 3 event types (`note:added`, `item:completed`, `item:added`)
- Tailscale Funnel :443 → worker :3111 directly (ADR-0051). Caddy path-routing dropped — Caddy swallows POST bodies on Funnel requests.
- 3 Inngest notify functions with API enrichment step (fetches task title + project name)
- Gateway middleware returns `GatewayPushResult` (not void) for observability
- Rate limiting: 10 req/min per IP via Hono middleware
- HMAC gotcha: Todoist "Verification token" ≠ signing key. `client_secret` is the HMAC key per docs.
- Key files: `src/webhooks/server.ts`, `src/webhooks/providers/todoist.ts`, `src/inngest/functions/todoist-notify.ts`

### ✅ Phase 2b: Front Webhook Adapter (2026-02-18)
- Front Rules-based webhook (not app-level) — scoped to private inboxes at Front's Rules layer
- HMAC-SHA1 over `JSON.stringify(body)` → base64 (different from Todoist's SHA256)
- No challenge mechanism (rules webhooks don't use challenges)
- 3 Inngest notify functions: inbound email, outbound sent, assignee changed
- API enrichment step fetches conversation details (tags, assignee, status) from Front API
- Structured agent prompts with triage instructions (matches Todoist pattern)
- Webhook URL: `https://panda.tail7af24.ts.net/webhooks/front`
- Secrets: `front_rules_webhook_secret` (HMAC), `front_api_token` (enrichment) in agent-secrets
- Key files: `src/webhooks/providers/front.ts`, `src/inngest/functions/front-notify.ts`
- Gotchas: Rules webhooks use SHA1 not SHA256; app-level webhooks auto-disable after repeated failures; `agent-secrets` v0.5.0 dropped `--raw` flag (now default)

### ⬜ Phase 1: Poll Fallback
- Todoist Activity Log API poll as backup (not needed while Funnel is reliable)
- Idempotency keys already on all webhook events — safe to run push + poll simultaneously

### ⬜ Phase 3: GitHub + Vercel Adapters
- GitHub webhook adapter (push, PR, deploy status events)
- Vercel webhook adapter (deploy.ready, deploy.error)
- Provider interface is ready — add adapter + register route + notify function

### ⬜ Phase 4: Mapping System (optional)
- Port OpenClaw's template mapping for config-driven webhooks
- Config-driven: add new webhooks without code changes
