---
name: gremlin
displayName: Gremlin Bootstrap
description: Bootstrap Gremlin work from the joelclaw side. Use when a task mentions gremlin from outside the repo and you need to locate the repo, load its shipped repo-local skill, or understand which guidance belongs to gremlin versus joelclaw.
version: 0.2.1
author: joel
tags:
  - gremlin
  - joelclaw
  - bootstrap
  - repo-local-skills
---

# Gremlin Bootstrap

This is **not** the canonical Gremlin repo skill.

Gremlin-specific skills should ship with the Gremlin repo unless they are specifically about how Gremlin plugs into the joelclaw system.

## Canonical repo-local skill

Load this first for normal Gremlin work:

- `/Users/joel/Code/badass-courses/gremlin/skills/gremlin/SKILL.md`

Then load narrower repo-local skills as needed:

- `/Users/joel/Code/badass-courses/gremlin/skills/gremlin-package-release/SKILL.md`
- `/Users/joel/Code/badass-courses/gremlin/skills/gremlin-project-setup/SKILL.md`
- `/Users/joel/Code/badass-courses/gremlin/skills/gremlin-tanstack-start/SKILL.md`

## Use this joelclaw-side skill only when

- you are outside the Gremlin repo and need to jump into it
- you need to distinguish repo-local Gremlin guidance from joelclaw-specific automation/integration guidance
- you are updating joelclaw prompts, routing, or memory surfaces that refer to Gremlin

## Rules

1. Prefer the repo-local Gremlin skill for Gremlin truth.
2. Do not let joelclaw-owned prompts drift into owning Gremlin repo policy.
3. If a Gremlin skill is generally useful to Gremlin contributors, move it into the Gremlin repo instead of expanding this file.
