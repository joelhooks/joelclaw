---
id: "0147"
title: Named Agent Profiles for Specialized Inference
status: shipped
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

1. **No identity for cost attribution.** Langfuse traces show which Inngest function triggered the call, but not the *role* of the LLM. A "researcher" call and a "classifier" call on the same function look identical. Can't answer "how much do we spend on research vs classification vs drafting?"

2. **Config duplication.** Multiple Inngest functions configure similar inference patterns — same system prompt fragments, same model preferences, same JSON mode flags. No reuse mechanism.

3. **No tool control.** All `infer()` calls run `pi -p --no-session --no-extensions --no-tools`. Some tasks would benefit from built-in tools (`read`, `bash`) or specific extensions. Currently impossible without spawning a full agent session.

## Decision

Introduce **named agent profiles** as metadata extensions to the existing inference-router catalog — not a parallel config surface.

### Profile Schema

Profiles extend `InferOptions` with identity metadata. All fields map 1:1 to existing runtime contracts:

| Field | Required | Maps to | Description |
|-------|----------|---------|-------------|
| `name` | yes | Langfuse metadata | Unique identifier, e.g. `researcher`, `classifier` |
| `model` | no | `InferOptions.model` | Default model (overridable). Falls through to task mapping if omitted. |
| `task` | no | `InferOptions.task` | Inference-router task hint (maps to model via `DEFAULT_TASK_TO_MODELS`) |
| `system` | no | `InferOptions.system` | System prompt text or path to `.md` file |
| `json` | no | `InferOptions.json` | Request JSON output parsing |
| `timeout` | no | `InferOptions.timeout` | Override default timeout (ms) |
| `noTools` | no | `InferOptions.noTools` → `--no-tools` | Disable all tools (default: true for profiles) |
| `builtinTools` | no | `--tools` flag | Pi built-in tool whitelist: `read`, `bash`, `edit`, `write` only |
| `extensions` | no | `-e` flag paths | Pi extension absolute paths to load |
| `tags` | no | Langfuse tags | Additional tags for this profile |

**Removed from earlier draft:** `maxTokens`, `jsonMode`, `tools` (generic) — these don't exist in `InferOptions` or pi CLI.

**`builtinTools` vs `tools`:** Pi's `--tools` flag accepts only built-in tool names (`read`, `bash`, `edit`, `write`). Extension-provided capabilities (like `web_search`) are exposed by loading the extension via `-e`, not via `--tools`. The schema reflects this distinction.

### Registry: Inference-Router Catalog Extension

Profiles live as entries in the inference-router catalog, not a separate YAML registry. This avoids dual source of truth for model→task mapping.

```typescript
// packages/inference-router/src/profiles.ts
import type { InferOptions } from "../../system-bus/src/lib/inference";

export interface AgentProfile {
  name: string;
  description?: string;
  tags: string[];
  // Defaults that merge into InferOptions
  defaults: Partial<Pick<InferOptions, "model" | "task" | "system" | "json" | "timeout" | "noTools">>;
  // Pi CLI capabilities
  builtinTools?: ("read" | "bash" | "edit" | "write")[];
  extensions?: string[]; // absolute paths to pi extensions
}

export const AGENT_PROFILES: Record<string, AgentProfile> = {
  classifier: {
    name: "classifier",
    description: "Fast classification into categories",
    tags: ["classification"],
    defaults: {
      task: "classify",
      json: true,
      timeout: 30_000,
      noTools: true,
    },
  },
  researcher: {
    name: "researcher",
    description: "Research analyst with vault and file access",
    tags: ["research"],
    defaults: {
      task: "research",
      system: "You are a research analyst. Extract facts, cite sources, be precise.",
    },
    builtinTools: ["read", "bash"],
    extensions: [`${process.env.HOME}/.pi/agent/git/github.com/joelhooks/pi-tools/vault-reader/index.ts`],
  },
  drafter: {
    name: "drafter",
    description: "Content drafting with Joel's voice",
    tags: ["drafting"],
    defaults: {
      task: "generate",
    },
  },
  reflector: {
    name: "reflector",
    description: "Self-reflection and observation synthesis",
    tags: ["reflection"],
    defaults: {
      task: "reason",
    },
  },
};

export function resolveProfile(name: string): AgentProfile | undefined {
  return AGENT_PROFILES[name];
}
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

### Resolution Order (explicit and deterministic)

1. **Explicit `opts`** always win — caller overrides beat everything
2. **Profile `defaults`** fill gaps for any field not explicitly set
3. **Inference-router `task` mapping** resolves model from `DEFAULT_TASK_TO_MODELS` if no explicit model
4. **Global `buildPolicy()` defaults** fill remaining gaps

Edge case: if `opts.model` is set AND profile has a different `defaults.model`, the explicit `opts.model` wins. Profile model is a suggestion, not a mandate.

### Langfuse Trace Threading

`traceLlmGeneration()` gains profile identity:

```typescript
await traceLlmGeneration({
  traceName: "joelclaw.inference",
  generationName: "system-bus.infer",
  // ... existing fields ...
  metadata: {
    agentProfile: profile?.name,        // NEW — profile identity
    agentTags: profile?.tags,           // NEW — profile tags
    agentToolset: profile?.builtinTools, // NEW — tool configuration
    // ... existing metadata ...
  },
  tags: [
    "joelclaw",
    "system-bus",
    ...(profile?.tags ?? []),            // NEW — merge profile tags
  ],
});
```

This enables Langfuse dashboard filtering: cost by agent profile, latency by role, error rate by persona.

### `runPiAttempt()` Enhancement

When a profile specifies `builtinTools` or `extensions`, `runPiAttempt()` builds flags:

```bash
# classifier — no tools, no extensions, fast (default behavior)
pi -p --no-session --no-extensions --no-tools --model anthropic/claude-haiku-4-5

