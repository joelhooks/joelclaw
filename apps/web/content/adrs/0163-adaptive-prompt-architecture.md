# ADR-0163: Adaptive Prompt Architecture

**Status**: proposed  
**Date**: 2026-02-28  
**Supersedes**: Extends 0140 (inference router), 0147 (named agent profiles)  
**Related**: 0144 (gateway hex arch), 0152 (dream process), 0131 (channel intelligence)

## Context

joelclaw runs multiple agent types — interactive pi sessions, gateway daemon, voice agent, codex workers, system-bus inference — each with different prompt stacks assembled ad-hoc. The current state:

| Agent Type | Prompt Source | Model | Personality | Config Location |
|---|---|---|---|---|
| Interactive pi | identity-inject ext (SOUL + IDENTITY + USER + TOOLS) + session-lifecycle briefing + AGENTS.md + skills | Claude Sonnet 4.6 | Full Panda | scattered across ~/.pi, ~/.joelclaw |
| Gateway daemon | AGENTS.md (gateway/) + session-lifecycle | Claude Sonnet 4.6 | Panda-lite (triage mode) | ~/.joelclaw/gateway/ |
| Voice agent | `load_soul()` + voice_rules hardcoded | Claude Sonnet 4.6 via OpenRouter | Casual Panda | infra/voice-agent/main.py |
| Codex worker | AGENTS.md + skill injection per task | gpt-5.3-codex | None (task-focused) | ~/.codex/config.toml |
| System-bus inference | Inline prompts per function | varies (haiku, codex-spark) | None | packages/system-bus/src/lib/inference.ts |

Problems:
1. **No unified composition model** — each agent assembles prompts differently
2. **Personality drift** — voice agent reads SOUL.md but gateway has its own AGENTS.md overlay that partially contradicts/supplements
3. **Model-prompt mismatch** — no systematic mapping of "this model works best with this prompt style"
4. **No feedback loop** — we don't measure what prompts produce good outcomes
5. **Configuration is scattered** — ~/.pi, ~/.joelclaw, ~/.codex, hardcoded in Python, hardcoded in TS
6. **No taxonomy of interactions** — every request is treated the same regardless of workload category

## Decision

### 1. Prompt Layer Stack

Every agent composes its system prompt from these layers, top to bottom:

```
┌─────────────────────────────────┐
│  SOUL.md                        │  Who we are. Values. Voice. Boundaries.
│  (shared across ALL agents)     │  Source: ~/.joelclaw/soul.md
├─────────────────────────────────┤
│  IDENTITY.md                    │  Panda's identity. Accounts. Hardware.
│  (shared across ALL agents)     │  Source: ~/.joelclaw/identity.md
├─────────────────────────────────┤
│  USER.md                        │  Joel's profile. Preferences. Context.
│  (shared across ALL agents)     │  Source: ~/.joelclaw/user.md
├─────────────────────────────────┤
│  AGENT_TYPE.md                  │  Agent-specific behavior + constraints.
│  (per agent type)               │  Source: ~/.joelclaw/agents/<type>.md
├─────────────────────────────────┤
│  TOOLS.md                       │  Operational tool-routing notes.
│  (per agent type, optional)     │  Source: ~/.joelclaw/agents/<type>/tools.md
├─────────────────────────────────┤
│  CONTEXT (dynamic)              │  Briefing, memory, recent slog, etc.
│  (injected at runtime)          │  Source: session-lifecycle / runtime
└─────────────────────────────────┘
```

**Codex workers** get SOUL (trimmed: values + boundaries only) + task prompt. No identity, no personality — they're hands, not a person.

**System-bus inference** gets only the per-function inline prompt. SOUL values (especially "earn it" and "show your work") can optionally prepend for functions that produce human-facing output.

### 2. Agent Type Registry

`~/.joelclaw/agents/` directory with one `.md` per agent type:

```
~/.joelclaw/agents/
├── interactive.md      # Full pi sessions (what Joel talks to)
├── gateway.md          # Always-on daemon (triage, routing, notifications)
├── voice.md            # Phone agent (SIP, conversational, brief)
├── codex.md            # Codex workers (task-focused, no personality)
├── inference.md        # System-bus LLM calls (function-specific)
└── registry.toml       # Agent type → model mapping + capability flags
```

