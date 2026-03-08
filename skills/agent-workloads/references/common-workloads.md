# Common Agent Workloads

This reference is the operational expansion for `skills/agent-workloads/SKILL.md`.

## Joel Steering Inputs

When Joel is steering coding/repo work, capture these first:

- **objective** — the outcome, not the mechanism
- **acceptance** — what proves the work is done
- **scope** — repo(s), files, or subsystems that are in / out
- **autonomy** — inline, supervised, AFK, or blocked pending review
- **proof posture** — dry-run, canary, soak, full implementation
- **risk posture** — reversible only, sandbox required, deploy allowed, human sign-off needed
- **sequence constraints** — what must happen before what
- **artifacts** — patch, tests, summary, docs, ADR, deploy evidence, etc.

If two or more of those are fuzzy, stop and shape the workload before dispatch.

## Map the task into the canonical schema

Use the vocabulary from `docs/workloads.md`.

Minimum shape for a sane plan:

```json
{
  "kind": "repo.patch|repo.refactor|repo.docs|repo.review|research.spike|runtime.proof|cross-repo.integration",
  "shape": "auto|serial|parallel|chained",
  "mode": "inline|durable|sandbox|loop|blocked",
  "backend": "host|local-sandbox|k8s-sandbox|queue|restate|none",
  "autonomy": "inline|supervised|afk|blocked",
  "proof": "none|dry-run|canary|soak|full",
  "artifacts": [
    "patch",
    "tests",
    "verification",
    "summary",
    "docs",
    "adr",
    "handoff"
  ]
}
```

If your summary cannot fit that shape, the task is still mush.

First move when possible:

```bash
joelclaw workload plan "<intent>"
```

Then inspect the canonical `request` + `plan` output before dispatching anything. Read the `guidance` block too — that is where the planner now says whether to execute inline, tighten scope, or dispatch, which skills should be loaded/installed first, and what the approval → execute/watch → summarize loop should be.

Helpful ergonomics that are now real:

```bash
# seed scope from active repo work
joelclaw workload plan "<intent>" --repo /abs/repo --paths-from recent:3

# use a preset instead of restating the obvious shape every time
joelclaw workload plan "<intent>" --preset refactor-handoff

# write a reusable plan artifact
joelclaw workload plan "<intent>" --write-plan ~/.joelclaw/workloads/

# turn the saved plan into a stage-specific dispatch contract
joelclaw workload dispatch ~/.joelclaw/workloads/WL_20260308_191410.json --write-dispatch ~/.joelclaw/workloads/
```

## Choosing the Shape

### Serial

Use serial when:

- stage B depends on stage A being correct
- one operator needs to keep a tight feedback loop
- the work is risky or canary-driven
- docs/ADR truth must follow code truth immediately

Examples:

- bug triage → fix → verify → commit
- runtime canary → cleanup → truth update
- refactor → tests → deploy verification → docs

Few-shot setup/execution pattern:

1. install/repair any missing repo-local skills (`joelclaw skills ensure <name>`)
2. reserve the scoped files
3. do the bounded change
4. run narrow validation
5. commit the slice cleanly before moving on

### Parallel

Use parallel when:

- branches are independent
- uncertainty is high and comparison is useful
- research or spikes can happen without overlapping files
- one lead agent will synthesize the branches later

Examples:

- compare two migration strategies
- inspect three codepaths in parallel
- spike local sandbox vs k8s sandbox vs loop path

Rules:

- each branch must have a clear goal
- each branch must own a non-overlapping file scope or stay read-only
- there must be one merge/synthesis owner

Few-shot setup/execution pattern:

1. split the work into independent branches before anyone edits
2. load/install the repo skill once, then dispatch branch-specific work
3. keep branch artifacts explicit (notes, diffs, comparisons)
4. run one synthesis pass that chooses the next path

### Chained

Use chained when:

- different stages want different specializations
- artifacts should flow forward explicitly
- implementation is not the final stage

Examples:

- implement → verify → docs
- patch → canary → truth update
- research → planner → implementor → reviewer

Rules:

- downstream stage consumes artifacts, not vague conversation memory
- every stage has an explicit pass/fail contract
- if the prompt includes a `Goal:` section, keep those milestones visible instead of collapsing everything into `execute primary work`
- if the prompt includes `Acceptance:`, preserve it unless the caller explicitly overrides with `--acceptance`
- handoff text must say what changed, what remains, and what must not be re-litigated

Few-shot setup/execution pattern:

1. write the plan artifact up front
2. dispatch the right stage instead of re-planning from scratch
3. reserve the scoped files for the executing stage
4. execute the stage, validate narrowly, then either close out or dispatch the next stage