# researcher — selective built-in tools + vault extension
pi -p --no-session --no-extensions \
  -e ~/.pi/agent/git/.../vault-reader/index.ts \
  --tools read,bash \
  --model anthropic/claude-sonnet-4

# drafter — no tools needed, just a system prompt
pi -p --no-session --no-extensions --no-tools --model anthropic/claude-sonnet-4
```

**Important:** `--tools` only accepts pi built-in names. Extension-provided tools (like MCP tools) become available automatically when the extension is loaded via `-e`. The profile schema enforces this by typing `builtinTools` as a union of known built-in names.

## Phases

### Phase 1: Profile registry + infer() integration
- `AGENT_PROFILES` in inference-router package (code, not YAML — single source of truth with catalog)
- `infer()` accepts `agent: string` option, resolves profile, merges defaults
- `traceLlmGeneration()` threads `agentProfile` + profile tags into Langfuse metadata
- Migrate 3 callers: classifier (triage), reflect, email-cleanup
- Validation: `bunx tsc --noEmit`, Langfuse traces show `agentProfile` field

### Phase 2: Tool-enabled profiles
- `runPiAttempt()` gains `builtinTools` and `extensions` support
- Research profile with `read` + `bash` + vault-reader extension
- Extension path validation at startup (warn if extension file missing)
- Validation: researcher profile can read vault files via extension

### Phase 3: CLI + observability
- `joelclaw agents list` — show all registered profiles
- `joelclaw agents test <name>` — dry-run with sample prompt
- Langfuse dashboard: cost/latency/volume breakdown by agent profile
- Per-profile budget caps (ADR-0146 Phase 3 integration)

## Consequences

### Positive
- Cost attribution by role, not just by Inngest function
- Controlled tool access — classifiers can't read files, researchers can
- DRY config — system prompts and model preferences defined once
- Single source of truth — profiles live in inference-router alongside catalog
- Path to per-agent budget caps (ADR-0146)
- Composable: profile defaults can be overridden by explicit opts

### Negative
- Adds complexity to `infer()` resolution logic
- Profile-not-found errors if name is misspelled (mitigated by TypeScript string literal union)
- Tool-enabled profiles are slower (pi loads extensions)

### Neutral
- Doesn't change the pi session model — gateway still uses `createAgentSession()`
- Doesn't replace inference-router — profiles use it for model resolution
- Profiles are optional — bare `infer()` calls continue to work unchanged
- No YAML config surface — profiles are TypeScript code in the inference-router package

## Review Notes (2026-02-25)

Based on codex architectural review:
- ~~YAML registry~~ → TypeScript in inference-router (avoids catalog drift)
- ~~`jsonMode`/`maxTokens`/generic `tools`~~ → removed (not in `InferOptions` or pi CLI)
- ~~`tools: ["web_search"]`~~ → `builtinTools` typed union + `extensions` for capability loading
- Added explicit resolution order with edge case documentation
- Added `agentProfile`/`agentTags`/`agentToolset` threading into `traceLlmGeneration()`
- Extension path validation deferred to Phase 2
