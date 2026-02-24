---
status: proposed
date: 2026-02-24
deciders: joel
tags:
  - gateway
  - architecture
  - agents
related:
  - 0124-discord-thread-forked-sessions
  - 0123-request-scoped-channel-routing
  - 0060-inngest-swarm-dag-orchestration
---

# ADR-0128: Subagent Delegation & Chain Execution for Gateway

## Context

The gateway daemon currently handles all work in a single pi session. Complex tasks (deploy + verify, research + implement, friction detect + fix + verify) are either done sequentially in one context window or split across ad-hoc Inngest function chains with no structured handoff.

`pi-subagents` (nicobailon/pi-subagents) provides a mature implementation of agent delegation with chains, parallel execution, and structured artifacts. Rather than rebuilding these patterns, we should adopt the extension directly and adapt specific patterns for gateway-specific work.

### What pi-subagents provides

- **Agent markdown format**: YAML frontmatter + system prompt body. Model, thinking level, tools, skills, extension sandboxing per agent.
- **Chain execution**: `scout -> planner -> worker` with `{previous}` output threading and per-step file I/O (`output:`, `reads:`).
- **Parallel execution**: Multiple agents simultaneously with file coalescing.
- **Background/dispatch mode**: Fire-and-forget with completion notification.
- **Extension sandboxing**: Control which tools/extensions each subagent can access.
- **Artifact pattern**: Structured temp dir per run with `context.md`, `progress.md`, metadata.

## Decision

### Phase 1: Install and Use Directly

Install `pi-subagents` globally. Use `/run`, `/chain`, `/parallel` in interactive sessions immediately. Create joelclaw-specific agent configs.

**Agent configs** (at `~/.pi/agent/agents/`):

```yaml
# deployer.md
---
name: deployer
description: Deploy and verify joelclaw services
tools: bash, read
skill: k8s, sync-system-bus
model: claude-sonnet-4-6
---
You deploy joelclaw services. You know the worker sync workflow, k8s namespace, and Inngest registration.
```

```yaml
# researcher.md
---
name: researcher
description: Research URLs, repos, and technologies
tools: bash, read, web_search
skill: defuddle, discovery
model: claude-sonnet-4-6
---
You research technologies and produce structured analysis notes.
```

```yaml
# friction-fixer.md
---
name: friction-fixer
description: Fix detected friction patterns autonomously
tools: bash, read, write
skill: o11y-logging
model: claude-sonnet-4-6
---
You fix friction patterns. Each fix must be a single git commit. Never break the build.
```

### Phase 2: Gateway Chain Integration

Adapt chain execution for gateway-dispatched workflows. Key patterns to port:

1. **Agent markdown configs for Discord threads** (ADR-0124)
   - Each Discord thread type maps to an agent config
   - Thread creation reads agent config → spawns pi session with that agent's model, tools, skills
   - Replaces the current "every thread gets the same prompt" approach

2. **Declarative chain files for multi-step workflows**
   - Friction pipeline: `detector -> fixer -> verifier`
   - Deploy pipeline: `builder -> deployer -> health-checker`
   - Discovery pipeline: `fetcher -> analyzer -> writer`
   - These replace ad-hoc Inngest function chains for agent-driven work

3. **Artifact handoff between steps**
   - Each chain step writes to a structured artifact dir
   - Next step reads previous artifacts via `reads:` config
   - Replaces Redis intermediate state for agent-to-agent communication

4. **Extension sandboxing for security**
   - Deploy agents get k8s tools but not email
   - Research agents get web search but not write access
   - Reduces blast radius of autonomous agent actions

### Phase 3: Inngest-Backed Chain Orchestration

Wire chain execution into Inngest for durability:
- Each chain step becomes an Inngest step with retry/timeout
- Chain definition lives in `.chain.md` files but execution is Inngest-durable
- Artifacts persist to temp dir (or Redis for distributed)
- Gateway notified on chain completion with summary

### Non-goals

- Replacing codex for heavy coding tasks (codex has its own sandbox + model)
- Building a custom chain runtime (pi-subagents already has one)
- Multi-agent collaboration within a single context window (out of scope)

## Consequences

- **Positive**: Structured multi-step workflows replace ad-hoc chains
- **Positive**: Agent configs are version-controlled markdown files
- **Positive**: Extension sandboxing improves security posture
- **Positive**: Artifact pattern gives observability into intermediate results
- **Negative**: Another pi extension dependency to maintain
- **Risk**: pi-subagents is third-party — upstream breaking changes possible
- **Mitigation**: Pin version, fork if needed (it's open source, MIT)
