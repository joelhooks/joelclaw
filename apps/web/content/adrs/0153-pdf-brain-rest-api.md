---
status: accepted
date: 2026-02-26
parent: ADR-0115
---

# ADR-0153: Docs REST HTTP API for Agent Access (Typesense-backed)

## Context

The previous implementation path was wrong.

What was done incorrectly:
- REST routes were added to `~/Code/pdf-brain/src/cli.ts`.
- A launchd service was created for that `pdf-brain serve` process.

Why that is wrong:
- `pdf-brain` is a standalone local CLI (libsql + Ollama) and is **not** the canonical joelclaw knowledge base.
- The active docs knowledge base used by joelclaw agents is indexed by the docs ingest pipeline:
  - `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/docs-ingest.ts`
- That pipeline writes to Typesense collections:
  - `docs`
  - `docs_chunks`

Relevant Typesense field model (from `docs-ingest.ts`):
- `docs`: `id`, `title`, `filename`, `storage_category`, `document_type`, `file_type`, `tags`, `summary`, `added_at`, `nas_path`, `nas_paths`, etc.
- `docs_chunks`: `id`, `doc_id`, `title`, `chunk_type`, `chunk_index`, `heading_path`, `content`, `retrieval_text`, `embedding`, `added_at`, plus parent/neighbor linkage fields.

So the REST API must target Typesense directly, not `pdf-brain`.

## Decision

Build a small HTTP service in `~/Code/joelhooks/joelclaw/` that wraps Typesense `docs` + `docs_chunks` and returns `AgentEnvelope` JSON.

Implementation location:
- New standalone app (`apps/docs-api/`) or endpoint mounted in an existing joelclaw service.

Runtime can be Bun + Hono or plain `Bun.serve`.

**Deployment requirement (mandatory):**
- Service runs in joelclaw **k8s** as a deployed workload + Service.
- No launchd/local-daemon runtime for production access.

## REST Surface (unchanged contract)

| Method | Path | Backend collection |
|---|---|---|
| `GET` | `/search?q=<query>` | `docs_chunks` |
| `GET` | `/docs` | `docs` |
| `GET` | `/docs/:id` | `docs` |
| `GET` | `/chunks/:id` | `docs_chunks` |

Response shape for all routes: `AgentEnvelope` (`ok`, `command`, `protocolVersion`, `result|error`, `nextActions`, `meta`).

## Backend Query Plan

- `GET /search?q=`
  - Query `docs_chunks`
  - Use `query_by` fields aligned with current schema (`retrieval_text,content,title`; optional semantic/hybrid can include `embedding`/`vector_query`)
  - Return chunk hits with doc/chunk identifiers and snippets

- `GET /docs`
  - Query/list `docs`
  - Return lightweight metadata rows (`id`, `title`, `filename`, `summary`, `tags`, `added_at`, `nas_path`)

- `GET /docs/:id`
  - Fetch one document from `docs` by `id`

- `GET /chunks/:id`
  - Fetch one chunk from `docs_chunks` by `id`

## Auth and Network

- Keep bearer token auth using `pdf_brain_api_token` from `agent-secrets` (reuse existing secret)
- Keep Caddy mapping:
  - `:5443 -> localhost:3838`
- `localhost:3838` must resolve to the **k8s-hosted** docs API, not a launchd process.

Public-domain requirement (account for joelclaw.com):
- Support at least one externally resolvable endpoint strategy:
  1. Dedicated subdomain (preferred): `docs-api.joelclaw.com` (or similar)
  2. Path-based endpoint under main domain: `https://joelclaw.com/api/docs/*`
- Route contract remains the same at service root. Service should also accept equivalent prefixed routes when mounted under `/api/docs`.
- External endpoint remains token-protected; no anonymous public access.

## Concrete k8s Topology (normative)

Namespace:
- `joelclaw`

Kubernetes objects to add:
1. `Deployment/docs-api` (1 replica to start)
2. `Service/docs-api` (`NodePort`, service port `3838` → container port `3838`, nodePort `3838`)
3. External exposure (choose one, can support both):
   - `Ingress/docs-api` host `docs-api.joelclaw.com`
   - `Ingress/joelclaw-web` (or equivalent) path route `/api/docs` → `Service/docs-api`

