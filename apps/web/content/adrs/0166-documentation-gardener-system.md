# ADR-0166: Documentation Gardener System

**Status**: proposed
**Date**: 2026-02-28
**Relates to**: ADR-0163 (Adaptive Prompt Architecture), ADR-0164 (Mandatory Taxonomy Classification), ADR-0165 (Taxonomy-Aware Skill Retrieval)

## Context

joelclaw now has multiple layers of documentation that govern agent behavior:

- `~/.pi/agent/SYSTEM.md` — base system prompt (GRANITE tier)
- `~/.joelclaw/SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md` — identity inject layer
- `~/Code/joelhooks/joelclaw/docs/` — 10 reference docs (architecture, inngest, skills, CLI, etc.)
- `skills/*/SKILL.md` — 55+ operational skills
- `~/Vault/docs/decisions/` — 166+ ADRs
- `AGENTS.md` files — project context for pi and gateway sessions

All of these drift. A deploy workflow changes but docs/deploy.md stays stale. A skill references a path that moved. An ADR says "proposed" but the feature shipped months ago. The documentation mandate ("all writers must update docs") helps for *new* changes, but doesn't catch *existing* drift.

We need scheduled gardeners — lightweight agents that compare docs against reality and propose corrections.

## Decision

Implement a gardener system: scheduled Inngest functions that review specific document categories against current system state, using a repeatable staleness rubric.

### The Staleness Rubric

Every gardener evaluates documents against 6 signals:

1. **Source drift** — Does the doc describe files/paths/commands that still exist and match current behavior? Run the commands, check the paths, diff against reality.

2. **Slog contradiction** — Do recent slog entries describe changes to systems this doc covers? If slog says "changed X" and the doc still describes old X, it's stale.

3. **Missing coverage** — Are there new files, functions, skills, or systems that should be documented but aren't? Check git log for new additions not reflected in docs.

4. **Dead references** — Do cross-references, links, ADR numbers, file paths still resolve? Broken references = immediate fix.

5. **Frequency decay** — When was this doc last meaningfully updated? Docs untouched for 30+ days covering active systems are suspect.

6. **Memory divergence** — Does MEMORY.md or slog contain hard rules or patterns that contradict or extend what the doc says?

Each signal scores 0 (fresh) to 3 (critically stale). Total score determines action:

- **0-3**: Fresh. No action.
- **4-8**: Aging. Log observation, include in weekly digest.
- **9-12**: Stale. Emit `docs/garden.proposal` event with specific corrections.
- **13-18**: Critical. Emit proposal + Telegram alert to Joel.

### Gardener Functions

Four gardeners, each responsible for a document category:

#### 1. `docs/garden.system-prompt` (weekly)
- Target: `~/.pi/agent/SYSTEM.md`
- Checks: Do the 10 principles still match operational reality? Do file paths in "How to Modify" sections resolve? Does the Pi section match current pi version?
- Method: Read SYSTEM.md, spot-check 5 random file references, compare principles against last 50 slog entries.

#### 2. `docs/garden.reference-docs` (daily)
- Target: `~/Code/joelhooks/joelclaw/docs/*.md`
- Checks: Do documented commands still work? Do file paths exist? Have related source files changed since doc was last updated?
- Method: For each doc, extract referenced file paths and commands. Verify paths exist. Check `git log --since="last doc update"` on referenced source files. Flag docs where source changed but doc didn't.

#### 3. `docs/garden.skills` (daily)
- Target: `skills/*/SKILL.md`
- Checks: Do symlinks resolve? Do referenced tools/commands exist? Are trigger patterns still relevant? Is the description accurate?
- Method: Verify symlinks, spot-check 3 random path references per skill, compare description against actual skill content for accuracy.

#### 4. `docs/garden.adrs` (weekly)
- Target: `~/Vault/docs/decisions/*.md`
- Checks: Are statuses accurate? (proposed but implemented = stale). Do superseded ADRs have `superseded-by` references? Are there contradictions between recent ADRs?
- Method: Read status field, cross-reference with slog/git for evidence of implementation. Flag `proposed` ADRs with related committed code.

### Proposal Format

Gardeners emit `docs/garden.proposal` events:

```json
{
  "name": "docs/garden.proposal",
  "data": {
    "gardener": "reference-docs",
    "target": "docs/deploy.md",
    "staleness_score": 11,
    "signals": {
      "source_drift": 3,
      "slog_contradiction": 2,
      "missing_coverage": 2,
      "dead_references": 1,
      "frequency_decay": 2,
      "memory_divergence": 1
    },
    "findings": [
      "k8s/publish-system-bus-worker.sh path changed to k8s/deploy-worker.sh",
      "Missing: Talon worker supervisor (ADR-0159) not documented",
      "Stale: still references launchctl kickstart for worker restart"
    ],
    "proposed_changes": "...",
    "auto_applicable": false
  }
}
```

### Auto-Apply vs Human Review

- **Auto-apply** (score 4-8, changes are mechanical): Dead reference fixes, path updates, status corrections. Codex applies, commits to branch, creates PR.
- **Human review** (score 9+, or changes are semantic): Principle rewording, coverage additions, architectural descriptions. Proposal surfaces in daily digest + Telegram.

### Dashboard

Daily digest includes a "Garden Health" section:

```
🌿 Garden Health
  SYSTEM.md: 🟢 fresh (score: 2, checked 2h ago)
  docs/deploy.md: 🟡 aging (score: 6, 3 findings)
  skills/k8s: 🔴 stale (score: 14, dead symlink + 4 stale paths)
  ADR-0155: 🟡 status drift (proposed → should be shipped)
```

## Phases

### Phase 1: Reference Docs Gardener
- Implement `docs/garden.reference-docs` Inngest function
- Daily cron, processes all `docs/*.md` files
- Emits proposals, surfaces in digest
- No auto-apply yet

### Phase 2: Full Gardener Suite
- Add system-prompt, skills, and ADR gardeners
- Implement auto-apply for mechanical fixes
- Add "Garden Health" to daily digest

### Phase 3: Feedback Loop
- Track proposal acceptance rate per gardener
- Tune staleness thresholds based on false positive rate
- Gardeners learn which signals matter most for each doc type

## Consequences

### Positive
- Docs stay current without relying on writer discipline alone
- Staleness is quantified, not vibes-based
- Repeatable rubric means consistent quality assessment
- Auto-apply handles mechanical drift without human attention
- Dashboard gives Joel instant visibility into doc health

### Negative
- LLM calls for each gardener run (mitigated: use inference pipeline, not paid keys)
- False positives possible (mitigated: tune thresholds, Phase 3 feedback)
- Another set of Inngest functions to maintain (mitigated: gardeners garden themselves)

### Neutral
- Complements writer mandate — mandate catches new changes, gardeners catch drift
- Gardener proposals go through same review pipeline as other system changes
