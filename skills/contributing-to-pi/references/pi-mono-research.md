# Pi Mono Research Notes

Deep repo/context notes for upstream work against `badlogic/pi-mono`.

This is not a generic OSS contribution guide. It is a working profile of how **this repo** behaves, how **Mario** reviews work, and what evidence tends to get a `lgtm` vs a blunt rejection.

## Repo Shape

Autopsy snapshot:

- repo: `badlogic/pi-mono`
- local clone: `~/Code/badlogic/pi-mono`
- scale: **647 files**, **136k TypeScript LOC**, **185k total LOC**
- packages:
  - `packages/ai`
  - `packages/agent`
  - `packages/coding-agent`
  - `packages/tui`
  - `packages/web-ui`
  - `packages/mom`
  - `packages/pods`

What the repo thinks it is:

- `pi-ai` = provider/model abstraction and streaming normalization
- `pi-agent-core` = stateful agent runtime
- `pi-coding-agent` = the CLI/TUI harness people actually call `pi`
- `pi-tui` = terminal rendering substrate

This matters because many "pi bugs" are really one of four things:

1. provider normalization bugs in `packages/ai`
2. agent-loop/state machine bugs in `packages/agent`
3. TUI/session/interactive bugs in `packages/coding-agent`
4. rendering/input bugs in `packages/tui`

If we file at the wrong layer, Mario notices immediately.

## Velocity and Release Cadence

Current repo cadence is fast, not ceremonial.

- maintainer commits in last 14 days: **123**
- release commits in last 14 days: **11**
- recent tags: `v0.56.3`, `v0.56.2`, `v0.56.1`, `v0.56.0`, `v0.55.4`, `v0.55.3`, ...

Implication:

- upstream will often fix and ship quickly if the bug is real and the repro is clear
- long speculative issue threads are lower value than a crisp repro plus a small patch
- changelog discipline matters because releases happen constantly

## Governance and Contribution Gate

### Canonical files

Always read:

- `CONTRIBUTING.md`
- `AGENTS.md`
- `.github/ISSUE_TEMPLATE/bug.yml`
- `.github/ISSUE_TEMPLATE/contribution.yml`
- `.github/workflows/pr-gate.yml`
- `.github/workflows/approve-contributor.yml`

### What the gate actually does

The issue-first policy is enforced by automation, not vibes.

- new contributors open an issue first
- maintainer comments `lgtm`
- GitHub Action appends the author to `.github/APPROVED_CONTRIBUTORS`
- PR gate closes any PR from an unapproved contributor

This explains the high closed-unmerged PR count:

- last 200 PRs: **33 merged**, **164 closed unmerged**, **3 open**

Do not read that as "maintainer hates contributions." A chunk of those closures are the automated gate doing exactly what it was designed to do.

### Issue templates

Bug report asks for only four things:

- what happened
- steps to reproduce
- expected behavior
- version

Contribution proposal asks for:

- what do you want to change?
- why?
- optional how?

The template text explicitly says:

- keep it short
- if it doesn't fit on one screen, it's too long
- write in your own voice

There is **no PR template**. That means the repo expects contributors to internalize the rules from `AGENTS.md` and `CONTRIBUTING.md`, not fill out ceremonial form text.

## Maintainer Voice Profile

Mario's public repo voice is:

- terse
- direct
- usually lowercase
- occasionally profane
- technical, not diplomatic
- appreciative when the work is good
- instantly dismissive when the premise is wrong

Recent issue comment samples:

- `which provider/model triggered this?`
- `please reopen the issue with a concrete steps on how to reproduce this... i won't add a guard without knowing how this can ever happen.`
- `this makes zero sense.`
- `why would you open two issues for this ...`
- `nah, we'll wait for upstream to unfuck itself.`
- `cheers!`
- `lgtm`

Recent PR review samples:

- `Breaks TUI.`
- `This PR just smokes things. Sorry, no go.`
- `Entirely unnecessary...`
- `No dynamic imports.`
- `What I meant was that we should NEVER console.log anywhere. Breaks tui, breaks other shit.`

Takeaways:

- do not mistake brevity for ambiguity
- if he says the type/system boundary makes your claim impossible, prove the violating boundary or withdraw
- comments are often one sentence because he expects the code and repo rules to carry the rest

## Common Maintainer Heuristics

These are the recurring accept/reject patterns.

### 1. Core stays small

Repeated pattern: if something can live in an extension, wrapper script, or external integration, Mario wants it there.

