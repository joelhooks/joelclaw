---
name: workflow-rig
displayName: Workflow Rig
description: "Canonical front door for agent-first workload planning, runtime mode selection, workflow-rig dogfood, and runtime dispatch in joelclaw. Use when the user says 'run this through the workflow rig', 'kick this off', 'dogfood this with the workflow rig', 'start a canary', 'run this as a workload', or any request to turn coding/runtime intent into a real joelclaw workload plan or run."
version: 0.1.0
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
- canary vs full execution posture
- inline vs sandbox vs durable runtime choice
- `joelclaw workload plan` / `dispatch` / `run`
- full-mode or minimal-mode sandbox selection when local sandboxing is the point
- workflow-rig dogfood of real runtime paths

## Core rule

**Intent first, substrate second.**

The caller describes the work.
The workflow rig decides how it should run.

Do not push runtime choice back onto the caller unless the runtime tradeoff is the actual decision.

## Canonical operator flow

1. Shape the work with `joelclaw workload plan`
2. Present the shaped workload and ask **approved?**
3. After approval:
   - execute inline if bounded/local/reversible
   - run `joelclaw workload run` if it should enter the real runtime
   - use `joelclaw workload dispatch` only when another worker truly needs the baton
4. Report outcome tersely: changed, verified, remaining, next move

## Magic words → canonical commands

### Plan only
```bash
joelclaw workload plan "<intent>" --repo <repo> [--paths a,b,c] [--stages-from <path>] [--write-plan <path>]
```

### Real runtime canary / dogfood
```bash
joelclaw workload run <plan-artifact> \
  --stage <stage-id> \
  --tool pi|codex|claude \
  --execution-mode host|sandbox \
  --sandbox-backend local|k8s \
  --sandbox-mode minimal|full \
  [--skip-dep-check]
```

### Handoff, not execution
```bash
joelclaw workload dispatch <plan-artifact> --to <agent> --from <agent> --send-mail
```

## Sandbox mode guidance

Use `--sandbox-mode full` when the proof needs real runtime surfaces:
- compose bring-up / bring-down
- devcontainer/runtime materialization
- service/network lifecycle
- cleanup evidence

Use `--sandbox-mode minimal` for cheap code/doc/test slices where runtime provisioning is overkill.

Use `--stages-from` when the project already has a real stage DAG (for example an ADR phase plan or hand-authored rollout JSON). The planner will validate the DAG, infer `serial|parallel|chained` when `--shape auto` is still open, and preserve stage acceptance/dependsOn truth instead of collapsing everything into generated template stages.

Use `--skip-dep-check` only for deliberate manual recovery. Normal `joelclaw workload run` now blocks a stage until each explicit dependency has terminal inbox truth.

## When to reach for compatibility skills

- `agent-workloads` — only when an older prompt already names it; treat it as a compatibility alias
- `restate-workflows` — only when the work is specifically about external-repo runtime bridging or low-level substrate contracts

## Dogfood posture

When proving runtime work:
- prefer a canary first
- use the real front door (`joelclaw workload run`), not hand-rolled `system/agent.requested` unless you are debugging below the rig
- capture honest runtime truth: queue health, drainer health, worker state, inbox state, cleanup state
- if the rig is broken, say the rig is broken; don’t pretend the sandbox failed when the queue bridge is the real dog
- inside a sandboxed stage run, do **not** start another workflow-rig canary. Nested `joelclaw workload run` is blocked by default, and repo-local verifier scripts that call it are the wrong move for stage execution

## Rules

- do not invent new workload vocabulary when `docs/workloads.md` already defines it
- do not force the operator to choose queue vs Restate vs sandbox when `joelclaw workload run` is the right bridge
- do not claim a dogfood proof succeeded unless the real runtime path actually moved and produced evidence
- if the proof exposes a substrate failure, fix or report that separately from the feature under test