Repo file targets:
- `k8s/docs-api.yaml` (Deployment + Service)
- `k8s/docs-api-ingress.yaml` (subdomain and/or path ingress)
- `k8s/publish-docs-api.sh` (build/push/deploy helper)

Internal bridge requirement:
- Existing host/Caddy route `:5443 -> localhost:3838` must terminate at the k8s service path (via existing cluster bridge strategy).

## Implementation Plan

1. Add docs API service under joelclaw (`apps/docs-api/` preferred).
2. Wire Typesense client config from existing joelclaw env conventions.
3. Implement the four routes listed above against `docs` + `docs_chunks`.
4. Add a shared envelope helper so every route returns AgentEnvelope JSON.
5. Add auth middleware for bearer token validation (`pdf_brain_api_token`).
6. Add k8s manifests:
   - `k8s/docs-api.yaml` with Deployment + Service (`namespace: joelclaw`)
   - readiness/liveness probes at `/health`
7. Add secret contract for API token:
   - `k8s/docs-api-secret.example.yaml` (template only; real secret created out-of-band)
8. Add domain exposure manifest(s):
   - `k8s/docs-api-ingress.yaml` for `docs-api.joelclaw.com` and/or `/api/docs/*`
9. Keep/confirm Caddy `:5443 -> localhost:3838`, with `3838` backed by the k8s NodePort bridge.
10. Emit structured telemetry for route success/failure (joelclaw observability standard).
11. Add runbook checks (below) as acceptance criteria for this ADR.

## Rollout + Verification Checklist (mechanical)

Deployment health:
- `kubectl -n joelclaw get deploy docs-api`
- `kubectl -n joelclaw rollout status deploy/docs-api`
- `kubectl -n joelclaw get svc docs-api`

In-cluster behavior:
- `kubectl -n joelclaw get endpoints docs-api`
- `kubectl -n joelclaw logs deploy/docs-api --tail=100`

Route contract checks (authenticated):
- `GET /search?q=typescript`
- `GET /docs`
- `GET /docs/:id`
- `GET /chunks/:id`

Security checks:
- No token → `401`
- Bad token → `401`
- Missing IDs → `404`

Exposure checks:
- Internal bridge works: `https://<tailscale-host>:5443/...`
- Public endpoint works (selected strategy):
  - `https://docs-api.joelclaw.com/...` **or**
  - `https://joelclaw.com/api/docs/...`

Observability checks:
- `joelclaw otel search "docs-api" --hours 1`
- `joelclaw otel stats --hours 1`

## Consequences

### Positive
- REST API now points at the real joelclaw docs knowledge base.
- Runtime aligns with joelclaw ops model (k8s), not ad hoc host daemons.
- Agent callers can use simple HTTP without MCP while getting stable AgentEnvelope responses.
- Endpoint can be resolved from joelclaw.com domain surface when needed.
- Eliminates architecture drift between `pdf-brain` and joelclaw docs ingestion.

### Negative / Tradeoffs
- New service surface to operate and monitor.
- Need ingress + auth hardening for any public-domain route.
- Need to keep route contract stable while schema evolves.

## Status

Accepted and implemented (internal path live).

Implemented artifacts:
- `apps/docs-api/` service (Bun) with `/health`, `/search`, `/docs`, `/docs/:id`, `/chunks/:id`
- `k8s/docs-api.yaml` (`Deployment/docs-api` + `Service/docs-api` NodePort 3838)
- `k8s/docs-api-ingress.yaml` (host + path ingress rules)
- `k8s/publish-docs-api.sh` (GHCR build/push/deploy helper, supports `GHCR_TOKEN`)

Operational status at acceptance:
- Internal bridge is live via Caddy route `https://panda.tail7af24.ts.net:5443` → `localhost:3838` → `Service/docs-api`
- Direct local NodePort endpoint is live at `http://localhost:3838`
- Public joelclaw.com exposure is configured at manifest level but depends on cluster ingress-controller activation/DNS wiring

The previous `pdf-brain`-based implementation is rejected and has been rolled back from the standalone `pdf-brain` CLI path.
