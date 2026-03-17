---
name: workflow-rig
displayName: Workflow Rig
description: "Canonical front door for agent-first workload planning, runtime mode selection, workflow-rig dogfood, and runtime dispatch in joelclaw. Use when the user says 'run this through the workflow rig', 'kick this off', 'dogfood this with the workflow rig', 'start a canary', 'run this as a workload', or any request to turn coding/runtime intent into a real joelclaw workload plan or run."
version: 0.2.0
author: Joel Hooks
tags:
  - workflows
  - workload
  - runtime
  - sandbox
  - restate
  - queue
  - adr-0217
---

# Workflow Rig

Use this skill as the **canonical front door** for agent-driven work in joelclaw.

The user should not have to choose between `agent-workloads`, `restate-workflows`, queue internals, or runtime trivia.

If the user says the magic words —
- "run this through the workflow rig"
- "dogfood this with the workflow rig"
- "kick this off"
- "start a canary"
- "run this as a workload"

— load this skill first.

## What this skill owns

- workload shaping (`serial`, `parallel`, `chained`)
- choosing between inline work, durable runtime, or a pure handoff
- `joelclaw workload plan` / `dispatch` / `run`
- explicit stage DAGs via `--stages-from`
- honest runtime truth: what the restate-worker can do today, and what it still cannot do
- canary/dogfood posture for real workload proofs

## Core rule

**Intent first, substrate second.**

The caller describes the work.
The workflow rig chooses the narrowest honest execution path.

Do not push Redis vs Restate vs sandbox trivia back onto the caller unless that tradeoff is the actual decision.

## Current proven state (as of 2026-03-17)

- `joelclaw workload plan`, `joelclaw workload dispatch`, and `joelclaw workload run` are real.
- Proven durable path: `joelclaw workload plan` → Redis queue → Restate `dagOrchestrator` → `dagWorker` → execution.
- Multi-stage DAGs with `dependsOn` are proven across 3-5 stage pipelines. Downstream stages can consume earlier outputs via `{{nodeId}}` interpolation.
- `--stages-from stages.json` is proven: duplicate ids, unknown deps, self-deps, and cycles are rejected before runtime admission; critical path and phase grouping are calculated.
- `shell` handler ✅ runs commands in the k8s `restate-worker` pod. Git clone, pi agent file writes, git commit, and git push are proven.
- `infer` handler ✅ runs `pi -p` in-cluster for research, planning, review, and other text work.
- `microvm` handler ⚠️ boots/restores Firecracker v1.15.0 inside the pod via `/dev/kvm` with ~9ms snapshot restore, but the exec-in-VM workspace protocol is not wired yet.
- The `restate-worker` image is a full agent environment: pi 0.58.4, 76 skills, Firecracker, `/dev/kvm`, GitHub push auth from a k8s secret, and pi auth mounted from the host so it stays fresh.
- Autonomous codegen is proven with pi agent mode (not `-p`): the shell handler can clone a repo, let pi write files via tools, then commit and push the result.
- Performance truth: pre-cloned repo cache at `/app/repo-cache` cuts workspace setup to ~200ms instead of ~3s for a fresh clone. `dagWorker` uses a 15m inactivity timeout and 30m hard abort; the worker heartbeat pi extension keeps active runs alive.

## What does not work yet

- `microvm` stage execution inside the guest
- automatic DAG completion notifications to the gateway; operators still have to poll
- large-file pi agent edits are slow (often 3–5 minutes) even when they succeed

## Canonical operator flow

1. Shape the work with `joelclaw workload plan`
2. Present the shaped workload and ask **approved?**
3. After approval:
   - execute inline if it is bounded, local, and reversible
   - use `joelclaw workload run` for real durable execution
   - use `joelclaw workload dispatch` only for a real baton pass
4. If you enqueue runtime work, poll for progress with `joelclaw runs`, `joelclaw run <run-id>`, or OTEL. There is no automatic completion ping yet.
5. Report outcome tersely: changed, verified, remaining, next move

## Magic words → canonical commands

### Plan only
```bash
joelclaw workload plan "<intent>" --repo <repo> [--paths a,b,c] [--stages-from <path>] [--write-plan <path>]
```

