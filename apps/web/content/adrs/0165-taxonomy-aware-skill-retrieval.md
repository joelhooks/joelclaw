# ADR-0165: Taxonomy-Aware Skill Retrieval

**Status**: proposed
**Date**: 2026-02-28
**Relates to**: ADR-0163 (Adaptive Prompt Architecture), ADR-0164 (Mandatory Taxonomy Classification)

## Context

Pi's built-in skill system dumps all 55+ skills into every system prompt as an `<available_skills>` XML block. Each skill entry includes name, description, and file path. The model reads the descriptions and decides which to load via the `read` tool.

Problems with this approach at joelclaw's scale:

1. **Token waste**: 55 skill descriptions × ~100 tokens each = ~5,500 tokens in every prompt, regardless of relevance. Most turns use 0-2 skills.
2. **Relevance dilution**: The model must scan all 55 descriptions to find the right one. False matches increase with skill count.
3. **No semantic awareness**: Pi matches skills by description substring. It can't reason about workload categories, related skills, or skill chains.
4. **Static injection**: Skills are loaded at session start and don't adapt to conversation context. A k8s debugging session still sees all 55 skills in every turn.
5. **No skill metadata**: No way to express skill relationships (broader/narrower), version, author, quality score, or usage frequency.

## Decision

Replace pi's static skill injection with a Typesense-backed skill retrieval system that uses SKOS taxonomy classification to find relevant skills per-turn.

### Architecture

```
Turn arrives
    ↓
Workload classifier (lightweight, inline)
    → primary_concept_id: "joelclaw:concept:platform:k8s"
    → concept_ids: ["joelclaw:concept:platform", "joelclaw:concept:tooling:cli"]
    ↓
Typesense query: `agent_skills` collection
    → filter: concept_ids IN taxonomy match
    → semantic: embed(user_message) → vector search
    → hybrid: combine taxonomy filter + vector similarity
    ↓
Top 3-5 skills returned with scores
    ↓
Inject into prompt as focused <relevant_skills> block
    → Only the matched skills, not all 55
    → Include relevance reason for model transparency
```

### Typesense `agent_skills` Collection Schema

```json
{
  "name": "agent_skills",
  "fields": [
    {"name": "skill_name", "type": "string", "facet": true},
    {"name": "description", "type": "string"},
    {"name": "content", "type": "string"},
    {"name": "file_path", "type": "string"},
    {"name": "primary_concept_id", "type": "string", "facet": true},
    {"name": "concept_ids", "type": "string[]", "facet": true},
    {"name": "taxonomy_version", "type": "string"},
    {"name": "trigger_patterns", "type": "string[]"},
    {"name": "usage_count", "type": "int32", "optional": true},
    {"name": "last_used", "type": "int64", "optional": true},
    {"name": "quality_score", "type": "float", "optional": true},
    {"name": "embedding", "type": "float[]", "embed": {
      "from": ["description", "trigger_patterns"],
      "model_config": {"model_name": "ts/e5-small"}
    }}
  ],
  "default_sorting_field": "usage_count"
}
```

### Retrieval Strategy

Three-signal retrieval per turn:

1. **Taxonomy match** (fast, high precision): Filter skills by SKOS concept overlap with classified workload. Broader concepts match narrower skills (k8s work matches both `k8s` skill and `sync-system-bus` skill).

2. **Semantic search** (recall): Vector similarity between user message embedding and skill description+triggers embedding. Catches intent that doesn't map cleanly to taxonomy.

3. **Usage recency** (tiebreaker): Recently-used skills in this session get a boost. Prevents thrashing between skills mid-task.

Score: `0.5 * taxonomy_score + 0.3 * semantic_score + 0.2 * recency_score`

### Prompt Injection Format

Replace `<available_skills>` with:

```xml
```xml
<relevant_skills turn_context="k8s pod debugging" confidence="0.87">
  `<skill name="k8s" relevance="0.94" reason="Primary workload match: PLATFORM/k8s">`
    <location>/Users/joel/.pi/agent/skills/k8s/SKILL.md</location>
  </skill>
  `<skill name="sync-system-bus" relevance="0.72" reason="Related: system-bus deploys to k8s">`
    <location>/Users/joel/.pi/agent/skills/sync-system-bus/SKILL.md</location>
  </skill>
</relevant_skills>
```
```

### Integration with Pi

Pi's `SYSTEM.md` (custom prompt branch) bypasses the built-in `formatSkillsForPrompt`. joelclaw's custom `SYSTEM.md` does not include the `<available_skills>` block. Instead:

1. A `before_agent_start` extension hook classifies the turn and queries Typesense.
2. The extension injects the `<relevant_skills>` block into the system prompt for that turn.
3. The `read` tool still loads full skill content — retrieval only selects which skills to surface.

### Skill Indexing Pipeline

```
skills/*/SKILL.md (filesystem, canonical)
    ↓
Index script: read each SKILL.md
    → Parse frontmatter + description
    → Classify with SKOS taxonomy (ADR-0164)
    → Extract trigger patterns from description
    → Upsert to Typesense `agent_skills` collection
    ↓
Daily refresh via Inngest cron
    → Re-index changed skills (git diff)
    → Update usage_count from session telemetry
    → Flag skills with zero usage in 30 days for review
```

### Fallback

If Typesense is unreachable, fall back to pi's default behavior: inject all skills via `<available_skills>`. Degraded but functional.

## Phases

### Phase 1: Index + Query (no prompt changes yet)
- Create `agent_skills` Typesense collection
- Build indexing script for all 55 skills with SKOS classification
- Build query function with three-signal scoring
- Verify retrieval quality against 20 representative queries

### Phase 2: Pi Extension
- Build `skill-retrieval` pi extension
- Hook into `before_agent_start` for per-turn skill injection
- Implement `<relevant_skills>` prompt format
- A/B test: full skill list vs top-5 retrieval (measure token savings + skill hit rate)

### Phase 3: Feedback Loop
- Track which skills are actually loaded (via `read` tool calls on skill files)
- Update `usage_count` and `quality_score` from telemetry
- Surface unused/stale skills in weekly review
- Auto-suggest new trigger patterns from successful retrievals

## Consequences

### Positive
- ~5,000 token savings per turn (55 skills → 3-5 relevant)
- Better skill matching through semantic + taxonomy signals
- Skill metadata enables quality tracking and lifecycle management
- Scales to 100+ skills without prompt bloat
- Foundation for cross-project skill sharing (gremlin reuses joelclaw skills)

### Negative
- Typesense dependency for skill discovery (mitigated by fallback)
- Classification quality depends on SKOS taxonomy accuracy
- Latency: ~50ms Typesense query per turn (acceptable)
- Requires pi extension development (new code surface)

### Neutral
- Skill authoring unchanged (still `skills/*/SKILL.md`)
- `read` tool loading unchanged (still reads full file)
- Skills directory remains canonical git-tracked source