Examples from issue comments:

- queue consumer / automation should use `--mode json` or `--mode rpc`, not add queue semantics to core
- document conversion should use CLI tools like `markitdown`, not complicate the agent
- settings/options get rejected if they smell like preference accretion

Rule:

**If the feature can be built outside core without degrading pi, expect "do it as an extension" or "wrapper script" pushback.**

### 2. TUI integrity is sacred

A surprising amount of review language reduces to this:

- no `console.log`
- no `console.warn`
- no stderr junk in interactive mode
- no changes that cause full rerenders or noisy redraws
- no behaviours that break message ordering or interactive rendering assumptions

If a change "works" but pollutes or destabilizes the TUI, it is dead.

### 3. Provider boundaries matter

Mario thinks in normalized layers.

If a value violates `packages/ai/src/types.ts`, his first reaction is not "add a guard in agent-core" — it is "which lower layer broke the invariant?"

That is why issue #1899 got the response it did.

### 4. Unnecessary config is a smell

Patterns from review/comments:

- `we don't need a setting for this`
- `let's not make this a nested property`
- reluctance to add options that preserve edge-case preferences but worsen overall UX

If you propose a setting, be ready to explain why the default cannot just be fixed.

### 5. Good ideas are often rewritten before merge

Accepted contribution does not mean "your implementation lands verbatim."

Common pattern:

- maintainer says the idea is good
- rewrites implementation to better match repo architecture
- merges with extra fixes/docs/changelog changes

So when the underlying idea is good, don't get precious about the exact patch.

## Contrast Case: Issue #1899 vs Issue #1900

### #1899 — rejected as under-evidenced

What we filed:

- crash site in `packages/agent/src/agent-loop.ts`
- proposed narrow guard
- no provider/model
- no clean repro
- no proof whether the bug was core, provider, extension, or local patched runtime

Maintainer response:

- `which provider/model triggered this?`
- `on a type level, this is impossible`
- `either one of the provider implementations is broken, or an extension you use is doing something nasty`

Interpretation:

- we reported the null dereference, not the actual bug
- we asked for a defensive patch without proving ownership of the bug

### #1900 — approved quickly

What the issue did right:

- very small scope
- specific target (`PI_CODING_AGENT_DIR` handling in example extensions)
- clear why
- concise technical approach

Maintainer response:

- `lgtm`
- `please send a pr. please use getAgentDir()`

Interpretation:

- scoped, concrete, repo-native proposals get fast approval
- maintainers may still redirect you to the preferred abstraction (`getAgentDir()`)

## Practical Issue Style Guide

### Good issue shape for pi-mono

```md
Problem
- One sentence.

Repro
1. Exact step
2. Exact step
3. Exact step

Environment
- provider/model:
- package/layer affected:
- clean main or patched/local build:
- extensions on/off:
- version:

Expected
- ...

Actual
- ...

Hypothesis
- I think the invariant breaks in <provider|adapter|extension|core> because ...
```

### Bad issue smells

- session diary instead of repro
- vague phrases like "during a longer session"
- leading with the patch instead of the failing case
- hiding local patches / repo-wired binaries / enabled extensions
- calling a core fix obvious when the type layer says the state should never exist
- asking Mario to infer the package boundary from the stack trace alone

## Practical PR Style Guide

### Before opening a PR

- get approved first
- use the right abstraction names already present in repo (`getAgentDir()`, existing compat blocks, existing setters, etc.)
- read the touched package README and changelog section
- read `AGENTS.md` again for touched area rules

### In the patch

- stay surgical
- no drive-by cleanup
- no new config unless the default cannot be fixed cleanly
- no direct console output
- no dynamic imports
- preserve public API shape unless change is deliberate and documented
- add/update changelog exactly as requested in `AGENTS.md`

### Validation language that matches the repo

Mario often includes exact validation commands in issue comments when closing/fixing. Do the same.

Example shape:

- targeted test command(s)
- `npm run check`
- exact file/docs/changelog touched

## Review Taxonomy for Future Indexing

These categories showed up repeatedly and are worth indexing explicitly:

- `needs_repro`
- `wrong_layer`
- `extension_not_core`
- `tui_breakage`
- `provider_boundary`
- `unnecessary_config`
- `rewrite_needed`
- `approved_with_direction`
- `fixed_in_main`
- `upstream_dependency_wait`
- `duplicate_or_confused_issue`

These would be useful fields in a Typesense collection for retrieval and later summarization.

