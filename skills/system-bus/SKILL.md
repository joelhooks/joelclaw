---
name: system-bus
displayName: System Bus Worker
description: Develop, deploy, and debug the system-bus worker — joelclaw's 110+ Inngest durable function engine, webhook gateway, and observability pipeline. Triggers on 'add a function', 'new inngest function', 'system-bus', 'worker', 'add a webhook', 'deploy worker', 'restart worker', 'function failed', 'worker not working', 'register functions', or any task involving Inngest function development, webhook providers, or worker operations.
version: 0.1.0
author: joel
tags:
  - inngest
  - worker
  - infrastructure
  - core
---

# System Bus Worker

The system-bus worker (`@joelclaw/system-bus`) is joelclaw's event-driven backbone — 110+ Inngest durable functions, webhook ingestion, and observability. It runs as a Hono HTTP server registered with the self-hosted Inngest instance.

## Architecture

```
packages/system-bus/
├── src/
│   ├── serve.ts                          # Hono server, Inngest registration, health endpoint
│   ├── inngest/
│   │   ├── client.ts                     # Inngest client + event type definitions
│   │   ├── middleware/                    # Gateway injection, dependency injection
│   │   └── functions/
│   │       ├── index.ts                  # Combined exports
│   │       ├── index.host.ts             # Functions for host-role worker (local Mac)
│   │       ├── index.cluster.ts          # Functions for cluster-role worker (k8s)
│   │       └── <function-name>.ts        # Individual functions
│   ├── lib/                              # Shared utilities
│   │   ├── inference.ts                  # LLM calls via pi (CANONICAL — always use this)
│   │   ├── redis.ts                      # Redis client helper
│   │   ├── typesense.ts                  # Typesense client
│   │   ├── convex-content-sync.ts        # Convex upsert for content pipeline
│   │   ├── langfuse.ts                   # Langfuse tracing
│   │   └── ...
│   ├── observability/
│   │   └── emit.ts                       # OTEL event emission
│   ├── webhooks/
│   │   ├── server.ts                     # Webhook router (mounted at /webhooks)
│   │   ├── types.ts                      # Provider interface
│   │   └── providers/                    # Per-service webhook handlers
│   │       ├── front.ts
│   │       ├── github.ts
│   │       ├── vercel.ts
│   │       ├── todoist.ts
│   │       ├── mux.ts
│   │       └── joelclaw.ts
│   └── memory/                           # Memory pipeline components
├── scripts/
│   └── sync-content-to-convex.ts         # Manual full Convex sync
└── package.json
```

## Worker Roles

Two deployment modes controlled by `WORKER_ROLE` env var:

| Role | Where | Functions |
|------|-------|-----------|
| `host` | Local Mac Mini via Talon supervisor (optional) | Agent loops, heartbeat checks, memory pipeline, content sync, video ingest, book download — anything needing local filesystem, pi CLI, or docker |
| `cluster` | k8s pod (GHCR image) | Webhooks (Front, GitHub, Vercel, Todoist, Mux), approvals, notifications, Slack backfill — stateless, network-only |

Functions are split between `index.host.ts` and `index.cluster.ts`. The combined `index.ts` exports everything for tooling/tests.

## Deployment Model

- **Source of truth**: `~/Code/joelhooks/joelclaw/packages/system-bus/`
- **Primary runtime**: `system-bus-worker` Deployment in the Talos/Colima k8s cluster
- **Deploy path**: `~/Code/joelhooks/joelclaw/k8s/publish-system-bus-worker.sh`

No standalone worker clone is used for deploys. Edit in monorepo, then publish to k8s.

## Adding a New Inngest Function

1. Create `packages/system-bus/src/inngest/functions/<name>.ts`
2. Import `inngest` from `../client`
3. Define the function:

```typescript
import { inngest } from "../client";

export const myFunction = inngest.createFunction(
  {
    id: "system/my-function",
    // NEVER set retries: 0 — let Inngest defaults handle retries
    concurrency: { limit: 1, key: '"my-function"' },
  },
  { event: "my/event.name" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as
      import("../middleware/gateway").GatewayContext | undefined;

    const result = await step.run("do-work", async () => {
      // your logic here
      return { done: true };
    });

    return result;
  }
);
```

