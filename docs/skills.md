# Skills

Canonical guide for creating, updating, and maintaining joelclaw skills.

Skills are joelclaw's institutional memory. If a workflow is repeatable, non-obvious, and likely to come up again, it should become a skill instead of living as tribal knowledge in one session transcript.

ADR anchors:

- **ADR-0165** — taxonomy-aware skill retrieval
- **ADR-0179** — automated skill gardening

## Canonical Contract

- Source of truth: `~/Code/joelhooks/joelclaw/skills/`
- Consumer dirs are symlinks into the repo:
  - `~/.agents/skills/<name>`
  - `~/.pi/agent/skills/<name>`
  - optionally `~/.claude/skills/<name>` when that harness is in use
- Never author skill content in dot directories. Those are consumers, not sources.
- Directory name must match the `name:` field in `SKILL.md`.
- Skills are git-tracked. If the skill matters, commit it.

## When to Create a Skill

Create or update a skill when:

- a workflow has already repeated twice
- an operational gotcha would waste future-you 30 minutes
- a maintainer, API, or system constraint needs to be remembered verbatim
- a domain has enough moving parts that a generic agent will otherwise relearn it badly
- a session produced a clear "don't do that again" lesson

Recent examples:

- `skills/contributing-to-pi/` captures the upstream contribution discipline we should have applied before filing `badlogic/pi-mono` issue #1899.
- `skills/joel-writing-style/` captures the public joelclaw.com prose constraints so site articles stop relying on fuzzy vibe-matching.
- `skills/workflow-rig/` is now the canonical front door for ADR-0217 workload planning, runtime mode selection, workflow-rig dogfood, and `joelclaw workload run` invocation.
- `skills/agent-workloads/` remains as a compatibility alias for older prompts that still name the legacy front door.
- `skills/restate-workflows/` remains the substrate bridge compatibility alias for cross-repo ADR-0217 handoff patterns after workload planning is already clear.

## Required Shape

Every skill needs `skills/<name>/SKILL.md` with frontmatter:

```yaml
---
name: skill-name
displayName: Human Readable Name
description: "What this skill does and when to use it. Include trigger phrases."
version: 1.0.0
author: Joel Hooks
tags: [relevant, tags]
---
```

After frontmatter, write instructions for another agent, not for Joel. Include:

- when to use the skill
- non-obvious rules and constraints
- concrete commands or workflows
- failure modes and anti-patterns
- checklists when appropriate
- optional `references/` docs when the skill needs deeper research notes, templates, or API specifics without bloating `SKILL.md`

## Add a Skill

1. Create the canonical repo directory.
2. Write `SKILL.md`.
3. Install/repair the consumer symlinks with `joelclaw skills ensure <name>`.
4. If the skill changes system reality or closes a doc gap, update `docs/` in the same session.
5. Slog the change.
6. Commit it.

Example:

```bash
mkdir -p ~/Code/joelhooks/joelclaw/skills/<name>
joelclaw skills ensure <name>
```

`joelclaw skills ensure` is the canonical local-repo install/maintenance surface for skills that already live in a repo `skills/` directory. It creates missing consumer symlinks and repairs wrong symlinks in:

- `~/.agents/skills/`
- `~/.pi/agent/skills/`
- `~/.claude/skills/`

If the skill is **external** and does not live in a local repo `skills/` directory, use the upstream installer instead:

```bash
npx skills add -y -g <source>
```

## Update a Skill

Update a skill the same session that reality changes.

Common triggers:

- architecture changed
- CLI flags changed
- deploy workflow changed
- path or package names changed
- a maintainer clarified an expectation
- a postmortem exposed a missing checklist

If a skill is stale, it is actively harmful.

## Quality Bar

A good skill is:

- specific
- operational
- terse
- honest about failure modes
- explicit about the real next move after approval (execute inline, tighten scope, dispatch, or stop)
- written from actual evidence, not vibes

A bad skill is:

- generic advice
- cargo-culted commands
- aspirational future-state pretending to be current reality
- missing trigger phrases
- detached from the repo's real paths and tools

## Discovery and Maintenance

Use the existing tooling:

- `joelclaw skills ensure <name> [--source-root <repo>]` — install or repair local repo skills in consumer dirs
- `joelclaw skills audit` — run the skill garden checks on demand
- `skills/skill-review/SKILL.md` — maintenance workflow
- `skills/add-skill/SKILL.md` — canonical add-skill process

The skill garden exists because stale skills silently rot the system. Keep the garden clean.
