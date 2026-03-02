---
name: memory-system
displayName: Memory System
description: "Operate and extend the joelclaw agent memory system — observation pipeline, write gates, vector store, retrieval, reflection, and nightly maintenance. Use when working on memory functions, debugging recall, tuning observation quality, or evolving the memory architecture."
version: 0.1.0
author: joel
tags:
  - memory
  - system-bus
  - typesense
  - recall
  - reflection
---

# Memory System

Operational reference for the joelclaw memory pipeline (session signal → durable recall → curated MEMORY.md).

## When to use

Use this skill when working on memory capture, write gates, Typesense-backed recall, reflection/promote flows, or nightly maintenance.

## Canonical flow

```text
sessions → observe → write-gate → store → decay/rank → retrieve → inject
    ↑                                                              ↓
    └──── nightly maintenance (dedup + stale pruning + stats) ─────┘
                       ↓
               observe → reflect → propose → triage → MEMORY.md
```

**Guiding filter:** “will this fact still be true and useful next month?”

## 1) Write gate states (allow / hold / discard)

| State | Persist | Default retrieval | Rules |
|---|---|---|---|
| `allow` | yes | yes | Durable, reusable facts (constraints, architecture truths, operational fixes, explicit user rules). |
| `hold` | yes | no (unless explicitly requested) | Ambiguous/contextual signal worth keeping but not auto-injecting. |
| `discard` | no | no | Noise, tool traces, instruction artifacts, ephemeral chatter. |

Rules to enforce:
- Very short/low-information observations (e.g. <12 chars) → `discard`.
- Instruction-edit artifacts/raw tool traces (`<toolCall>`, command dumps, “replace X with Y”) → `discard`.
- Facts with ADR IDs, concrete file paths, or explicit runnable commands bias toward `allow`.
- If gate annotation parsing fails, mark `write_gate_fallback=true` and track drift (high fallback rate is a health smell).

## 2) Vector store schema (Typesense only)

**Backend:** `memory_observations` in Typesense. Qdrant is retired (per slog, 2026-02-28).

Minimum operational fields:
- Identity/source: `id`, `session_id`, `source`, `timestamp`, `updated_at`
- Content: `observation`, `observation_type`, `embedding`
- Write gate: `write_verdict`, `write_confidence`, `write_reason`, `write_gate_version`, `write_gate_fallback`
- Taxonomy: `category_id`, `category_confidence`, `category_source`, `taxonomy_version`
- Ranking/lifecycle: `merged_count`, `recall_count`, `retrieval_priority`, `stale`, `stale_tagged_at`, `last_used_at`, `superseded_by`, `supersedes`

## 3) Category taxonomy (7 categories)

Use taxonomy v1 IDs:
1. `jc:preferences`
2. `jc:rules-conventions`
3. `jc:system-architecture`
4. `jc:operations`
5. `jc:memory-system`
6. `jc:projects`
7. `jc:people-relationships`

## 4) Retrieval pipeline

1. **Query rewrite** (fast model, hard timeout, fail-open to original query).
2. **Hybrid search** (keyword + vector over `memory_observations`).
3. **Time decay** ranking:
   `final_score = raw_score × exp(-0.01 × days_since_created)`
   - stale memories get extra downweight.
4. **Cap** results before injection (protect context budget).
5. **Budget profile**:
   - `lean`: 2–3 hits, no rewrite, low-latency checks
   - `balanced`: 5–7 hits, default interactive mode
   - `deep`: 10–15 hits, complex debugging/research
   - `auto`: choose profile from query complexity/context

## 5) Reflection cycle

`observe → reflect → propose → triage (3 tiers) → promote to MEMORY.md`

Triage tiers:
- **Tier 1 auto-action:** auto-promote / auto-reject / auto-merge using deterministic rules.
- **Tier 2 LLM batch review:** batch adjudication for undecided proposals.
- **Tier 3 human review:** only ambiguous/risky proposals; then promote/edit/reject.

Goal: keep `MEMORY.md` small, durable, and high-signal.

## 6) Nightly maintenance

Run idempotent maintenance to keep recall quality high:
1. **Dedup sweep** (semantic similarity merge; maintain supersession chain).
2. **Stale pruning** (mark old never-recalled observations stale; prune very old stale records conservatively).
3. **Stats emission** (observation count, merges, stale volume, category distribution).

## 7) ADR map (read before changing architecture)

- **ADR-0021** — memory system foundation.
- **ADR-0068** — auto-triage pipeline.
- **ADR-0077** — next phase (reflection + maintenance).
- **ADR-0082** — Typesense as memory backend (Qdrant replaced).
- **ADR-0094 → ADR-0100** — proposed evolution (write gate governance, taxonomy/budgets, forward triggers, graph/dual-search roadmap).

## 8) Operations commands (slog + recall)

```bash
# Record memory-system changes
slog write --action configure --tool memory-system --detail "<what changed>" --reason "<why>"

# Inspect recent operational history
slog tail --count 50

# Default recall
joelclaw recall "<query>" --budget balanced --limit 7

# Deep recall for hard debugging
joelclaw recall "<query>" --budget deep --limit 10

# Inspect memory-system category specifically
joelclaw recall "<query>" --category jc:memory-system --limit 10

# Include held memories when needed
joelclaw recall "<query>" --include-hold --raw
```

## 9) Canonical code paths

- Observe: `packages/system-bus/src/inngest/functions/observe.ts`
- Write gate: `packages/system-bus/src/memory/write-gate.ts`
- Taxonomy: `packages/system-bus/src/memory/taxonomy-v1.ts`
- Recall adapter: `packages/cli/src/capabilities/adapters/typesense-recall.ts`
- Reflect/propose: `packages/system-bus/src/inngest/functions/reflect.ts`, `promote.ts`
- Nightly maintenance: `packages/system-bus/src/inngest/functions/memory/nightly-maintenance.ts`

## 10) Non-negotiables

- Memory stores **patterns**, not transcript noise.
- No silent failure paths: emit telemetry on every transition.
- Keep retrieval bounded; never flood context windows.
- Keep `MEMORY.md` curated; do not auto-append raw observations.
