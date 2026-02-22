---
status: shipped
date: 2026-02-19
tags: [skills, attribution, distribution, joelclaw]
---

# ADR-0057: Skill Pack Distribution — Install from Source

## Context

The joelclaw monorepo had 49 third-party skills (52,224 lines) committed directly into `.agents/skills/` and symlinked to `.claude/skills/`. These skills were authored by external projects — CharlesWiltgen/Axiom, coreyhaines31/marketingskills, vercel-labs, inngest, ehmo, withgraphite, axiomhq — but appeared to originate from joelclaw.

People cloning or browsing joelclaw on GitHub were installing skills via `npx skills add joelhooks/joelclaw` instead of from the canonical repos. This meant:

1. **Lost attribution** — original authors got no install credit on skills.sh
2. **Stale copies** — bundled skills diverged from upstream as authors shipped updates
3. **Repo bloat** — 52K lines of content joelclaw doesn't own or maintain

## Decision

Third-party skills are never committed to the joelclaw repo. Instead:

1. **`skillpacks.json`** — A manifest at repo root listing recommended skill packs with canonical source repos, URLs, descriptions, and skill names.
2. **`install-skills.sh`** — A shell script that reads the manifest and runs `npx skills add <repo> --yes --all` for each pack, installing from the original author's repo.
3. **`.gitignore`** — Third-party skill directories are gitignored. Custom joelclaw skills (10) are allowlisted and remain tracked.

Users run `./install-skills.sh` after cloning, or `./install-skills.sh <pack-name>` for specific packs.

## Packs (as of 2026-02-19)

| Pack | Repo | Skills | Author |
|------|------|--------|--------|
| inngest | inngest/inngest-skills | 6 | Inngest |
| vercel-react | vercel-labs/agent-skills | 3 | Vercel |
| vercel-next | vercel-labs/next-skills | 3 | Vercel |
| axiom | CharlesWiltgen/Axiom | 64+ | Charles Wiltgen |
| marketing | coreyhaines31/marketingskills | 20+ | Corey Haines |
| platform-design | ehmo/platform-design-skills | 4+ | ehmo |
| graphite | withgraphite/agent-skills | 1 | Graphite |
| axiom-observability | axiomhq/skills | 5 | Axiom (observability) |
| skills-meta | vercel-labs/skills | 1 | Vercel |

## Custom Skills (tracked in repo)

cli-design, discovery, docker-sandbox, gateway-setup, inngest-local, joel-writing-style, joelclaw-system-check, recall, task-management, video-note.

## Consequences

### Positive
- Original authors get proper install attribution on skills.sh
- Skills stay up-to-date — `npx skills update` pulls latest from source
- Repo is 52K lines lighter
- Clear separation: joelclaw's skills vs. recommended third-party

### Negative
- Extra step after clone (`./install-skills.sh`)
- `--all` flag installs to every agent directory (`.cursor/`, `.cline/`, etc.) — gitignore handles this but it's messy on disk

### Implementation Notes
- `npx skills add` inside a bash `while read` loop steals stdin — must use `</dev/null` redirect
- The manifest lists specific skill names per pack for documentation, but the installer uses `--all` to get the full repo (authors add new skills over time)
