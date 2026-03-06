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
