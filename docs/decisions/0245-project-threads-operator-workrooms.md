---
status: accepted
date: 2026-05-21
decision-makers:
  - Joel Hooks
consulted:
  - StubbornFerret
informed:
  - joelclaw agents
tags:
  - gateway
  - slack
  - operator-ux
  - project-threads
related:
  - 0210-channel-intelligence-pipeline
  - 0237-thread-oriented-conversation-intelligence
  - 0244-reply-grants-channel-routing
---

# ADR-0245: Project Threads as Operator Workrooms

## Status

accepted

## Context

joelclaw implementation work often needs milestone updates, approvals, blockers, canary evidence, and handoff receipts. When those updates happen in the same Slack thread as a public/customer/external discussion, agents blur two different domains:

1. operator-facing coordination about the work
2. public-channel participation that requires explicit permission

ADR-0244 introduced **Reply Grants** for public replies. Reply Grants solve permission to speak publicly, but they do not provide a clean operator workroom for implementation progress.

`grill-with-docs` is also becoming the front door for shaping implementation work. When a grill crosses into ADR/PRD/runtime-change territory, the system needs a consistent place to park the workroom URL and route milestones.

## Decision

Use **Project Threads** as the standard operator-facing Slack workroom for bounded joelclaw implementation efforts.

A Project Thread is a User-approved Slack thread in `#brain-joel` for one bounded objective. Agents post milestone updates, blockers, approvals, canary evidence, and handoff links there. A Project Thread is coordination space only; it does **not** grant permission to post into any public/customer/external thread.

`grill-with-docs` must recommend creating or reusing a Project Thread when the emerging plan crosses any threshold:

- it will produce an ADR, PRD, or multi-step implementation plan
- it will require milestone updates, operator approvals, or canary evidence
- it touches gateway routing, public channel behavior, deploys, secrets, customer-facing systems, or durable runtime state
- it is expected to outlive the current chat turn or involve follow-up verification

Working artifacts that exist for the effort should carry the Project Thread URL or ID:

- PRD frontmatter/metadata when a PRD exists
- ADR notes when the thread informs a decision
- handoff/final audit sections when the thread is created after the PRD

## Consequences

- Operators get one Slack URL per bounded effort.
- Milestone noise stays out of incident/public threads.
- Agents have a place to report canary evidence without implying public reply permission.
- Reply Grants remain the only public-reply boundary.
- Work that does not cross the threshold can stay in the current conversation without ceremony.

## Alternatives considered

### Keep posting milestones in the source thread

Rejected. It mixes implementation chatter with external/public discussion and caused confusing Slack behavior during Reply Grants work.

### Always create a Project Thread for every task

Rejected. Too much ceremony for small reversible edits.

### Use Telegram-only milestones

Rejected. Telegram is good for immediate approval, but Slack Project Threads provide better shared history, links, and artifact anchoring.

## Implementation notes

V1 is process + documentation + skill behavior:

- Project Thread domain language lives in `CONTEXT.md`.
- `grill-with-docs` asks for approval when the threshold is crossed.
- PRDs include `project_thread_url` metadata when available.
- Gateway docs explain Project Threads versus Reply Grants.

Future automation may add a `joelclaw gateway project-thread create|reuse` command, but V1 does not require a new command surface.
