---
name: agent-workloads
displayName: Agent Workloads
description: "Compatibility alias for the canonical `workflow-rig` front door. Use when older prompts mention `agent-workloads` or when you need the legacy workload-planning guidance; for new work, load `workflow-rig` first."
version: 0.8.0
author: Joel Hooks
tags:
  - agent-first
  - workloads
  - coding
  - repo
  - steering
  - serial
  - parallel
  - chained
  - adr-0217
---

# Agent Workloads

This skill is now a **compatibility alias**.

For new work, load **`workflow-rig`** first. That is the canonical front door for workload planning, runtime mode selection, and workflow-rig dogfood.

Keep using this skill only when an older prompt already names `agent-workloads` or when you need the historical workload-planning guidance below.

If the work is really about external repo bridging or low-level runtime submission mechanics, _then_ the `restate-workflows` skill may matter. For normal coding/repo work, this skill comes first.

## What this skill is for

- turning Joel steering into an execution shape
- choosing between **serial**, **parallel**, and **chained** work
- deciding whether a task should stay inline or move to a durable/sandboxed path
- defining the handoff contract between workers
- keeping repo/coding work agent-first instead of runtime-first

## Load Order

For serious workload design, also load:

- `cli-design` — future `joelclaw workload` surface and JSON contract
- `clawmail` — reservations, ownership, and handoffs
- `system-architecture` — real runtime topology
- `docker-sandbox` — isolation/backends when execution mode matters
- `codex-prompting` — if the workload will dispatch coding agents downstream

Canonical repo doc:

- `docs/workloads.md` — source of truth for workload vocabulary, request/plan/handoff schema, and shipped-vs-planned boundaries

## Core rule

**Do not make the caller choose the substrate unless that tradeoff is the task.**

And do not let an approved bounded local slice drift into planner/dispatch/queue theatre just because those surfaces exist.

The caller should describe intent.
The planner should decide execution.

Bad:

- “Should I use Restate or queue or sandbox or a loop?”

Good:

- “This is a chained repo workload with sandboxed implementation, inline verification, and docs closeout.”

## First pass: classify the workload

Ask or infer these inputs:

- workload kind (`repo.patch`, `repo.refactor`, `repo.docs`, `repo.review`, `research.spike`, `runtime.proof`, `cross-repo.integration`)
- objective
- acceptance criteria
- repo / file scope
- shape (`auto`, `serial`, `parallel`, `chained`)
- autonomy level
- proof posture (`none`, `dry-run`, `canary`, `soak`, `full`)
- risk posture (`reversible-only`, `sandbox-required`, `host-okay`, `deploy-allowed`, `human-signoff`)
- sequence constraints
- required artifacts

If those are fuzzy, shape the workload before dispatch.

## Choose the shape

### Serial

Use when steps depend on each other or risk is high.

Examples:

- fix → verify → commit
- canary → cleanup → truth update
- refactor → deploy check → docs

### Parallel

Use when branches are independent and comparison helps.

Examples:

- spike multiple approaches
- inspect multiple codepaths in parallel
- gather evidence from several repos/surfaces before synthesis

### Chained

Use when specialist stages add value and artifacts should flow forward.

Examples:

- implement → verify → docs
- research → planner → implementor → reviewer
- patch → canary → ADR truth

## Default execution bias

- prefer **inline** for obvious low-risk local tasks
- prefer **serial** for risky or dependent work
- prefer **parallel** to reduce uncertainty, not to look clever
- prefer **chained** when artifacts and stage boundaries matter
- prefer **sandboxed** execution when repo mutation is risky or isolation is the point

## Operator loop

Canonical posture for coding/repo work:

1. operator gives intent + context
2. agent returns a shaped workload plan
3. agent asks **approved?**
4. once approved, follow `guidance.executionLoop.approvedNextStep` instead of re-planning
5. while work is running, let the pi extension/TUI show honest status at real stage boundaries
6. finish with a terse outcome summary: what changed, what was verified, what remains, and whether the next move is push / handoff / stop

For a **bounded local slice** (`mode=inline`, local repo, explicit paths, cheap verification), the honest default is:

- reserve scope
- execute inline
- verify
- commit
- ask whether to push

Not:

- dispatch ceremony
- queue/restate submission theatre
- adjacent ops churn the operator did not ask for

## Handoff rule

Every downstream worker should receive:

- goal
- current state
- artifacts produced
- verification already done
- remaining gates
- reserved file scope
- known risks/caveats
- exact next action

If the next worker has to reconstruct everything from chat history, the workload was shaped badly.

## Runtime boundary

This skill is the **product layer**.

Substrate skills remain implementation details:

- `restate-workflows` — external repo/runtime bridge details
- `docker-sandbox` — isolation/backends
- `agent-loop` — durable coding loop mechanics