4. Export from `index.host.ts` or `index.cluster.ts` (depending on role)
5. Add the export to `index.ts` as well
6. Add the event type to `client.ts` if it's a new event
7. TypeScript check: `bunx tsc --noEmit -p packages/system-bus/tsconfig.json`
8. Deploy (see below)

### Event Naming Convention

Events describe what happened, not commands: `agent/memory.observed` not `agent/memory.write`.

### LLM Inference

**ALWAYS** use the shared utility:

```typescript
import { infer } from "../../lib/inference";

const { text } = await infer("Your prompt", {
  task: "classification",
  model: "anthropic/claude-haiku",
  system: "System prompt here",
  component: "my-function",
  action: "my-function.classify",
  noTools: true,
  print: true,
});
```

This shells to `pi -p --no-session --no-extensions`. Zero config, zero API cost. **NEVER** use OpenRouter, read auth.json, or use paid API keys directly.

### Gateway Context

All functions receive `gateway` context via middleware (ADR-0144). Use it for notifications:

```typescript
const gateway = (rest as any).gateway as
  import("../middleware/gateway").GatewayContext | undefined;

await gateway?.notify("event.name", { details });
await gateway?.alert("Something broke", { error: String(err) });
await gateway?.progress("Step 3/5 complete");
```

## Hard Rules

- **NEVER set `retries: 0`** — Inngest defaults handle retries. This has caused multiple production failures.
- **Events silently dropped if functions not registered.** Verify `joelclaw functions` returns >0 before sending events. `joelclaw refresh` forces re-registration.
- **Inngest server function registry goes stale** on worker restart. Always `curl -X PUT http://127.0.0.1:3111/api/inngest` after restart.
- **Don't edit monorepo while a loop is running.** `git add -A` scoops up unrelated changes.
- **Step names must be unique within a function** — Inngest uses them for memoization.
- **`step.invoke` over fan-out events for rate-limited APIs** — fan-out starts all near-simultaneously even with throttle.
- **Silent failure anti-pattern**: Functions that shell to CLIs must detect and propagate subprocess failures.
- **Never call `joelclaw` CLI with `Bun.spawnSync` from inside a running Inngest function.** `joelclaw inngest status` probes the worker endpoint; sync subprocesses can deadlock the worker event loop. Use async subprocess execution (`Bun.spawn`/`Bun.$`) with explicit timeouts, or direct internal health probes.

## Deploy: system-bus-worker (k8s)

```bash
~/Code/joelhooks/joelclaw/k8s/publish-system-bus-worker.sh
kubectl -n joelclaw rollout status deployment/system-bus-worker --timeout=180s
joelclaw refresh
```

Builds ARM64 image, pushes to GHCR, updates k8s deployment, verifies rollout.

## Adding a Webhook Provider

See the `webhooks` skill for full details. Quick summary:

1. Create `src/webhooks/providers/<service>.ts` implementing `WebhookProvider`
2. Register in `src/webhooks/server.ts`
3. Add secret to `WEBHOOK_SECRETS` array in `serve.ts`
4. Store secret in agent-secrets: `secrets add <service>_webhook_secret`

## Debugging

```bash
# Check worker health
curl http://localhost:3111/ | jq

# View registered functions
joelclaw functions

# Recent runs
joelclaw runs --count 20

# Inspect a specific run
joelclaw run <RUN_ID>

# Worker logs (k8s)
kubectl logs -n joelclaw deploy/system-bus-worker -f

# Inngest server logs
kubectl logs -n joelclaw inngest-0 | grep ERROR

# Force re-registration
curl -X PUT http://127.0.0.1:3111/api/inngest
```

## Key Files

| File | Purpose |
|------|---------|
| `src/serve.ts` | HTTP server, Inngest registration, health endpoint |
| `src/inngest/client.ts` | Event type definitions, Inngest client |
| `src/inngest/middleware/gateway.ts` | Gateway context injection |
| `src/inngest/functions/index.host.ts` | Host-role function list |
| `src/inngest/functions/index.cluster.ts` | Cluster-role function list |
| `src/lib/inference.ts` | LLM inference via pi (use this, not raw APIs) |
| `src/observability/emit.ts` | OTEL event emission |
| `src/webhooks/server.ts` | Webhook route registration |
| `~/Code/joelhooks/joelclaw/k8s/publish-system-bus-worker.sh` | K8s deploy script |
