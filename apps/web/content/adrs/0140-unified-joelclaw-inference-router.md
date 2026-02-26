---
status: shipped
date: 2026-02-25
decision-makers: "Joel, Codex agent"
consulted: "ADR-0091, ADR-0092, ADR-0101, ADR-0135, ADR-0108, ADR-0109, claw-llm-router patterns, o11y-logging skill, inngest-events skill, inngest-flow-control skill"
informed: "joelclaw system owners"
---

# One place to pick and trace LLM models

## Context and Problem Statement

joelclaw currently routes LLM calls through multiple incompatible paths:

1. `pi -p --no-session --no-extensions` calls in `packages/system-bus/src/inngest/functions/*`.
2. The shared `infer()` utility in `packages/system-bus/src/lib/inference.ts`.
3. Gateway session-based inference with its own fallback controller in `packages/gateway/src/model-fallback.ts` and `packages/gateway/src/daemon.ts`.
4. Direct inference providers in CLI and workers (for example `packages/cli/src/commands/recall.ts` and `packages/system-bus/src/inngest/functions/transcript-process.ts`).
5. `step.ai.infer` in `packages/system-bus/src/inngest/functions/daily-digest.ts`, which uses direct provider model selection (`claude-3-5-sonnet-latest`) disconnected from current model allowlists.

This fragmentation causes:
- Model policy drift across components (`packages/gateway/src/commands/config.ts` vs `packages/system-bus/src/lib/models.ts` vs ad hoc env-configured defaults).
- Cost opacity (no single routing policy, incomplete model attribution across all execution planes).
- Observability gaps for a subset of inference calls (partial `Langfuse` + partial OTEL instrumentation).
- Reduced model flexibility (every caller tends to re-harden policy in-place).

The goal is a single system-level inference router that normalizes model selection, supports rich fallback/policy logic, and emits uniform telemetry while preserving the same inference surface from CLI, gateway, and Inngest worker functions.

## Decision Drivers

- We already have successful fallback behavior in gateway (`ModelFallbackController`) and should keep its failure semantics while centralizing the policy and decision logic.
- Cost discipline requires a consistent model tiering strategy with auditable spend attribution, not per-call ad hoc policy.
- `Langfuse` is already accepted as the LLM observability plane, and OTEL remains the canonical event fabric for system-wide triage.
- Maximum model flexibility is needed because callers change by task (triage, summarization, vision, classification, batch workflows) and provider ecosystems evolve quickly.
- The existing router implementation from `claw-llm-router` provides a proven local classification + tier fallback pattern we can adapt to joelclaw's architecture.

## Considered Options

1. **Option A: Keep current paths and add best-effort wrappers per caller**
   - Keep current inference implementations and add wrapper helpers around all call sites.
   - Pros: minimal immediate refactor.
   - Cons: never reaches single source of truth; long-term debt remains and policy remains distributed.

2. **Option B: Force everything through gateway session inference**
   - Route all inference through gateway and retire `system-bus`/CLI-specific calls.
   - Pros: quick to standardize at transport level.
   - Cons: introduces avoidable coupling, recursion risks, and weaker fit for non-interactive/background Inngest jobs that do not need sessions.

3. **Option C: Build/introduce a joelclaw inference-router service used by gateway, system-bus, and CLI**
   - Add a small, policy-first inference control plane with explicit model registry, classifiers, fallback policy, and provider adapters.
   - Pros: centralized policy, highest flexibility, and uniform OTEL + Langfuse wiring.
   - Cons: larger migration effort and requires strict rollout guardrails.

## Decision Outcome

Chosen option: **Option C**, because it preserves task-specific optimization and allows joelclaw to keep `pi` where useful while centralizing policy, validation, cost metadata, and fallback governance across all AI consumers.

### Consequences

- Good, because all inference callsites will consume the same policy contract (`InferRequest`) and no longer duplicate routing assumptions.
- Good, because router policy can be adjusted without editing unrelated functions (just update registry + policy version).
- Good, because every call can emit:
  - OTEL semantic events for operational triage.
  - Langfuse traces for token/cost/quality review.
