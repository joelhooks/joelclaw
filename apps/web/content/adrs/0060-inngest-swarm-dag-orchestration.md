---
status: proposed
date: 2026-02-19
decision-makers: Joel
consulted: oh-my-pi (can1357/oh-my-pi) swarm extension
informed: pi-tools consumers, joelclaw system
tags:
  - joelclaw
  - inngest
  - multi-agent
  - orchestration
  - pi-tools
supersedes: null
related:
  - "0005"
  - "0026"
---

# ADR-0060: Inngest-Backed Swarm/DAG Multi-Agent Orchestration

## Context and Problem Statement

`ralph-loop` executes PRD stories **sequentially** — one codex session per story, linear chain. This works for implementation loops but can't express:

- **Parallel fan-out**: 3 agents researching simultaneously, then a synthesizer
- **Dependency graphs**: agent C depends on A and B, but A and B are independent
- **Pipeline iteration**: repeat the full graph N times (e.g., find 50 items, one per iteration)
- **Mixed topologies**: diamond, fan-in, hybrid DAGs

oh-my-pi's `packages/swarm-extension/` solves this with YAML-defined DAGs, topological wave sorting, and parallel execution. But their implementation is **process-local** — spawns subprocesses from the pi session, tracks state on the filesystem, dies if the terminal closes. No durability, no retries, no observability beyond log files.

joelclaw already has durable execution infrastructure via Inngest (ADR-0005). The swarm should be built on top of it.

## Decision Drivers

- ralph-loop can't express parallel or DAG workflows
- oh-my-pi's swarm architecture (YAML config, DAG, waves) is well-designed but wrong execution layer
- Inngest provides durability, step memoization, retries, event fan-out — exactly what a DAG orchestrator needs
- Must run AFK (no pi session required) via the existing system-bus worker
- Must integrate with existing joelclaw infrastructure (Redis state, gateway notifications, `joelclaw` CLI)

## Decision

Build an Inngest-backed swarm/DAG orchestrator that uses oh-my-pi's YAML definition format and DAG algorithms, but executes via Inngest functions and steps instead of local subprocesses.

### YAML Definition Format

Adopt oh-my-pi's swarm YAML format (credit: Can Boluk, MIT licensed):

```yaml
swarm:
  name: codebase-audit
  workspace: /path/to/project
  mode: parallel          # pipeline | parallel | sequential
  target_count: 1         # iterations (pipeline mode only)
  model: claude-sonnet-4  # optional model override
  tool: codex             # codex | claude | pi (agent runtime)

  agents:
    security:
      role: security-auditor
      task: |
        Audit all code in src/ for security vulnerabilities.
        Write findings to reports/security.md with severity ratings.
      reports_to:
        - lead

    performance:
      role: performance-analyst
      task: |
        Profile and analyze src/ for performance bottlenecks.
        Write findings to reports/performance.md with benchmarks.
      reports_to:
        - lead

    lead:
      role: engineering-lead
      task: |
        Read all reports in reports/.
        Create a prioritized action plan in output/action_plan.md.
      waits_for:
        - security
        - performance
```

Extensions to oh-my-pi format:
- `tool` field (default: `codex`) — which agent runtime to use per-agent or globally
- Per-agent `tool` override — mix codex and claude in the same swarm
- Per-agent `model` override
- Per-agent `sandbox` mode (`workspace-write` default, `danger-full-access` for system tasks)

### Architecture

#### Event Flow

```
swarm/started              → Inngest function: swarm-orchestrator
  ├─ step: parse-yaml      → validate + build DAG + compute waves
  ├─ step: wave-0           → fan-out: invoke agent functions in parallel
  │   ├─ swarm/agent.started (security)  → step.invoke → codex exec
  │   └─ swarm/agent.started (performance) → step.invoke → codex exec
  ├─ step: wave-0-collect   → waitForEvent on all wave-0 completions
  ├─ step: wave-1           → fan-out: invoke agent functions for next wave
  │   └─ swarm/agent.started (lead) → step.invoke → codex exec
  ├─ step: wave-1-collect
  └─ step: finalize         → update Redis state, gateway notification
```

