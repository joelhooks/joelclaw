---
title: Taxonomy-enhanced session search with SKOS concept layer
status: superseded
date: 2026-02-16
deciders: Joel Hooks
consulted: Claude (pi session 2026-02-16)
informed: All agents operating on this machine
related:
  - "[ADR-0021 — Agent memory system](0021-agent-memory-system.md)"
  - "[ADR-0002 — Personal assistant system architecture](0002-personal-assistant-system-architecture.md)"
  - "[ADR-0019 — Event naming past tense](0019-event-naming-past-tense.md)"
  - "[ADR-0109 — System-wide taxonomy + concept contract](0109-system-wide-taxonomy-concept-contract.md)"
credits:
  - "W3C SKOS (Simple Knowledge Organization System) — concept schemes, broader/narrower hierarchies, preferred/alternate labels, cross-scheme mapping. W3C Recommendation 2009. https://www.w3.org/2004/02/skos/"
  - "Squirro (2026 RAG report) — GraphRAG pattern: structured taxonomy + vector search achieving 99% precision for enterprise knowledge bases"
  - "FloTorch (Feb 2026 benchmark) — recursive 512-token chunking outperforms semantic/proposition methods; re-ranking is the largest accuracy improvement lever"
  - "Anthropic contextual retrieval (2024) — adding context prefix to chunks improves retrieval by 2-18% over baseline"
  - "Sanity/Nuum — Reflect tool pattern, segment-aware extraction, temporal memory tier (ADR-0021)"
  - "Heather Hedden — The Accidental Taxonomist, 2nd Ed. SKOS specification details, controlled vocabulary design, faceted taxonomies for retrieval, auto-tagging patterns. (pdf-brain library)"
  - "Mem0 team (arXiv 2504.19413) — Mem0g dual memory architecture: text + graph memory, entity-relation triple extraction, conflict detection for temporal reasoning, temporal event graph. (pdf-brain library)"
  - "Xu et al. — A-MEM: Agentic Memory for LLM Agents. Zettelkasten-inspired self-evolving memory with dynamic linking and contextual descriptions — validates taxonomy growth pattern. (pdf-brain library)"
  - "Zep/Graphiti — Temporal Knowledge Graph Architecture for Agent Memory. Deep Memory Retrieval: 98.2% recall with graph-enhanced memory vs 35.3% for recursive summarization. (pdf-brain library)"
  - "Joonghyuk Hahn et al. — Generative Agents: Interactive Simulacra of Human Behavior. Memory stream with recency/importance/relevance scoring for retrieval. (pdf-brain library)"
  - "Darren Edge et al. — Graph RAG: From Local to Global. Community detection + summarization outperforms vector RAG for global sensemaking. (pdf-brain library)"
  - "Chip Huyen — AI Engineering (O'Reilly 2024). Chunking strategies, contextual retrieval, re-ranking patterns. (pdf-brain library)"
  - "Jesus Barrasa et al. — Building Knowledge Graphs: A Practitioner's Guide. 'KGs are the strongest foundation for semantic search' — entity extraction, disambiguation, KG-enhanced retrieval. (pdf-brain library)"
  - "Louis Rosenfeld et al. — Information Architecture for the Web and Beyond. Controlled vocabularies as 'glue that holds systems together', faceted search, findability. (pdf-brain library)"
---

# ADR-0024: Taxonomy-Enhanced Session Search with SKOS Concept Layer

## Update (2026-02-22)

This ADR remains **deferred** and historically important, but it is Qdrant-era design.

Current execution path:

- ADR-0095 carries the memory SKOS-lite implementation on Typesense.
- ADR-0105 carries docs taxonomy integration.
- ADR-0109 now defines the system-wide concept contract so taxonomy meshes across the whole joelclaw graph.

## Context and Problem Statement

590 agent sessions were generated in 48 hours (37 Pi, 381 Claude Code, 172 Codex). These contain every decision, debugging insight, architecture discussion, and configuration change that happened on this system. They are completely unsearchable.

ADR-0021 specifies a `memory_observations` collection for **extracted observations** — LLM-processed, structured, ~50 bullets per session. But observations are lossy by design. When the Reflect tool (ADR-0021 Phase 5) needs to answer "how did we fix the worker crash?" or "what did Joel say about Redis TTLs?", it needs the raw transcript context, not just a distilled bullet.

