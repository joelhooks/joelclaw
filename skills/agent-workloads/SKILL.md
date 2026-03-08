---
name: agent-workloads
displayName: Agent Workloads
description: "Plan and steer agent-first coding/repo workloads in joelclaw. Use when the task is development work and you need to choose serial, parallel, or chained execution; shape pi-session steering; decide whether work should stay inline, go durable, or run in a sandbox; or define the handoff contract between workers. Triggers on 'plan this workload', 'serial/parallel/chained', 'repo workflow', 'coding workflow', 'pi steering', 'agent-first workload', 'how should an agent run this task', or any request to make coding work legible before dispatching it." 
version: 0.1.0
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

Use this skill as the **front door** for coding and repo work in joelclaw.

If the real question is:

> what is this work, how should it run, and what should happen next?

load this skill before touching substrate-specific docs.

If the work is really about external repo bridging or low-level runtime submission mechanics, *then* the `restate-workflows` skill may matter. For normal coding/repo work, this skill comes first.

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

## Core rule

**Do not make the caller choose the substrate unless that tradeoff is the task.**

The caller should describe intent.
The planner should decide execution.

Bad:
- “Should I use Restate or queue or sandbox or a loop?”

Good:
- “This is a chained repo workload with sandboxed implementation, inline verification, and docs closeout.”

## First pass: classify the workload

Ask or infer these inputs:
- objective
- acceptance criteria
- repo / file scope
- autonomy level
- proof posture (dry-run, canary, soak, full implementation)
- risk posture (reversible only, sandbox required, deploy allowed)
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

## Future command surface

Design and think toward:

```bash
joelclaw workload plan "<intent>"
joelclaw workload run "<intent>"
joelclaw workload status <id>
joelclaw workload explain <id>
joelclaw workload cancel <id>
```

Until that exists, emulate the same discipline manually:
1. classify the workload
2. choose the shape
3. define artifacts and gates
4. dispatch through the appropriate existing surface
5. keep the handoff explicit

## Reference

Read the detailed workload catalog here:
- [references/common-workloads.md](./references/common-workloads.md)

## Rules

- start with workload shape, not runtime mechanism
- never hand a coding agent substrate docs as the only answer to “how should I run this work?”
- serial / parallel / chained are first-class planning choices, not afterthoughts
- use `clawmail` for any delegated or shared-file workload
- keep outputs machine-usable and explicit
- if the best execution path is unclear, say so and produce a plan rather than guessing
