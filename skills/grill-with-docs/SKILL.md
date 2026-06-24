---
name: grill-with-docs
description: Grilling session that challenges your plan against the existing domain model, sharpens terminology, captures long-form rationale, and updates documentation (CONTEXT.md, ADRs, skills, TA notes) inline as decisions crystallise. Use when user wants to stress-test a plan, explain why a tool/guardrail was chosen, build teacher-assistant material, or align work with their project's language and documented decisions.
---

<what-to-do>

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing.

If a question can be answered by exploring the codebase, explore the codebase instead.

When the user is choosing tools, guardrails, skills, or teaching material, explicitly prompt for long-form rationale before compressing the answer. Ask why this choice, why now, what trade-off is accepted, what a learner/operator should understand, and what future agents should remember. Capture the result in the appropriate durable surface: `CONTEXT.md` for terms, ADRs for hard-to-reverse decisions, project Brain/docs for source-backed rationale, or skills/TA notes for reusable guidance.

When the plan is likely to become implementation work, evaluate whether it needs a **Project Thread** in `#brain-joel`. Recommend creating one when the work crosses any of these thresholds:

- it will produce an ADR, PRD, or multi-step implementation plan
- it will require milestone updates, operator approvals, or canary evidence
- it touches public channel behavior, gateway routing, deploys, secrets, customer-facing systems, or durable runtime state
- it is expected to outlive the current chat turn or involve follow-up verification

Ask for operator approval before creating or using a Project Thread. Do not treat a Project Thread as permission to post into public/customer/external threads; public replies still require the appropriate Reply Grant or explicit channel permission.

</what-to-do>

<supporting-info>

## Long-form rationale capture

Do not accept a bare preference like "use this library" when the session is meant to teach or bank reusable agent behavior. Grill for:

- the practical reason for the choice
- the alternatives being rejected
- the trade-offs and risks
- the kind of loop, gate, or workflow the choice supports
- whether the rationale is for humans, agents, or both
- where the rationale should live so future agents can use it

Keep the user's full explanation long enough to preserve nuance, then write a compact version only after the durable source exists.

For post-hoc questions like "why did we add all this?", do not lead with a file inventory or "because you asked." Lead with the captured rationale, then map that rationale to files, commands, or guardrails as evidence.

## Domain awareness

During codebase exploration, also look for existing documentation:

### File structure

Most repos have a single context:

```
/
├── CONTEXT.md
├── docs/
│   └── adr/
│       ├── 0001-event-sourced-orders.md
│       └── 0002-postgres-for-write-model.md
└── src/
```

If a `CONTEXT-MAP.md` exists at the root, the repo has multiple contexts. The map points to where each one lives:

```
/
├── CONTEXT-MAP.md
├── docs/
│   └── adr/                          ← system-wide decisions
├── src/
│   ├── ordering/
│   │   ├── CONTEXT.md
│   │   └── docs/adr/                 ← context-specific decisions
│   └── billing/
│       ├── CONTEXT.md
│       └── docs/adr/
```

Create files lazily — only when you have something to write. If no `CONTEXT.md` exists, create one when the first term is resolved. If no `docs/adr/` exists, create it when the first ADR is needed.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the existing language in `CONTEXT.md`, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

### Update CONTEXT.md inline

When a term is resolved, update `CONTEXT.md` right there. Don't batch these up — capture them as they happen. Use the format in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

Don't couple `CONTEXT.md` to implementation details. Only include terms that are meaningful to domain experts.

### Use Project Threads for operator-facing workrooms

A **Project Thread** is the operator-facing Slack workroom for a bounded objective, usually in `#brain-joel`. Use it for milestone updates, blockers, audit receipts, canary evidence, and handoff links.

During a grill, if the emerging plan crosses the Project Thread threshold, ask one question before implementation:

> Recommended: create/use a `#brain-joel` Project Thread for this objective so milestones and evidence stay out of public/incident threads. Approve?

If approved, create or reuse a `#brain-joel` Project Thread. When creating one, the root message must mention Joel directly (`<@U030BJ3CK>`) and state the bounded objective. Then carry the Project Thread URL/ID into the PRD (`project_thread_url`) or working notes. Post milestones, blockers, approval requests, and canary evidence there. If declined, continue in the current conversation and keep updates concise.

### Offer ADRs sparingly

Only offer to create an ADR when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the ADR. Use the format in [ADR-FORMAT.md](./ADR-FORMAT.md).

</supporting-info>