### Real runtime canary / dogfood
```bash
joelclaw workload run <plan-artifact> \
  [--stage <stage-id>] \
  [--tool pi|codex|claude] \
  [--timeout <seconds>] \
  [--model <model>] \
  [--execution-mode auto|host|sandbox] \
  [--sandbox-backend local|k8s] \
  [--sandbox-mode minimal|full] \
  [--repo-url <git-url>] \
  [--dry-run] \
  [--skip-dep-check]
```

### Handoff, not execution
```bash
joelclaw workload dispatch <plan-artifact> \
  [--stage <stage-id>] \
  [--project <mail-project>] \
  [--from <agent>] \
  [--to <agent>] \
  [--send-mail] \
  [--write-dispatch <path>]
```

## Sandbox mode guidance

Use `--sandbox-mode full` when the proof needs real runtime surfaces:
- service/network lifecycle
- full environment materialization
- cleanup evidence
- anything where a minimal local sandbox would hide the real failure mode

Use `--sandbox-mode minimal` for cheap code/doc/test slices where full runtime provisioning is overkill.

Use `--stages-from` when you already have a real stage DAG. The planner preserves per-stage acceptance, validates dependencies/cycles, calculates critical path metadata, and keeps the DAG instead of collapsing it into template stages.

Use `--skip-dep-check` only for deliberate manual recovery. Normal `joelclaw workload run` blocks a stage until its explicit dependencies have terminal truth.

Do **not** choose `microvm` just because Firecracker boots. Today that proves guest bring-up, not general command execution inside the VM.

## Current runtime truth

- `joelclaw workload run` is the real bridge from workload artifacts to runtime admission.
- The durable path is Redis queue admission → Restate `dagOrchestrator` → `dagWorker`.
- `dagOrchestrator` resolves dependency waves correctly for chained multi-stage DAGs.
- `{{nodeId}}` interpolation is proven for passing upstream outputs into downstream stages.
- The `shell` handler is the only proven path for autonomous repo mutation today.
- The `infer` handler is the proven text-only path for planning, research, and analysis.
- The `microvm` handler proves Firecracker boots and snapshot restore, but not workspace execution.
- Completion is poll-based for now. No gateway finish event is emitted when a DAG lands.

## Real chained example

This is an honest four-stage shape the rig can run today:

```json
[
  {
    "id": "research",
    "name": "Research current state",
    "acceptance": ["Facts gathered"],
    "executionMode": "manual"
  },
  {
    "id": "plan",
    "name": "Turn research into an execution plan",
    "dependsOn": ["research"],
    "acceptance": ["Implementation plan written"],
    "executionMode": "manual"
  },
  {
    "id": "implement",
    "name": "Apply the change in the worker",
    "dependsOn": ["plan"],
    "acceptance": ["Requested files updated", "Commit pushed"],
    "executionMode": "pi",
    "notes": "Use {{plan}} as the downstream input."
  },
  {
    "id": "verify",
    "name": "Verify and summarize",
    "dependsOn": ["implement"],
    "acceptance": ["Verification captured", "Closeout ready"],
    "executionMode": "manual",
    "notes": "Use {{implement}} for verification context."
  }
]
```

Run it through the front door:

```bash
joelclaw workload plan "Research, plan, implement, then verify the change" \
  --repo ~/Code/joelhooks/joelclaw \
  --stages-from stages.json \
  --write-plan plan.json
```

## When to reach for compatibility skills

- `agent-workloads` — only when an older prompt already names it; treat it as a compatibility alias
- `restate-workflows` — only when the work is specifically about external-repo runtime bridging or low-level substrate contracts

## Dogfood posture

When proving runtime work:
- prefer a canary first
- use the real front door (`joelclaw workload run`), not hand-rolled `system/agent.requested`, unless you are debugging below the rig
- capture honest evidence from queue admission, Restate, `dagWorker`, and resulting git/verification artifacts
- poll the run yourself; there is no completion event to the gateway yet
- inside a sandboxed stage run, do **not** launch another workflow-rig canary
- if the rig is broken, say the rig is broken; do not blame sandboxes or the gateway for a queue/worker failure
- if the task needs large-file agent edits, budget minutes, not seconds

## Rules

- do not invent new workload vocabulary when `docs/workloads.md` already defines it
- do not force the operator to choose queue vs Restate vs sandbox when `joelclaw workload run` is the right bridge
- do not claim `microvm` can run general stage commands yet
- do not claim a dogfood proof succeeded unless the real runtime path moved and produced evidence
- do not imply automatic completion notifications exist when they do not
