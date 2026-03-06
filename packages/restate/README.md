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

Default DAG payload shape:

```json
{
  "requestId": "dag-demo",
  "nodes": [
    { "id": "discover", "task": "discover inputs" },
    { "id": "analyze", "task": "analyze inputs" },
    { "id": "synthesize", "task": "synthesize outputs", "dependsOn": ["discover", "analyze"] },
    { "id": "publish", "task": "publish artifact", "dependsOn": ["synthesize"] }
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

Environment variables:

- `RESTATE_DEPLOYMENT_ENDPOINT` (default `http://host.lima.internal:9080`)
- `RESTATE_ADMIN_URL` (default `http://localhost:9070`)
- `RESTATE_CLI_BIN` (default `restate`)

## Trigger workloads

```bash
# deploy gate
bun run packages/restate/src/trigger-deploy.ts -- --skip-approval

# DAG fan-out/fan-in demo
bun run packages/restate/src/trigger-dag.ts
```

## Smoke tests

### Deploy gate smoke

```bash
scripts/restate/test-workflow.sh
# or
joelclaw restate smoke
```

Behavior:

- port-forwards Restate ingress/admin (`svc/restate`)
- starts local `packages/restate` endpoint on `:9080` in console channel mode
- force-registers deployment endpoint
- triggers `POST /deployGate/{id}/run` with:
  - `skipApproval=true` (default)
  - `tag` defaulting to the current tag in `k8s/system-bus-worker.yaml`
- validates:
  - response image tag matches requested tag
  - decision is `skipped` when skip-approval is enabled
  - `rolloutVerified=true`

Key env vars:

- `SMOKE_TAG`
- `SMOKE_REASON`
- `SMOKE_SKIP_APPROVAL`
- `SMOKE_DEPLOY_ID`
- `SMOKE_TIMEOUT_SECONDS`

### DAG smoke

```bash
scripts/restate/test-dag-workflow.sh
# or
joelclaw restate smoke --script scripts/restate/test-dag-workflow.sh
```

Behavior:

- force-registers deployment endpoint
- triggers `POST /dagOrchestrator/{id}/run`
- validates:
  - `nodeCount=4`
  - `waveCount=3`
  - expected wave topology:
    - wave 0: `discover`, `analyze`
    - wave 1: `synthesize`
    - wave 2: `publish`
