---
name: skill-cleaner
displayName: Skill Cleaner
description: "Audit Joel's Pi/joelclaw skills: loaded roots, duplicates, stale or unused skills, prompt-budget cost, and compact descriptions. Use when trimming skill prompt budget, finding duplicate skills, or deciding which skill copy should be canonical."
version: 0.1.0
author: Joel Hooks, adapted from Peter Steinberger's agent-scripts skill-cleaner
tags: [joelclaw, pi, skills, maintenance, prompt-budget]
---

# Skill Cleaner

Use this when trimming skill prompt budget, finding duplicate skills, auditing enabled/disabled skill roots, or deciding which skills/plugins to remove.

This is adapted for Joel's system from Peter Steinberger's `agent-scripts` `skill-cleaner` skill.

## Joel System Contract

- Canonical joelclaw skills live in `~/Code/joelhooks/joelclaw/skills/`.
- Consumer skill dirs should usually symlink into canonical skills:
  - `~/.pi/agent/skills/<name>`
  - `~/.agents/skills/<name>`
  - `~/.claude/skills/<name>`
- External skill packs may live under `~/.pi/agent/git/`, `~/.pi/agent/npm/node_modules/`, or extension directories. Do **not** copy those into joelclaw unless Joel explicitly wants a curated fork.
- Preserve project-local skills and repo policy even when they look redundant. They often encode operational truth.

## Workflow

1. Run the analyzer from this skill directory or the joelclaw repo root:

```bash
node --experimental-strip-types skills/skill-cleaner/scripts/skill-cleaner.ts --months 3
```

Useful variants:

```bash
node --experimental-strip-types skills/skill-cleaner/scripts/skill-cleaner.ts --no-logs
node --experimental-strip-types skills/skill-cleaner/scripts/skill-cleaner.ts --months 6 --max-log-mb 800 --deep-logs
node --experimental-strip-types skills/skill-cleaner/scripts/skill-cleaner.ts --context-tokens 272000 --budget-percent 2 --no-logs
node --experimental-strip-types skills/skill-cleaner/scripts/skill-cleaner.ts --root ~/Code/badass-courses/skills --no-logs
node --experimental-strip-types skills/skill-cleaner/scripts/skill-cleaner.ts --json --no-logs
```

2. Read the report in this order:

- `Skill Budget`: GPT-5.5-ish context size, 2% skill budget, model-budgeted usage, and pre-budget full-list pressure.
- `Description candidates`: long descriptions where tighter plain language saves prompt budget.
- `Duplicates`: same skill name or near-identical description/body across Pi, joelclaw canonical, external packs, Codex, and project roots.
- `Unused candidates`: no recent `$skill` mention, `SKILL.md` read, or explicit skill-use trace in recent Pi/Codex/Claude logs.
- `Root summary`: where skills came from and whether config marks them disabled.

3. Before deleting or editing:

- Verify the kept copy exists and is loaded.
- Prefer canonical joelclaw repo copies for Joel-owned operational skills.
- Prefer external package copies for third-party skills unless we intentionally forked them.
- Preserve trigger nouns in descriptions: product, tool, action, object.
- Never delete ignored/untracked skill dirs without naming the destination or confirming they are disposable.

## Analyzer Notes

- The script mirrors model-visible skill list line shape: `- name: description (file: path)`.
- It applies Codex/Pi-like frontmatter rules: YAML frontmatter only, default name from parent dir, single-line sanitized `name` and `description`.
- It follows the common 2% of raw `context_window` prompt-budget heuristic, token cost `ceil(utf8_bytes / 4)`, then full descriptions -> equal description truncation -> omitted minimum lines.
- It searches `~/.pi/models_cache.json` then `~/.codex/models_cache.json`; fallback is 272,000 tokens and 95% effective context.
- It scans Joel's normal skill roots by default: joelclaw canonical, Pi user skills, agents skills, Claude skills, Pi git/npm/extension skills, plus legacy Codex roots.
- Extra folders such as project-specific skill roots are included only with `--root <path>`.
- It realpath-dedupes roots, so symlinked roots do not create false duplicates.
- For duplicate names, it reports description/body similarity and suggests deletion candidates only when bodies are near copies.
- Usage evidence is heuristic: `$skill`, `Use $skill`, and paths like `skills/<name>/SKILL.md` in recent logs.

## Output Policy

- Suggest first; edit only when the user asks.
- If asked to apply cleanup, make small grouped commits: descriptions, deletes, config disables.
- Do not delete ignored/untracked skill dirs without naming the destination or confirming they are disposable.
- For broad cleanup, pair this with `skill-review` and keep the parent agent as the decision-maker. No silent axe murder. 🐀
