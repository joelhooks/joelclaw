# ADR-0172: Agent Mail via MCP Agent Mail

**Status:** proposed  
**Date:** 2026-02-28  
**Deciders:** Joel Hooks  
**Supersedes:** None  
**Related:** ADR-0169 (CLI capability contracts), ADR-0170 (agent role system), ADR-0171 (system prompt architecture)

## Context

Multiple agents (gateway, codex workers, loop workers, interactive pi) operate on the same codebase simultaneously. Without coordination:

- Agents overwrite each other's edits
- File conflicts cause silent data loss
- No way to communicate task status or friction between agents
- Branch-based isolation creates worktree management overhead Joel calls "a huge problem"

Joel identified `Dicklesworthstone/mcp_agent_mail` as the coordination layer. It's an MCP HTTP server providing:

- Agent identity registration (memorable names)
- Inbox/outbox messaging with GFM markdown
- Advisory file reservations (leases) to signal edit intent
- Searchable, threaded message history
- Git-backed audit trail (human-readable artifacts)
- SQLite indexing for fast queries

## Decision

### Adopt mcp_agent_mail as the `joelclaw mail` adapter

Per ADR-0169 (CLI capability contracts), `joelclaw mail` is a port with a swappable adapter. The first adapter wraps mcp_agent_mail's HTTP API.

### Architecture

```
joelclaw mail send → CLI command
  → MailPort interface (ADR-0169)
    → McpAgentMailAdapter
      → HTTP POST to mcp_agent_mail server (:8765)
        → SQLite + Git storage
```

### Why this project

1. **MCP-native** — standard protocol, not proprietary API
2. **File reservations** — advisory leases prevent edit conflicts, exactly what loop workers need
3. **Git-backed** — every message and reservation is auditable
4. **Actively maintained** — large test suite, Docker support, multi-agent design
5. **Agent-agnostic** — works with any MCP client (Claude Code, Codex, Gemini, etc.)

### Why NOT build from scratch

Joel has `agent_mail` and `swarm-tools/swarm-mail` as prior art. mcp_agent_mail subsumes both with a more complete implementation (identity management, file reservations, search, threading).

### Integration plan

**Phase 1: CLI wrapper** (ADR-0169 port)
- `joelclaw mail register` — register agent identity
- `joelclaw mail send <to> <message>` — send message
- `joelclaw mail read [--unread]` — read inbox
- `joelclaw mail reserve <path>` — claim file reservation
- `joelclaw mail release <path>` — release reservation
- HATEOAS JSON envelope on all responses

**Phase 2: Pi extension tool**
- Register `mail` as pi tool via `pi.registerTool()`
- Tool shells to `joelclaw mail` under the hood
- Available to all pi sessions (gateway, interactive)

**Phase 3: Pipeline integration**
- Loop workers (ADR-0170) must `reserve` before editing, `release` after commit
- Story pipeline checks reservations before dispatching to workers
- Conflict detection: fail-fast if reserved by another agent

### AT Protocol migration path

The `MailPort` interface (ADR-0169) is designed for adapter swapping:

```toml
# Phase 1: mcp_agent_mail
[capabilities.mail]
adapter = "mcp-agent-mail"
endpoint = "http://127.0.0.1:8765"

# Future: AT Protocol PDS
[capabilities.mail]
adapter = "atproto-pds"
pds_endpoint = "http://localhost:3000"
lexicon = "dev.joelclaw.agent.mail"
```

The port interface stays stable. Only the adapter changes. Agent code never knows which backend is active.

## Consequences

- Agents can coordinate without shared branches or worktrees
- File reservations prevent silent edit conflicts
- All agent communication is auditable via git
- `joelclaw mail` becomes mandatory in SYSTEM.md principles (already done)
- mcp_agent_mail server must be running for agent coordination (add to health checks)
- AT Proto migration is a config change, not a rewrite
