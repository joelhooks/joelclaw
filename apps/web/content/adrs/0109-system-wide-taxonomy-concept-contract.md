---
type: adr
status: proposed
date: 2026-02-22
tags: [adr, taxonomy, concepts, skos, graph, typesense, memory, docs]
deciders: [joel]
consulted: [pi session 2026-02-22, codex session 2026-02-22]
supersedes: []
superseded-by: []
related:
  - "0024-taxonomy-enhanced-session-search"
  - "0095-typesense-native-memory-categories-skos-lite"
  - "0099-memory-knowledge-graph-substrate"
  - "0100-memory-dual-search-activation"
  - "0105-joelclaw-pdf-brain-typesense"
  - "0082-typesense-unified-search"
---

# ADR-0109: System-Wide Taxonomy + Concept Contract (No Tag Soup)

## Status

proposed

## Context

Taxonomy exists in multiple places today, but not as one system contract:

- memory has SKOS-lite category IDs (ADR-0095),
- docs migration currently routes by coarse folder categories (ADR-0105 Phase 0),
- free-form tags still exist in several surfaces,
- graph work is deferred (ADR-0099, ADR-0100) and needs stable concept IDs first.

Legacy `pdf-brain` data proves the risk of ungoverned growth:

- `concepts`: 1643
- `concept_hierarchy` edges: 24
- most concepts are leaf-like and weakly connected
- `document_concepts` mostly came from backfill heuristics, not curated ontology decisions

This is useful evidence and alias material, but not a canonical taxonomy source.

Without one shared concept contract, we get tag soup:

- drift between domains (`memory`, `docs`, `projects`, `people`, `events`),
- brittle recall/routing behavior,
- weak cross-domain graph mesh.

## Decision

Adopt a **single system-wide concept taxonomy contract** across joelclaw.

1. Concepts are first-class and versioned.
2. Every major entity and event carries concept IDs.
3. Free-form tags are secondary metadata and must map to concepts before they affect retrieval/routing.
4. Graph relations and dual-search build on concept IDs, not raw tags.

## Canonical Taxonomy Surfaces

Canonical source lives in the monorepo and is mirrored to read-only consumers:

- `packages/system-bus/src/taxonomy/core-v1.*`
- `packages/system-bus/src/taxonomy/aliases-v1.*`
- `packages/system-bus/src/taxonomy/mappings-v1.*`

Mirror targets:

- CLI/runtime modules in `packages/cli` and `apps/web`
- Vault documentation snapshots (optional, generated)

Legacy sources (including `~/Documents/.pdf-library/library.db`) feed candidate aliases and proposals only.

## Concept Contract

### Concept record

- `id` (immutable concept ID)
- `prefLabel`
- `altLabels[]`
- `broader[]` / `narrower[]` / `related[]`
- `scopeNote`
- `taxonomy_version`
- `state` (`canonical|candidate|deprecated`)

### Entity fields (minimum)

- `primary_concept_id` (optional)
- `concept_ids[]`
- `concept_source` (`rules|llm|backfill|manual`)
- `taxonomy_version`

### Event metadata (minimum)

- `concept_ids[]`
- `primary_concept_id` (optional)
- `taxonomy_version`

### Retrieval evidence metadata (required for docs/memory text units)

For any retrievable evidence unit (memory observation, transcript chunk, docs chunk):

- `context_prefix` (short structural context used for retrieval text)
- `source_entity_id` (document/session/source id)
- `evidence_tier` (`snippet|section|summary|observation`)
- `parent_evidence_id` (required for snippet-tier units)

This keeps retrieval explainable and lets systems expand from precise hits to fuller context deterministically.

## Anti-Tag-Soup Guardrails

1. No unbounded auto-creation of canonical concepts in hot ingest paths.
2. New concepts enter as `candidate` first, with dedupe + review.
3. Retrieval/routing features read concept IDs, not raw tags.
4. Concept growth is measured and capped by policy until governance matures.
5. Every alias must resolve to exactly one canonical concept per taxonomy version.

## Rollout Plan

### Phase 0: Contract + Freeze

- Publish canonical concept schema and alias schema.
- Freeze direct canonical writes from auto-taggers.
- Import curated base from `pdf-brain/data/taxonomy.json`.
- Build alias table from legacy `library.db` leaves and current memory/doc categories.

### Phase 1: Docs + Memory Alignment

- ADR-0105 docs ingest writes concept fields (`primary_concept_id`, `concept_ids[]`, version/source).
- ADR-0095 memory writes align to shared concept contract and aliases.
- Docs ingest emits hierarchical evidence (`section` + `snippet`) with concept propagation and parent links.
- Keep storage routing separate from semantic taxonomy (filesystem categories are operational, not ontology).

### Phase 2: Cross-Domain Coverage

Add concept IDs to:

- memory observations and summaries
- docs records and chunk records
- docs distillates (narrative + retained facts linked back to evidence chunk ids)
- system log events
- discovery records
- people dossiers
- project/task records where applicable

### Phase 3: Graph Substrate Activation

Use shared concept IDs to activate ADR-0099 relation substrate:

- relation extraction
- relation health checks
- conflict/drift controls

### Phase 4: Dual Search Activation