Beyond searchability, a deeper problem exists: **the same concepts have different names across every data source**.

| Concept | Slog | Vault | Codebase | Sessions |
|---------|------|-------|----------|----------|
| System bus worker | `tool: system-bus-worker` | `Projects/07-event-bus/` | `packages/system-bus/` | "the worker crashed" |
| Video pipeline | `tool: video-ingest` | `Projects/06-video-ingest/` | `src/inngest/video/` | "ingest this video" |
| joelclaw | `tool: joelclaw` | `Projects/09-joelclaw/` | `~/Code/joelhooks/joelclaw/` | "the monorepo" |
| Memory | `tool: memory` | `Projects/08-memory-system/` | (not yet implemented) | "memory system", "recall", "Qdrant" |

Vector similarity alone cannot bridge these gaps reliably. A query for "infrastructure" won't find chunks about Qdrant, Redis, Inngest, or Docker unless those chunks literally contain the word "infrastructure."

### What the research says (Feb 2026)

1. **FloTorch benchmark (Feb 2026)**: Recursive 512-token chunking outperformed semantic and proposition-based methods on equal context budgets. Simpler chunking + re-ranking is the dominant strategy. Proposition-based chunking (LLM decomposition into atomic facts) ranked among the worst — smaller fragments dilute accuracy.

2. **GraphRAG / taxonomy-enhanced search (Squirro 2026)**: Combining vector search with structured taxonomies achieves up to 99% precision. The prerequisite is a carefully curated taxonomy. This is the single largest precision lever beyond basic chunking.

3. **Contextual chunking (Anthropic)**: Adding a short context prefix to each chunk before embedding (e.g., "[SESSION: pi, debugging worker crash, 2026-02-15]") improves retrieval 2-18% over baseline.

4. **Re-ranking (FloTorch)**: Cross-encoder re-ranking after initial retrieval boosts precision 18-42%. This is larger than any chunking improvement.

5. **Hybrid retrieval (BM25 + dense)**: 20-40% higher recall than dense search alone, especially for exact terminology, acronyms, and domain jargon.

**Synthesis**: Simple chunking + rich metadata taxonomy + re-ranking >>> complex chunking alone.

### Storage projections

| Timeframe | Sessions | Raw size | Chunks (est.) | Vector storage |
|-----------|----------|----------|---------------|----------------|
| Current (2 days) | 590 | 137 MB | ~34k | ~100 MB |
| 1 month | ~9,000 | ~2.1 GB | ~500k | ~1.5 GB |
| 6 months (with TTL) | ~30,000 | ~5 GB | ~1.2M | ~4 GB |

With source-based TTL (Codex sessions expire after 30 days), 6-month projection drops from ~9 GB to ~4 GB. Manageable on local SSD.

## Decision

Add two new Qdrant collections — `session_transcripts` and `taxonomy_concepts` — that work together with the existing `memory_observations` (ADR-0021) to provide taxonomy-enhanced semantic search across all system data.

