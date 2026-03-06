---
name: system-bus
displayName: System Bus Worker
description: Develop, deploy, and debug the system-bus worker — joelclaw's 110+ Inngest durable function engine, webhook gateway, and observability pipeline. Triggers on 'add a function', 'new inngest function', 'system-bus', 'worker', 'add a webhook', 'deploy worker', 'restart worker', 'function failed', 'worker not working', 'register functions', or any task involving Inngest function development, webhook providers, or worker operations.
version: 0.1.3
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
- **Running host worker**: launchd service `com.joel.system-bus-worker`
  - launch script: `~/Code/system-bus-worker/packages/system-bus/start.sh`
  - checkout used by the running host worker: `~/Code/system-bus-worker/`
- **Cluster runtime**: `system-bus-worker` Deployment in the Talos/Colima k8s cluster for cluster-role workloads
- **Cluster deploy path**: `~/Code/joelhooks/joelclaw/k8s/publish-system-bus-worker.sh`

### Host function rollout reality

After changing `packages/system-bus/src/inngest/functions/*` that run on the host worker:

1. commit + push the monorepo change to `origin`
2. `cd ~/Code/system-bus-worker && git pull --ff-only`
3. `launchctl kickstart -k gui/$(id -u)/com.joel.system-bus-worker`
4. `curl -X PUT http://127.0.0.1:3111/api/inngest`

Do not trust stale monorepo docs that imply the host worker runs directly from `~/Code/joelhooks/joelclaw`.

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
- **ADR content sync must degrade on frontmatter parse failures.** `upsertAdr` falls back to body-only parsing (empty frontmatter + stripped frontmatter block) and logs a warning, instead of dropping the ADR from Convex.
- **Non-authoritative side effects must degrade, not crash the workflow.** Example: `memory/proposal-triage` keeps triage authoritative, retries review-task creation across primary/fallback Todoist projects (`MEMORY_REVIEW_TODOIST_PROJECT` → `MEMORY_REVIEW_TODOIST_FALLBACK_PROJECT`), and only records degraded state if both fail.
- **Never call `joelclaw` CLI with `Bun.spawnSync` from inside a running Inngest function.** `joelclaw inngest status` probes the worker endpoint; sync subprocesses can deadlock the worker event loop. Use async subprocess execution (`Bun.spawn`/`Bun.$`) with explicit timeouts, or direct internal health probes.
- **Background agent runs must be non-blocking.** `system/agent-dispatch` cannot use `execSync`/other blocking subprocess APIs for long codex or claude runs on the host worker; blocking the Bun event loop causes Talon/worker-supervisor health checks to fail, the worker to restart, `/internal/agent-await` to drop, and Inngest runs to go stale.
- **Pi is now the preferred Restate PRD story executor.** `system/agent-dispatch` must honor the requested `cwd` when it calls `infer()`, should enable pi tools when file work is requested (`readFiles` or path-heavy prompts), and should use the dedicated roster agent `story-executor` for Restate PRD stories so they run under the tight execution prompt instead of the generic background-agent system prompt. The host bridge must also write a `running` inbox snapshot before long agent execution starts and dedupe `/internal/agent-dispatch` by `requestId`; otherwise multi-minute Restate retries spawn duplicate story agents and operators get a useless forever-`pending` state.
- **Do not capture tool-enabled pi attempts by waiting on pipe EOF.** In `src/lib/inference.ts`, background pi runs with tools can spawn descendants that inherit stdout/stderr, leaving `new Response(proc.stdout).text()` or similar pipe readers hanging after the real `pi` child exits. Redirect stdout/stderr to temp files (or another exit-driven sink), wait for `proc.exited`, then read the captured output so `system/agent-dispatch` can always write a terminal inbox snapshot.
- **Do not import `packages/cli/src/*` from system-bus via relative paths.** Keep runbook resolution local in `packages/system-bus` (or extract to a dedicated leaf package) and avoid creating `@joelclaw/system-bus` ↔ `@joelclaw/sdk` dependency cycles that break Turbo/Vercel.

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

### Runtime forensics: stale `RUNNING` runs

When Inngest APIs disagree (`runs` list shows `RUNNING`, `run` detail shows terminal or non-cancellable state), treat it as runtime metadata drift, usually after SDK reachability failures.

Operational truths:

- Runtime DB is SQLite inside k8s Inngest pod: `inngest-0:/data/main.db`.
- `trace_runs.status` alone is not sufficient to infer terminality.
- Terminal source-of-truth is the presence of terminal history entries:
  - `FunctionCompleted`
  - `FunctionFailed`
  - `FunctionCancelled`

Safe reconciliation sequence:

1. Preview with `joelclaw inngest sweep-stale-runs`.
2. Apply with `joelclaw inngest sweep-stale-runs --apply` (auto backup + transactional writes).
3. If manual fallback is required:
   - Backup DB: `kubectl -n joelclaw exec inngest-0 -- sqlite3 /data/main.db '.backup /data/main.db.pre-sweep-<ts>.sqlite'`
   - Find stale candidates via `trace_runs` + `function_finishes` + `history` joins.
   - Insert missing terminal history (`FunctionCancelled`) for stale candidates.
   - Ensure `function_finishes` rows exist.
   - Update `trace_runs.status` to cancelled (`500`) only after history/finishes.
4. Verify with `joelclaw run <id>` and a fresh `joelclaw runs --status RUNNING`.

## Key Files

| File | Purpose |
|------|---------|
| `src/serve.ts` | HTTP server, Inngest registration, health endpoint, and host-only internal agent bridge endpoints (`/internal/agent-dispatch`, `/internal/agent-result/:id`, `/internal/agent-await/:id`) |
| `src/inngest/client.ts` | Event type definitions, Inngest client |
| `src/inngest/middleware/gateway.ts` | Gateway context injection |
| `src/inngest/functions/index.host.ts` | Host-role function list |
| `src/inngest/functions/index.cluster.ts` | Cluster-role function list |
| `src/lib/inference.ts` | LLM inference via pi (use this, not raw APIs) |
| `src/observability/emit.ts` | OTEL event emission |
| `src/webhooks/server.ts` | Webhook route registration |
| `~/Code/joelhooks/joelclaw/k8s/publish-system-bus-worker.sh` | K8s deploy script |
