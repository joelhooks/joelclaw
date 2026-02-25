---
status: proposed
date: 2026-02-25
decision-makers: Joel
consulted: ADR-0140 (unified inference router)
informed: joelclaw system owners
---

# ADR-0142: Dynamic Inference Provider Scheduling

## Context

ADR-0140 established a unified inference router with a static model catalog and policy-based routing. All inference now flows through `buildInferenceRoute()` with `DEFAULT_TASK_TO_MODELS` mapping tasks to ordered model lists. Langfuse traces every call. OTEL emits on every call.

This creates the foundation for **dynamic** routing — the router already selects models per-task with a fallback chain, but the selection is static (hardcoded priority order). With Langfuse capturing every call's latency, cost, and success/failure, we have the signal to make routing decisions at runtime.

## Decision

Extend the inference router with a dynamic scheduling layer that adjusts model selection based on real-time provider signals.

### Scheduling Signals

| Signal | Source | Update Frequency |
|--------|--------|-----------------|
| Provider latency p50/p95 | Langfuse traces | Rolling 15min window |
| Provider error rate | Langfuse traces + OTEL | Rolling 15min window |
| Provider degraded status | Manual flag or auto-detect | Event-driven |
| Daily spend per provider | Langfuse cost rollup | Per-call check against Redis counter |
| Task success rate by model | Langfuse (classification confidence, retry count) | Rolling 1h window |
| Time of day | Clock | Implicit |

### Scheduling Strategies

**1. Health-weighted fallback** (phase 1)
- Track provider health score (0-1) from error rate + latency
- Healthy providers stay in catalog order
- Degraded providers (score < 0.7) get demoted in the fallback chain
- Down providers (score < 0.3) get skipped entirely
- Recovery: auto-probe every 5min, restore when score > 0.8

**2. Cost-aware task routing** (phase 2)
- Background/batch tasks (digests, cleanup, backfill) prefer cheapest viable model
- Interactive tasks (gateway session, triage) prefer fastest model
- Budget caps: per-provider daily limit in Redis, router shifts traffic when approaching cap
- "Economy mode" flag for Inngest functions that tolerate cheaper models

**3. Quality feedback loop** (phase 3)
- Track downstream success metrics per model×task (e.g., classification accuracy from retry rates)
- Models that consistently need retries for a task type get deprioritized for that task
- Slow quality drift detection: if model X's summary quality degrades over weeks, alert + auto-adjust

### Architecture

```
buildInferenceRoute(input, policy)
  │
  ├── Static catalog (existing) → base model ordering
  │
  └── Dynamic scheduler (new) → re-ranks based on signals
       ├── Redis: provider health scores, spend counters
       ├── Langfuse API: recent trace stats (cached 5min)
       └── Config: budget caps, economy mode flags
```

The scheduler is an **optional overlay**. If Redis is down or signals are stale, fall back to static catalog order. Zero-failure-mode requirement — dynamic scheduling is an optimization, never a hard dependency.

### Data Flow

1. Every inference call completes → Langfuse trace + OTEL event (ADR-0140)
2. Inngest cron (`inference/health.update`, every 5min) → queries Langfuse API for rolling stats → writes provider health scores to Redis
3. Each `buildInferenceRoute()` call → reads health scores from Redis (with 0-latency fallback to static if Redis unavailable) → re-ranks fallback chain
4. Budget tracking: `inference.ts` increments Redis counter per-provider on each call → router checks counter before selecting

### Inngest Functions

- `inference/health.update` — cron (5min): query Langfuse, compute health scores, write to Redis
- `inference/budget.reset` — cron (daily midnight): reset per-provider spend counters
- `inference/provider.degraded` — event-driven: auto-detect or manual flag, notify gateway
- `inference/provider.recovered` — event-driven: probe confirms recovery, notify gateway

### Redis Keys

```
inference:health:{provider}     → { score, p50, p95, errorRate, lastUpdated }
inference:spend:{provider}:daily → float (USD)
inference:budget:{provider}     → float (daily cap USD)
inference:mode                  → "normal" | "economy"
```

### Economy Mode

A system-wide or per-function flag:
- `economy: true` in Inngest function metadata → router prefers cheapest model for the task
- System-wide `inference:mode = economy` in Redis → all batch/background functions use cheapest viable
- Interactive (gateway) sessions always use quality-optimized routing regardless of economy mode

### OTEL Events

- `inference.schedule.health_check` — health scores computed
- `inference.schedule.provider_demoted` — provider moved down in chain
- `inference.schedule.provider_skipped` — provider skipped due to health/budget
- `inference.schedule.budget_warning` — provider approaching daily cap
- `inference.schedule.economy_mode` — economy mode toggled

## Implementation Order

1. Redis health score schema + read/write helpers
2. `inference/health.update` Inngest cron (Langfuse API query → Redis)
3. `buildInferenceRoute()` dynamic re-ranking (read health scores, adjust chain)
4. Budget tracking (Redis counters, per-call increment, cap check)
5. `inference/budget.reset` daily cron
6. Economy mode flag (Redis + function metadata)
7. Provider degraded/recovered events + gateway notifications
8. Quality feedback loop (phase 3, deferred)

## Consequences

### Easier
- Automatic failover when a provider degrades — no manual intervention
- Cost visibility and control without changing function code
- Background work gets cheaper without sacrificing interactive quality
- Provider outages become non-events — router adapts in <5min

### Harder
- Redis dependency for scheduling (mitigated: static fallback)
- Langfuse API rate limits for health queries (mitigated: 5min cache)
- Tuning health thresholds and budget caps requires operational experience
- Quality feedback loop (phase 3) needs meaningful success metrics per task type
