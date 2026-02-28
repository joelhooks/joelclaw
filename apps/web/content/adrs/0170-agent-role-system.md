# ADR-0170: Agent Role System (ROLE.md)

**Status:** accepted  
**Date:** 2026-02-28  
**Deciders:** Joel Hooks  
**Supersedes:** None  
**Related:** ADR-0163 (adaptive prompt architecture), ADR-0169 (CLI capability contracts)

## Context

SYSTEM.md previously contained role-specific principles like "Gateway is triage, not implementation." But SYSTEM.md is the base platform prompt for ALL agents — gateway, codex workers, interactive pi, voice agent. Not all agents are gateways.

The prompt composition chain is:

```
SYSTEM.md → IDENTITY.md → SOUL.md → ROLE.md → USER.md → TOOLS.md → AGENTS.md → skills
```

Identity, voice, and user context already have dedicated files. Role boundaries need the same treatment.

## Decision

### ROLE.md defines agent role boundaries

Each agent context gets a ROLE.md that specifies:

1. **What this agent does** — its operational scope
2. **What this agent does NOT do** — explicit exclusions
3. **Delegation rules** — when and how to hand off work
4. **Capability restrictions** — which `joelclaw` capabilities this role uses

### Role inventory

| Role | File | Scope |
|------|------|-------|
| Gateway | `~/.joelclaw/roles/gateway.md` | Triage, orchestrate, delegate. Does NOT write code. Routes to specialists. |
| Codex Worker | `~/.joelclaw/roles/codex-worker.md` | Implement, test, commit. Sandboxed execution. No direct human communication. |
| Interactive | `~/.joelclaw/roles/interactive.md` | Full capabilities. Direct human collaboration. Research, code, operate. |
| Voice | `~/.joelclaw/roles/voice.md` | Conversational. Brief, interview, capture action items. No file editing. |
| Loop Worker | `~/.joelclaw/roles/loop-worker.md` | Story implementation within pipeline. Must use `joelclaw mail` for file reservation. |

### Role file format

```markdown
# Role: Gateway

## Scope
Triage inbound messages. Orchestrate workflows. Delegate implementation to specialists.

## Boundaries
- Does NOT write code
- Does NOT modify files directly
- Does NOT start feature work unprompted

## Delegation
- Code changes → codex (must set cwd + sandbox)
- Research → background agent
- Alerts → joelclaw notify

## Capabilities
- joelclaw mail: read (monitor system), send (coordinate)
- joelclaw notify: push (alert human)
- joelclaw otel: query (health checks)
- joelclaw secrets: lease (credential access for delegation)
- joelclaw recall: search (context retrieval)
```

### Loading

ROLE.md is loaded by the agent harness (pi extension or codex config) and appended to the prompt after SOUL.md. The specific role file is selected based on agent context:

- **Pi interactive sessions**: `~/.joelclaw/roles/interactive.md`
- **Gateway daemon**: `~/.joelclaw/roles/gateway.md`
- **Codex exec tasks**: `~/.joelclaw/roles/codex-worker.md` (via `model_instructions_file` or AGENTS.md)
- **Voice agent**: `~/.joelclaw/roles/voice.md`

### Composition

Roles compose with the base SYSTEM.md. The role file can:
- Restrict capabilities (codex worker can't `notify`)
- Add role-specific instructions (gateway delegation rubric)
- Define communication patterns (loop worker must mail before editing)

Roles do NOT:
- Override operating principles
- Change non-negotiable rules
- Modify the capability interface contracts

## Consequences

- SYSTEM.md stays clean and universal — no role-specific content
- Each agent type has clear, documented boundaries
- New agent types get a role file, not a SYSTEM.md fork
- Role files are git-tracked in `~/.joelclaw/roles/` (symlinked from joelclaw repo)
- Gateway's "triage not implementation" rule moves from principle to role
- Codex workers get explicit sandbox and communication requirements
- Voice agent gets scoped capabilities appropriate for phone interaction
