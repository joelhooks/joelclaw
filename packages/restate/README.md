# @joelclaw/restate

ADR-0207 Restate package for durable execution patterns.

## What this package proves

- Durable step execution (`ctx.run`)
- Fan-out/fan-in orchestration (`ctx.serviceClient`)
- Human-in-the-loop signaling (`ctx.promise` + resolve)

## Services

- `workerService.runTask` — durable unit-of-work handler
- `orchestratorService.runBatch` — fan-out/fan-in orchestrator
- `approvalWorkflow.run/approve/reject` — approval signal workflow

## Run locally

```bash
bun run packages/restate/src/index.ts
```

## Register deployment with Restate runtime

```bash
scripts/restate/register-deployment.sh
```

Environment variables:

- `RESTATE_DEPLOYMENT_ENDPOINT` (default `http://localhost:9080`)
- `RESTATE_ADMIN_URL` (default `http://localhost:9070`)
- `RESTATE_CLI_BIN` (default `restate`)
