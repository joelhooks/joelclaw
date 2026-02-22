---
status: implemented
date: 2026-02-20
decision-makers: joel
consulted: agent
tags: [vault, cli, voice, search, agent-tools]
---

# ADR-0081: Vault CLI & Agent Tool Access

## Context

Agents interact with the Vault through ad-hoc file reads and `recall` (Qdrant semantic search). There's no unified CLI for vault operations, forcing agents to know filesystem paths, ripgrep flags, and Qdrant API details. The vault resolver in `packages/gateway/src/vault-read.ts` (ADR-0080) proved the pattern — resolve human-friendly references to file content.

The voice agent (LiveKit SIP, ADR-0043) needs scoped vault access via tools but shouldn't have raw filesystem access.

## Decision

Add `joelclaw vault` CLI commands and wire them as voice agent tools.

### CLI Commands

| Command | Purpose |
|---------|---------|
| `joelclaw vault read <ref>` | Resolve + read — ADR refs, project refs, paths, fuzzy |
| `joelclaw vault search <query>` | Ripgrep text search across vault |
| `joelclaw vault search --semantic <query>` | Qdrant vector search |
| `joelclaw vault ls [section]` | List projects, decisions, inbox, resources |
| `joelclaw vault tree` | PARA structure overview |

### Voice Agent Tools

| Tool | Shells to |
|------|-----------|
| `vault_read` | `joelclaw vault read <ref>` |
| `vault_search` | `joelclaw vault search <query>` |
| `vault_list` | `joelclaw vault ls <section>` |

### Design Principles

1. **CLI-first**: Voice tools shell to `joelclaw vault`, no direct file access
2. **Scoped**: Voice agent can read vault content but not write
3. **Smart resolution**: ADR-0077 → file, "memory system" → fuzzy match, exact paths work too
4. **Truncated output**: Large files capped at 500 lines for context windows
5. **HATEOAS JSON**: All commands return structured output with next_actions

## Consequences

- Voice agent gains vault knowledge without raw filesystem access
- All agents benefit from unified vault CLI (gateway, codex, pi sessions)
- Fuzzy matching may return wrong file — next_actions suggest refinement
- Semantic search depends on Qdrant being up (graceful fallback to ripgrep)
- Future: `joelclaw vault write` for creating notes, updating frontmatter
