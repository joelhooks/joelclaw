---
type: adr
status: accepted
date: 2026-02-22
tags: [adr, observability, llm, langfuse, self-hosting]
deciders: [joel]
consulted: [pi session 2026-02-22]
supersedes: []
superseded-by: []
---

# ADR-0101: Langfuse as an LLM-Only Observability Plane

## Context

We need deeper observability for **LLM usage only** (prompt/input-output traces, model latency, token/cost usage, eval workflow), without replacing existing joelclaw observability.

Current state:

- **Canonical system observability already exists** via ADR-0087 (`otel_events` in Typesense + Convex/UI/CLI surfaces).
- joelclaw runtime is event-first (Inngest + gateway + OTEL events), not APM-first.
- Most LLM calls are made through `pi` subprocesses in CLI and worker code, with one direct Anthropic HTTP call in `transcript-process.ts`.
- Current cluster capacity is a single node (`4 CPU`, `~8 GiB RAM`) with running workloads (inngest, worker, redis, typesense, pds, livekit).

The question is not “replace observability,” but “add a dedicated LLM observability plane with strict boundaries.”

## Research Summary (top-to-bottom)

### 1) Langfuse self-host architecture is production-grade but infra-heavy

Langfuse v3 self-host requires:

- `langfuse-web`
- `langfuse-worker`
- Postgres (OLTP)
- ClickHouse (OLAP, mandatory)
- Redis/Valkey (queue + cache)
- S3/blob store (event/object persistence)

Key requirement details:

- ClickHouse is mandatory (no Postgres-only mode in v3).
- Redis queue behavior expects `maxmemory-policy noeviction`.
- For OTEL ingest, Langfuse supports HTTP/protobuf endpoint (`/api/public/otel`), not gRPC.
- Health endpoints exist for web and worker (`/api/public/health`, `/api/public/ready`, `/api/health`).

### 2) Minimum published sizing is above our current node footprint

Langfuse minimum guidance (self-host scaling docs) is roughly:

- Web: `2 CPU / 4 GiB`
- Worker: `2 CPU / 4 GiB`
- Postgres: `2 CPU / 4 GiB`
- Redis: `1 CPU / 1.5 GiB`
- ClickHouse: `2 CPU / 8 GiB`
- Blob store: managed S3 or MinIO

This exceeds current control-plane capacity if co-located with existing joelclaw services.

### 3) Scope fit is strong if we keep strict boundaries

Langfuse is a good fit for:

- generation-level traces
- prompt/version lineage
- model/provider/latency/token/cost visibility
- LLM-focused analysis and eval UX

Langfuse is not needed for:

- infra health
- webhook/gateway plumbing telemetry
- non-LLM pipelines

Those stay in ADR-0087 OTEL/Typesense.

### 4) Licensing and feature split

- Core Langfuse OSS is MIT with full core tracing APIs.
- Some admin/security features are EE via license key (RBAC expansions, audit logs, server-side ingestion masking, SCIM/org management APIs, etc.).
- LLM-only observability goal does not require EE for initial adoption.

### 5) Alternatives considered

1. **Status quo + custom OTEL LLM fields only**
   - Lowest ops load
   - Misses dedicated prompt/eval/tracing workflows
2. **Self-host Langfuse (chosen)**
   - Best product fit for LLM usage debugging
   - Higher ops load and infra footprint
3. **Arize Phoenix**
   - Strong eval tooling, self-hostable
   - ELv2 license (different OSS posture from MIT) and less direct fit with current desired product workflow
4. **LangSmith self-host**
   - Enterprise-gated self-host model; not aligned with current self-host-first preference

## Decision

Adopt **Langfuse as a separate LLM-only observability plane** with hard boundaries and phased deployment:

