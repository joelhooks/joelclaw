# ADR-0164: Mandatory Taxonomy Classification

- **Status**: proposed
- **Date**: 2026-02-28
- **Relates to**: ADR-0163 (Adaptive Prompt Architecture), ADR-0084 (Unified Content Resource Schema)

## Context

joelclaw has a SKOS taxonomy (`joelclaw:scheme:workload:v1`) with 9 top-level concepts (PLATFORM, INTEGRATION, TOOLING, PIPELINE, BUILD, KNOWLEDGE, COMMS, OBSERVE, META) and the `skos-taxonomy` skill defines the full classification contract. But taxonomy is only useful if it's applied consistently — every write path that touches persistent state must classify its output.

Today, classification is optional. Sub-agents write to Typesense, Redis, Convex, slog, memory, and vault without taxonomy metadata. This makes retrieval inconsistent and the taxonomy decorative rather than structural.

## Decision

**Every system write path emits taxonomy metadata. No exceptions.**

### Enforcement Tiers

**Tier 1: System Prompt Lite Contract (all agents)**

Every agent — gateway, terminal, sub-agents, classifiers, synthesizers, coders — gets this baked into their base system prompt:

```
## Taxonomy Contract

All persistent writes must include classification metadata:
- primary_concept_id: single joelclaw:concept:* URI
- concept_ids: ordered list (primary first, then secondary)
- taxonomy_version: "workload-v1"

The 9 domains: PLATFORM (infra/k8s/deploy), INTEGRATION (APIs/webhooks/channels),
TOOLING (CLI/skills/extensions), PIPELINE (Inngest/event flows), BUILD (code/tests/CI),
KNOWLEDGE (docs/memory/taxonomy), COMMS (messaging/notifications), OBSERVE (telemetry/logs),
META (ADRs/governance/process).

When unsure, classify with best guess + confidence < 0.5. Never omit classification.
```

This is ~500 tokens. It goes in the base system prompt at BEDROCK stability tier — updated weekly if the taxonomy evolves.

**Tier 2: Full SKOS Skill (taxonomy-focused work)**

The complete `skos-taxonomy` skill (360 lines) is loaded on-demand when the task involves:
- Designing or revising the taxonomy itself
- Debugging classification failures
- Adding new concepts or subconcepts
- Cross-scheme mapping
- Typesense collection schema changes
- Governance and candidate concept lifecycle

This is WEATHER tier — loaded per-turn when matched.

**Tier 3: Write-Path Validation (infrastructure)**

Typesense indexing functions, slog, memory pipeline, and Convex mutations validate taxonomy fields at write time:
- Reject writes missing `primary_concept_id` (hard fail or fallback to `joelclaw:concept:meta:unclassified`)
- Warn on unknown concept URIs (not in the canonical scheme)
- Track classification coverage metrics via OTEL

### Write Paths That Must Classify

| Write Path | Current State | Action |
|---|---|---|
| slog entries | No taxonomy | Add `concept_ids` field |
| Memory observations | No taxonomy | Add to Typesense document |
| Memory proposals | No taxonomy | Classify during triage |
| Typesense documents (all collections) | Some have tags | Migrate to `concept_ids` field |
| Convex mutations | No taxonomy | Add to schema |
| Vault notes (ADRs, contacts, discoveries) | Frontmatter tags | Map tags → concept URIs |
| Inngest event payloads | No taxonomy | Add to event data envelope |
| OTEL spans | No taxonomy | Add as span attributes |

### Gardening Process

The taxonomy is a living system. The evolution engine (ADR-0163) includes taxonomy gardening:

1. **Monitor unmapped labels** — when agents can't classify, log the candidate label
2. **Candidate review** — weekly, review accumulated candidates for promotion to concepts
3. **Alias drift** — detect when altLabels start meaning something different
4. **Coverage metrics** — track % of writes with valid classification
5. **Subconcept growth** — promote frequently-used narrower concepts from ad-hoc to canonical

### Anti-Patterns

- ❌ Skipping classification because "it's just a quick write"
- ❌ Inventing concept URIs not in the canonical scheme (use `meta:unclassified` + log)
- ❌ Treating taxonomy as optional metadata vs structural contract
- ❌ Letting the taxonomy grow unchecked without gardening
- ❌ Duplicating taxonomy logic — one canonical source, lite versions reference it

## Consequences

- Every persistent artifact becomes queryable by workload domain
- Retrieval quality improves as classification coverage increases
- Sub-agents inherit taxonomy awareness through the base prompt
- Gardening load: ~15 minutes/week for candidate review
- Migration work: 8 write paths need taxonomy fields added
- Token cost: ~500 tokens per agent session for the lite contract
