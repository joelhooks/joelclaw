---
title: Agent memory workspace
status: superseded
superseded-by: "[ADR-0021 — Comprehensive agent memory system](0021-agent-memory-system.md)"
date: 2026-02-14
deciders: Joel Hooks
updated: 2026-02-15
---

# ADR-0014: Agent Memory Workspace

## Context and Problem Statement

Agents lose all context between sessions. Shared instructions (`AGENTS.md`) tell agents what to do but not what happened. Without persistent memory files, every session starts from zero.

OpenClaw uses a workspace directory with `MEMORY.md` (curated long-term) and `memory/YYYY-MM-DD.md` (daily logs). The agent reads these at session start and writes updates during and after sessions.

This ADR adapts that model for Joelclaw's multi-harness setup.

## Decision

Adopt a file-based memory workspace at `~/.joelclaw/workspace/` as the canonical cross-session memory mechanism.

### Layout

```
~/.joelclaw/workspace/
|-- MEMORY.md              # Curated long-term memory
`-- memory/
    `-- YYYY-MM-DD.md      # Daily append-only logs
```

### Identity files (separate, version controlled)

```
joelclaw/.agents/
|-- AGENTS.md              # Operating instructions
|-- SOUL.md                # Voice, values, boundaries
|-- IDENTITY.md            # Name, nature
`-- USER.md                # About Joel
```

### Key decisions

- Memory is local state, not source code: `~/.joelclaw/workspace/` is not version controlled.
- Identity is source code: `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md` are version controlled in `joelclaw/.agents/`.
- Symlinks provide one source of truth across harnesses (`~/.agents/`, `~/.pi/agent/`, `~/.claude/`).
- Agents can read and write memory files without approval.
- Session-start protocol: read `SOUL.md` -> `USER.md` -> `MEMORY.md` -> today's daily log.

## Implemented vs Aspirational (as of 2026-02-15)

### Implemented now

- Workspace exists at `~/.joelclaw/workspace/`.
- `MEMORY.md` exists and is actively used.
- Daily log files under `memory/YYYY-MM-DD.md` are in use.
- Memory and identity files are symlinked into active harness paths.
- Session-start read order is documented in `AGENTS.md`.

### Not implemented yet

- Automated daily->`MEMORY.md` compaction pipeline.
- Memory search (keyword/semantic) over workspace memory files.
- Heartbeat-driven memory maintenance.
- Pre-compaction memory flush before context truncation.
- Verification automation that proves all harnesses actually load memory on session start.

## Gaps That Block Acceptance

1. Compaction gap: no repeatable mechanism promotes durable learnings from daily logs into `MEMORY.md`.
2. Search gap: memory retrieval is linear/manual, so old context is effectively lost at scale.
3. Heartbeat gap: no periodic maintenance process to keep memory current.
4. Pre-compaction flush gap: if a long session compacts before writing memory, insights are lost.

## Consequences

### Positive

- Knowledge compounds across sessions using plain markdown.
- No database or service dependency required for baseline persistence.
- Works across harnesses by symlink rather than duplicate files.

### Negative

- Quality depends on disciplined writing/curation.
- Without automation, memory quality degrades over time.
- Missing gaps above make this a working foundation, not a complete system.

## Verification Criteria

Acceptance requires all items below to be true:

- [ ] `~/.joelclaw/workspace/MEMORY.md` and `~/.joelclaw/workspace/memory/` exist and are writable by agents.
- [ ] `~/.agents`, `~/.pi/agent`, and `~/.claude` all resolve to the same canonical memory and identity files via symlinks.
- [ ] Session-start behavior is validated in each harness: `SOUL.md` -> `USER.md` -> `MEMORY.md` -> daily log is read before task work.
- [ ] A compaction workflow exists and is documented (manual checklist or automated job) with a measurable cadence.
- [ ] A memory search path exists (at minimum keyword; target semantic/hybrid) and is callable by agent workflow.
- [ ] A pre-compaction flush mechanism exists to persist durable notes before context compaction.
- [ ] A heartbeat or scheduled process exists for periodic memory maintenance.

## Implementation Stories

### Story A: Baseline integrity checks (short)

- Build a script/checklist to verify workspace paths, file presence, and symlink correctness across harnesses.
- Add a quick "memory health" command or note for routine validation.

### Story B: Pre-compaction memory flush (short)

- Add a compaction-threshold reminder step that writes durable notes to daily memory before context truncation.
- Start with prompt-level behavior; automate only after observed reliability.

### Story C: Compaction pipeline (medium)

- Define a daily/weekly process to distill daily logs into `MEMORY.md`.
- Start as a constrained rubric (promote durable patterns, drop noise).
- Record compaction events in system log or memory maintenance notes.

### Story D: Search (medium)

- Implement minimal keyword search first over memory files.
- Add semantic/hybrid search later through QMD/OpenClaw memory backend once stable.
- Ensure results include source file/line citations.

### Story E: Heartbeat maintenance (medium)

- Add periodic memory hygiene checks (new daily file exists, stale entries flagged, compaction overdue warning).
- Keep it low-noise and auditable.

## References

- [OpenClaw memory docs](~/Code/openclaw/openclaw/docs/concepts/memory.md)
- [OpenClaw AGENTS template](~/Code/openclaw/openclaw/docs/reference/templates/AGENTS.md)
- [Joelclaw AGENTS](~/Code/joelhooks/joelclaw/.agents/AGENTS.md)
- [Joelclaw SOUL](~/Code/joelhooks/joelclaw/.agents/SOUL.md)
- [Workspace memory](~/.joelclaw/workspace/MEMORY.md)
- [Project 08](~/Vault/Projects/08-memory-system/)
