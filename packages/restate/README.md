# @joelclaw/restate

ADR-0207 Restate package for production durable workflow execution.

## Current workflow surface

- `deployGate.run` — durable deploy pipeline for `system-bus-worker`
- `deployGate.approve` — resolve approval promise as approved
- `deployGate.reject` — resolve approval promise as rejected

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

## Run end-to-end smoke test (deployGate)

```bash
scripts/restate/test-workflow.sh
# or
joelclaw restate smoke
```

Smoke behavior:

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

Smoke environment variables:

- `SMOKE_TAG` — override image tag (defaults to current `k8s/system-bus-worker.yaml` tag)
- `SMOKE_REASON` — reason string attached to deploy gate request
- `SMOKE_SKIP_APPROVAL` — `true|false` (default `true`)
- `SMOKE_DEPLOY_ID` — override workflow key
- `SMOKE_TIMEOUT_SECONDS` — curl timeout for workflow completion (default `900`)
- `SMOKE_RESTATE_ADMIN_LOCAL_PORT` — local admin forward port (default `9070`)
- `SMOKE_RESTATE_INGRESS_LOCAL_PORT` — local ingress forward port (default `8080`)
- `SMOKE_RESTATE_SERVICE_PORT` — local worker port (default `9080`)
- `SMOKE_RESTATE_DEPLOYMENT_ENDPOINT` — endpoint registered with Restate
