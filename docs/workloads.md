# Workloads

Canonical design doc for **ADR-0217 Phase 4.1–4.2**.

This document defines the canonical vocabulary, schema, and planner surface for **agent-first coding/repo workloads** in joelclaw.

## Status

- **Canonical for planning:** yes
- **Implemented as CLI/runtime contract:** planner-only `joelclaw workload plan`
- **Still planned:** `joelclaw workload run|status|explain|cancel`
- **Current use:** manual planning, skill guidance, and planner-driven CLI output

Do not pretend the whole workload command family already ships. Only `joelclaw workload plan` is real right now.

## Why this exists

The runtime substrate got legible before the workload model did.

That was backwards.

If an agent asks:

> how should I run this coding task?

it should not need to learn Restate, Redis queue families, or sandbox backend trivia first.

The point of this doc is to give agents one stable way to describe:

- what the work is
- how it should be shaped
- what proof/artifacts matter
- how handoffs should work
- why a given execution mode was chosen

## The workload stack

For coding/repo work, think in this order:

1. **Joel steering** — what outcome matters
2. **workload request** — the structured description of the task
3. **shape selection** — `serial`, `parallel`, `chained`, or `auto`
4. **execution mode** — `inline`, `durable`, `sandbox`, `loop`, or `blocked`
5. **backend selection** — host, local sandbox, k8s sandbox, queue/restate, etc.
6. **handoff contract** — what the next worker gets

Substrate comes last.

## Pi sessions in the model

A pi session is the default **operator control surface** for workload planning.

Use a pi session to:

- capture Joel steering
- decide the workload shape
- produce or refine the structured request
- dispatch downstream workers if needed
- synthesize results back into one answer

A pi session is usually the **planner/integrator**, not necessarily the worker that mutates code.

Typical split:

- **pi session** — operator conversation, planning, synthesis, coordination
- **codex/worker session** — focused implementation stage
- **clawmail** — reservations and baton passing

## Canonical vocabulary

### Workload kinds

Use one of these for coding/repo work unless the task clearly needs a new class:

| kind                     | Use for                                                       |
| ------------------------ | ------------------------------------------------------------- |
| `repo.patch`             | local bugfix or targeted code change                          |
| `repo.refactor`          | multi-file code reshaping with regression risk                |
| `repo.docs`              | docs / ADR / truth-grooming work                              |
| `repo.review`            | review, verification, or audit without primary implementation |
| `research.spike`         | bounded investigation or comparison work                      |
| `runtime.proof`          | canary, soak, or live proof windows                           |
| `cross-repo.integration` | work spanning multiple repos or an external repo bridge       |

### Shapes

| shape      | Meaning                                               |
| ---------- | ----------------------------------------------------- |
| `auto`     | planner chooses                                       |
| `serial`   | ordered dependent stages                              |
| `parallel` | independent branches with later synthesis             |
| `chained`  | stage-specialized flow with explicit artifact handoff |

### Execution modes

| mode      | Meaning                                              |
| --------- | ---------------------------------------------------- |
| `inline`  | one session can do it directly                       |
| `durable` | should run through a tracked background/durable path |
| `sandbox` | isolate side effects or repo mutation                |
| `loop`    | repeated autonomous coding cycle is warranted        |
| `blocked` | cannot safely proceed yet                            |

### Backend classes

| backend         | Meaning                         |
| --------------- | ------------------------------- |
| `host`          | direct local execution on Panda |
| `local-sandbox` | isolated local sandbox          |
| `k8s-sandbox`   | isolated cluster-backed sandbox |
| `queue`         | queued/durable dispatch path    |
| `restate`       | Restate-backed durable executor |
| `none`          | no execution selected yet       |

### Autonomy levels

| autonomy     | Meaning                                         |
| ------------ | ----------------------------------------------- |
| `inline`     | answer or patch directly in-session             |
| `supervised` | execute, but keep operator checkpoints tight    |
| `afk`        | the system can take the batch and run           |
| `blocked`    | do not proceed until ambiguity/risk is resolved |

### Proof postures

| proof     | Meaning                                             |
| --------- | --------------------------------------------------- |
| `none`    | normal implementation                               |
| `dry-run` | simulate or plan without mutating reality           |
| `canary`  | narrow live proof                                   |
| `soak`    | longer live confidence window                       |
| `full`    | direct implementation without a staged proof window |

### Risk postures

| risk               | Meaning                             |
| ------------------ | ----------------------------------- |
| `reversible-only`  | every step must be easy to back out |
| `sandbox-required` | isolation is mandatory              |
| `host-okay`        | local/host execution is acceptable  |
| `deploy-allowed`   | deployment is in scope              |
| `human-signoff`    | explicit human review gate required |

### Artifact names

Use these values in workload specs and stage outputs:

