---
name: adr-skill
displayName: ADR Skill
description: Create and maintain Architecture Decision Records (ADRs) optimized for agentic coding workflows. Use when you need to propose, write, update, accept/reject, deprecate, or supersede an ADR; bootstrap an adr folder and index; consult existing ADRs before implementing changes; or enforce ADR conventions. This skill uses Socratic questioning to capture intent before drafting, and validates output against an agent-readiness checklist.
version: 1.2.0
author: Joel Hooks
tags: [adr, architecture, decision-records, documentation, workflows, visual-explainer]
disable-model-invocation: true
---

# Architecture decisions

Use an ADR for a durable architectural choice with meaningful alternatives or consequences. Routine fixes and established implementation choices need no new ADR. Consult relevant accepted records before changing their governed code.

## Capture the decision

Read the project's instructions, existing decision index, relevant records, dependencies, and affected code. Reuse existing conventions. In a Brain tree, write prose as `.svx`.

Extract intent from the request and sources. Ask only for missing decisions that prevent an accurate record. A request to document a settled decision needs no preliminary interview or confirmation round. Keep an unapproved choice `proposed`; do not accept it merely because it ranked first in a queue.

Capture the trigger, constraints, considered alternatives, selected option, consequences, non-goals, and conditions for revisiting it. Distinguish the user's decision from the agent's recommendation.

## Write and verify

Use [template variants](references/template-variants.md) to choose the simple or MADR template in `assets/templates/`. Include affected paths, patterns, implementation steps, and observable validation where implementation is in scope. Name only skills actually needed for that work.

Read [the review checklist](references/review-checklist.md) after drafting. Fix factual and completeness gaps from sources. Ask about unresolved consequential choices, not ordinary editing. Add a diagram only when it clarifies architecture; verify any tool or slash command before invoking it.

Link the ADR to governed code and implementation receipts. A short code reference at the relevant boundary is enough. Update the existing index and visual links when applicable.

Done means the record accurately states the decision and status, sources, consequences, implementation boundary, and verification. Report unresolved gaps without inventing acceptance.

## Lifecycle

For acceptance, rejection, deprecation, or supersession, use the user's authorization and the project's status conventions. Preserve history; superseding records link both ways. Mark shipped only after checking the implementation and recording its validation.

Tracker creation and implementation are separate actions unless included in the request. Selecting the next proposed ADR does not authorize its acceptance or execution.

For the existing JoelClaw ADR store, the sync event is `system/adr.sync.requested` with source `adr-skill`; verify the current owning handler before emission. Use the project's own indexing path elsewhere. A local draft does not justify an unrelated fleet-wide sync.

## Tools and references

Read current help before use:

- `scripts/new_adr.js`: create from a template and optionally update the index.
- `scripts/set_adr_status.js`: update the record's status.
- `scripts/bootstrap_adr.js`: initialize ADR conventions when requested.
- [ADR conventions](references/adr-conventions.md): naming, status, and lifecycle.
- [Examples](references/examples.md): completed records.

For a requested next-ADR search, inspect `joelclaw vault adr --help`. Rank candidates by readiness and value, then verify whether they already shipped.
