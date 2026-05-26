---
name: signal-friction-scan
displayName: Signal Friction Scan
description: Scan recent agent sessions for repeated friction, corrections, approvals, workflow patterns, and packaging candidates. Use when asked to find signals, friction, recurring manual workflows, missing skills, prompt improvements, or automation opportunities from recent Codex/Pi work.
version: 0.1.0
author: joel
tags:
  - sessions
  - friction
  - skills
  - memory
  - workflow
---

# Signal Friction Scan

Use this to turn recent session history into a grounded shortlist of improvements: skill patches, new skills, docs, runbooks, commands, monitors, automations, or deliberate skips.

This is a **scan and synthesis skill**, not a license to mutate the system immediately. Default to Pass 1: investigate, produce a shortlist, and stop unless Joel explicitly asks to create or patch assets.

## When to Use

Trigger on requests like:

- "scan friction"
- "find repeated workflows"
- "what should we package?"
- "look at recent sessions"
- "find missing skills"
- "turn recent work into skills"
- "what keeps pissing me off?"
- "capture the signal/friction scan process"
- "find prompt/system skill improvements from recent work"

Also use it when a task asks for repeated patterns across recent Codex/Pi work, especially if the output should become durable process.

## Evidence Order

Use available evidence in this order:

1. Local session signals and friction scans.
2. Targeted session searches and bounded extracts for high-signal hits.
3. Existing skills and docs, to avoid duplicates.
4. `.brain/`, vault, ADRs, project docs, and swarm memory when relevant.
5. Source repos, logs, issue trackers, Slack/email/task systems only when needed to verify a candidate.

Chronicle or GUI history is discovery-only. Confirm important details in source systems before recommending mutations.

## Core Commands

Start with local machine facts:

```bash
hostname
pwd
```

Run the broad signal scan:

```bash
joelclaw sessions signals \
  --kind any \
  --source local \
  --machine "$(hostname -s)" \
  --since 30d \
  --limit 40 \
  --evaluate
```

Run a focused friction scan:

```bash
joelclaw sessions friction \
  --source local \
  --machine "$(hostname -s)" \
  --since 30d \
  --limit 30
```

If `hostname -s` does not match the machine id used by session capture, rerun with the observed machine id from recent session paths or known context, for example:

```bash
joelclaw sessions signals --kind any --source local --machine blaine-the-mono --since 30d --limit 40 --evaluate
```

Use targeted searches to triangulate themes:

```bash
joelclaw sessions search workflow --source local --machine <machine> --limit 10
joelclaw sessions search skill --source local --machine <machine> --limit 10
joelclaw sessions search automate --source local --machine <machine> --limit 10
joelclaw sessions search "approved" --source local --machine <machine> --limit 10
joelclaw sessions search "not what i asked" --source local --machine <machine> --limit 10
```

Inspect existing skill coverage:

```bash
find ~/Code/joelhooks/joelclaw/skills -maxdepth 2 -name SKILL.md -print
find ~/Code/joelhooks/joelclaw/skills -maxdepth 2 -name SKILL.md -print \
  | xargs rg -n "friction|signals|workflow-pattern|mode-mismatch|<candidate-term>"
```

Use bounded extracts only for candidates that may become concrete work:

```bash
joelclaw sessions search "<candidate query>" \
  --source local \
  --machine <machine> \
  --limit 5 \
  --extract

joelclaw session inspect <session-id-or-path> \
  --around "<regex>" \
  --before 20 \
  --after 80
```

## How to Read Signals

Treat `sessions signals` as radar, not truth.

Look at:

- `evaluation.bySurface`: where improvements are likely to land.
- `evaluation.byKind`: decision, friction, workflow-pattern, praise, correction, preference.
- `evaluation.byReviewPriority`: high-priority candidates first.
- `clusters`: repeated problem classes.
- `hits[].improvement`: proposed surface, target, confidence, and reason.
- transcript paths, line numbers, dates, and exact user turns.

Do not overfit on single words. Joel's `fuck`, `fucking`, and `fuckin` are emphasis, not automatically anger. Classify by nearby critique, correction, approval, or preference.

Common high-value surfaces:

- `skill`: repeated procedural failure or missing operating method.
- `system-prompt`: cross-cutting response shape, action bias, voice, or boundary issue.
- `docs`: project-local instructions, runbooks, or source summaries.
- `memory`: durable decision or reusable preference.
- `adr`: architecture/process decision that should be ratified.
- `harness`: tool availability, permissions, or runtime mismatch.

## Candidate Criteria

Only recommend packaging when most of these are true:

- repeated at least twice, or clearly likely to recur and costly to repeat
- stable inputs
- repeatable procedure
- clear output or stopping condition
- material improvement to speed, quality, consistency, reliability, or discoverability
- not already adequately covered
- validation is possible
- scope can stay narrow

Skip candidates that are one-off, speculative, too broad, mostly taste, private-sensitive, poorly evidenced, or already covered well enough.

## Existing Asset Check

Before proposing a new skill, inspect for existing coverage:

- canonical skills in `~/Code/joelhooks/joelclaw/skills`
- project-local `.pi/skills`, `.agents/skills`, and `.brain`
- scripts, CLIs, Inngest functions, monitors, GitHub Actions
- ADRs, runbooks, and project docs

Prefer **extend existing** over creating a duplicate. New skills are for missing reusable workflows, not every interesting pattern.

## Output Shape

For Pass 1, return only a shortlist and recommendations. Do not edit files.

Use this shape:

```markdown
**Evidence Inspected**

- Commands run and notable counts.
- Existing assets checked.
- Sources unavailable or failed.

**Shortlist**

| Candidate | Evidence | Frequency / Confidence | Pain | Recommended Form | Existing Assets | Recommendation |
|---|---|---:|---:|---|---|---|

**Highest-Confidence Recommendations**

1. <candidate>
   Why:
   Scope:
   Validation:

**Deliberately Skipped**

- <candidate and reason>

**Needs More Evidence**

- <candidate and exact missing evidence>

**Validation Performed**

- No files modified, unless explicitly requested.
- Commands run and their results.
```

Keep the report compact. Lead with the useful answer, then receipts.

## Pass 2 Creation Rules

Only create or patch assets when Joel explicitly asks for Pass 2 or asks to capture a specific candidate.

When creating:

- Use the smallest form: patch existing skill/doc before creating new.
- Keep the artifact narrow, source-aware, and easy to validate.
- Do not include raw transcript dumps.
- Do not capture secrets, private overlays, paid corpus text, or irrelevant machine config.
- Include exact commands and fallback behavior where possible.
- Run validation commands or explain why no validation exists.
- Inspect `git status --short` first and preserve unrelated user work.

For a new joelclaw skill, follow `add-skill`: create under `~/Code/joelhooks/joelclaw/skills/<name>`, keep frontmatter `name` matching the directory, symlink only where needed, slog if available, and commit only if Joel asks or the current workflow requires it.

## Failure Handling

- If `joelclaw sessions signals` emits huge output or times out after useful JSON, use the emitted counts/clusters and say it timed out.
- If `slog` is unavailable, say so and continue.
- If local machine session capture is thin, search Typesense or the relevant remote machine via `session-search`.
- If evidence is thin, say the evidence is thin. Do not fabricate patterns.
