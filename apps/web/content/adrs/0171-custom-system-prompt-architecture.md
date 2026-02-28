# ADR-0171: Custom System Prompt Architecture

**Status:** accepted  
**Date:** 2026-02-28  
**Deciders:** Joel Hooks  
**Supersedes:** None  
**Related:** ADR-0163 (adaptive prompt architecture), ADR-0170 (agent role system), ADR-0169 (CLI capability contracts)

## Context

joelclaw agents run on multiple harnesses — pi (interactive + gateway), Codex (autonomous workers), and potentially others. Each harness has its own default system prompt. Without a unified, custom prompt, agents lack shared operating principles, don't know about joelclaw's capabilities, and can't coordinate.

Pi supports full system prompt replacement via `~/.pi/agent/SYSTEM.md`. Codex supports it via `model_instructions_file` in `~/.codex/config.toml`. Both are open source and monitored daily.

## Decision

### Single canonical system prompt

`joelclaw/SYSTEM.md` is the source of truth. All harness-specific paths are symlinks or config pointers:

- **Pi**: `~/.pi/agent/SYSTEM.md` → symlink to `joelclaw/SYSTEM.md`
- **Codex**: `~/.codex/config.toml` → `model_instructions_file = "/Users/joel/Code/joelhooks/joelclaw/SYSTEM.md"`

### Prompt composition chain

The full prompt seen by any agent is:

```
SYSTEM.md          — platform principles, capabilities, non-negotiables
  → IDENTITY.md    — agent name, nature (appended by harness)
  → SOUL.md        — voice, values, agency framework (appended by harness)
  → ROLE.md        — role boundaries (ADR-0170, selected by context)
  → USER.md        — user preferences, communication style
  → TOOLS.md       — content publishing, revalidation routes
  → AGENTS.md      — per-directory project instructions
  → skills         — on-demand via read tool
```

### Prime directive

The prompt opens with `# IMPROVE THE SYSTEM` — agents are always looking for ways to make joelclaw more reliable, observable, and autonomous. This is not aspirational; it's the prime directive.

### Design principles

1. **Identity-agnostic** — SYSTEM.md contains no agent name, voice, or user details. Those live in layered files.
2. **CLI-centric** — All capabilities reference `joelclaw` CLI commands. The CLI is the interface contract.
3. **Skill-demanding** — Inngest work requires loading inngest skills. This is enforced in the prompt.
4. **Communication-mandatory** — `joelclaw mail` for agent coordination is a principle, not optional.
5. **Harness-documented** — "How to Modify Pi" and "How to Modify Codex" sections give agents self-knowledge about their own customization surface.

### What SYSTEM.md contains

- Operating principles (9 rules)
- System capabilities (`joelclaw` CLI commands with interface contracts)
- Non-negotiable rules (inference policy, fabrication ban, hexagonal arch)
- How to modify joelclaw (docs pointers, identity files, documentation mandate)
- How to modify Codex (config override, AGENTS.md, skills, personalities)
- How to modify Pi (prompt composition, extensions, skills, sessions, tools)
- Deep repository analysis protocol (autopsy methodology)

### What SYSTEM.md does NOT contain

- Agent identity (→ IDENTITY.md)
- Voice and values (→ SOUL.md)
- Role boundaries (→ ROLE.md per ADR-0170)
- User preferences (→ USER.md)
- Implementation details (no `pi -p --no-session` internals)
- Specific lint/build commands (replaced with "commit your work every time")

## Consequences

- All joelclaw agents share the same operating principles regardless of harness
- New harnesses (future: opencode, custom) just need a config pointer to SYSTEM.md
- Identity is composable — same system prompt, different roles
- Prompt changes are git-tracked, reviewable, and instantly deployed via symlink
- Codex workers now get the full joelclaw context (capabilities, principles, skills)
- The "IMPROVE THE SYSTEM" directive means every agent session is an improvement opportunity