`registry.toml`:
```toml
[interactive]
model = "claude-sonnet-4-6"
provider = "anthropic"
personality = "full"
layers = ["soul", "identity", "user", "agent_type", "tools", "context"]
capabilities = ["tools", "skills", "memory", "web", "code"]

[gateway]
model = "claude-sonnet-4-6"
provider = "anthropic"
personality = "triage"
layers = ["soul", "identity", "user", "agent_type", "context"]
capabilities = ["tools", "skills", "memory", "events", "channels"]

[voice]
model = "claude-sonnet-4-6"
provider = "openrouter"
personality = "casual"
layers = ["soul", "identity", "user", "agent_type"]
capabilities = ["tools", "calendar", "tasks", "vault", "email"]
max_response_tokens = 200  # Keep it brief for voice

[codex]
model = "gpt-5.3-codex"
provider = "openai"
personality = "none"
layers = ["soul_values", "agent_type"]
capabilities = ["code", "filesystem"]

[inference]
model = "claude-haiku-4-5"
provider = "anthropic"
personality = "none"
layers = []
capabilities = ["structured_output"]
```

### 3. Interaction Taxonomy (SKOS in Typesense)

New Typesense collection: `interaction_taxonomy`

Schema:
```json
{
  "name": "interaction_taxonomy",
  "fields": [
    { "name": "id", "type": "string" },
    { "name": "timestamp", "type": "int64" },
    { "name": "agent_type", "type": "string", "facet": true },
    { "name": "model", "type": "string", "facet": true },
    { "name": "intent", "type": "string", "facet": true },
    { "name": "workload_category", "type": "string", "facet": true },
    { "name": "friction_score", "type": "float" },
    { "name": "skos_concepts", "type": "string[]", "facet": true },
    { "name": "skos_broader", "type": "string[]" },
    { "name": "outcome", "type": "string", "facet": true },
    { "name": "prompt_layers_used", "type": "string[]" },
    { "name": "token_count", "type": "int32" },
    { "name": "user_satisfaction", "type": "string", "optional": true },
    { "name": "raw_input_snippet", "type": "string" },
    { "name": "embedding", "type": "float[]", "num_dim": 1536, "optional": true }
  ]
}
```

**SKOS concept hierarchy** (initial, grows organically):

```
joelclaw:workload
  ├── joelclaw:ops           # Infrastructure, deploys, health checks
  │   ├── joelclaw:ops/k8s
  │   ├── joelclaw:ops/deploy
  │   └── joelclaw:ops/health
  ├── joelclaw:build         # Feature work, coding, PRDs
  │   ├── joelclaw:build/feature
  │   ├── joelclaw:build/bugfix
  │   └── joelclaw:build/refactor
  ├── joelclaw:content       # Writing, publishing, editing
  │   ├── joelclaw:content/article
  │   ├── joelclaw:content/discovery
  │   └── joelclaw:content/feedback
  ├── joelclaw:intel         # Research, analysis, dossiers
  │   ├── joelclaw:intel/person
  │   ├── joelclaw:intel/tech
  │   └── joelclaw:intel/strategy
  ├── joelclaw:comms         # Messages, email, notifications
  │   ├── joelclaw:comms/telegram
  │   ├── joelclaw:comms/slack
  │   └── joelclaw:comms/email
  ├── joelclaw:memory        # Vault, slog, recall, skills
  │   ├── joelclaw:memory/capture
  │   ├── joelclaw:memory/recall
  │   └── joelclaw:memory/skill
  └── joelclaw:meta          # Self-improvement, prompt tuning
      ├── joelclaw:meta/prompt
      ├── joelclaw:meta/friction
      └── joelclaw:meta/taxonomy
```

### 4. Friction Detection

Every interaction is classified by a lightweight Haiku pass (async, non-blocking):

```typescript
// Runs after each agent turn, fires-and-forgets to Inngest
{
  name: "interaction/classify",
  data: {
    agent_type: "interactive",
    model: "claude-sonnet-4-6",
    user_input_snippet: first200Chars,
    agent_response_snippet: first200Chars,
    turn_count: 3,
    tool_calls: ["bash", "read", "edit"],
    duration_ms: 4200,
    // Haiku classifies these:
    intent: "ops/deploy",
    workload_category: "joelclaw:ops/deploy",
    friction_score: 0.2,  // 0 = smooth, 1 = painful
    friction_signals: [],
    skos_concepts: ["joelclaw:ops", "joelclaw:ops/deploy"],
  }
}
```