## Bounded local slice posture

If the problem is **one repo, one failing surface, and local verification is cheap**, default to direct execution.

- shape it
- ask **approved?**
- reserve scope
- inspect → patch → verify → commit
- summarize outcome and ask whether to push

Do **not** widen that into dispatch, queue submission, or adjacent ops churn unless the operator explicitly asked for a wider blast radius.

## Handoff Contract

Every handoff should include:

- **workload id / story id / stage id**
- **goal**
- **current state**
- **artifacts produced**
- **verification already done**
- **remaining gates**
- **reserved files / released files**
- **known risks / caveats**
- **next command or next action**

If the next worker has to reconstruct the plan from raw chat, the handoff is bad.

## Workload Patterns

### Single-pass patch

Use when the task is obvious and local.

Suggested schema:

```json
{
  "kind": "repo.patch",
  "shape": "serial",
  "mode": "inline",
  "backend": "host",
  "artifacts": ["patch", "verification", "summary"]
}
```

Expected outputs:

- code diff
- verification output
- commit
- minimal summary

### Scoped cleanup chain

Use when the work is still basically repo.patch, but the prompt carries multiple cleanup milestones and you need them to stay visible.

Suggested schema:

```json
{
  "kind": "repo.patch",
  "shape": "chained",
  "mode": "inline",
  "backend": "host",
  "artifacts": ["patch", "verification", "summary", "handoff"]
}
```

Prompt pattern that works well:

- `Goal:` with semicolon-separated milestones
- `Acceptance:` with explicit completion criteria
- `--paths-from recent:<n>` or explicit `--paths`
- optional `--write-plan` when another agent will pick it up

Expected outputs:

- visible milestone stages instead of generic sludge
- preserved scoped paths on implementation stages
- optional `reflect and update plan` stage when the prompt asks for it
- a reusable plan artifact if requested
- a stage-specific dispatch contract via `joelclaw workload dispatch` when the work is ready to hand off
- dispatch guidance that says whether handing it off is actually smart, or whether the agent should just execute the selected stage now

### Multi-step refactor

Use serial or chained.

Suggested schema:

```json
{
  "kind": "repo.refactor",
  "shape": "chained",
  "mode": "sandbox",
  "backend": "local-sandbox",
  "artifacts": ["patch", "tests", "verification", "docs", "handoff"]
}
```

Expected outputs:

- stage checkpoints
- explicit regression checks
- follow-through docs/ADR updates

### Parallel research / spikes

Use parallel with a synth owner.

Suggested schema:

```json
{
  "kind": "research.spike",
  "shape": "parallel",
  "mode": "inline",
  "backend": "host",
  "artifacts": ["research-note", "comparison", "summary"]
}
```

Expected outputs:

- one finding note per branch
- recommendation with tradeoffs
- selected path

### Implementation + review chain

Use chained.

Suggested schema:

```json
{
  "kind": "repo.review",
  "shape": "chained",
  "mode": "sandbox",
  "backend": "local-sandbox",
  "artifacts": ["patch", "tests", "verification", "handoff", "summary"]
}
```

Expected outputs:

- implementation artifact
- independent verification artifact
- final judgment / next step

### Supervised runtime drill

Use serial.

Suggested schema:

```json
{
  "kind": "runtime.proof",
  "shape": "serial",
  "mode": "durable",
  "backend": "restate",
  "artifacts": ["telemetry-proof", "summary", "rollback-plan"]
}
```

Expected outputs:

- anchors (`since`, run ids, snapshot ids)
- earned / unearned proof
- cleanup evidence
- restored steady state

## Selection Heuristics

Prefer:

- **inline** for obvious, local, low-risk work
- **serial** for dependent or risky work
- **parallel** for uncertainty reduction or independent branches
- **chained** when specialist stages add value

Avoid:

- parallel edits on the same files without a designated integrator
- giving a coding agent substrate docs when it really needs a workload plan
- “just use Restate” as a user-facing answer
- dispatching before acceptance / artifacts / risk posture are clear

## `joelclaw workload` Surface

Shipped now:

```bash
joelclaw workload plan "<intent>"
```

Shipped now in addition to planning:

```bash
joelclaw workload dispatch <plan-artifact>
```

Still planned:

```bash
joelclaw workload run "<intent>"
joelclaw workload status <id>
joelclaw workload explain <id>
joelclaw workload cancel <id>
```

The contract should answer:

- what shape is this?
- what runtime path should carry it?
- why?
- what artifacts and gates exist?
- what should happen next?
