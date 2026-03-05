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

# against AIStor
MINIO_NAMESPACE=aistor MINIO_SERVICE_NAME=aistor-s3-api MINIO_USE_SSL=true scripts/restate/test-workflow.sh
```

Smoke test behavior:

- port-forwards Restate ingress/admin + selected object-store service (`joelclaw/minio` by default, `aistor/aistor-s3-api` supported)
- starts `packages/restate` deployment endpoint locally
- registers endpoint with Restate admin API
- invokes `orchestratorService.runBatch`
- validates result includes S3 artifact write/read round-trip

Object-store environment variables used by smoke script:

- `MINIO_NAMESPACE` (default `joelclaw`; set `aistor` for AIStor)
- `MINIO_SERVICE_NAME` (default `minio`; set `aistor-s3-api` for AIStor)
- `MINIO_LOCAL_PORT` (default `9000`)
- `MINIO_USE_SSL` (default `false`; set `true` for AIStor)
- `MINIO_ACCESS_KEY` (default `minioadmin`)
- `MINIO_SECRET_KEY` (default `minioadmin`)
- `MINIO_BUCKET` (default `restate-smoke-tests`)

When `MINIO_USE_SSL=true`, the script uses insecure TLS for health checks and sets `NODE_TLS_REJECT_UNAUTHORIZED=0` for the local smoke-run process.