- Bad, because this is a migration-heavy change touching gateway, system-bus, and CLI paths with temporary dual-stack risk.
- Bad, because we need robust policy governance to avoid introducing centralized misconfiguration as a new blast radius.

## Scope

- In scope:
  - Canonical model registry and aliases (`anthropic/claude-*`, `openai`/`openai-codex`, and provider models).
  - Central inference router service API and shared client library.
  - Migration of `infer`, `recall`, `daily-digest`, and high-frequency Inngest function inference callsites.
  - Unified cost/event telemetry + policy observability.
  - Policy-driven fallback and retry strategy consistent across gateway, system-bus, and CLI.
- Out of scope:
  - Rewriting all domain logic and model prompts.
  - Changing gateway transport mechanics unrelated to LLM invocation.
  - Introducing new vector/embedding infrastructure in this ADR (may happen later under a separate ADR).

## Deep-dive findings before decision lock

### Source-of-truth drift discovered
- Model allowlists are split and inconsistent:
  - `packages/gateway/src/commands/config.ts`
  - `packages/system-bus/src/lib/models.ts`
  - inline hard-coded models in `packages/cli/src/commands/recall.ts` and `packages/system-bus/src/cli` helpers.
- Direct and indirect inference calls are mixed:
  - `packages/cli/src/commands/recall.ts` (direct `ANTHROPIC_MESSAGES_URL` and `OPENAI_CHAT_COMPLETIONS_URL`).
  - `packages/system-bus/src/inngest/functions/transcript-process.ts` (direct Anthropic).
  - direct `pi -p --no-session --no-extensions` in `x-content-hook`, `x-discovery-hook`, `discovery-capture`, `summarize`.
  - `step.ai.infer` in `daily-digest.ts` with model value outside current allowlist conventions.

### Git history consulted
- `packages/system-bus/src/lib/inference.ts`: migrations to shared pi utility (`4123d9d`, `2c8a997`).
- `packages/gateway/src/model-fallback.ts`: fallback model controller and event surface are already foundational.
- `packages/system-bus/src/lib/langfuse.ts` and `packages/system-bus/src/lib/models.ts` are recent but still partial relative to total call surface.

### External architecture reference
- `claw-llm-router` already demonstrates:
  - rule-based tier classification,
  - provider matrix + override and fallback chain,
  - adapter boundaries for direct provider calls vs gateway fallback,
  - recursion protection for provider/model override.

## Implementation Plan

### Phase 1 — Canonical policy and contract (foundational)
- Add new package module:
  - `packages/inference-router/` (or equivalent joelclaw-owned package).
  - Core contract:
    - `schema.ts` with `InferencePolicy`, `ModelRef`, `ProviderRef`, `RouteAttempt`, `InferenceEvent`.
    - `catalog.ts` with canonical model IDs and compatibility aliases (including legacy aliases such as `anthropic/claude-haiku` -> `anthropic/claude-haiku-4-5` where safe).
  - Runtime config source:
    - file-based default policy under repo config and `Redis` override for live updates.
  - Add deterministic event names:
    - `model_router.request`, `model_router.route`, `model_router.fallback`, `model_router.result`, `model_router.fail`.
- Add a migration note for policy versioning and deprecation windows.

### Phase 2 — Central client API + telemetry parity
- Update inference entrypoints to consume the router:
  - `packages/system-bus/src/lib/inference.ts`: re-implement using router contract instead of ad hoc model handling.
  - `packages/cli/src/commands/recall.ts`: replace dual-provider direct calls with the same router client.
  - `packages/system-bus/src/inngest/functions/daily-digest.ts`: replace `step.ai.infer` model path with central router request wrapper and explicit policy scope (`digest`, `reasoning`, `speed`).
- Instrument in one place:
  - OTEL span lifecycle:
    - `inference.request`, `inference.classify`, `inference.fallback`, `inference.success`, `inference.failure`.
  - Langfuse per-call trace wrapper with:
    - policy version,
    - model/tier,
    - caller key (`component.function_id`),
    - estimated-cost metadata.
- Preserve direct `pi` fallback behavior temporarily:
  - where `pi` sessions are currently mandatory for existing auth flows, route via router provider adapters rather than bypassing policy.

