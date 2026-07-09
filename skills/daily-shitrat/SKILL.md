---
name: daily-shitrat
displayName: Daily SHITRAT
description: Operate, inspect, and optimize the Daily SHITRAT loop. Use when running Daily SHITRAT, reviewing a Daily SHITRAT attempt, doing a Daily SHITRAT Dream/optimizer pass, checking brain daily artifacts, fixing report/Discord metadata, or preparing ShitRat-authored PR plans.
version: 0.1.0
author: joel
tags:
  - joelclaw
  - brain
  - daily
  - shitrat
  - automation
  - optimizer
---

# Daily SHITRAT

Operate the Daily SHITRAT loop and its optimizer pass without losing the trail.

This skill has two modes:

- **Daily run**: inspect or execute a real `brain daily` attempt.
- **Dream/optimizer pass**: review the latest run and write separate optimizer artifacts. The Dream pass does not create a new daily attempt.

## When to Use

Use this skill when the user says any of:

- "Daily SHITRAT"
- "SHITRAT Dream"
- "daily brain run"
- "brain daily"
- "latest sealed attempt"
- "daily run optimizer"
- "daily-shitrat-run-optimizer"
- "fix the Daily SHITRAT loop"
- "why did the daily report/Discord publish break?"

## Source Paths

| Purpose | Path |
|---|---|
| Daily automation memory | `/Users/joel/.codex/automations/daily-shitrat-agent-turn/memory.md` |
| Optimizer memory | `/Users/joel/.codex/automations/daily-shitrat-run-optimizer/memory.md` |
| Daily data root | `/Users/Shared/joelclaw/data/brain-daily` |
| Optimizer outputs | `/Users/Shared/joelclaw/data/brain-daily/optimizer/YYYY-MM-DD/` |
| Brain CLI repo | `/Users/joel/Code/joelhooks/joelclaw-brain` |
| Discord bridge repo | `/Users/joel/Code/joelhooks/pi-discord-threads` |
| Codex sessions | `/Users/joel/.codex/sessions/**/rollout-*.jsonl` |

Resolve Codex memory with a default. An unset `CODEX_HOME` is not evidence that memory is missing:

```bash
CODEX_HOME="${CODEX_HOME:-/Users/joel/.codex}"
DAILY_MEMORY="$CODEX_HOME/automations/daily-shitrat-agent-turn/memory.md"
```

## Hard Rules

- Do not run `brain daily start` unless Joel explicitly asks for a new Daily SHITRAT attempt.
- For Dream/optimizer work, treat the daily memory as read-only input. Write separate output artifacts under `brain-daily/optimizer/YYYY-MM-DD/`.
- Do not call Managed Agents, Anthropic Dreams, or any connected memory-store API unless Joel explicitly configures that later.
- Do not mutate product/customer-facing repos during optimizer work.
- Do not merge, deploy, or make GitHub writes as Joel.
- For GitHub-visible work, prepare ShitRat-authored PR plans and use ShitRat dry-run first.
- If an attempt is already running or sealed, reuse it. Do not create duplicate attempts or duplicate Discord starts.
- Do not open duplicate VISION PRs. Reference existing PRs when they already cover the work.

## Daily Run Workflow

1. Inspect current state before doing anything:

```bash
brain daily latest --base-dir /Users/Shared/joelclaw/data/brain-daily
find /Users/Shared/joelclaw/data/brain-daily -maxdepth 3 -name latest.json -print
```

2. If a run exists for the day, reuse it. If it is sealed, inspect, repair metadata, or publish reports; do not start another attempt unless Joel asked for that exact action.

3. Read input memory before broad scans:

```bash
CODEX_HOME="${CODEX_HOME:-/Users/joel/.codex}"
sed -n '1,220p' "$CODEX_HOME/automations/daily-shitrat-agent-turn/memory.md"
```

4. Append an early useful receipt within 120 seconds. During broad repo scans, restores, transcript archaeology, or report repair, append progress receipts at least every 180 seconds:

```bash
brain daily progress \
  --phase scan \
  --status active \
  --summary "Read input memory and latest manifest; inspecting sealed attempt metadata"
```

Progress receipts must say what was read, decided, blocked, repaired, or verified. `scan-started` alone is too weak.

5. Keep ledger sequence contiguous. Before sealing, verify `brain-dump.jsonl`, checksum, manifest, report metadata, and latest pointer.

6. Prefer `brain daily finish --publish-report` for a normal completion. It should be robust if another actor sealed first: inspect the sealed attempt, merge final Discord metadata, and re-render/re-publish report metadata instead of failing the loop.

## Dream / Optimizer Workflow

Dream work is a local analog of the "read input memory, write output memory" pattern. It is not an Anthropic Dreams API call.

1. Inspect inputs first:

```bash
CODEX_HOME="${CODEX_HOME:-/Users/joel/.codex}"
sed -n '1,260p' "$CODEX_HOME/automations/daily-shitrat-agent-turn/memory.md"
test -f "$CODEX_HOME/automations/daily-shitrat-run-optimizer/memory.md" && sed -n '1,260p' "$CODEX_HOME/automations/daily-shitrat-run-optimizer/memory.md"
find /Users/Shared/joelclaw/data/brain-daily -maxdepth 3 -name latest.json -print
```