#### Inngest Functions

**`swarm-orchestrator`** — main function, triggered by `swarm/started`:
1. `step.run("parse")` — parse YAML, validate, build dependency graph, compute waves via topological sort
2. For each wave:
   - `step.run("wave-N-dispatch")` — emit `swarm/agent.started` events for all agents in wave
   - For each agent in wave: `step.invoke("swarm-agent-exec", { agent, wave, iteration })`
   - Collect results (all agents in wave must complete before next wave)
3. `step.run("finalize")` — update Redis state, push gateway notification
4. For pipeline mode: loop back to wave-0 for next iteration

**`swarm-agent-exec`** — individual agent execution, invoked by orchestrator:
1. `step.run("exec")` — spawn codex/claude/pi with the agent's task + system prompt
2. Return result (exit code, output summary, error if any)

#### DAG Algorithms

Port oh-my-pi's `dag.ts` directly (MIT licensed, pure functions, no runtime deps):
- `buildDependencyGraph()` — extracts deps from `waits_for` / `reports_to`
- `detectCycles()` — Kahn's algorithm
- `buildExecutionWaves()` — topological sort into parallel wave groups

#### State Management

Redis keys (namespace: `swarm:{name}`):
- `swarm:{name}:state` — JSON: pipeline status, current iteration, current wave
- `swarm:{name}:agents` — hash: per-agent status, timing, errors
- `swarm:{name}:definition` — stored YAML definition for resume/inspection
- TTL: 7 days after completion

#### Inter-Agent Communication

Same pattern as oh-my-pi: agents communicate via the **shared workspace filesystem**. The orchestrator doesn't pass data between agents. Patterns:
- Signal files: `signals/agent_out.txt` — lightweight status flags
- Structured output: `reports/security.md` — detailed results
- Tracking files: `processed.txt` — dedup across pipeline iterations

#### CLI Integration

```bash
# Start a swarm
joelclaw swarm start path/to/swarm.yaml

# Status
joelclaw swarm status <name>

# Cancel
joelclaw swarm cancel <name>

# List running swarms
joelclaw swarm list
```

#### pi Extension (Optional)

A pi-tools extension for interactive use:
- `/swarm run path/to/swarm.yaml` — start from pi session
- `/swarm status <name>` — check progress
- Progress events pushed to gateway via `pushGatewayEvent()`

### Relationship to ralph-loop

ralph-loop is **not replaced**. It serves a different purpose:
- **ralph-loop**: PRD-driven story implementation with judge evaluation, git branching, test verification
- **swarm**: arbitrary DAG workflows — research pipelines, code audits, content creation, data processing

They coexist. A swarm agent could internally use a ralph-loop for its task if the task is "implement this PRD."

## Consequences

### Positive

- Parallel multi-agent execution with dependency management
- Durable — survives crashes, restarts, terminal closures via Inngest
- Observable — `joelclaw runs` shows swarm progress, Inngest dashboard for step traces
- AFK — runs through system-bus worker, no pi session needed
- Gateway notifications on progress and completion
- YAML config is human-readable and version-controllable
- DAG algorithms are pure functions, easily testable
- Pipeline mode enables iterative accumulation workflows

### Negative

- More complex than ralph-loop — DAG orchestration adds conceptual overhead
- Inngest step limits may constrain very large swarms (hundreds of agents)
- Filesystem-based inter-agent communication is loose — no type safety between agents
- Each agent is a full codex/claude session — cost scales with agent count × iterations

### Follow-up Tasks