1. **Langfuse is scoped to LLM usage only.**
2. **ADR-0087 OTEL/Typesense remains canonical for system observability.**
3. **No non-LLM spans/events are sent to Langfuse.**
4. **Rollout is phased:** hosted Langfuse Cloud first (to start instrumentation now), then full self-host after hardware expansion.
5. **Self-host phase must not contend with existing single-node control-plane capacity**; use dedicated infra (new node or external managed datastore topology).
6. **All LLM instrumentation must fail-open** (Langfuse outages cannot block command/function execution).

## Boundary Contract

### In-scope for Langfuse

- `pi`-backed inference calls used for triage/rewrite/summarization/classification
- direct provider calls (Anthropic/OpenAI/etc.)
- Inngest `step.ai` model invocations where usage is available

### Out-of-scope for Langfuse

- gateway queue drain events
- webhook verification events
- k8s/service health checks
- storage/network/infra diagnostics
- generic OTEL event stream mirroring

### Correlation fields required on every Langfuse trace

- `joelclaw.component`
- `joelclaw.action`
- `joelclaw.event_id` (if present)
- `joelclaw.run_id` (Inngest run id when available)
- `joelclaw.session_id` (gateway/cli session where applicable)
- `environment` (`dev`/`prod`)

## Implementation Plan

### Phase 0 — Infra preflight + deployment topology

1. Provision Langfuse on dedicated capacity (not current overloaded control-plane):
   - either separate k8s node/namespace (`langfuse`), or
   - managed Postgres/ClickHouse/S3 + dedicated Redis/Valkey with noeviction
2. Add deployment config in repo:
   - `k8s/langfuse-values.yaml` (new)
   - `k8s/deploy-langfuse.sh` (new)
3. Add secret contract docs:
   - Langfuse keys/host
   - storage/database/redis credentials

### Phase 1 — Instrumentation foundation (LLM-only)

1. Add shared helper wrappers:
   - `packages/system-bus/src/lib/llm-observe.ts` (new)
   - `packages/cli/src/llm-observe.ts` (new)
2. For `pi` subprocess paths, switch to `--mode json` in wrappers to capture provider/model/usage/cost from final events.
3. Emit both:
   - Langfuse trace/generation records (LLM plane)
   - existing OTEL event summary (`llm.call.completed|failed`) for cross-plane diagnosis

### Phase 2 — Pilot callsites (high-signal first)

Pilot on:

- `packages/cli/src/commands/recall.ts` (query rewrite)
- `packages/system-bus/src/observability/triage.ts` (LLM classifier)
- `packages/system-bus/src/inngest/functions/transcript-process.ts` (direct Anthropic vision call)

### Phase 3 — Expand to remaining `pi` callsites

Migrate LLM subprocess callsites in:

- `packages/system-bus/src/inngest/functions/check-email.ts`
- `packages/system-bus/src/inngest/functions/task-triage.ts`
- `packages/system-bus/src/inngest/functions/observe.ts`
- `packages/system-bus/src/inngest/functions/reflect.ts`
- `packages/system-bus/src/inngest/functions/promote.ts`
- `packages/system-bus/src/inngest/functions/memory/batch-review.ts`
- `packages/system-bus/src/inngest/functions/content-sync.ts`
- `packages/system-bus/src/inngest/functions/vip-email-received.ts`
- `packages/system-bus/src/inngest/functions/daily-digest.ts` (step.ai path)

### Phase 4 — Ops + guardrails

1. Add health checks and alerts for Langfuse web/worker readiness.
2. Add sampling/masking policy (PII-safe) before production rollout.
3. Enforce span allowlist (`LLM scopes only`) to prevent scope creep.
4. Document rollback switch: `JOELCLAW_LLM_OBS_ENABLED=0`.

## Acceptance Criteria

- [ ] Langfuse receives traces for pilot LLM callsites with model/latency/token/cost metadata.
- [ ] No non-LLM system events appear in Langfuse.
- [ ] Existing OTEL pipeline remains unchanged and fully functional.
- [ ] LLM call execution remains successful when Langfuse is unavailable (fail-open verified).
- [ ] Each Langfuse trace is correlatable to joelclaw run/session/event identifiers.
- [ ] Dedicated infra deployment does not degrade existing joelclaw workloads.

