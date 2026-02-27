---
status: accepted
date: 2026-02-27
tags: [skills, automation, maintenance, inngest]
related: [0144-gateway-hexagonal-architecture]
---

# ADR-0158: Automated Skill Gardening

## Context

The joelclaw system has 51+ skills in `skills/` that serve as institutional memory for agents. These skills reference specific architecture details (k8s versions, pod names, CLI commands, function counts, file paths) that drift as the system evolves.

On 2026-02-27, a manual audit found:
- 29 dead agent tool directories in the repo
- 8 broken symlinks across home skill directories
- 9 skills as REAL DIRs in `~/.pi/agent/skills/` instead of symlinks to repo
- `joelclaw` skill referencing k3d/k3s (replaced by Talos months ago), 16 functions (now 110+), missing 10+ CLI commands
- `sync-system-bus` skill missing ADR-0156 drain-then-restart protocol
- 6 inngest-* skills were dead symlinks to a deleted directory

Skills rot silently. Agents using stale skills produce subtly wrong output. Manual reviews happen only when something breaks visibly.

## Decision

### Daily structural check (cron)

An Inngest function `skill-garden` runs daily and checks:

1. **Broken symlinks** — scan `~/.agents/skills/`, `~/.pi/agent/skills/`, `~/.claude/skills/` for dead links
2. **Non-canonical REAL DIRs** — find directories in home skill dirs that should be symlinks to `skills/`
3. **Missing frontmatter** — skills in `skills/` without required SKILL.md frontmatter (name, description)
4. **Pattern-based staleness** — grep skills for known stale references:
   - Dead infrastructure: `k3d`, `k3s`, `qdrant` (removed), `launchctl.*system-bus` (now k8s)
   - Stale paths: `~/Code/system-bus-worker`, `~/Code/joelhooks/igs`
   - Version drift: hardcoded k8s/Talos versions that no longer match reality
5. **Orphan detection** — skills in repo `skills/` with no symlink from any home dir

Reports findings via OTEL event. If issues found, sends a gateway notification. Zero noise on clean days.

### Monthly LLM deep review (1st of month)

Same cron function, but on the 1st of each month, additionally:
- Reads current `AGENTS.md` as ground truth
- For each skill, uses `pi` inference to compare skill content against system reality
- Flags skills that describe workflows, architecture, or tooling that has changed
- Produces a structured report with specific stale passages and suggested updates

### CLI surface

`joelclaw skills audit` runs the same checks on-demand, returning a HATEOAS JSON report.

## Consequences

### Positive
- Skill rot detected within 24 hours of the change that caused it
- Monthly deep review catches subtle drift that patterns miss
- CLI command enables pre-merge skill validation
- Zero noise — only alerts when findings exist

### Negative
- Monthly LLM review costs inference tokens (mitigated: one `pi` call per skill, ~51 calls/month)
- Pattern list needs maintenance as infrastructure changes (but this is the skill's own job)
- False positives possible on pattern matches (e.g., skill mentions k3d in a "we migrated from k3d" note)

### Operational
- New function: `skill-garden` in `packages/system-bus/src/inngest/functions/`
- New CLI command: `joelclaw skills audit`
- New skill: `skills/skill-review/SKILL.md`
- OTEL events: `skill-garden.check`, `skill-garden.findings`
