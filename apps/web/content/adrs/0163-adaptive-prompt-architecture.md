# ADR-0163: Adaptive Prompt Architecture

**Status**: proposed  
**Date**: 2026-02-28  
**Supersedes**: Extends 0140 (inference router), 0147 (named agent profiles)  
**Related**: 0144 (gateway hex arch), 0152 (dream process), 0131 (channel intelligence)

## Context

joelclaw runs one **Conductor** (Panda) that delegates to specialists. The current prompt system is ad-hoc: identity files in `~/.joelclaw/`, AGENTS.md for project context, 51 skills for workload-specific injection, MEMORY.md as flat markdown. Retrieval is file-based — grep/read over markdown. This doesn't scale.

### The Conductor Model

Panda is the COO/chief-of-staff — one orchestrating intelligence, not a collection of separate agents. It delegates to specialists that have distinct **execution boundaries**:

| Role | Type | What It Does | Model |
|---|---|---|---|
| **Panda** | Conductor | Judgment, integration, knowledge, comms, observability, meta | Claude Sonnet 4.6 |
| **Coder** | Specialist | BUILD workload — sandboxed code execution | gpt-5.3-codex |
| **Worker** | Specialist | PIPELINE workload — durable Inngest functions | varies per function |
| **Voice** | Interface | Phone channel to the Conductor | Claude Sonnet 4.6 |

Voice, Telegram, interactive pi are **interfaces** to the Conductor — not separate agents. Writer and Researcher are **modes** of the Conductor, not specialists (no separate execution boundary).

### Empirical Workload Taxonomy (from 1069 slog entries)

| Category | % of slog | Description | Owner |
|---|---|---|---|
| **PLATFORM** | ~20% | k8s, deploys, services, NAS, launchd | Panda (direct) |
| **INTEGRATION** | ~18% | gateway, channels, webhooks, APIs, secrets | Panda (direct) |
| **TOOLING** | ~13% | skills, extensions, CLI, pi-tools | Panda (direct) |
| **PIPELINE** | ~12% | video ingest, transcribe, summarize, content review | Worker |
| **BUILD** | ~7% | implement features, create tools, ship | Coder |
| **KNOWLEDGE** | ~7% | discoveries, ADRs, planning, decisions | Panda (direct) |
| **COMMS** | unsized | telegram, slack, email triage | Panda (direct) |
| **OBSERVE** | unsized | diagnose, monitor, verify, validate | Panda (direct) |
| **META** | unsized | milestones, todos, self-improvement | Panda (direct) |

## Decision

### 1. Prompt Layer Stack with Stability Tiers

Every agent composes its system prompt from layers with declared stability:

```
GRANITE  (quarterly)   SOUL.md — values, voice, boundaries, agency rules
BEDROCK  (weekly)      USER.md — Joel profile, preferences, working style
SANDSTONE (monthly)    IDENTITY.md — Panda identity, accounts, hardware
TOPSOIL  (daily)       TOOLS.md — operational routing, current tool state
WEATHER  (per-turn)    CONTEXT — workload-specific, from skills + queries
```

**Pi's base prompt** (`"You are an expert coding assistant..."`) can be replaced via `~/.pi/agent/SYSTEM.md`. The identity-inject extension prepends SOUL/IDENTITY/USER/TOOLS. Session-lifecycle injects briefing + slog nudges.

**Stability contract**: Layers declare their tier. High-churn layers (TOPSOIL, WEATHER) get extra scrutiny from the evolution engine before promotion to prompt. The evolution engine can suggest promoting frequently-needed WEATHER items to TOPSOIL, or demoting unused TOPSOIL to WEATHER (query-on-demand).

### 2. Skills ARE Weather Layers

**Skills are already workload-specific context injection.** The k8s skill IS the PLATFORM weather layer. The gateway skill IS the INTEGRATION weather layer. We have 51 skills doing this organically.

What changes:
- Every skill gets tagged with its SKOS workload category
- Skills are **indexed in Typesense** — queried by workload, not grep'd from markdown
- MEMORY.md is **replaced by a Typesense collection** with SKOS taxonomy
- Vault, docs, research all queryable through the same Typesense interface

**Markdown is for human editing. Typesense is for agent retrieval.**

The pi skill spec is followed for authoring (SKILL.md files in `skills/`). But at runtime, the agent queries Typesense for relevant skills by workload category + semantic similarity, not by scanning markdown trigger phrases.

### 3. Unified Knowledge Retrieval

Replace the current fragmented retrieval:

| Current | Problem | Replacement |
|---|---|---|
| MEMORY.md (flat file) | Linear scan, no taxonomy | `agent_memory` Typesense collection |
| Skills (markdown grep) | Trigger phrase matching is brittle | `agent_skills` Typesense collection |
| Qdrant (semantic only) | No taxonomy, no FTS | Typesense embedding + FTS hybrid |
| Vault (file reads) | Requires knowing the path | `vault_index` Typesense collection |
| Slog (jsonl grep) | No semantic search | Already indexed, add SKOS tags |