- `patch`
- `tests`
- `verification`
- `summary`
- `docs`
- `adr`
- `deploy-proof`
- `telemetry-proof`
- `handoff`
- `research-note`
- `comparison`
- `rollback-plan`

## Shipped CLI surface

Current shipped command:

```bash
joelclaw workload plan "<intent>" \
  [--kind auto|repo.patch|repo.refactor|repo.docs|repo.review|research.spike|runtime.proof|cross-repo.integration] \
  [--shape auto|serial|parallel|chained] \
  [--autonomy inline|supervised|afk|blocked] \
  [--proof none|dry-run|canary|soak|full] \
  [--risk reversible-only,host-okay] \
  [--artifacts patch,verification,summary] \
  [--acceptance "criterion one|criterion two"] \
  [--repo /abs/path/or/owner/repo] \
  [--paths docs/workloads.md,docs/cli.md] \
  [--requested-by Joel]
```

Semantics:

- returns a canonical `request` + `plan` envelope using the vocabulary below
- infers `kind`, `shape`, `mode`, and `backend` when the caller leaves them open
- validates known `risk` and `artifacts` values and warns on unknown ones
- treats a missing `--repo` as the current working directory and infers `branch` / `baseSha` when that target is a local git repo
- **does not dispatch anything**

## Workload request schema

This is the canonical request envelope.

```json
{
  "version": "2026-03-08",
  "kind": "repo.refactor",
  "intent": "make queue observation planning agent-first instead of substrate-first",
  "requestedBy": "Joel",
  "shape": "auto",
  "autonomy": "supervised",
  "proof": "dry-run",
  "risk": ["reversible-only", "host-okay"],
  "targets": [
    {
      "repo": "/Users/joel/Code/joelhooks/joelclaw",
      "branch": "main",
      "baseSha": "42065cc3",
      "paths": ["docs/", "skills/"]
    }
  ],
  "acceptance": [
    "canonical workload vocabulary exists",
    "serial parallel chained semantics are explicit",
    "another agent can use one workload contract without reading runtime internals"
  ],
  "artifacts": ["docs", "summary", "handoff"],
  "constraints": {
    "mustFollow": [
      "use clawmail for shared-file work",
      "keep shipped docs separate from planned CLI behavior"
    ],
    "avoid": ["pretending joelclaw workload already exists"]
  },
  "context": {
    "adr": ["ADR-0217"],
    "steering": "ergonomics is phase 4",
    "notes": [
      "the current restate-workflows front door makes agents sad and confused"
    ]
  }
}
```

### Required fields

- `version`
- `kind`
- `intent`
- `requestedBy`
- `shape`
- `autonomy`
- `proof`
- `risk`
- `targets`
- `acceptance`
- `artifacts`

### Optional fields

