# Agent Instructions

## Model Policy

- Codex tasks MUST use `gpt-5.3-codex`.
- If model is unspecified, set `model: "gpt-5.3-codex"`.

## Current System Snapshot

- Primary repo: `~/Code/joelhooks/joelclaw`
- Vault (source of truth): `~/Vault`
- Decision records: `~/Vault/docs/decisions/`
- System log JSONL: `~/Vault/system/system-log.jsonl`
- Repo skills (authoritative): `~/Code/joelhooks/joelclaw/skills`
- Skill links (consumers): `~/.agents/skills`, `~/.pi/agent/skills`, `~/.claude/skills`

Operational architecture (current):
- Event/workflow core: Inngest + system-bus worker
- Gateway: Redis-backed session/event bridge + Telegram integration
- Observability: OTEL-style events -> Typesense (`otel_events`) + Convex/UI surfaces
- Web: joelclaw.com in `apps/web`, including `/system` and `/system/events`

## Core Rules

1. Use CLI surfaces first (not plumbing)
- Prefer `joelclaw` and `slog` over raw `launchctl`, `curl`, direct Redis edits, or ad hoc log greps.
- Only drop to plumbing when CLI lacks required capability.

2. Observability is mandatory
- Silent failures are bugs.
- Emit or preserve structured telemetry for pipeline/function/service work.
- Verify behavior with `joelclaw otel list|search|stats` and relevant status commands.

3. Log system changes
- For installs/config mutations/ops changes, append a `slog` entry.
- Example:
```bash
slog write --action configure --tool gateway --detail "rotated webhook secret lease" --reason "signature failures"
```

4. Keep skills current with the system
- When operational reality changes, update skills in `~/Code/joelhooks/joelclaw/skills`.
- Maintain Codex desktop metadata on every repo skill:
  - `agents/openai.yaml`
  - `assets/small-logo.svg`
  - `assets/large-logo.png`
  - SKILL frontmatter: `name`, `displayName`, `description`, `version`, `author`, `tags`

5. Treat repo skills as source, home dirs as links
- Repo skill directories are canonical.
- `~/.agents/skills`, `~/.pi/agent/skills`, `~/.claude/skills` should symlink out to repo skills.
- External/third-party skill packs should remain external (system/global install), not copied into repo unless intentionally curated.

6. Prefer safe git workflows
- Do not use destructive commands (`git reset --hard`, force-checkout) unless explicitly requested.
- Never discard user changes without consent.

## Standard Operational Commands

Health and status:
```bash
joelclaw status
joelclaw inngest status
joelclaw gateway status
```

Worker/registration lifecycle:
```bash
joelclaw inngest sync-worker --restart
joelclaw refresh
```

Gateway operations:
```bash
joelclaw gateway events
joelclaw gateway test
joelclaw gateway restart
joelclaw gateway stream
```

Observability:
```bash
joelclaw otel list --hours 1
joelclaw otel search "<query>" --hours 24
joelclaw otel stats --hours 24
```

Runs and triage:
```bash
joelclaw runs --count 10 --hours 24
joelclaw run <run-id>
joelclaw logs worker --lines 80
joelclaw logs errors --lines 120
```

## Efficient Prompting

Use this format for high-signal requests:

```md
Goal: <single concrete outcome>
Context: <repo/path/runtime facts>
Constraints: <time/risk/tool limits>
Do:
- <task 1>
- <task 2>
Deliver:
- <exact artifact paths>
- <verification commands + expected signals>
```

Prompting heuristics:
- State exact paths and systems (`apps/web`, `packages/system-bus`, `skills/<name>`).
- Request executable verification, not just code changes.
- Ask for diffs plus brief risk notes when touching infra or workflows.
- For operational work, ask for rollback or recovery command.
- Prefer “do it now + validate” over brainstorming when implementation is intended.

Fast iteration pattern:
1. Ask for a short plan.
2. Ask to execute immediately.
3. Require verification output summary.
4. Decide next step from findings.

## Output Contract (for agents)

When returning results:
- Lead with what changed.
- List touched absolute paths.
- Include validation commands run and key outcomes.
- Note blockers explicitly.
- Suggest the smallest meaningful next actions.

## ADR and Vault Discipline

When architecture/behavior changes:
- Update or add ADRs in `~/Vault/docs/decisions/`.
- Keep project status in Vault current.
- Keep this AGENTS file aligned with reality.

## Notes

- `skills/` in the joelclaw repo is **sacred and fully tracked**. Every custom skill must be committed. Never gitignore this directory.
- If command contracts change in `packages/cli`, update dependent skills the same session.