Use them only after the workload shape is clear.

## Command surface

Shipped now:

```bash
joelclaw workload plan "<intent>" \
  [--preset docs-truth|research-compare|refactor-handoff] \
  [--repo /abs/path/or/owner/repo] \
  [--paths a,b,c] \
  [--paths-from status|head|recent:<n>] \
  [--write-plan ~/.joelclaw/workloads/]

joelclaw workload dispatch <plan-artifact> \
  [--stage stage-2] \
  [--to BlueFox] \
  [--from MaroonReef] \
  [--send-mail] \
  [--write-dispatch ~/.joelclaw/workloads/]

joelclaw workload run <plan-artifact> \
  [--stage stage-2] \
  [--tool pi|codex|claude] \
  [--execution-mode auto|host|sandbox] \
  [--sandbox-backend local|k8s] \
  [--dry-run]
```

Use `plan` to get the canonical `request` + `plan` envelope, seed scope from real repo activity, and emit a reusable plan artifact. The CLI now also returns `guidance` so the agent gets:

- `recommendedExecution` — execute inline now vs tighten scope first vs dispatch after health check
- `operatorSummary` — plain-spoken next-step recommendation
- `adrCoverage` — which ADRs likely govern the slice already; on fresh repo-local ADR clusters, reconcile nearby follow-on ADRs before declaring coverage complete
- `recommendedSkills` — including `joelclaw skills ensure <name>` for local repo skills or `npx skills add -y -g <source>` for external ones
- `executionExamples` — serial / parallel / chained coding-task few-shot setup + execution examples
- `executionLoop` — the honest plan → approve → execute/watch → summarize contract, including what to do immediately after approval

Use `dispatch` to turn a saved plan into a real handoff contract instead of retyping the whole bloody thing. The CLI now also returns dispatch guidance so it can say when dispatch is overkill for a bounded inline slice, when to health-check before handing off, when the recipient still needs to be made explicit, and what the approval/progress/closeout loop should look like.

Use `run` when the plan is approved and should enter the queue-backed runtime through one canonical bridge. It normalizes the saved plan into `workload/requested` → `system/agent.requested` instead of forcing the operator to hand-roll `joelclaw queue emit` payloads.

Still planned:

```bash
joelclaw workload status <id>
joelclaw workload explain <id>
joelclaw workload cancel <id>
```

Until the rest exists:

1. run `joelclaw workload plan`
2. read the returned `guidance` before doing anything cute
3. present the plan, then ask **approved?**
4. once approved, follow `guidance.executionLoop.approvedNextStep`
5. if `recommendedExecution=execute-inline-now`, reserve the scoped files and just do the work
6. if `recommendedExecution=tighten-scope-first`, rerun the planner with explicit `--paths` or `--paths-from ...`
7. if the approved plan should enter the queue-backed runtime, run `joelclaw workload run` instead of hand-rolling `queue emit`
8. if another worker should take it first, save the plan and run `joelclaw workload dispatch`
9. deliver the dispatch contract through clawmail when appropriate
10. keep the handoff explicit and report the final outcome tersely

## Reference

Read the detailed workload catalog here:

- [references/common-workloads.md](./references/common-workloads.md)

## Rules

- start with workload shape, not runtime mechanism
- use the canonical vocabulary from `docs/workloads.md`; don't invent fresh field names unless the doc changes too
- implementation intent beats docs follow-through: `refactor ... then update docs` or `extend ... then update README` should still plan as implementation work
- preserve explicit `Acceptance:` clauses from the prompt when they exist; don't throw them away and replace them with mush
- mentioning a sandbox as the topic of research does not automatically mean the work must execute in a sandbox
- `deploy-allowed` should come from explicit release/deploy intent, not from nouns like `published skills`
- supervised repo work mentioning `canary` or `soak` does not automatically mean `durable` / `restate`
- use `Goal:` milestones and `reflect/update plan` cues to keep chained plans from collapsing into generic sludge
- if you are not inside the target repo and `workload plan` warns about the cwd not being a git repo, rerun with `--repo`
- use `--paths-from status|head|recent:<n>` when scope should come from actual repo activity instead of hand-typed path lists
- use `--write-plan` when another agent should be able to pick up the workload without reading raw chat
- use `joelclaw workload dispatch` when a saved plan should become a stage-specific handoff contract
- `--write-dispatch` is for reusable dispatch artifacts; `--send-mail` is for actually delivering the contract through clawmail
- never hand a coding agent substrate docs as the only answer to “how should I run this work?”
- serial / parallel / chained are first-class planning choices, not afterthoughts
- use `clawmail` for any delegated or shared-file workload
- keep outputs machine-usable and explicit
- if the best execution path is unclear, say so and produce a plan rather than guessing