**Friction signals** (what Haiku looks for):
- User rephrased the same request (misunderstanding)
- User said "no", "wrong", "that's not what I meant"
- Multiple retries of same tool
- Agent apologized or backtracked
- Agent produced output user discarded
- Task took >5 turns for something simple
- User took over and did it manually

### 5. Prompt Evolution Engine (3x Daily)

Inngest cron: `prompt/evolution.analyze` — runs at 7am, 1pm, 9pm PST.

Each run:
1. **Query** `interaction_taxonomy` for last 8 hours (since previous run)
2. **Aggregate** by workload category, friction score, agent type
3. **Identify patterns**:
   - High-friction categories (avg friction > 0.5)
   - Workload category shifts (what's Joel doing more/less of?)
   - Model performance by category (does codex struggle with X?)
   - Unused prompt layers (are we injecting context nobody uses?)
4. **Generate suggestions** via Sonnet:
   - Specific prompt layer edits (with diffs)
   - Skill gaps (repeating friction → missing skill)
   - Model routing changes (category X works better with model Y)
   - Memory system gaps (repeated lookups → should be in MEMORY.md)
5. **Store** suggestions in `~/.joelclaw/evolution/YYYY-MM-DD-HH.md`
6. **Notify** Joel via gateway (Telegram) with top 3 suggestions
7. **Track** which suggestions Joel accepts/rejects (feedback loop)

### 6. Config Schema

`~/.joelclaw/config.toml` (new, canonical):

```toml
[system]
taxonomy_collection = "interaction_taxonomy"
evolution_schedule = "7,13,21"  # hours PST
friction_threshold = 0.5

[defaults]
model = "claude-sonnet-4-6"
provider = "anthropic"

[prompt_layers]
soul = "~/.joelclaw/soul.md"
identity = "~/.joelclaw/identity.md"
user = "~/.joelclaw/user.md"
tools = "~/.joelclaw/tools.md"
agents_dir = "~/.joelclaw/agents/"

[evolution]
enabled = true
suggestions_dir = "~/.joelclaw/evolution/"
max_suggestions_per_run = 5
auto_apply = false  # Never auto-modify prompts without Joel
notify_channel = "telegram"
```

## Phases

### Phase 1: Prompt Layer Formalization (this week)
- Create `~/.joelclaw/agents/` directory with agent type .md files
- Write `registry.toml` with current agent-model mappings
- Refactor identity-inject to read from registry
- Refactor voice agent to use same layer stack
- Create `~/.joelclaw/config.toml` with defaults

### Phase 2: Interaction Taxonomy (next)
- Create `interaction_taxonomy` Typesense collection
- Build SKOS concept hierarchy seed
- Add Inngest `interaction/classify` function (Haiku classifier)
- Wire classification into gateway + interactive sessions (async, non-blocking)

### Phase 3: Friction Detection
- Implement friction signal detection in classifier
- Add friction score aggregation queries
- Build friction dashboard in CLI (`joelclaw friction`)

### Phase 4: Evolution Engine
- Build `prompt/evolution.analyze` Inngest cron
- Implement suggestion generation + storage
- Wire Telegram notifications
- Add accept/reject tracking
- Build `joelclaw evolve` CLI for reviewing suggestions

## Consequences

**Good:**
- Unified prompt composition across all agent types
- Measurable friction → actionable improvements
- Self-improving system that learns from every interaction
- Clean separation of concern: SOUL (who) vs AGENT (how) vs CONTEXT (what)
- Joel sees concrete suggestions instead of vague "the system should be better"

**Bad:**
- Haiku classification adds ~$0.002/interaction (negligible)
- Initial taxonomy will be wrong — needs 2-3 weeks of real data to calibrate
- Risk of over-engineering: some agents (codex workers) need almost no prompt

**Mitigations:**
- `auto_apply = false` — Joel always reviews suggestions
- Haiku classification is async/fire-and-forget — never blocks the interaction
- Taxonomy is additive — new concepts can be added without breaking old classifications
- Phase 1 is purely organizational, zero risk

## Agent Readiness

- [ ] All agent types documented in registry
- [ ] `identity-inject` reads from `~/.joelclaw/agents/`
- [ ] Voice agent reads from same layer stack
- [ ] Typesense collection created with SKOS schema
- [ ] Haiku classifier deployed as Inngest function
- [ ] Evolution engine cron running
- [ ] CLI commands for friction + evolution review
- [ ] 2 weeks of taxonomy data collected
- [ ] First batch of evolution suggestions generated and reviewed
