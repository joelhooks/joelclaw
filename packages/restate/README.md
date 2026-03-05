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

- `RESTATE_DEPLOYMENT_ENDPOINT` (default `http://host.lima.internal:9080`)
- `RESTATE_ADMIN_URL` (default `http://localhost:9070`)
- `RESTATE_CLI_BIN` (default `restate`)

## Run end-to-end smoke test (includes MinIO/AIStor)

```bash
scripts/restate/test-workflow.sh
# or
joelclaw restate smoke
```

Smoke test behavior:

- port-forwards Restate ingress/admin + selected S3 service (`minio` by default, `aistor-s3` supported)
- starts `packages/restate` deployment endpoint locally
- registers endpoint with Restate admin API
- invokes `orchestratorService.runBatch`
- validates result includes S3 artifact write/read round-trip

S3 environment variables used by smoke script:

- `S3_NAMESPACE` (default `joelclaw`; set `aistor` for AIStor)
- `S3_SERVICE_NAME` (default `minio`; set `aistor-s3-api` for AIStor)
- `S3_LOCAL_PORT` (default `9000`)
- `S3_USE_SSL` (default `false`)
- `S3_ACCESS_KEY` (default `minioadmin`)
- `S3_SECRET_KEY` (default `minioadmin`)
- `S3_BUCKET` (default `restate-smoke-tests`)

The package itself still reads `MINIO_*` variables; the smoke script maps `S3_*` into that runtime contract.
