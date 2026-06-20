---
name: vision-forge
description: "Create or revise a scoped vision document for external actors: who the work serves, why it exists, what outcomes matter, and what boundaries guide decisions. Use when the user asks to draft a vision, VISION.md, project constitution, CEO doc, product charter, external contributor guidance, or agent/loop governance that needs a separate companion policy."
---

# Vision Forge

Create a vision document that acts like the CEO for a chosen scope: short, explicit, and useful to external actors. This is not a PRD, roadmap, strategy memo, or task list. It is the standing intent layer that users, contributors, maintainers, partners, and operators can use to understand what the work is for and what does not fit.

Default assumption: `VISION.md` is **not** an agent instruction file. Agents may consult it for product intent only when project instructions tell them to. Operational agent rules belong in `AGENTS.md`, skills, or a separate loop/agent policy.

## Scope first

Vision can vary in scope. Before drafting, name the boundary the vision governs and do not mix multiple layers into one mushy doc.

Common scopes:

- **Organization / operating system** — mission, values, governance, roles, budget, and long-lived operating constraints.
- **Product / business line** — who the product serves, the durable outcome, positioning, non-goals, and investment boundaries.
- **Project / repo** — project intent, target users, architecture direction, contribution policy, merge/sign-off gates, and maintenance priorities.
- **Feature / subsystem** — the target user outcome, local non-goals, constraints, and evidence that the subsystem is working.
- **Loop / agent program** — allowed autonomy, escalation gates, budgets, reviewer/judge policy, and learning/amendment rules. This is usually a companion policy, not the external `VISION.md` itself.

Use `VISION.md` for repo/project-level external intent when that is the convention. For smaller or larger scopes, choose a clearer path such as `docs/vision.md`, `docs/<feature>/vision.md`, `.brain/areas/<area>.svx`, or a section inside a PRD. The artifact name is less important than the scope and audience being explicit.

Parent visions constrain child visions. A feature vision can specialize product intent; it should not quietly overrule the product or org vision.

## Audience first

Name who the document is for before choosing sections:

- **External actors**: users, contributors, partners, buyers, community members, auditors, maintainers outside the core loop. This is the normal `VISION.md` audience.
- **Internal operators**: owners, maintainers, staff, support, release managers. They may need private notes or an ops charter.
- **Agents / loops**: planner, worker, reviewer, judge, loop master. They need explicit operational instructions elsewhere.

If the user wants agents to enforce the vision, add a companion pointer rather than stuffing internal loop rules into the external vision:

```md
# AGENTS.md excerpt

Read `VISION.md` for product intent, target users, non-goals, and decision boundaries before planning substantial work. `VISION.md` is not permission to bypass this file. Operational rules, commands, validation, and sign-off gates live here.
```

## Read first

Before asking questions, inspect whatever exists:

- existing `VISION.md`, `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, docs, ADRs, issue templates, and changelog
- project notes, PRDs, roadmaps, or planning docs if present
- recent code shape when the vision must reflect actual architecture
- open issues/PRs only when they reveal current priorities or governance pain

If evidence answers a question, do not ask it again. Draft from receipts, then ask only for missing decisions.

## Ask one question at a time

Use this format:

```txt
Question: ...

My recommendation: ...

Why: ...
```

Ask branch-forcing questions, not essay prompts. Good questions identify a decision:

- Who is the first real user/operator this project exists to help?
- What long-term outcome should survive even if the implementation changes?
- What work should contributors or maintainers treat as safe by default?
- What work must stop for owner/maintainer sign-off?
- What tempting adjacent work is explicitly not the project?
- What evidence tells a loop it made the project better?

## Draft shape

A strong project/repo `VISION.md` usually fits on one screen per section:

```md
# Vision

<One or two paragraphs: what this project is and why it exists.>

## Who We Serve

- Primary users:
- Secondary users:
- Not for:

## Outcomes

- Long-term outcome 1
- Long-term outcome 2
- Long-term outcome 3

## Current Priorities

1. Priority one
2. Priority two
3. Priority three

## Actors

- Primary users / beneficiaries:
- Contributors / builders:
- Maintainers / owners:
- Partners / external systems:
- Not an audience:

## Merge by Default

- Safe bug fixes with clear cause and bounded risk
- Documentation fixes that do not change policy
- Tests/checks that encode existing intended behavior
- Small improvements that follow existing architecture and do not add maintenance burden

## Needs Sign-Off

- New product surface or user promise
- Architecture, dependency, toolchain, auth, privacy, security, deploy, pricing, or data-retention changes
- Behavior that changes public API, user data, billing, or operational risk
- Broad refactors or changes that add meaningful maintenance complexity

## Will Not Do For Now

- Tempting non-goal 1
- Tempting non-goal 2

## Decision Boundaries

- Safe by default:
- Needs owner sign-off:
- Evidence expected for meaningful changes:
- Budget / maintenance constraints:

## Amendment Policy

This document may change when evidence shows the project direction or governance is wrong. Agents may propose amendments with receipts. A human owner approves changes.
```

Adapt headings to the scope and audience. Do not force every section if it adds sludge. Keep merge/sign-off or decision-boundary sections for repo/project scopes because external contributors need to know what kinds of changes fit. If agent/loop governance is required, create or update `AGENTS.md`, a skill, or a separate loop policy as a companion artifact.

## Rules

- State the scope and audience boundary near the top.
- Make it short enough that an agent will actually read it.
- Use plain language. No executive fog machine.
- Prefer explicit tradeoffs over values posters.
- Separate vision from tasks: tasks go in PRDs, plans, issues, or backlog docs.
- Separate external vision from internal procedures: commands, local workflow details, and agent autonomy rules go in `AGENTS.md`, skills, or a companion loop policy.
- Include non-goals. They are usually the most useful part.
- If the project already has a strong vision, revise surgically instead of rewriting.
- If a proposed vision contradicts current code/docs, surface the contradiction and ask which truth should win.

## Output

When done, report:

- `VISION.md` path created/updated
- key decisions captured
- sign-off / decision boundaries added
- open questions left unresolved
- companion agent/loop policy created or updated, if needed
- validation run, if any