### Phase 3 — Gateway alignment
- Replace direct model-id decisions in gateway command/config with policy-backed IDs.
  - `packages/gateway/src/commands/config.ts` moves to canonical catalog names.
  - `packages/gateway/src/model-fallback.ts` and `packages/gateway/src/daemon.ts` emit router events and consume the same routing telemetry fields.
- Add a policy bridge:
  - if request uses Anthropic OAuth-like auth or gateway-native session mode, router sets explicit provider override and avoids recursive routing loops.

### Phase 4 — Inngest and background worker migration
- Replace remaining direct calls and shell invocations:
  - `packages/system-bus/src/inngest/functions/transcript-process.ts`
  - `packages/system-bus/src/inngest/functions/x-content-hook.ts`
  - `packages/system-bus/src/inngest/functions/x-discovery-hook.ts`
  - `packages/system-bus/src/inngest/functions/discovery-capture.ts`
  - `packages/system-bus/src/inngest/functions/summarize.ts`
  - all other files from inventory that still use raw model strings (`rg`-discoverable hotspots in `friction-fix`, `vip-email-received`, `observe`, `task-triage`, `content-sync`, `media-process`, etc.).
- Add optional Inngest guardrails:
  - use `inngest-events` event names for policy rejections and degraded-mode escalation,
  - use `inngest-flow-control` concurrency keys by policy (`inference.<policy_id>`) and failure classes (`provider.*`, `model.*`).

### Phase 5 — Enforcement and rollout
- Add a lint/lint-like check:
  - block direct `fetch` to model provider endpoints in non-router modules (except gateway/provider adapters and temporary migration windows).
- Add config validation at startup:
  - unknown model IDs fail fast,
  - ambiguous model aliases require explicit compatibility mapping.
- Rollout by traffic class:
  - low-risk background functions -> user-facing gateway flows -> recall/classification functions -> high-QPS ingestion functions.

### Affected paths
- `packages/system-bus/src/lib/{inference.ts, models.ts, langfuse.ts}`
- `packages/system-bus/src/inngest/functions/{channel-message-classify.ts,daily-digest.ts,discovery-capture.ts,x-content-hook.ts,x-discovery-hook.ts,summarize.ts,transcript-process.ts,observe.ts,sleep-mode.ts,task-triage.ts,vip-email-received.ts,friction-fix.ts}` (exact set to be finalized in phase 4)
- `packages/gateway/src/{commands/config.ts,model-fallback.ts,daemon.ts}`
- `packages/cli/src/commands/recall.ts`
- `packages/inference-router/` new package (or equivalent package boundary)
- `apps/web/content/adrs/` and `~/Vault/docs/decisions/` for ADR records and discoverability

### Patterns to follow
- Use one inference request schema and enforce all callsites use it.
- Keep policies declarative and versioned (`policy_version`).
- Keep provider adapter logic isolated to one package.
- Emit both OTEL and Langfuse metadata on the same inference lifecycle event.

### Patterns to avoid
- Do not add provider-specific branching in every function.
- Do not keep local fallback arrays per callsite.
- Do not emit success telemetry without prompt length/tier/model metadata.

### Configuration
- Add policy configuration:
  - canonical model catalog,
  - tier targets (`simple`, `medium`, `complex`, `reasoning`, `vision`, `json`),
  - fallback chain per tier,
  - provider quotas/limits.
- Add opt-in environment flags:
  - `JOELCLAW_INFERENCE_ROUTER_URL`,
  - `JOELCLAW_INFERENCE_POLICY_VERSION`,
  - `JOELCLAW_INFERENCE_STRICT_MODE=true`.

### Migration order (explicit)
1. Read-only mode: router computes route but callsites still execute old calls while comparing emitted events.
2. Dual-write mode: emit OTEL + Langfuse for old and new paths in test environments.
3. Hard switch: all production callsites use router, direct provider calls removed.

## Verification

