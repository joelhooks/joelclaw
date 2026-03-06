# @joelclaw/restate

ADR-0207 Restate package for production durable workflow execution.

## Current workflow surface

### Deploy gate workload

- `deployGate.run` — durable deploy pipeline for `system-bus-worker`
- `deployGate.approve` — resolve approval promise as approved
- `deployGate.reject` — resolve approval promise as rejected

### DAG workload

- `dagOrchestrator.run` — dependency-aware DAG execution with wave fan-out/fan-in
- `dagWorker.execute` — per-node durable execution service called by orchestrator

#### Handler types

Each DAG node specifies a `handler` that determines what real work it does:

| Handler | What it does | Config fields |
|---------|-------------|---------------|
| `noop` | Simulated delay (default) | `simulatedMs` |
| `shell` | Runs a bash command | `config.command` |
| `http` | Makes an HTTP request | `config.url`, `config.method`, `config.headers`, `config.body` |
| `infer` | LLM inference via pi | `config.prompt`, `config.model`, `config.system` |

#### Dependency output passing

Nodes receive outputs from their upstream dependencies via `{{nodeId}}` template interpolation. The `infer` handler replaces `{{dep-name}}` in the prompt with that dependency's output.

#### Example: real health check pipeline

```json
{
  "requestId": "health-1",
  "nodes": [
    { "id": "k8s", "task": "check pods", "handler": "shell",
      "config": { "command": "kubectl get pods -n joelclaw" } },
    { "id": "redis", "task": "ping redis", "handler": "shell",
      "config": { "command": "kubectl exec -n joelclaw redis-0 -- redis-cli ping" } },
    { "id": "report", "task": "synthesize", "handler": "infer",
      "dependsOn": ["k8s", "redis"],
      "config": { "prompt": "Health results:\n{{k8s}}\n{{redis}}\nSummarize." } }
  ]
}
```

## Run locally

```bash
bun run packages/restate/src/index.ts
```

## Register deployment with Restate runtime

```bash
scripts/restate/register-deployment.sh
```

## Trigger workloads

```bash
# deploy gate
bun run packages/restate/src/trigger-deploy.ts -- --skip-approval

# DAG demo (noop nodes)
bun run packages/restate/src/trigger-dag.ts

# DAG system health check (real work)
bun run packages/restate/src/trigger-dag.ts -- --pipeline health

# DAG research (real work — web search + vault + memory → LLM synthesis)
bun run packages/restate/src/trigger-dag.ts -- --pipeline research --topic "Restate vs Temporal"

# PRD → DAG compilation (host pi planning + Restate orchestration + host agent bridge)
bun run packages/restate/src/trigger-prd.ts -- --prd ~/Vault/Projects/09-joelclaw/0217-phase-1-queue-execution-plan.md --cwd ~/Code/joelhooks/joelclaw

# Deterministic PRD execution (skip markdown planning; load a prebuilt JSON plan)
bun run packages/restate/src/trigger-prd.ts -- --plan ~/Vault/Projects/09-joelclaw/0217-phase-1-story-1-plan.json --cwd ~/Code/joelhooks/joelclaw
```

### PRD execution bridge

The Restate pod does **not** have `pi`, `codex`, `bun`, or a repo checkout. PRD execution therefore uses a host bridge:

1. `trigger-prd.ts` runs on the host and either:
   - compiles markdown PRD → DAG using `pi` with `gpt-5.4`, or
   - loads a deterministic JSON execution plan via `--plan`
2. Restate executes the DAG in-cluster
3. Story nodes call host worker internal endpoints on `127.0.0.1:3111` by default (override `PRD_AGENT_WORKER_URL` when the DAG worker runs somewhere else, such as an in-cluster runtime that needs `host.docker.internal:3111`). `x-otel-emit-token` is sent only when `OTEL_EMIT_TOKEN` is configured.
4. Headless host runs should start the Restate worker with `CHANNEL=noop`; `CHANNEL=console` binds stdin and exits immediately under `nohup`/background launch.
5. Host worker dispatches **`pi`** agent work from the requested `cwd` and short-polls `/internal/agent-result/:requestId` until completion. Story execution now defaults to the dedicated roster agent `agents/story-executor.md` so Restate PRD runs use a tight system prompt instead of the generic background-agent path.

Every generated story prompt prepends the joelclaw mail contract: announce work, reserve exact paths, send status updates, release locks, commit atomically, and fail closed if unrelated dirty paths would be scooped into the commit.

## Dkron scheduler proof (ADR-0216 phase 1)

The tier-1 scheduled Restate workloads now run through Dkron:

```bash
joelclaw restate cron status
joelclaw restate cron sync-tier1 --run-now
joelclaw restate cron list
```

This seeds the ADR-0216 tier-1 set in Dkron:

- `restate-health-check`
- `restate-skill-garden`
- `restate-typesense-full-sync`
- `restate-daily-digest`
- `restate-subscription-check-feeds`

Each job uses Dkron's shell executor plus `wget` against `http://restate:8080/...` from inside the cluster. The shell wrapper appends epoch seconds to the workflow ID prefix so each scheduled run gets a unique Restate workflow ID.

For the tier-1 migrations, Restate shell nodes call `scripts/restate/run-tier1-task.ts` on the host so a green scheduled run means the underlying task actually ran. Non-zero shell exits now fail the Restate node instead of returning fake success.

Dkron uses **six-field** cron expressions. Hourly-at-minute-7 is:

```bash
0 7 * * * *
```

## Smoke tests

### Deploy gate smoke

```bash
scripts/restate/test-workflow.sh
# or
joelclaw restate smoke
```

### DAG smoke

```bash
scripts/restate/test-dag-workflow.sh
# or
joelclaw restate smoke --script scripts/restate/test-dag-workflow.sh
```
