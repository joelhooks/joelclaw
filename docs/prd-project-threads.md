---
status: active
created: 2026-05-21
project_thread_url: https://eggheadio.slack.com/archives/C09LKT871PE/p1779381716944829?thread_ts=1779381716.944829&channel=C09LKT871PE
adr: docs/decisions/0245-project-threads-operator-workrooms.md
---

# PRD: Project Threads Operator Workrooms v1

## Objective

Implement Project Threads as the standard operator-facing workroom for bounded joelclaw implementation efforts: create or reuse `#brain-joel` Slack threads when `grill-with-docs` crosses the threshold, store the thread URL in working artifacts, and route milestone updates, blockers, approvals, and canary evidence there without changing Reply Grant public-reply boundaries.

## Success criteria

- Project Threads have ADR backing.
- Project Thread domain language is captured in `CONTEXT.md`.
- `grill-with-docs` asks for operator approval to create/reuse a Project Thread when threshold conditions are met.
- PRDs can store `project_thread_url` metadata.
- Gateway documentation clearly separates Project Threads from Reply Grants.
- A real `#brain-joel` Project Thread exists for this work and is referenced here.
- Milestone updates for this work are posted in that Project Thread.

## Non-goals

- No new public reply permission model.
- No change to Reply Grants.
- No always-on Project Thread creation for tiny tasks.
- No mandatory new CLI surface in v1.

## Threshold for recommending a Project Thread

Recommend a Project Thread when a grill or plan crosses any of these:

1. It will produce an ADR, PRD, or multi-step implementation plan.
2. It needs milestone updates, operator approvals, blockers, handoffs, or canary evidence.
3. It touches gateway routing, public channel behavior, deploys, secrets, customer-facing systems, or durable runtime state.
4. It is expected to outlive the current chat turn or require follow-up verification.

## Required workflow

1. Agent detects threshold during `grill-with-docs`.
2. Agent asks: “Recommended: create/use a `#brain-joel` Project Thread for this objective so milestones and evidence stay out of public/incident threads. Approve?”
3. If approved, agent creates or reuses a `#brain-joel` thread.
4. Agent stores the Slack thread URL in the PRD or working artifact.
5. Agent posts milestone updates, blockers, approval requests, and canary evidence in that thread.
6. Agent keeps Reply Grants separate for public/external channel replies.

## Artifact fields

When a PRD exists, include:

```yaml
project_thread_url: https://eggheadio.slack.com/archives/...
```

When no PRD exists, include the Project Thread URL in the handoff/final audit.

## Test / verification plan

- Verify `CONTEXT.md` defines Project Thread.
- Verify `skills/grill-with-docs/SKILL.md` contains the threshold and approval prompt.
- Verify `docs/gateway.md` distinguishes Project Threads from Reply Grants.
- Verify this PRD includes a valid `project_thread_url`.
- Verify a milestone update was posted in the Project Thread.

## Current Project Thread

- Slack thread: https://eggheadio.slack.com/archives/C09LKT871PE/p1779381716944829?thread_ts=1779381716.944829&channel=C09LKT871PE
