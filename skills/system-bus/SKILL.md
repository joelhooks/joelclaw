---
name: system-bus
displayName: System Bus Worker
description: Develop, deploy, and debug the system-bus worker — joelclaw's 110+ Inngest durable function engine, webhook gateway, and observability pipeline. Triggers on 'add a function', 'new inngest function', 'system-bus', 'worker', 'add a webhook', 'deploy worker', 'restart worker', 'function failed', 'worker not working', 'register functions', or any task involving Inngest function development, webhook providers, or worker operations.
version: 0.1.5
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

Queue pilot flags are evaluated inside the live worker process, not your shell. If a host-worker emitter like `discovery-capture` or `/webhooks/github` should switch to queue mode, put the flag in `~/.config/system-bus.env`, then kickstart the worker and PUT-sync `/api/inngest`. Ad-hoc shell env only affects CLI-local emitters.

Queue triage flags follow the same rule. Current bounded admission contract:
- `QUEUE_TRIAGE_MODE=off|shadow|enforce` sets the base triage mode.
- `QUEUE_TRIAGE_FAMILIES=discovery,content,subscriptions,github` (or exact event names) chooses which queue families participate at all.
- `QUEUE_TRIAGE_ENFORCE_FAMILIES=discovery,github` is the narrow Story 4 override that upgrades only `discovery/noted` and `github/workflow_run.completed` into enforce.
- Any non-eligible family is clamped back to `shadow` even if someone sets global `QUEUE_TRIAGE_MODE=enforce`.
- Handler routing always stays registry-derived; triage may only shape bounded admission fields.

`content/updated` is the odd one out: its ingress comes from the launchd watcher `com.joel.content-sync-watcher`, not from a worker-local function. The canonical watcher source now belongs in `infra/launchd/com.joel.content-sync-watcher.plist` plus `scripts/content-sync-watcher.sh`, and the script reads `~/.config/system-bus.env` on each trigger so `QUEUE_PILOTS=content` can switch between `joelclaw queue emit` and legacy `joelclaw send` without hand-editing the live plist.

For Story 5 soak work, start from `joelclaw queue stats` before spelunking raw OTEL or Redis. That command is now the operator-facing summary for Restate drainer health and queue triage behavior: it rolls up recent `queue.dispatch.started|completed|failed` telemetry plus the `queue.triage.*` lifecycle into live depth, terminal success/failure counts, `waitTimeMs` percentiles, dispatch-duration percentiles, fallback reasons, disagreement counts, applied-vs-suggested deltas, route mismatches, family rollups, and recent mismatch/fallback samples. Use `joelclaw queue stats --since <iso|ms>` when you need to anchor the sample to a known-clean point such as a supervised `queue.drainer.started` after rollout. Honest gotcha from the live Story 5 cleanup follow-through: global depth can lie because of unrelated historical backlog, so judge the supervised sample first with the anchored triage/dispatch window plus `joelclaw queue inspect <stream-id>` / `joelclaw queue list --limit <n>` on the fresh sample IDs. If old residue survives a supervised `com.joel.restate-worker` restart, clear it with a bounded `@joelclaw/queue ack()` pass only after confirming zero pending leases and an age filter on the orphaned stream IDs. If that command is broken or misleading, fix it before widening queue cutovers.

For ADR-0217 Phase 3 Story 2-4, the operator surfaces are `joelclaw queue observe`, `joelclaw queue pause`, `joelclaw queue resume`, and `joelclaw queue control status`. `queue observe` still answers “what would Sonnet do right now?” in dry-run, but its `snapshot.control.activePauses` plus top-level `control` block now reflect the shipped deterministic control plane: active pauses, expirations, and recent `queue.control.*` OTEL. `queue pause` / `queue resume` are the bounded manual apply path before any automatic observer mutation. `queue control status` is the direct operator truth source for active manual controls and recent `queue.control.applied|expired|rejected` events.

