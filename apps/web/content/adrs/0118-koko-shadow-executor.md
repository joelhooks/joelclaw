---
status: proposed
date: 2026-02-23
parent: ADR-0115
credit: Sean Grove
---

# ADR-0118: Koko Shadow Executor Mode

## Context

ADR-0117 proposed novel workloads for Koko (health pulse, event digest, file watcher). Sean Grove suggested a better approach: **shadow execution** — Koko runs the same workloads as the TypeScript stack in parallel, on the same inputs, and we compare results. This is how you actually validate whether BEAM is better, worse, or equivalent for joelclaw's real workloads.

Shadow execution eliminates the "apples to oranges" problem. Instead of "Koko can do X," the question becomes "Koko does X better/faster/more reliably than TypeScript does X, on the same data."

## Decision

### How it works

```
Event arrives
    ├─→ Inngest function (TypeScript) → authoritative result → writes to state
    └─→ Koko shadow (Elixir) → shadow result → writes to shadow log only
                                                     ↓
                                              Compare: latency, output, errors
```

1. Koko observes the same Redis events that trigger Inngest functions
2. Koko executes its own implementation of the same function
3. Koko writes results to a shadow log (`joelclaw:koko:shadow:<function>` in Redis, or local file)
4. Koko **never** writes to authoritative state — no Typesense upserts, no Todoist mutations, no gateway notifications
5. A comparison process periodically diffs shadow results against real results

### Shadow log schema

```json
{
  "function": "heartbeat",
  "event_id": "evt_abc123",
  "shadow_result": { ... },
  "shadow_latency_ms": 42,
  "shadow_error": null,
  "timestamp": "2026-02-23T21:00:00Z"
}
```

The TypeScript side already logs via OTEL. Koko logs shadow results to its own namespace. A comparison can be done offline — no real-time coupling needed.

### Candidate functions for shadow execution

Ranked by suitability (read-only inputs, clear outputs, no mutation required):

| Function | Inputs | Output to shadow | Why |
|----------|--------|-------------------|-----|
| **heartbeat checks** | Redis ping, Typesense health, Inngest API | health status per service | Pure reads. Both check the same endpoints. Compare detection speed + accuracy. |
| **event digest** | N hours of events from Redis | summary text | Same events in, LLM summary out. Compare quality + latency. |
| **friction analysis** | observation corpus from Typesense | pattern list | Same observations in, patterns out. Compare what each finds. |
| **proposal triage** | pending memory proposals | approve/reject/needs-review verdicts | Same proposals in, verdicts out. Compare triage quality. |
| **ADR validation** | ADR file contents | validation errors/warnings | Pure file read + check. Compare completeness. |
| **content-sync detection** | Vault file mtimes | changed file list | Both scan same directory. Compare detection latency. |

### Functions explicitly excluded from shadow

- **Anything that mutates external state**: Todoist close, Front archive, Telegram send, PDS write, Vercel deploy hooks
- **Agent loops**: code generation requires tool execution and git mutations
- **Gateway message routing**: has side effects by definition

### Comparison metrics

For each shadowed function, track:

| Metric | What it tells us |
|--------|------------------|
| **Latency** (ms) | Is BEAM faster for this workload? |
| **Error rate** | Does Koko crash less? Does supervisor recovery mask errors? |
| **Output quality** | When both produce text (digests, summaries), are they equivalent? |
| **Recovery time** | When a check fails, how fast does each recover? (BEAM advantage) |
| **Resource usage** | Memory per function. Process count vs Node.js event loop. |

### Implementation phases

**Phase 1: Single shadow (heartbeat)**
- Koko shadows the heartbeat checks only
- Logs results to `~/Code/joelhooks/koko/shadow/heartbeat.jsonl`
- Manual comparison after 7 days

**Phase 2: Multi-shadow (3-4 functions)**
- Add friction analysis, event digest, content-sync
- Structured shadow log in Redis (`joelclaw:koko:shadow:*`)
- Basic comparison script (Elixir Mix task or CLI command)

**Phase 3: Automated comparison**
- Koko reads OTEL events for TypeScript function results
- Automatic diff report: latency distribution, error rates, output quality
- Weekly shadow report posted to gateway (or Vault note)

### Shadow execution rules

1. **Shadow must never write to authoritative stores.** No Typesense, no Todoist, no Convex, no gateway notify. Violation = immediate disable.
2. **Shadow reads are fine.** Redis GET, Typesense search, file reads, HTTP GETs to health endpoints — all OK.
3. **Shadow LLM calls use the same provider/model as TypeScript.** Apples to apples. Different models invalidate the comparison.
4. **Shadow failures are logged, not escalated.** Koko crashing during shadow execution is data, not an incident.
5. **Shadow results are append-only.** Never overwrite or delete shadow logs. They're the evidence base for ADR-0114 decisions.

## Consequences

- Koko's value proposition becomes empirically testable, not hypothetical
- Every shadow run produces data that informs the ADR-0114 migration decision
- Zero risk to production — shadow is purely additive
- Forces Koko implementations to be input-compatible with TypeScript versions (good discipline)
- Shadow comparison becomes the graduation exam: if Koko consistently matches or beats TypeScript on 3+ functions, ADR-0114 Strategy B (hybrid) has concrete evidence
- If Koko consistently loses or adds no value, we kill ADR-0114 with data instead of opinion