The SKOS taxonomy layer lives in two places:
1. **Qdrant `taxonomy_concepts` collection** — full machine-queryable concept graph with vectors, SKOS relationships, and cross-system mappings
2. **Vault `Resources/taxonomy/` notes** — human-curated concept notes for major categories, browsable in Obsidian with wikilinks

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Qdrant Collections                                              │
│                                                                  │
│  taxonomy_concepts         session_transcripts                   │
│  ├─ vector: 768-dim        ├─ vector: 768-dim                   │
│  ├─ prefLabel              ├─ text (chunk content)               │
│  ├─ altLabels[]            ├─ concept_ids[]  ←── taxonomy link   │
│  ├─ broader[]              ├─ source (pi|claude|codex)           │
│  ├─ narrower[]             ├─ sessionId                          │
│  ├─ related[]              ├─ timestamp_start / timestamp_end    │
│  ├─ exactMatch{}           ├─ turn_roles[] (user|assistant|tool) │
│  ├─ closeMatch{}           ├─ files_read[]                       │
│  ├─ scopeNote              ├─ files_modified[]                   │
│  ├─ definition             ├─ vault_notes[]                      │
│  ├─ conceptScheme          ├─ slog_tool_refs[]                   │
│  └─ vault_note_path        ├─ codebase_paths[]                   │
│                            ├─ adr_refs[]                         │
│  memory_observations       ├─ chunk_index                        │
│  (ADR-0021, enriched)      ├─ total_chunks                       │
│  ├─ concept_ids[]  ←─┐     ├─ context_prefix                    │
│  └─ (existing schema)│     └─ ttl_expires_at (codex only)        │
│                      │                                           │
│                      └──── shared concept_ids enable cross-query │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  Vault (human layer)                                             │
│                                                                  │
│  Resources/taxonomy/                                             │
│  ├─ _index.md              (concept scheme overview)             │
│  ├─ agent-infrastructure.md                                      │
│  │   frontmatter: { prefLabel, altLabels, narrower, related }    │
│  │   body: scope note, definition, links to projects             │
│  ├─ memory-system.md                                             │
│  ├─ video-pipeline.md                                            │
│  ├─ joelclaw.md                                                  │
│  └─ ...                                                          │
│                                                                  │
│  Wikilinks = broader/narrower/related graph                      │
│  Frontmatter = machine-readable SKOS fields                      │
│  Sync: Vault notes → Qdrant taxonomy_concepts (Inngest function) │
└──────────────────────────────────────────────────────────────────┘
```

### Query Flow

```
User/Agent query: "how did we fix the worker crash?"
│
├─ 1. Embed query (nomic-embed-text-v1.5, 768-dim)
│
├─ 2. Taxonomy expansion
│     ├─ Search taxonomy_concepts by vector similarity
│     │   → finds: jc:system-bus-worker (score 0.82)
│     ├─ Traverse broader[]: jc:agent-infrastructure
│     ├─ Traverse related[]: jc:inngest, jc:launchd, jc:docker
│     ├─ Collect altLabels: ["worker", "event bus", "system-bus"]
│     └─ Build expanded concept set: [jc:system-bus-worker, jc:inngest, ...]
│
├─ 3. Hybrid retrieval
│     ├─ Dense: vector similarity on session_transcripts + memory_observations
│     ├─ Sparse: BM25 on altLabels + query terms (future: Qdrant sparse vectors)
│     ├─ Filter: concept_ids overlap with expanded concept set (payload filter)
│     └─ Combine via Reciprocal Rank Fusion (RRF)
│
├─ 4. Re-rank top-k results
│     ├─ Cross-encoder or LLM-based re-ranking
│     └─ Score by: relevance + recency + source priority
│
└─ 5. Return ranked chunks with concept context
      ├─ Each result includes: text, source, timestamp, concept_ids, files
      └─ Reflect tool synthesizes answer from top chunks
```

### SKOS Concept Schema

Each concept in `taxonomy_concepts`:

```typescript
interface TaxonomyConcept {
  // Identity
  id: string;                    // e.g., "jc:system-bus-worker"
  prefLabel: string;             // "system-bus worker"
  altLabels: string[];           // ["worker", "event bus worker", "system-bus"]
  hiddenLabels: string[];        // typos, abbreviations: ["sb-worker", "sysbus"]
  
  // Hierarchy (SKOS semantic relations)
  broader: string[];             // ["jc:agent-infrastructure"]
  narrower: string[];            // ["jc:inngest-functions", "jc:launchd-plist"]
  related: string[];             // ["jc:inngest", "jc:docker", "jc:bun"]
  
  // Cross-system mappings (SKOS mapping properties)
  exactMatch: {
    slog_tool?: string;          // "system-bus-worker"
    vault_project?: string;      // "Projects/07-event-bus/"
    codebase_path?: string;      // "packages/system-bus/"
    skill?: string;              // "inngest"
  };
  closeMatch: {
    vault_notes?: string[];      // related Vault notes
    adr_refs?: string[];         // ["ADR-0021", "ADR-0022"]
  };
  
  // Documentation (SKOS documentation properties)
  scopeNote: string;             // brief description of concept scope
  definition?: string;           // formal definition
  