ADR-0217 Phase 3 Story 4 now has a live host-worker runtime in `packages/system-bus/src/inngest/functions/queue-observer.ts`. Durable cadence belongs in Inngest, not the gateway daemon: use the host worker cron plus manual `queue/observer.requested` for probes. Runtime flags live in `~/.config/system-bus.env` and require the usual host-worker restart + `PUT /api/inngest`:
- `QUEUE_OBSERVER_MODE=off|dry-run|enforce`
- `QUEUE_OBSERVER_FAMILIES=discovery,content,subscriptions,github`
- `QUEUE_OBSERVER_AUTO_FAMILIES=content`
- `QUEUE_OBSERVER_INTERVAL_SECONDS` (currently clamped to a 60s minimum on the durable cron path)

Current operator truth after the first live canaries: dry-run is earned, but the first supervised enforce probe on `content/updated` returned `noop` rather than an automatic mutation. That means Story 4 is implemented but **not yet earned as autonomous control**. Keep the worker in `QUEUE_OBSERVER_MODE=dry-run` until a supervised enforce window actually applies `pause_family` or `resume_family` and the queue drains cleanly afterward.

Hard-won gotcha from the Story 3 live proof: queue operator commands must resolve Redis from the canonical CLI config (`~/.config/system-bus.env` → `REDIS_URL`) before ambient shell env. The first proof looked wrong because the shell had an unrelated Upstash `REDIS_URL`, so `queue pause` wrote control state to the wrong Redis while `queue emit` still hit the localhost worker/drainer queue. If the CLI and worker disagree about Redis, fix that first or your proof is bullshit.

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
- **Execution mode: host vs sandbox (ADR-0217 Story 4).** `system/agent-dispatch` accepts `executionMode: "host" | "sandbox"` (default: `"host"`). Host mode uses the existing shared-checkout path. Sandbox mode now routes through the real local sandbox runner on the host worker: it materializes a clean temp checkout at `baseSha`, runs the requested agent inside that isolated repo, exports patch/touched-file artifacts, and then tears the sandbox down without dirtying the operator checkout. **Gate A** (non-coding vertical slice) is proven via `packages/agent-execution/__tests__/gate-a-smoke.test.ts`. **Gate B** (minimal coding sandbox) is proven via `packages/agent-execution/__tests__/gate-b-smoke.test.ts`. Gate C (k8s Job launcher) is still next. See `packages/restate/README.md` for full gate status. Deterministic sandbox requests should carry `workflowId`, `storyId`, and `baseSha`; `trigger-prd.ts` now does this for Restate PRD story runs. The execution mode is captured in the `InboxResult.executionMode` field for observability. Set via `PRD_EXECUTION_MODE` environment variable in `trigger-prd.ts`.
- **Terminal state guarantees (ADR-0217 Story 5).** `system/agent-dispatch` ensures every execution lands in a terminal state (`completed|failed|cancelled`). Duplicate requests with the same `requestId` are deduped at function entry — if a terminal result already exists, it returns that result without spawning new work. Cancellation via `system/agent.cancelled` kills the active subprocess (tracked in `activeProcesses` map by requestId) and writes a `cancelled` inbox snapshot via the `onFailure` handler.
- **Log surfacing (ADR-0217 Story 5).** All terminal results include `stdout`/`stderr` output (truncated to 10KB each) in the `logs` field. This is captured from subprocess execution and attached to the inbox result for post-mortem debugging. The logs are also emitted via OTEL events for searchability.
- **Do not capture tool-enabled pi attempts by waiting on pipe EOF.** In `src/lib/inference.ts`, background pi runs with tools can spawn descendants that inherit stdout/stderr, leaving `new Response(proc.stdout).text()` or similar pipe readers hanging after the real `pi` child exits. Redirect stdout/stderr to temp files (or another exit-driven sink), wait for `proc.exited`, then read the captured output so `system/agent-dispatch` can always write a terminal inbox snapshot.
- **`infer({ timeout })` is an overall budget, not a per-fallback reset.** Story 6 proved that reusing a fresh 10-minute timeout on every fallback attempt creates a hidden 30-minute failure chain (`SIGTERM` → `exit 143`) before the real story budget is exhausted. `src/lib/inference.ts` must spend the remaining deadline across attempts and preserve up to a one-hour explicit request budget for Restate PRD story runs.
- **Timeout errors must say timeout, not `exit 143: empty output`.** When `pi` is killed by the inference timer, surface `pi timed out after <ms>` in the thrown error and OTEL metadata so operators know it was our budget kill, not a mysterious subprocess crash.
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