- `constraints`
- `context`
- `handoffSeed`
- `priority`
- `deadline` (only when externally imposed; don't invent one)

## Workload plan schema

This is what the planner should produce.

```json
{
  "workloadId": "WL_20260308_165513",
  "version": "2026-03-08",
  "status": "planned",
  "kind": "repo.docs",
  "shape": "serial",
  "mode": "inline",
  "backend": "host",
  "summary": "serial repo.docs planned for inline execution on host",
  "why": [
    "kind pinned by caller to repo.docs",
    "repo.docs defaults to ordered gates because one stage depends on the previous one being correct",
    "nothing about the workload justifies background durability or isolation yet",
    "inline planning or execution defaults to the local host session"
  ],
  "risks": ["risk posture: reversible-only", "risk posture: host-okay"],
  "artifacts": ["docs", "summary", "adr"],
  "verification": [
    "request and plan use the canonical fields from docs/workloads.md",
    "the chosen shape, mode, and backend are explained in plain language"
  ],
  "stages": [
    {
      "id": "stage-1",
      "name": "scope and prepare",
      "owner": "planner",
      "mode": "inline",
      "inputs": ["intent", "acceptance criteria"],
      "outputs": ["workload plan"],
      "verification": ["scope boundary and artifacts are explicit"],
      "stopConditions": ["acceptance criteria are still mush"]
    },
    {
      "id": "stage-2",
      "name": "execute primary task",
      "owner": "planner",
      "mode": "inline",
      "inputs": ["workload plan"],
      "outputs": ["docs", "adr"],
      "verification": ["primary artifact is produced"],
      "stopConditions": ["execution drifts outside planned boundaries"],
      "dependsOn": ["stage-1"]
    },
    {
      "id": "stage-3",
      "name": "verify and summarize",
      "owner": "planner",
      "mode": "inline",
      "inputs": ["stage-2 outputs"],
      "outputs": ["summary"],
      "verification": ["result and next action are explicit"],
      "stopConditions": ["closeout cannot explain done vs remaining work"],
      "dependsOn": ["stage-2"]
    }
  ],
  "next_actions": [
    {
      "command": "joelclaw workload plan \"groom ADR-0217 truth and docs\" --kind repo.docs --shape serial",
      "description": "re-run the planner with the inferred kind/shape pinned explicitly"
    }
  ]
}
```

## Stage schema

Every stage in a `serial` or `chained` plan should carry:

- `id`
- `name`
- `owner`
- `mode`
- `inputs`
- `outputs`
- `verification`
- `stopConditions`

Recommended optional fields:

- `reservedPaths`
- `dependsOn`
- `handoffTo`
- `estimatedBlastRadius` (small/medium/large if useful)

## Handoff schema

Use this when one worker hands off to another.

```json
{
  "workloadId": "WL_20260308_001",
  "stageId": "stage-2",
  "goal": "align skills to the canonical workload vocabulary",
  "currentState": "docs/workloads.md landed; skill updates still pending",
  "artifactsProduced": ["docs/workloads.md"],
  "verificationDone": [
    "schema terms enumerated",
    "planned CLI surface marked as not shipped"
  ],
  "remainingGates": [
    "update skill reference",
    "groom ADR/PRD truth",
    "commit and push"
  ],
  "reservedPaths": ["skills/agent-workloads/SKILL.md"],
  "releasedPaths": ["docs/workloads.md"],
  "risks": ["skill drift from canonical schema"],
  "nextAction": "update the skill and reference to use the exact vocabulary from docs/workloads.md"
}
```

If the next worker has to reconstruct the task from raw chat, the handoff is bad.

## Selection rules

### When to choose `serial`

Choose `serial` when:

- stage order is strict
- risk is high
- the same operator should inspect each gate
- runtime proof or cleanup is part of the task

### When to choose `parallel`

Choose `parallel` when:

- branches are independent
- uncertainty reduction matters more than immediate integration
- each branch can own non-overlapping files or remain read-only
- one synthesis owner is assigned

### When to choose `chained`

Choose `chained` when:

- different stage specializations add value
- artifacts need to be consumed downstream explicitly
- implementation is not the final step

## Common workload examples

### Example: single-pass patch

```json
{
  "kind": "repo.patch",
  "shape": "serial",
  "mode": "inline",
  "backend": "host",
  "artifacts": ["patch", "verification", "summary"]
}
```

### Example: compare two approaches

```json
{
  "kind": "research.spike",
  "shape": "parallel",
  "mode": "inline",
  "backend": "host",
  "artifacts": ["research-note", "comparison", "summary"]
}
```

### Example: implement → verify → docs

```json
{
  "kind": "repo.refactor",
  "shape": "chained",
  "mode": "sandbox",
  "backend": "local-sandbox",
  "artifacts": ["patch", "tests", "verification", "docs", "handoff"]
}
```

### Example: live canary window

```json
{
  "kind": "runtime.proof",
  "shape": "serial",
  "mode": "durable",
  "backend": "restate",
  "artifacts": ["telemetry-proof", "summary", "rollback-plan"]
}
```

## Manual use until the rest of the CLI exists

Use `joelclaw workload plan` first whenever it fits.

For everything beyond planning, stay manual until more of the command family ships:

1. capture Joel steering in the request fields
2. run `joelclaw workload plan` or mirror its request fields manually
3. choose `mode` and `backend` only after the shape is clear
4. define the artifacts and verification gates
5. use `clawmail` for reservation and handoff
6. keep the final summary in the same vocabulary

## Anti-patterns

Avoid:

- answering a workload question with only substrate docs
- mixing shipped CLI truth with planned surfaces
- parallel edits without a synthesis owner
- vague handoffs like “continue from above”
- choosing `durable` or `sandbox` because it sounds fancy rather than because the workload needs it

## Relationship to other docs and skills

- `Vault/docs/decisions/0217-event-routing-queue-discipline.md` — why Phase 4 exists
- `Vault/Projects/09-joelclaw/0217-phase-4-agent-first-workload-ergonomics.md` — broader Phase 4 PRD
- `skills/agent-workloads/` — agent-facing front door for this model
- `skills/restate-workflows/` — substrate bridge after workload planning is already clear
- `docs/cli.md` — shipped CLI semantics and the remaining planned workload surfaces

## Story 4.1 done criteria

Story 4.1 is earned when:

- this vocabulary is canonical in the repo
- the `agent-workloads` skill uses the same contract
- Phase 4 PRD and ADR-0217 point at the same model
- future CLI implementation can start from this doc instead of rediscovering the shape from scratch

## Story 4.2 done criteria

Story 4.2 is earned when:

- `joelclaw workload plan` returns the canonical `request` + `plan` envelope
- the planner uses the shared vocabulary from this doc instead of inventing fresh field names
- shipped behavior is explicit: planning only, no fake dispatch/status/explain/cancel path yet
- docs, skill guidance, ADR truth, and CLI docs all describe the same planner-only reality
