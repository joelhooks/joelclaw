---
name: skillrecordings-payout
displayName: Skill Recordings Payout Core
description: Work on the skillrecordings/payout repo (financial core + payout workflows). Trigger when user mentions skillrecordings/payout, payout repo, Soulver payout templates, royalties payouts, payout ADRs, or accounting core for Gremlin/platform.
version: 0.1.0
author: joel
tags:
  - skillrecordings
  - payout
  - accounting
  - soulver
  - drizzle
  - mysql
  - planetscale
  - gremlin
---

# Skill Recordings Payout Core

Use this skill whenever work targets:

- `/Users/joel/Code/skillrecordings/payout`
- `github.com/skillrecordings/payout`
- “payout repo”, “Soulver template payouts”, “royalties payout automation”, “accounting core”

## Project Position

`skillrecordings/payout` is **not just a utility repo**. It is a **piece of Gremlin** and intended to become the accounting substrate for broader platform workflows.

Design choices must remain reusable across:

- current royalties payout workflows
- future memberships/subscriptions flows
- future multi-property / multi-beneficiary platform payouts

## Immediate Goal (current phase)

Deliver reproducible **Soulver template generation first**, before full double-entry execution is switched on.

## Canonical ADR order

Read these first, in order:

1. `docs/decisions/0002-adopt-financial-core-monorepo-with-ports-and-adapters.md`
2. `docs/decisions/0003-adopt-minimal-immutable-financial-ledger-with-deferral-and-irregular-cadence-support.md`
3. `docs/decisions/0004-adopt-multi-beneficiary-allocation-and-tax-treaty-extension-points.md`
4. `docs/decisions/0005-automate-royalties-payout-pipeline-from-stripe-to-mercury-with-operator-approval.md`

## Rules

1. **pnpm monorepo only** (Turborepo + workspace layout).
2. **Dependency installs via CLI only** (`pnpm add`, `pnpm add -D`, `pnpm remove`).
   - Never hand-edit dependency sections in `package.json`.
3. **Ports and adapters discipline**.
   - Domain/application logic must not import infra adapters.
4. **Money math discipline**.
   - Integer minor units only.
5. **Interval discipline**.
   - Model periods as `[start, end)`; no month-only assumptions.
6. **Multi-beneficiary first-class**.
   - Never hardcode one beneficiary per property.
7. **Local-first DB strategy**.
   - Start with local MySQL in Docker, keep Drizzle contracts portable to PlanetScale.

## Skills policy for this project

- Develop domain/project skills **in tandem** with implementation.
- Canonical skills live in `~/Code/joelhooks/joelclaw/skills/`.
- Do **not** create project-local `./skills` content in `skillrecordings/payout`.

## Core commands

```bash
cd /Users/joel/Code/skillrecordings/payout
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm soulver:sample
```

Generate template from custom input:

```bash
pnpm soulver -- --input <path-to-input.json> [--out <output.soulver>]
```