All collections share the SKOS workload taxonomy. A single query can fan out across memory, skills, vault, and slog to find relevant context for the current workload.

### 4. SKOS Workload Taxonomy

```
joelclaw:work
  ├── joelclaw:platform      # k8s, deploys, services, NAS
  ├── joelclaw:integration   # gateway, channels, webhooks, APIs
  ├── joelclaw:tooling       # skills, extensions, CLI, pi-tools
  ├── joelclaw:pipeline      # video ingest, transcribe, summarize
  ├── joelclaw:build         # implement, create, ship
  ├── joelclaw:knowledge     # discoveries, ADRs, planning
  ├── joelclaw:comms         # telegram, slack, email
  ├── joelclaw:observe       # diagnose, monitor, verify
  └── joelclaw:meta          # milestones, self-improvement
```

Each category can have subcategories (e.g., `joelclaw:platform/k8s`, `joelclaw:comms/slack`). Taxonomy grows organically — the evolution engine proposes new categories when it sees uncategorized clusters.

### 5. Prompt/Query Boundary

**Frequency test**: if Panda needs knowledge >50% of turns within a workload, it belongs in the prompt (TOPSOIL or WEATHER). Otherwise, query on demand.

**Stability + frequency together determine layer placement:**
- High frequency + high stability → GRANITE/BEDROCK (always in prompt)
- High frequency + low stability → TOPSOIL (in prompt, monitored for churn)
- Low frequency + any stability → WEATHER (queried on demand from Typesense)

The 3x/daily evolution engine measures actual frequency and proposes promotions/demotions.

### 6. Evolution Engine (3x Daily)

Inngest cron: `prompt/evolution.analyze` at 7am, 1pm, 9pm PST.

Each run:
1. Query `interaction_taxonomy` for last 8 hours
2. Aggregate by workload category, friction score, agent type
3. Identify: high-friction categories, workload shifts, unused prompt layers
4. Generate suggestions: prompt edits (with diffs), skill gaps, model routing changes, memory promotions/demotions
5. Store in `~/.joelclaw/evolution/YYYY-MM-DD-HH.md`
6. Notify Joel via Telegram with top 3 suggestions
7. `auto_apply = false` — Joel always reviews

### 7. Configuration

`~/.joelclaw/config.toml`:

```toml
[conductor]
name = "Panda"
role = "COO"

[specialists.coder]
model = "gpt-5.3-codex"
workloads = ["build"]

[specialists.worker]
workloads = ["pipeline"]

[prompt_layers]
soul = "~/.joelclaw/soul.md"
identity = "~/.joelclaw/identity.md"  
user = "~/.joelclaw/user.md"
tools = "~/.joelclaw/tools.md"

[retrieval]
backend = "typesense"
collections = ["agent_memory", "agent_skills", "vault_index", "otel_events"]
taxonomy = "joelclaw:work"

[evolution]
enabled = true
schedule = "7,13,21"  # hours PST
auto_apply = false
notify_channel = "telegram"
```

## Phases

### Phase 1: Taxonomy + Skill Tagging
- Finalize SKOS workload taxonomy
- Tag all 51 skills with workload categories
- Create `agent_skills` Typesense collection
- Index skills with category, description, triggers, content

### Phase 2: Memory Migration
- Create `agent_memory` Typesense collection
- Migrate MEMORY.md content into structured documents with SKOS tags
- Build retrieval function that replaces MEMORY.md reads

### Phase 3: Prompt Layer Formalization
- Create `~/.joelclaw/config.toml`
- Create `~/.pi/agent/SYSTEM.md` (replaces pi's default base prompt)
- Refactor identity-inject to read from config
- Formalize stability tiers

### Phase 4: Interaction Classification
- Create `interaction_taxonomy` Typesense collection
- Build Haiku classifier Inngest function
- Wire into gateway + interactive sessions (async)

### Phase 5: Evolution Engine
- Build `prompt/evolution.analyze` Inngest cron
- Implement suggestion generation + Telegram notification
- Add accept/reject tracking
- Build `joelclaw evolve` CLI

## Consequences

**Good:**
- Single retrieval interface across all knowledge (skills, memory, vault, slog)
- Empirically-grounded taxonomy from real workload data
- Self-improving system that measures and tunes itself
- Skills become queryable by workload, not just by trigger phrases
- Markdown stays for authoring, Typesense handles retrieval

**Bad:**
- Migration effort: MEMORY.md, 51 skills, vault index all need Typesense indexing
- Typesense becomes critical infrastructure (already is for OTEL)
- Initial taxonomy will need 2-3 weeks of real data to calibrate

**Mitigations:**
- Phased rollout — each phase is independently valuable
- Typesense already runs in k8s with persistence
- Taxonomy grows organically, doesn't need to be perfect upfront
- `auto_apply = false` — human in the loop for all prompt changes