  // Metadata
  conceptScheme: string;         // "jc:system" | "jc:tools" | "jc:projects"
  vault_note_path?: string;      // "Resources/taxonomy/system-bus-worker.md"
  created: string;               // ISO 8601
  modified: string;              // ISO 8601
  source: "mined" | "curated";  // how the concept was created
}
```

**Concept schemes** (top-level groupings):
- `jc:system` — infrastructure, services, deployment (Qdrant, Redis, Inngest, Docker, launchd, Caddy, Tailscale)
- `jc:tools` — CLI tools, skills, extensions (pi, claude, codex, slog, igs, yt-dlp, ffmpeg)
- `jc:projects` — active projects, features, pipelines (joelclaw, video-ingest, memory-system)
- `jc:patterns` — architectural patterns, decisions (ADRs, PARA, SKOS, event-driven, durable execution)
- `jc:people` — people and organizations referenced (Joel, Alex Hillman, John Lindquist, Anthropic, Sanity)

### Chunking Strategy

Based on FloTorch 2026 findings, we use **adaptive recursive chunking** — simple splitting that respects the natural structure of session transcripts, enhanced with contextual metadata.

#### Session transcript structure

Sessions are JSONL files with entries like:
```json
{"type":"user","message":"fix the worker crash","timestamp":"2026-02-15T10:30:00Z"}
{"type":"assistant","message":"Let me check the logs...","timestamp":"2026-02-15T10:30:05Z"}
{"type":"tool_use","tool":"bash","input":"docker logs ...","timestamp":"2026-02-15T10:30:06Z"}
{"type":"tool_result","output":"Error: Cannot find module '@qdrant/js-client-rest'","timestamp":"2026-02-15T10:30:07Z"}
{"type":"assistant","message":"The worker crashed because...","timestamp":"2026-02-15T10:30:10Z"}
```

#### Chunking rules

1. **Parse JSONL** into conversation turns (user message + assistant response + any tool calls between them = 1 logical turn)
2. **Target chunk size**: 400-600 tokens (recursive character splitting within turns at paragraph/sentence boundaries)
3. **Small turns** (< 100 tokens): merge with adjacent turns up to target size
4. **Large turns** (> 600 tokens): split at paragraph boundaries, then sentence boundaries. Tool outputs over 1000 tokens are truncated to first/last 200 tokens with `[...truncated...]` marker
5. **Overlap**: 50 tokens between chunks from the same turn split (not between different turns)
6. **Compaction summaries**: treated as single high-value chunks (they're already distilled)

#### Contextual prefix

Each chunk gets a prefix before embedding (Anthropic contextual retrieval pattern):

```
[SESSION: {source} | {date} | {session_name}]
[TOPIC: {auto-detected or taxonomy concept labels}]
[FILES: {files_read + files_modified, truncated to top 5}]
```

This prefix is embedded with the chunk but stored separately in the `context_prefix` payload field so it can be excluded from the returned text.

### Metadata Extraction

At chunk ingestion time, extract from the session content:

| Metadata field | Extraction method |
|---|---|
| `files_read[]` | Parse tool_use entries for `read`, `cat`, `head` operations |
| `files_modified[]` | Parse tool_use entries for `write`, `edit`, `sed`, `tee` operations |
| `vault_notes[]` | Regex: paths matching `~/Vault/` or `Vault/` |
| `codebase_paths[]` | Regex: paths matching `~/Code/` or common project directories |
| `slog_tool_refs[]` | Match against known slog tool names |
| `adr_refs[]` | Regex: `ADR-\d{4}` |
| `concept_ids[]` | Match chunk text against taxonomy altLabels + prefLabels (exact + fuzzy) |

### TTL Strategy

Source-based TTL reflecting signal density:

| Source | TTL | Rationale |
|--------|-----|-----------|
| Pi sessions | ∞ (no expiry) | Joel's direct conversations — highest signal, decisions, preferences |
| Claude Code sessions | ∞ (no expiry) | Direct coding sessions — architecture context, debugging insights |
| Codex loop sessions | 30 days | Automated iterations — repetitive, low-signal. 52% of storage, ~10% of unique insights |

**Implementation**: Codex chunks include `ttl_expires_at` in payload. A daily Inngest cron function deletes expired points.

### Ingestion Pipeline

```
                    ┌─────────────────────────────────┐
                    │  Inngest Functions               │
                    │                                  │
  File watcher or   │  search/session.index.requested  │
  manual trigger ──→│    ① Find unindexed sessions     │
                    │    ② For each: parse JSONL        │
                    │    ③ Chunk (adaptive recursive)   │
                    │    ④ Extract metadata per chunk   │
                    │    ⑤ Tag with concept_ids         │
                    │       (match against taxonomy)    │
                    │    ⑥ Add context prefix           │
                    │    ⑦ Embed (nomic-embed-text)     │
                    │    ⑧ Upsert to Qdrant             │
                    │    ⑨ Mark session as indexed       │
                    │       (Redis: indexed:{hash})     │
                    │                                  │
  Vault change or   │  search/taxonomy.sync.requested  │
  manual trigger ──→│    ① Read Resources/taxonomy/*.md │
                    │    ② Parse frontmatter → SKOS     │
                    │    ③ Embed prefLabel + definition  │
                    │    ④ Upsert to taxonomy_concepts  │
                    │    ⑤ Re-tag affected chunks        │
                    │       (concept label changes)     │
                    │                                  │
  Daily cron ──────→│  search/session.ttl.cleanup       │
                    │    ① Find points where             │
                    │       ttl_expires_at < now         │
                    │    ② Delete expired points         │
                    │    ③ Log cleanup stats             │
                    └─────────────────────────────────┘
```

**Idempotency**: Each session is hashed (`sha256(filepath + file_mtime)`). Redis stores `indexed:{hash}` — if the hash exists, the session is skipped. If the file changes (rare), the hash changes and it gets re-indexed.

### Embedding

Per ADR-0021, use `nomic-ai/nomic-embed-text-v1.5`:
- 768 dimensions, Cosine distance
- Local execution via subprocess (no external API dependency)
- Already validated in memory system spikes (0.454 similarity for related queries vs 0.004 for unrelated)
- Matryoshka representation: can truncate to 256/512 dims for storage optimization later

### Qdrant Collection Configuration

```typescript
// session_transcripts
{
  vectors: { size: 768, distance: "Cosine" },
  optimizers_config: {
    indexing_threshold: 20000,  // delay indexing until 20k points (batch-friendly)
  },
  // Payload indexes for filtered search
  payload_indexes: [
    { field: "source", type: "keyword" },
    { field: "sessionId", type: "keyword" },
    { field: "concept_ids", type: "keyword" },  // array of concept IDs
    { field: "timestamp_start", type: "integer" },
    { field: "files_read", type: "keyword" },
    { field: "files_modified", type: "keyword" },
    { field: "ttl_expires_at", type: "integer" },
  ],
}

// taxonomy_concepts
{
  vectors: { size: 768, distance: "Cosine" },
  payload_indexes: [
    { field: "prefLabel", type: "keyword" },
    { field: "altLabels", type: "keyword" },
    { field: "conceptScheme", type: "keyword" },
    { field: "broader", type: "keyword" },
    { field: "narrower", type: "keyword" },
    { field: "related", type: "keyword" },
    { field: "exactMatch.slog_tool", type: "keyword" },
    { field: "exactMatch.vault_project", type: "keyword" },
  ],
}
```

### Vault Taxonomy Notes

Each concept note in `Resources/taxonomy/` follows this template:

```markdown
---
type: taxonomy-concept
concept_id: "jc:system-bus-worker"
prefLabel: "system-bus worker"
altLabels:
  - worker
  - event bus worker
  - system-bus
hiddenLabels:
  - sb-worker
  - sysbus
broader:
  - "[[agent-infrastructure]]"
narrower:
  - "[[inngest-functions]]"
  - "[[launchd-plist]]"
related:
  - "[[inngest]]"
  - "[[docker]]"
  - "[[bun]]"
exactMatch:
  slog_tool: system-bus-worker
  vault_project: "Projects/07-event-bus/"
  codebase_path: "packages/system-bus/"
conceptScheme: jc:system
tags:
  - taxonomy
---

# System Bus Worker

The Inngest worker process that registers and executes durable functions for the event bus. Runs as a launchd service on the Mac Mini, serving the `/api/inngest` endpoint.

## Scope

Covers the worker process itself, its start script (`start.sh`), the launchd plist (`com.joel.system-bus-worker.plist`), and the serve entrypoint (`src/serve.ts`). Does NOT cover individual Inngest functions (those have their own concepts) or the Inngest server (see [[inngest]]).

## See Also

- [[Projects/07-event-bus/index|Event Bus Project]]
- [[ADR-0022|Webhook to System Event Pipeline]]
```

### Bootstrap: Seed Taxonomy from Existing Data

The initial taxonomy is mined from structured data already in the system:

| Source | Concepts extracted | Method |
|--------|-------------------|--------|
| Slog tool names | ~30 unique tools | Direct: each tool name → concept |
| Vault Projects | 12 projects | Direct: each project → concept with broader: `jc:projects` |
| Vault Resources/tools | Tool inventory notes | Parse frontmatter |
| Skills | 18 skills | Direct: each skill → concept |
| Codebase packages | 4 packages | Direct: each → concept |
| ADRs | 23 ADRs | Each ADR topic → concept or concept refinement |
| AGENTS.md tool tables | CLI tools, Mac apps | Parse markdown tables |

**Estimated seed size**: ~80-100 concepts with hierarchy. Agents expand organically as new concepts emerge in sessions.

**Bootstrap process**: An Inngest function (`search/taxonomy.bootstrap.requested`) reads all sources, deduplicates, infers broader/narrower from Vault PARA structure and codebase nesting, generates Vault notes, and upserts to Qdrant.

## Implementation Phases

### Phase 1: Collections + Taxonomy Seed (MEM-24 through MEM-28)

- [ ] MEM-24: Create `session_transcripts` collection in Qdrant with schema above
- [ ] MEM-25: Create `taxonomy_concepts` collection in Qdrant
- [ ] MEM-26: Build taxonomy bootstrap function — mine slog, Vault, codebase, skills → seed ~80 concepts
- [ ] MEM-27: Create Vault `Resources/taxonomy/` with top ~20 concept notes (human-curated subset)
- [ ] MEM-28: Taxonomy sync function — Vault notes → Qdrant (and flag drift)

### Phase 2: Session Ingestion (MEM-29 through MEM-33)

- [ ] MEM-29: Session JSONL parser — handle Pi, Claude Code, and Codex formats
- [ ] MEM-30: Adaptive chunker — turn-based grouping, recursive splitting, context prefix
- [ ] MEM-31: Metadata extractor — files, Vault refs, codebase paths, slog tools, ADR refs
- [ ] MEM-32: Concept tagger — match chunk content against taxonomy labels
- [ ] MEM-33: Ingestion Inngest function — orchestrate parse → chunk → tag → embed → upsert

### Phase 3: Search + Query Expansion (MEM-34 through MEM-37)

- [ ] MEM-34: Taxonomy expansion — given a query, find related concepts and expand
- [ ] MEM-35: Hybrid search — dense vector + payload filter on concept_ids
- [ ] MEM-36: Re-ranking layer — cross-encoder or LLM-based re-rank of top-k
- [ ] MEM-37: Reflect tool integration — wire search into ADR-0021 Phase 5 Reflect tool

### Phase 4: Maintenance (MEM-38 through MEM-40)

- [ ] MEM-38: TTL cleanup cron — daily deletion of expired Codex session chunks
- [ ] MEM-39: Incremental indexing — watch for new sessions, index on arrival (via Inngest event)
- [ ] MEM-40: Taxonomy growth — agents propose new concepts during sessions, staged for review

## Consequences

### Positive

- **Searchable sessions**: Every conversation, debug session, and decision becomes findable
- **Cross-system linking**: Vault project ↔ slog tool ↔ codebase path ↔ session topic, connected by shared concept IDs
- **Hierarchical retrieval**: Search for "infrastructure" and get results about Qdrant, Redis, Inngest, Docker
- **Disambiguation**: "Worker" resolves to the correct concept in context
- **Human-browsable**: Vault taxonomy notes give Joel a visual map of the concept graph in Obsidian
- **Reflect tool powered**: ADR-0021 Phase 5 has a real search backend
- **Agent vocabulary**: Shared controlled vocabulary prevents terminology drift across sessions and agents

### Negative

- **Two sources of truth for taxonomy**: Qdrant (machine) and Vault (human) can drift. Mitigated by sync function, but requires discipline.
- **Taxonomy maintenance**: Concepts need curation as the system evolves. Mitigated by agent-proposed growth + human review.
- **Storage growth**: ~4 GB vectors at 6 months. Acceptable for local SSD, but worth monitoring.
- **Embedding compute**: ~34k chunks today × embedding time. Local `nomic-embed-text` is ~100 chunks/sec on M-series — initial backfill takes ~6 minutes. Incremental is negligible.
- **Complexity**: Three Qdrant collections + taxonomy sync + TTL cleanup + multiple Inngest functions. More moving parts than flat vector search.

### Neutral

- Does not replace ADR-0021's `memory_observations` — complements it. Observations are distilled intelligence; transcript chunks are raw evidence. Different retrieval patterns, connected by sessionId and concept_ids.
- Does not require changes to the session-lifecycle extension. Sessions are indexed after the fact by the ingestion pipeline.
- Taxonomy is intentionally SKOS-inspired, not SKOS-compliant. We use the conceptual framework (concepts, labels, hierarchies, mappings) without RDF, OWL, or SPARQL. If interoperability with external SKOS systems becomes needed, the JSON schema maps cleanly to RDF.

## Related Literature (pdf-brain @ internal host)

The following books and papers in the pdf-brain library directly inform this ADR. Agents can query `<internal-pdf-brain-search-endpoint>` with `{"query": "...", "limit": N}` for deep-dive content.

| Document | Pages | Key Relevance |
|---|---|---|
| The Accidental Taxonomist, 2nd Ed | 500 | SKOS spec (p.184-389), controlled vocabulary design, faceted taxonomies for retrieval (p.57, p.340), auto-tagging (p.255-283) |
| Building Knowledge Graphs: A Practitioner's Guide | 291 | KG-enhanced semantic search (p.225-247), entity extraction with NER (p.227), disambiguation |
| Knowledge Graphs: Fundamentals, Techniques and Applications | 679 | Comprehensive KG reference, graph algorithms for retrieval |
| Mem0 paper (2504.19413) | 23 | Dual memory (text + graph), Mem0g entity-relation triples, conflict detection, temporal event graph |
| A-MEM: Agentic Memory for LLM Agents | 28 | Zettelkasten-inspired self-evolving memory, dynamic linking, contextual descriptions per note |
| Temporal KG Architecture for Agent Memory | 12 | Zep/Graphiti, deep memory retrieval (98.2% recall), temporally-aware KGs |
| Generative Agents: Interactive Simulacra | 22 | Memory stream, recency/importance/relevance scoring for retrieval |
| Graph-Based RAG for Global Sensemaking | 26 | Microsoft GraphRAG, community detection + summarization, outperforms vector RAG |
| Chip Huyen: AI Engineering | 1209 | Chunking strategies (p.635), contextual retrieval (p.644), re-ranking |
| Patterns for Building AI Agents | 93 | Agent memory patterns, context engineering, tool selection |
| Principles of Building AI Agents, 2nd Ed | 149 | Working memory (p.40), Mastra agents with persistent memory |
| Information Architecture for the Web and Beyond | 603 | Controlled vocabularies (p.335-388), faceted search, synonym rings |
| MemoryBench | 51 | Memory architecture benchmarks, evaluation criteria |
| Ontology Engineering with Ontology Design Patterns | 389 | Formal ontology design (if SKOS-lite needs upgrading) |

## Verification Criteria

- [ ] `taxonomy_concepts` collection exists with ≥80 concepts, broader/narrower links, and cross-system exactMatch mappings
- [ ] `session_transcripts` collection exists with all 590 current sessions indexed
- [ ] Each transcript chunk has `concept_ids[]` payload linking to taxonomy
- [ ] Query "worker crash" retrieves relevant chunks from the Feb 15 debugging session
- [ ] Taxonomy expansion: query "memory" also retrieves chunks about Qdrant, Redis, embedding — not just literal "memory" mentions
- [ ] Codex session chunks include `ttl_expires_at` and cleanup cron deletes expired points
- [ ] Vault `Resources/taxonomy/` contains ≥20 curated concept notes with SKOS frontmatter
- [ ] Taxonomy sync function keeps Vault notes ↔ Qdrant concepts consistent