- [ ] `rg` inventory has zero direct provider endpoints in business callsites except whitelisted adapter modules (`packages/inference-router`, `packages/gateway/src/providers`, temporary migration files).
- [ ] `pnpm` (or equivalent workspace test harness) runs smoke check for:
  - `packages/system-bus/src/inngest/functions/daily-digest.ts`
  - `packages/system-bus/src/inngest/functions/observe.ts`
  - `packages/cli/src/commands/recall.ts`
  - `packages/gateway/src/daemon.ts`
  that all invoke the shared inference client.
- [ ] OTEL shows router lifecycle events for at least 4 policy branches (simple/medium/complex/reasoning) in one sample hour.
- [ ] Langfuse receives parity traces for the same sample set with model/tier/cost metadata.
- [ ] Policy conflict can be simulated in staging: force one provider to fail and validate fallback progression (no silent recursion, no unbounded retry loop).
- [ ] A migration report shows number of direct `pi -p --no-session --no-extensions` calls reduced by phase and identifies remaining exceptions.

## Implementation progress update (2026-02-25)

- `packages/system-bus/src/lib/inference.ts` is the shared inference entrypoint in use for migrated callsites.
- Added `infer()` adoption to:
  - `packages/system-bus/src/inngest/functions/content-review.ts`
  - `packages/system-bus/src/inngest/functions/reflect.ts`
  - `packages/system-bus/src/inngest/functions/memory/batch-review.ts`
  - `packages/system-bus/src/inngest/functions/self-healing-router.ts`
  - `packages/system-bus/src/inngest/functions/nas-backup.ts`
  - `packages/system-bus/src/inngest/functions/discovery-capture.ts`
  - `packages/system-bus/src/inngest/functions/meeting-analyze.ts`
  - `packages/system-bus/src/inngest/functions/transcript-process.ts`
  - `packages/cli/src/commands/recall.ts`
- Remaining in-scope direct `pi`-style / provider call paths still pending:
  - `packages/gateway/src/commands/config.ts` (legacy model allowlist alignment)

## ADR Review (Phase 3 checklist summary)

- [x] Context is understandable without prior tribal knowledge.
- [x] Trigger is explicit: distributed inference policy and observability fragmentation.
- [x] Decision is concrete and executable.
- [x] Scope includes in/out bullets.
- [x] Consequences list includes risks and benefits with follow-up tasks.
- [x] Plan names affected paths and configuration changes.
- [x] Verification criteria are specific and testable.
- [x] At least two options are compared with rejection reasons.
- [x] ADR status/metadata and filename convention match ADR conventions.

## Resolved questions (2026-02-25)

- **Package boundary**: Keep `inference-router` as separate `packages/inference-router/`. CLI and gateway already import independently — separate package enforces the contract boundary.
- **Fallback telemetry**: OTEL always emits. Langfuse always emits (cloud-hosted, cost nominal vs inference spend). Complete coverage — every call is traceable for cost attribution, latency analysis, and prompt version tracking.
- **Enforcement mode**: Strict in CI/deploy (unknown model ID = error), permissive in dev (warn + pass through). Environment-split avoids blocking experimentation while catching config drift in production.

## Open questions

~~What migration SLA is acceptable for bringing `gateway/src/commands/config.ts` and non-router gateway command surfaces fully onto the same policy metadata discipline as system bus CLI inference callsites?~~ **Resolved 2026-02-25**: Gateway `resolveModel()` and `providerForModel()` now use catalog lookup from `@joelclaw/inference-router`. Hardcoded `MODEL_PROVIDERS` map removed. Commit `865e10d`.

## Ship log (2026-02-25)

- **Package**: 16/16 tests green, `resolveModelFromCatalog`, `normalizeCatalogModel`, `routeInference` exported
- **Gateway wiring**: `daemon.ts:resolveModel()` uses catalog with console.log for observability. `config.ts:providerForModel()` delegates to catalog, falls back to "anthropic"
- **Fallback chain**: env vars PI_MODEL/PI_MODEL_ID/PI_MODEL_PROVIDER still honored — catalog is advisory layer
- **Biome enforcement** (ADR-0144): `noRestrictedImports` prevents regression to hardcoded maps
- **Validation scheduled**: 2026-02-26 — verify Langfuse traces, catalog resolution logs, fallback behavior in production
