# @joelclaw/restate-pilot

ADR-0207 pilot package for Restate durable execution patterns.

## What this package proves

- Durable step execution (`ctx.run`)
- Fan-out/fan-in orchestration (`ctx.serviceClient`)
- Human-in-the-loop signaling (`ctx.promise` + resolve)

## Services

- `pilotWorker.runTask` — durable unit-of-work handler
- `pilotOrchestrator.runBatch` — fan-out/fan-in orchestrator
- `pilotApprovalWorkflow.run/approve/reject` — approval signal workflow

## Run locally

```bash
bun run packages/restate-pilot/src/index.ts
```

## Register deployment with Restate runtime

```bash
scripts/restate/register-deployment.sh
```

Environment variables:

- `RESTATE_DEPLOYMENT_ENDPOINT` (default `http://localhost:9080`)
- `RESTATE_ADMIN_URL` (default `http://localhost:9070`)
- `RESTATE_CLI_BIN` (default `restate`)
