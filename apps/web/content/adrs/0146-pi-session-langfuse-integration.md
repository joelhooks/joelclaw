---
id: "0146"
title: "Inference Cost Monitoring and Control"
status: proposed
date: 2026-02-25
tags: [observability, langfuse, gateway, pi]
---

## Context
joelclaw executes LLM inference across multiple surfaces: gateway `pi` sessions (Telegram, Discord, Slack, iMessage), system-bus Inngest functions, codex loops, and agent dispatches. There is no unified view of what this costs or a shared enforcement model, so budget visibility and spend controls are fragmented.

System-bus inference already traces to Langfuse through `packages/system-bus/src/lib/inference.ts` and therefore already contributes to Langfuse-based cost observability. Gateway `pi` sessions emit `message_end` and `turn_end` events that include `Usage.cost` and token counters (`input`, `output`, `cacheRead`, `cacheWrite`, `total`) but those values are not currently in a unified cost pipeline. The gateway runtime has a dedicated extension in `~/Code/joelhooks/pi-tools/gateway/`, and OTEL telemetry continues to flow through `@joelclaw/telemetry` to the existing observability system.

Codex sessions currently report `cost=0` for subscription-auth inference. This is a known gap and cannot be corrected from joelclaw with current provider contracts.

## Decision
Adopt a unified inference cost monitoring and control approach with Langfuse as the implementation detail for the observability sink.

The goal is to produce consistent cost telemetry and enforce budgets across all inference surfaces, with operational controls (alerts, caps, fallback policies) available through one operational posture:

1. Unified cost telemetry from every surface into Langfuse.
2. Alerting and budget reporting using `joelclaw langfuse aggregate` and related dashboard surfaces.
3. Cost control policies including model downgrade/cap enforcement when thresholds are crossed.
4. Correlatable events via OTEL metadata so cost events remain connected to existing `@joelclaw/telemetry` traces.

## Implementation phases

### Phase 1: Unified cost telemetry in pi sessions
1. Extend/normalize the gateway `pi` extension at `~/Code/joelhooks/pi-tools/gateway/` to observe `message_end` and `turn_end` events.
2. Emit a Langfuse generation record for each completion-like event with metadata: channel, model, provider, tokens, cost, request/session identifiers.
3. Preserve OTEL correlation by attaching `traceId`, `spanId`, `requestId`, and channel/thread/user context to each generation.
4. Keep credentials sourced from `process.env.LANGFUSE_PUBLIC_KEY`, `process.env.LANGFUSE_SECRET_KEY`, and `process.env.LANGFUSE_HOST`; implement startup validation and fail-open behavior when missing.
5. Update docs/operations notes so `joelclaw langfuse aggregate` can verify new ingress and coverage.

### Phase 2: Cost alerting and budgets
1. Introduce daily and weekly budget calculations across inference surfaces (gateway, system-bus, codex, agent dispatches).
2. Define threshold states (for example soft/hard caps) and emit alerts when budgets are exceeded.
3. Route alerts through existing OTEL/notification channels with enough attribution to identify violating surfaces quickly.

### Phase 3: Cost control and enforcement
1. Add per-channel and global spend caps in enforcement policy.
2. On budget breach, apply cost-control actions: downgrade model routing (e.g., fallback to Haiku), and enforce stricter provider/model choices before additional high-cost calls.
3. Persist control events with cost and routing telemetry so policy actions remain auditable and explainable.
4. Ensure all control transitions maintain OTEL/Langfuse correlation with gateway sessions and system-bus traces.

## Known gap
`cost=0` for codex subscription-auth models remains a reporting gap and should be treated as a first-class caveat in dashboards, budgets, and guardrail behavior.

## Consequences
- Inference costs become comparable across all primary joelclaw LLM surfaces instead of being siloed by subsystem.
- Operations gains control mechanisms (alerts and caps) rather than only historical cost reporting.
- OTEL correlation preserves end-to-end traceability across Typesense/OTEL and Langfuse.
- Gateway `pi` stream schema drift remains a maintenance risk and requires schema-tolerant parsing and alerting when fields are missing or malformed.

## References
- [ADR-0140: Inference Router and model catalog resolution](./0140-unified-joelclaw-inference-router.md)
- [ADR-0144: Hexagonal architecture and package boundaries](./0144-gateway-hexagonal-architecture.md)
