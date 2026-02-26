---
id: "0147"
title: Named Agent Profiles for Specialized Inference
status: proposed
date: 2026-02-25
drivers:
  - Joel Hooks
links:
  - "[ADR-0140] Unified Inference Router"
  - "[ADR-0146] Pi Session Langfuse Integration"
  - "[ADR-0144] Gateway Hexagonal Architecture"
tags:
  - inference
  - agents
  - observability
---

# ADR-0147: Named Agent Profiles for Specialized Inference

## Context

Today `infer()` treats every LLM call as an anonymous pi subprocess. Callers pass raw flags — model, system prompt, JSON mode — but there's no concept of *who* is doing the inference. Every call looks the same in Langfuse: `joelclaw.inference` with a component tag.

This creates three problems:

1. **No tool control.** All `infer()` calls run `pi -p --no-session --no-extensions --no-tools`. Some tasks (research, code review, vault lookup) would benefit from specific tools (`read`, `bash`, `web_search`) or extensions (`vault-reader`). Currently impossible without spawning a full agent session.

2. **No identity for cost attribution.** Langfuse traces show which Inngest function triggered the call, but not the *role* of the LLM. A "researcher" call and a "classifier" call on the same function look identical. Can't answer "how much do we spend on research vs classification vs drafting?"

3. **Config duplication.** Multiple Inngest functions configure similar inference patterns — same system prompt fragments, same model preferences, same JSON mode flags. No reuse mechanism.

## Decision

Introduce **named agent profiles** — declarative configs that define a specialized inference persona. Each profile specifies:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Unique identifier, e.g. `researcher`, `classifier`, `drafter` |
| `model` | no | Default model (overridable). Falls through to inference-router task mapping if omitted. |
| `systemPrompt` | no | System prompt text or path to `.md` file |
| `tools` | no | Pi tool whitelist, e.g. `["read", "bash", "web_search"]` |
| `extensions` | no | Pi extension paths to load, e.g. `["vault-reader"]` |
| `jsonMode` | no | Default to JSON output parsing |
| `maxTokens` | no | Output token limit |
| `tags` | no | Additional Langfuse tags for this profile |
| `task` | no | Inference-router task hint (maps to model via catalog) |
| `timeout` | no | Override default timeout |

### Registry

Profiles live in `~/.joelclaw/agents/profiles/` as YAML files:

```yaml
# ~/.joelclaw/agents/profiles/researcher.yaml
name: researcher
model: anthropic/claude-sonnet-4
systemPrompt: |
  You are a research analyst. Extract facts, cite sources, be precise.
tools:
  - read
  - web_search
extensions:
  - vault-reader
tags:
  - research
task: research
```

```yaml
# ~/.joelclaw/agents/profiles/classifier.yaml
name: classifier
model: anthropic/claude-haiku-4-5
systemPrompt: |
  Classify the input into exactly one category. Return JSON.
jsonMode: true
tags:
  - classification
task: classify
timeout: 30000
```

### `infer()` Integration

```typescript
// Before — anonymous, raw flags
const result = await infer(prompt, {
  model: "anthropic/claude-haiku-4-5",
  json: true,
  system: "Classify the input...",
  component: "channel-message-classify",
});

// After — named profile
const result = await infer(prompt, {
  agent: "classifier",
  component: "channel-message-classify",
});
```

Profile resolution order:
1. Explicit `opts` override profile defaults (caller always wins)
2. Profile fields fill gaps
3. Inference-router `task` mapping fills remaining model selection
4. Global defaults from `buildPolicy()`

### Langfuse Tracing

Every `traceLlmGeneration()` call includes:
- `metadata.agent` — profile name
- `tags` — profile tags merged with existing `["joelclaw", "system-bus"]`
- Enables Langfuse dashboard filtering: cost by agent profile, latency by agent, error rate by agent

### Pi Subprocess

When a profile specifies `tools` or `extensions`, `runPiAttempt()` builds the appropriate flags:

```bash
# classifier profile — no tools, no extensions, fast
pi -p --no-session --no-extensions --no-tools --model anthropic/claude-haiku-4-5

# researcher profile — selective tools + extensions
pi -p --no-session --no-extensions \
  -e ~/.pi/agent/git/.../vault-reader/index.ts \
  --tools read,web_search \
  --model anthropic/claude-sonnet-4
```

## Phases

### Phase 1: Registry + infer() integration
- Profile loader reads YAML from `~/.joelclaw/agents/profiles/`
- `infer()` accepts `agent: string` option
- Langfuse traces tagged with agent name
- Migrate 2-3 existing callers as proof (classifier, reflect, email-cleanup)

### Phase 2: Tool-enabled agents
- `runPiAttempt()` supports `--tools` and `-e` flags from profile
- Research agent with `read` + `web_search` for discovery-capture, meeting-analyze
- Vault agent with vault-reader extension for context enrichment

### Phase 3: CLI + observability
- `joelclaw agents list` — show all profiles
- `joelclaw agents test <name>` — dry-run with sample prompt
- Langfuse dashboard: cost/latency/volume breakdown by agent profile
- Budget caps per agent profile (ADR-0146 Phase 3 integration)

## Consequences

### Positive
- Cost attribution by role, not just by Inngest function
- Controlled tool access — classifiers can't browse the web, researchers can
- DRY config — system prompts and model preferences defined once
- Path to per-agent budget caps (ADR-0146)
- Composable: profiles can be mixed with explicit overrides

### Negative
- Another config surface to maintain
- Profile-not-found errors if registry is missing
- Tool-enabled agents are slower (pi loads tools/extensions)

### Neutral
- Doesn't change the pi session model — gateway still uses `createAgentSession()`
- Doesn't replace inference-router — profiles use it for model resolution
- Profiles are optional — bare `infer()` calls continue to work unchanged