- [ ] Port oh-my-pi `dag.ts` algorithms (buildDependencyGraph, detectCycles, buildExecutionWaves) — credit Can Boluk
- [ ] Port oh-my-pi `schema.ts` YAML parser with joelclaw extensions (tool, per-agent model/sandbox)
- [ ] Create `swarm-orchestrator` Inngest function with wave-based step execution
- [ ] Create `swarm-agent-exec` Inngest function (codex/claude/pi dispatch)
- [ ] Add Redis state management for swarm pipelines
- [ ] Add `joelclaw swarm` CLI subcommands (start, status, cancel, list)
- [ ] Add gateway notifications for swarm progress
- [ ] Add swarm events to Inngest client schema
- [ ] Optional: pi-tools `/swarm` extension for interactive use
- [ ] Test: 3-agent fan-out → synthesizer DAG completes correctly
- [ ] Test: cycle detection rejects invalid YAML
- [ ] Test: pipeline mode runs N iterations

## Implementation Plan

### Affected Paths

- `packages/system-bus/src/inngest/functions/swarm-orchestrator.ts` — **new** orchestrator function
- `packages/system-bus/src/inngest/functions/swarm-agent-exec.ts` — **new** agent execution function
- `packages/system-bus/src/swarm/` — **new** directory
  - `dag.ts` — dependency graph + wave computation (port from oh-my-pi)
  - `schema.ts` — YAML parsing + validation (port from oh-my-pi + extensions)
  - `state.ts` — Redis state management
  - `types.ts` — swarm event types, agent config types
- `packages/system-bus/src/inngest/events.ts` — add swarm event schemas
- `packages/system-bus/src/inngest/serve.ts` — register new functions
- `packages/cli/src/commands/swarm.ts` — **new** CLI subcommand
- Optional: `pi-tools/swarm/index.ts` — pi extension for `/swarm` command

### Patterns to Follow

- oh-my-pi's DAG algorithms are MIT-licensed pure functions — port directly with attribution
- oh-my-pi's YAML format is the external interface — maintain compatibility for potential config sharing
- Inngest step naming: `swarm-{name}-wave-{N}-dispatch`, `swarm-{name}-wave-{N}-collect`
- Redis state follows existing patterns from loop PRD state (ADR-0011)
- Gateway notifications follow ADR-0018 patterns (`pushGatewayEvent`)
- Agent execution follows existing codex-exec / ralph-loop patterns for spawning

### What to Avoid

- Don't port oh-my-pi's subprocess execution (`runSubprocess`) — use Inngest `step.invoke` instead
- Don't port filesystem state tracking — use Redis
- Don't try to pass data between agents via Inngest events — filesystem is the communication channel
- Don't conflate with ralph-loop — they serve different purposes and coexist

### Verification

- [ ] Define a 3-agent fan-out + synthesizer YAML → `joelclaw swarm start` → all 4 agents run, waves respected
- [ ] Cycle in YAML → rejected with clear error before any execution
- [ ] Kill the worker mid-swarm → restart → swarm resumes from last completed wave (Inngest durability)
- [ ] `joelclaw swarm status <name>` → shows per-agent status, current wave, iteration
- [ ] Pipeline mode with target_count=3 → full DAG executes 3 times
- [ ] Gateway receives progress notifications during swarm execution

## More Information

### Reference Implementation

oh-my-pi swarm extension (`can1357/oh-my-pi`):
- `packages/swarm-extension/src/swarm/dag.ts` — dependency graph + topological sort
- `packages/swarm-extension/src/swarm/schema.ts` — YAML parsing + validation
- `packages/swarm-extension/src/swarm/pipeline.ts` — wave-based execution controller
- `packages/swarm-extension/src/swarm/executor.ts` — agent subprocess spawning
- `packages/swarm-extension/src/swarm/state.ts` — filesystem state persistence
- `packages/swarm-extension/README.md` — YAML format reference + usage patterns

Credit: Can Boluk (@can1357) for the YAML format, DAG algorithms, and swarm patterns. MIT licensed.

### Related ADRs

- **ADR-0005** — Durable multi-agent coding loops (Inngest foundation)
- **ADR-0011** — Redis-backed PRD state (same state pattern)
- **ADR-0018** — Pi-native gateway with Redis event bridge (notification pattern)
- **ADR-0026** — Background agents via Inngest (execution pattern)