2. Identify the latest sealed attempt and inspect:

- `manifest.json`
- `brain-dump.jsonl`
- `brain-dump.sha256`
- `wzrrd-report/index.html`
- receipt JSON/Markdown files
- Discord request/response files
- matching Codex rollout transcript

3. Use transcript summaries before raw transcript reads:

```bash
cd /Users/joel/Code/joelhooks/joelclaw-brain
bun run src/main.ts daily transcript-summary \
  --session /Users/joel/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl \
  --max-outputs 8 \
  --suspicious-output-token-threshold 1000
```

Expand raw rollout ranges only when the summary points to a suspicious command, final message, `brain daily` command, receipt gap, or oversized output. Do not dump huge transcript chunks by default.

4. Write optimizer outputs under:

```text
/Users/Shared/joelclaw/data/brain-daily/optimizer/YYYY-MM-DD/
```

Required files:

- `dream-memory.md`: proposed reorganized memory for the next Daily SHITRAT run.
- `run-quality.json`: facts, metrics, source paths, transcript ids, and verification commands.
- `recommendations.md`: concise findings and prioritized changes.
- `patch-plan.md`: exact proposed repo/code/prompt changes.

5. Update optimizer memory with pointers, top regressions, implemented fixes, verification commands, and carryover:

```text
/Users/joel/.codex/automations/daily-shitrat-run-optimizer/memory.md
```

Do not overwrite the daily automation memory.

## Loop Quality Checks

Analyze the loop, not just system health. Look for:

- duplicate automation starts
- abandoned attempts
- concurrent writers
- sequence jumps
- seal races
- stale latest pointers
- missing report publish metadata
- missing Discord URL metadata
- incomplete final summaries
- oversized context reads
- missing early progress receipts
- gaps over 180 seconds during broad scans
- weak event names
- duplicate/conflicting findings
- non-actionable PR plans

Good facts include counts, paths, timestamps, sequence numbers, command names, transcript ids, checksum status, report URLs, and Discord message ids/URLs.

## Report and Discord Contract

Manifest and latest state must persist publish metadata:

- `report.publish.url`
- `report.publish.expiresAt`
- `discord.threadUrl`
- `discord.startedMessageUrl`
- `discord.finalMessageUrl`

If the Discord bridge returns ids but omits URLs, Brain should derive:

- thread URL from `guildId` and `threadId`
- message URL from `guildId`, `threadId`, and `messageId`

`brain daily report --publish` after seal may update report metadata and repair derived Discord URLs. It must not mutate `brain-dump.jsonl`.

If final Discord metadata lands after the first report publish, re-render and re-publish so the local and published report HTML include `finalMessageUrl`.

## Ledger Event Shape

Use strong event names and canonical records:

- `agent.receipt` for source reads, progress, decisions, and verifications.
- `agent.finding` for one canonical finding per problem or confirmed healthy state.
- `agent.blocker` for actual blockers, not generic caution.
- `agent.pr_plan` for ShitRat-authored GitHub-visible work.
- `agent.sleep` for explicit "do not do this" carryover.

Collapse duplicate findings, blockers, PR plans, and carryover before final summary. The report renderer should also canonicalize duplicates and flag vague PR plans.

## PR Plan Contract

Every `agent.pr_plan` must be action-shaped:

- one repo
- one branch
- title
- base branch
- actor
- scope
- dry-run proof command
- GitHub write status
- validation commands
- body file or body text
- approval gate
- exact next command
- existing PR URL when present

Do not write a PR plan like "open a PR for the fixes." That is not actionable.

## Current Known Failure Modes

Verify these whenever touching Daily SHITRAT code or prompts:

- Starting should reuse an already-running attempt.
- Duplicate Discord starts should be avoided.
- `report.publish.url` and `expiresAt` should persist into manifest and latest.
- `brain daily report --publish` after seal should update report metadata.
- `brain daily finish --publish-report` should tolerate another actor sealing first.
- Final Discord URL metadata should survive in manifest, latest, local HTML, and published HTML.
- Transcript inspection should start with `brain daily transcript-summary`.
- Progress receipts should appear early and during long scans.

## Useful Verification Commands

From `/Users/joel/Code/joelhooks/joelclaw-brain`:

```bash
bun test --timeout 15000
bun run typecheck
bunx oxfmt --check src/daily.ts src/cli.ts test/daily.test.ts
bun run src/main.ts daily report --date YYYY-MM-DD --base-dir /Users/Shared/joelclaw/data/brain-daily
shasum -a 256 /Users/Shared/joelclaw/data/brain-daily/YYYY-MM-DD/attempt-001/brain-dump.jsonl
```

For transcript review:

```bash
bun run src/main.ts daily transcript-summary --session /absolute/path/to/rollout.jsonl
```

For progress during a live run:

```bash
brain daily progress --phase scan --status active --summary "Read latest manifest and verified report publish metadata"
```

## Closeout

A good Daily SHITRAT closeout names:

- dream output paths or sealed attempt path
- code/prompt changes made
- tests and verification commands run
- report URL and Discord URLs if relevant
- remaining loop risks

Keep it short. Joel needs the shape, the evidence, and the next useful constraint.