## pi-mono Typesense Collection Proposal

If we want long-memory around pi-mono, start with **one denormalized collection**, not five.

### Proposed collection

`pi_mono_artifacts`

### Document kinds

- `repo_doc` — `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, package READMEs, issue templates
- `issue`
- `issue_comment`
- `pull_request`
- `pull_request_review_comment`
- `commit`
- `release`

### Core fields

```json
{
  "name": "pi_mono_artifacts",
  "fields": [
    {"name": "id", "type": "string"},
    {"name": "repo", "type": "string", "facet": true},
    {"name": "kind", "type": "string", "facet": true},
    {"name": "title", "type": "string", "optional": true},
    {"name": "content", "type": "string"},
    {"name": "url", "type": "string"},
    {"name": "number", "type": "int32", "optional": true, "facet": true},
    {"name": "state", "type": "string", "optional": true, "facet": true},
    {"name": "author", "type": "string", "facet": true},
    {"name": "author_role", "type": "string", "optional": true, "facet": true},
    {"name": "package_scopes", "type": "string[]", "facet": true, "optional": true},
    {"name": "labels", "type": "string[]", "facet": true, "optional": true},
    {"name": "decision_tags", "type": "string[]", "facet": true, "optional": true},
    {"name": "path", "type": "string", "optional": true, "facet": true},
    {"name": "sha", "type": "string", "optional": true},
    {"name": "tag", "type": "string", "optional": true, "facet": true},
    {"name": "thread_key", "type": "string", "optional": true, "facet": true},
    {"name": "created_at", "type": "int64", "sort": true},
    {"name": "updated_at", "type": "int64", "optional": true},
    {"name": "embedding", "type": "float[]", "embed": {"from": ["title", "content"]}}
  ],
  "default_sorting_field": "created_at"
}
```

### Derived fields worth materializing

- `maintainer_signal`: true when author is `badlogic` or `Mario Zechner`
- `decision_tags`: from the taxonomy above
- `package_scopes`: infer from labels, touched paths, or title scopes like `fix(coding-agent)`
- `thread_key`: `issue:1899`, `pr:492`, `commit:<sha>`

### Why a single denormalized collection first

Because the first job is retrieval, not purity.

Questions we actually want to answer:

- show me all maintainer comments that rejected config bloat
- find examples where Mario said the bug belongs in an extension
- what are common TUI breakage review comments
- what approved proposals look like vs rejected ones
- show issue/PR pairs related to `coding-agent` and `skills`

One hybrid collection gets us there faster.

## Why This Fits Restate

This is a solid Restate workload because the ingestion problem is:

- paginated
- idempotent
- resumable
- rate-limit sensitive
- naturally decomposed by artifact type
- perfect for durable incremental sync

### Suggested Restate flow

1. `syncRepo(repo)`
   - fetch repo metadata
   - schedule page syncs for issues, PRs, commits, releases, docs

2. `syncIssuesPage(repo, page)`
   - fetch issues page
   - fan out `upsertArtifact(issue)`
   - fan out `syncIssueComments(issueNumber)`
   - continue while `next` exists

3. `syncPrPage(repo, page)`
   - fetch PR page
   - fan out `upsertArtifact(pr)`
   - fan out `syncPrComments(prNumber)`

4. `upsertArtifact(id)`
   - normalize to collection document
   - infer `package_scopes` and `decision_tags`
   - upsert into Typesense

5. `materializeMaintainerProfile(repo)`
   - aggregate recent maintainer comments/commits
   - emit summary docs later if we want secondary collections

### What Restate buys us

- durable backfills without losing pagination state
- per-artifact retries without restarting whole repo scans
- easy incremental sync keyed by updated timestamps / ETags
- cheap derived views later (maintainer profile, decision taxonomy, package hotspot summaries)

## What Else Is Worth Capturing

Beyond raw issues/PRs/comments/commits:

- approved contributor list changes
- release notes/changelog deltas per version
- issue-to-commit-to-release closure chains
- touched paths on maintainer commits for package hotspot evolution
- package README snapshots when philosophy changes
- recurring phrases from Mario that encode repo policy (`Breaks TUI`, `No dynamic imports`, `extension`, `no setting`, `lgtm`)

## Current Bottom Line

If we want to contribute upstream effectively:

1. think in layers
2. prove ownership of the bug
3. stay concise
4. respect the core-vs-extension boundary
5. never break the TUI
6. never ask Mario to reverse-engineer our machine state from a crash report

That is the game.