## Verification Commands

- `joelclaw status`
- `joelclaw inngest status`
- `joelclaw gateway status`
- `curl -fsS http://<langfuse-web>/api/public/health`
- `curl -fsS http://<langfuse-web>/api/public/ready`
- `curl -fsS http://<langfuse-worker>/api/health`
- `joelclaw otel search "llm.call" --hours 24`

## Non-Goals

- Replacing ADR-0087 OTEL/Typesense as system observability source of truth.
- Sending full infra/app spans into Langfuse.
- Re-architecting all model execution into a single gateway in this ADR.

## Consequences

### Positive

- Dedicated LLM debugging workflow without polluting system observability.
- Better visibility into model usage/cost regressions and prompt behavior.
- Preserves existing joelclaw o11y architecture and CLI surfaces.

### Negative / Risks

- Significant infra overhead for self-hosting.
- Requires disciplined scope enforcement to avoid dual-observability sprawl.
- Existing `pi` subprocess calls currently hide usage unless migrated to JSON-mode wrapper.

## Rollback

1. Disable instrumentation via env flag (`JOELCLAW_LLM_OBS_ENABLED=0`).
2. Keep OTEL summaries only.
3. Scale down/remove Langfuse deployment after confirming no runtime dependency remains.

## References

- ADR-0087: Full-Stack Observability + JoelClaw Design System
- Langfuse self-hosting architecture and deployment docs (`/self-hosting`)
- Langfuse scaling guide (`/self-hosting/configuration/scaling`)
- Langfuse ClickHouse requirements (`/self-hosting/deployment/infrastructure/clickhouse`)
- Langfuse Redis/cache requirements (`/self-hosting/deployment/infrastructure/cache`)
- Langfuse OTEL ingest docs (`/integrations/native/opentelemetry`)
- Langfuse health/readiness docs (`/self-hosting/configuration/health-readiness-endpoints`)
- Langfuse license key split (`/self-hosting/license-key`)

## More Information

- 2026-02-21: Operator directive changed rollout sequence to **hosted-first** (Langfuse Cloud) while keeping this ADR's LLM-only boundary contract intact.
- Self-hosted deployment remains the target state after new hardware capacity is available.
- Secrets for hosted phase were stored via `secrets` CLI as `langfuse_secret_key`, `langfuse_public_key`, and `langfuse_base_url`.
- 2026-02-21: Phase 1 pilot started in `packages/cli/src/commands/recall.ts` with Langfuse generation traces for query rewrite (provider/model/usage/cost captured from `pi --mode json`).
- 2026-02-22: Hosted rollout expanded in `@joelclaw/system-bus` with shared Langfuse LLM tracing helpers and instrumentation added to major inference paths (`observability/triage`, `check-email`, `task-triage`, `observe`, `reflect`, `memory/batch-review`, `content-sync`, `promote`, `vip-email-received`, `daily-digest`, `transcript-process`, `media-process`, `agent-dispatch` for `tool=pi`).
- 2026-02-22: Post-rollout validation confirmed new trace names in hosted Langfuse, including `joelclaw.agent-dispatch`.
- 2026-02-22: Remaining `step.ai.infer` callsite inventory in `@joelclaw/system-bus` reduced to `daily-digest`; callsite now emits Langfuse traces on both success and failure with inferred provider/model and extracted usage token fields when available.
- 2026-02-22: Added CI guardrail to prevent untraced `step.ai.infer` additions (`scripts/validate-llm-observability-guards.ts`, enforced via shared workflow `.github/workflows/agent-contracts.yml`), enforcing nearby `traceLlmGeneration` coverage.
- 2026-02-22: Added `joelclaw langfuse aggregate` CLI surface for project-level cloud trace rollups (cost/latency/signature trends) so Langfuse + OTEL + local logs can be queried through one agent-facing CLI.

## Status

Accepted.
