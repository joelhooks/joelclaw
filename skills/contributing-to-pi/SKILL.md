---
name: contributing-to-pi
displayName: Contributing to pi
description: "Contribute fixes, bug reports, and upstream discussions to badlogic/pi-mono without wasting maintainer time. Use when filing pi issues, preparing pi PRs, debugging whether a bug belongs upstream, or responding to maintainer pushback. Triggers on: 'contribute to pi', 'pi-mono issue', 'upstream pi fix', 'open a pi issue', 'why did Mario reject this', or any work in ~/Code/badlogic/pi-mono meant for upstream." 
version: 1.0.0
author: Joel Hooks
tags: [joelclaw, pi, upstream, contributing, github, quality]
---

# Contributing to pi

This skill exists to stop us sending half-baked upstream reports to Mario.

The maintainer standard is reasonable: understand the bug, isolate the boundary that actually breaks, and show a concrete repro. If we can't do that yet, we are still in local debugging mode — not upstream contribution mode.

## When to Use

Use this skill when:

- working in `~/Code/badlogic/pi-mono`
- filing or updating an issue on `badlogic/pi-mono`
- preparing a PR meant for upstream
- deciding whether a failure belongs in pi core, a provider adapter, an extension, or our local patches
- responding to maintainer questions like "which provider/model triggered this?" or "how is this possible?"

## Read These First

Always read both files in the local clone before touching upstream threads:

- `~/Code/badlogic/pi-mono/CONTRIBUTING.md`
- `~/Code/badlogic/pi-mono/AGENTS.md`

The important bits:

- first-time contributors open an issue first and wait for maintainer approval (`lgtm`)
- issue and PR text must be concise and written in a human voice
- new issues should carry the right `pkg:*` labels
- after code changes run `npm run check`
- do not run the repo's blanket `npm test`
- if you need tests, run targeted tests from the relevant package root

For the repo/maintainer deep dive, read:

- `references/pi-mono-research.md`

## Non-Negotiables

### 1. Reproduce on clean upstream before claiming a core bug

If the failure only happened in one of these environments, say that plainly and do more work before filing upstream:

- local repo build wired into `~/.local/bin/pi`
- globally patched installs under `~/.bun/install/global/...`
- sessions with custom extensions enabled
- branches with local instrumentation or emergency guards applied

Use a clean worktree when in doubt:

```bash
cd ~/Code/badlogic/pi-mono
git fetch origin
git worktree add /tmp/pi-mono-main origin/main
cd /tmp/pi-mono-main
npm install
```

If the bug disappears on clean `origin/main`, it is not yet an upstream core bug.

### 2. Identify the broken boundary, not just the crash site

"It crashed in `packages/agent/src/agent-loop.ts`" is not enough.

If a type-level invariant says the state is impossible, prove where reality violated the invariant:

- provider adapter emitted an invalid `AssistantMessage`
- extension mutated message state incorrectly
- local patch/build mismatch changed runtime behaviour
- external API returned something the adapter normalized badly

Upstream wants the *cause chain*, not just a defensive `?? []` around the symptom.

### 3. Capture provider/model and runtime conditions every time

For any LLM/runtime bug, record:

- provider
- model
- command path (`pi`, local repo build, published install)
- whether extensions were enabled
- relevant local patches
- commit SHA / branch

If you cannot answer "which provider/model triggered this?", you are not ready to open the issue.

### 4. Do not open a PR before the issue gets approval

`CONTRIBUTING.md` is explicit. New contributors start with an issue. A PR opened before approval is churn and will be closed.

## Workflow

### Step 1: confirm this belongs upstream

Ask, in order:

1. Does the failure reproduce on clean `origin/main`?
2. Does it reproduce with extensions disabled?
3. Does it reproduce with the published build, not just our repo-wired binary?
4. Can I point to the exact layer that produced the bad state?

If any answer is "no" or "not sure", keep digging locally.

### Step 2: gather the evidence pack