Activate ADR-0100 only after measurable gains from concept-grounded graph retrieval.

## Implementation Backlog

### `packages/system-bus`

- Create taxonomy core modules:
  - `src/taxonomy/core-v1.ts` (canonical concepts)
  - `src/taxonomy/aliases-v1.ts` (alias map)
  - `src/taxonomy/mappings-v1.ts` (domain/category mappings)
- Add shared resolver helpers:
  - `src/taxonomy/resolve.ts` (`label/tag -> concept_id`)
  - `src/taxonomy/validate.ts` (alias uniqueness + version checks)
- Wire docs ingest/enrich:
  - update ADR-0105 paths to persist `primary_concept_id`, `concept_ids[]`, `concept_source`, `taxonomy_version`.
  - ensure hierarchical docs chunk records (`snippet|section`) include `evidence_tier`, `parent_evidence_id`, `context_prefix`.
- Wire memory ingest:
  - align ADR-0095 flow to use shared resolver; reject or flag unmapped labels.
- Emit OTEL taxonomy diagnostics on write paths:
  - mapped count, unmapped count, alias hit rate, taxonomy version.

### `packages/cli`

- Add concept-aware query filters for:
  - `joelclaw recall`
  - `joelclaw docs search`
- Add taxonomy diagnostics commands (or subcommands under existing surfaces):
  - coverage by domain
  - unmapped tag report
  - alias collision report
- Ensure command outputs follow ADR-0093 navigation contract with next actions.
- Add retrieval context expansion surfaces shared by docs/memory:
  - deterministic expansion modes (`snippet-window`, `parent-section`, `section-neighborhood` for docs analogs)
  - per-response evidence attribution (`source`, `evidence_tier`, `chunk_id`/`observation_id`)

### `apps/web`

- Add concept facet filters to memory/docs system views.
- Show canonical concept labels (not raw tags) in detail panels.
- Add taxonomy version visibility in owner/system views for debugging drift.

### `Vault/docs` + governance

- Keep ADR links synchronized (`0095`, `0099`, `0100`, `0105`, `0109`).
- Add a recurring taxonomy governance review note template:
  - new candidates
  - alias conflicts
  - deprecated concepts
  - cross-domain drift summary.

### Legacy migration tasks

- Import seed concepts from `pdf-brain/data/taxonomy.json`.
- Build candidate alias set from legacy `~/Documents/.pdf-library/library.db` concept leaves.
- Do not auto-promote legacy candidates to canonical without review.

## Phase Exit Criteria

### Phase 0 exit

- Shared taxonomy modules exist and are imported by memory/docs write paths.
- Canonical auto-create is disabled in hot ingest routes.
- Seed taxonomy is loaded and versioned.

### Phase 1 exit

- New docs + memory writes include concept fields and taxonomy version.
- Resolver coverage for docs + memory is >=95%.
- Unmapped writes are observable and queryable in OTEL.
- Docs chunk entities preserve parent links and expose deterministic expansion behavior.

### Phase 2 exit

- Concept fields are present in at least 4 domains (memory, docs, system events, one of people/projects/discovery).
- Cross-domain recall/query by `concept_id` returns mixed-source hits.

### Phase 3 exit

- ADR-0099 activation gates pass with shared concept IDs.
- Relation extraction pilot runs with health metrics and drift/conflict reporting.

### Phase 4 exit

- ADR-0100 benchmark gate passes (>=10% retrieval quality lift on hard queries).
- Dual search fallback to vector-only is deterministic and telemetry-backed.

## Acceptance Criteria

- [ ] `concept_ids[]` coverage >= 95% for new memory + docs records.
- [ ] Unmapped tags in write paths <= 2% (weekly).
- [ ] Concept IDs are queryable across at least 4 domains.
- [ ] Cross-domain recall can pivot by concept ID and return mixed-source hits.
- [ ] Concept growth rate and alias drift are observable in OTEL/health output.
- [ ] Docs/memory retrieval responses include evidence attribution and expansion path metadata.

## Verification Commands

- `joelclaw otel search "taxonomy_version|concept_ids|primary_concept_id" --hours 24`
- `joelclaw otel search "evidence_tier|parent_evidence_id|context_prefix" --hours 24`
- `joelclaw otel stats --hours 24`
- `joelclaw recall "<query>" --json`
- `joelclaw docs search "<query>" --json`
- `joelclaw inngest memory-health --hours 24 --json`

## Non-Goals

- Adopting a dedicated graph database now.
- Replacing all legacy tags in one migration step.
- Perfect ontology design before shipping iterative improvements.

## Consequences

### Positive

- Shared semantics across memory, docs, and future graph retrieval.
- Less drift and better cross-domain recall precision.
- Clear path from taxonomy to graph mesh without tag explosion.

### Negative / Risks

- Governance overhead (proposal review, alias curation, deprecation policy).
- Upfront migration cost to normalize legacy tags and categories.

## References

- ADR-0024: Taxonomy-Enhanced Session Search (historical strategy)
- ADR-0095: Typesense-Native Memory Categories
- ADR-0099: Memory Knowledge-Graph Substrate
- ADR-0100: Memory Dual Search Activation Plan
- ADR-0105: Joelclaw PDF Brain
