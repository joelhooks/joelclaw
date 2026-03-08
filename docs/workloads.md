# Workloads

Canonical design doc for **ADR-0217 Phase 4.1**.

This document defines the first stable vocabulary and schema for **agent-first coding/repo workloads** in joelclaw.

## Status

- **Canonical for planning:** yes
- **Implemented as CLI/runtime contract:** not yet
- **Current use:** manual planning, skill guidance, and future `joelclaw workload ...` implementation

Do not pretend the workload CLI already ships. This doc exists so agents stop inventing a different contract every session.

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
  "workloadId": "WL_20260308_001",
  "version": "2026-03-08",
  "status": "planned",
  "kind": "repo.refactor",
  "shape": "chained",
  "mode": "inline",
  "backend": "host",
  "summary": "three-stage docs and skill closeout before CLI implementation",
  "why": [
    "the work is dependent, but stage-specialized",
    "the artifact contract matters more than background durability",
    "no sandbox or durable backend is justified yet"
  ],
  "risks": [
    "spec drift if skills and docs diverge",
    "future CLI implementation may rename some fields if this schema is not kept canonical"
  ],
  "artifacts": ["docs", "summary", "handoff"],
  "verification": [
    "docs reviewed for shipped-vs-planned truthfulness",
    "git diff scoped to workload docs/skills",
    "knowledge sync after merge"
  ],
  "stages": [
    {
      "id": "stage-1",
      "name": "define workload vocabulary",
      "owner": "planner",
      "mode": "inline",
      "inputs": ["ADR-0217", "Phase 4 PRD", "agent-workloads skill"],
      "outputs": ["docs/workloads.md"],
      "verification": ["schema terms are explicit and enumerated"],
      "stopConditions": ["cannot explain shape/mode/backend cleanly"]
    },
    {
      "id": "stage-2",
      "name": "align skills and references",
      "owner": "planner",
      "mode": "inline",
      "inputs": ["docs/workloads.md"],
      "outputs": [
        "skills/agent-workloads/SKILL.md",
        "skills/agent-workloads/references/common-workloads.md"
      ],
      "verification": ["skills use the same vocabulary as the doc"]
    },
    {
      "id": "stage-3",
      "name": "groom ADR and PRD truth",
      "owner": "planner",
      "mode": "inline",
      "inputs": ["docs/workloads.md", "updated skills"],
      "outputs": ["ADR-0217 updates", "Phase 4 PRD updates"],
      "verification": ["Story 4.1 done criteria are explicit"]
    }
  ],
  "next_actions": [
    {
      "command": "joelclaw workload run <workload-id>",
      "description": "future dispatch surface; not implemented yet"
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

## Manual use until the CLI exists

Until `joelclaw workload ...` is real:

1. capture Joel steering in the request fields
2. choose `shape`
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
- `docs/cli.md` — the future CLI must honor this contract once implemented

## Story 4.1 done criteria

Story 4.1 is earned when:

- this vocabulary is canonical in the repo
- the `agent-workloads` skill uses the same contract
- Phase 4 PRD and ADR-0217 point at the same model
- future CLI implementation can start from this doc instead of rediscovering the shape from scratch