Before filing an issue, collect this in a scratch note:

- one-sentence problem statement
- exact repro steps from repo root
- provider/model
- extension state (`--no-extensions` repro or not)
- clean vs patched build
- expected result
- actual result
- minimal log or message payload showing the bad state
- hypothesis for where the invariant broke
- package ownership (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, etc.)

For GitHub reading, use the maintainer-friendly command from `AGENTS.md`:

```bash
gh issue view <number> --json title,body,comments,labels,state
```

Read all comments before replying.

### Step 3: reduce the repro

Strip it down until another person can run it without our whole machine state.

Good repros usually look like one of these:

- a small failing test in the affected package
- a fixture that produces the invalid normalized message
- a short command sequence from repo root
- an extension-disabled repro plus a separate note saying extensions make it worse

Bad repros look like:

- "during a longer session"
- "while chasing compaction"
- "somehow got a malformed message"
- "here's the guard I already wrote"

### Step 4: write the issue like an adult

Keep it short. Human voice. No agent mush.

Use this shape:

```md
Problem
- One sentence describing the failure.

Repro
1. Step one
2. Step two
3. Step three

Environment
- provider/model:
- build: clean origin/main | local repo build | published install
- extensions: on/off

Expected
- ...

Actual
- ...

Hypothesis
- The invariant appears to break in <provider|adapter|extension|core> because ...
```

Add the right `pkg:*` labels.

If you comment on an issue or PR, write the comment to a temp file first and preview it before posting.

### Step 5: only then propose a fix

Once the maintainer agrees the bug is real and upstream-owned:

1. keep the patch minimal
2. add a failing regression test or fixture that proves the bug
3. run `npm run check`
4. run only the targeted tests needed by the touched package
5. avoid drive-by fixes or policy changes in the same patch

## Lesson from pi-mono issue #1899

What we got wrong:

- we reported the crash site in `packages/agent/src/agent-loop.ts`
- we proposed a narrow guard immediately
- we did **not** include provider/model
- we did **not** provide concrete repro steps
- we did **not** explain whether the failure came from clean upstream, our repo-wired local pi build, our extensions, or our patched install
- we already had local evidence that this class of `content.filter()` crash also showed up in patched runtime paths around `grind_stop`, which pointed to a broader boundary problem than the issue body admitted

Mario's pushback was correct:

- on the type level, `toolUse` with missing `content` should be impossible
- without a repro, a guard patch looks like papering over an unknown lower-layer bug
- the likely fault domain is provider normalization or extension/runtime mutation until proven otherwise

Future rule:

**If the maintainer can reasonably ask "how can this state even exist?", answer that before opening the issue.**

## Package Triage Heuristic

Use this to decide where a bug probably belongs:

- `packages/ai` — provider adapters, streaming normalization, tool-call event translation, malformed usage/stop reasons
- `packages/agent` — agent loop state machine, tool execution, context handling after normalized messages already exist
- `packages/coding-agent` — interactive mode, compaction UX, session persistence, slash commands, extension interaction surfaces
- local extensions / joelclaw runtime — if behaviour changes only with our extensions or patched local install

Don't dump provider or extension bugs into `packages/agent` because that is where the null dereference landed.

## Pre-Submit Checklist

- [ ] Read `CONTRIBUTING.md`
- [ ] Read `AGENTS.md`
- [ ] Reproduced on clean `origin/main`
- [ ] Captured provider/model
- [ ] Captured extension state
- [ ] Captured build path (published vs local repo build)
- [ ] Identified likely broken boundary
- [ ] Wrote concise human issue body
- [ ] Added `pkg:*` labels
- [ ] Waited for maintainer approval before opening a PR

## Don't Do This

- don't lead with the patch before the repro
- don't call something a core bug because a null dereference happened in core
- don't hide the fact that we run local patches or repo-wired binaries
- don't dump session-length narrative into the issue body
- don't use GitHub issues as a debugging notebook
- don't make Mario reverse-engineer our machine state
