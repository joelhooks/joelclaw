---
description: "Work on wizardshit.ai — Joel's AI education platform teaching the exploratory journey of building systems with and around AI. Covers the Next.js app in gremlin, The Claw course design, and the manage brain vault. Triggers on: 'wizardshit', 'wizard shit', 'wizardshit.ai', 'the claw course', 'agent game generation', 'zots', 'minions of toil'."
---

# wizardshit.ai

Joel's AI education platform. The crux: **teach the exploratory journey of building systems with and around AI.**

Not a polished curriculum factory — a system that teaches by showing the system being built. Digital garden philosophy applied to AI education.

## Repositories

### App: `~/Code/badass-courses/gremlin/apps/wizardshit-ai/`

Next.js 16 app in the gremlin monorepo (`badass-courses/gremlin`). Uses the badass-courses platform:
- `@badass-courses/core`, `@badass-courses/sdk`, `@badass-courses/next`, `@badass-courses/ui`
- Convex backend via `@badass-courses/convex-adapter`
- Package name: `@wizardshit/web`

The gremlin monorepo has its own `AGENTS.md` — **read it before any gremlin work**:
```bash
cat ~/Code/badass-courses/gremlin/AGENTS.md
```

### Brain/Design: `~/Code/joelhooks/manage/`

Vercel manage repo with PARA-structured brain vault. Course design docs live here:
- `brain/01 Projects/Agent Game Generation/` — The Claw course design bible
- `skills/the-claw-course-design/SKILL.md` — course design process skill
- `docs/decisions/` — ADRs for the manage workspace

Key design documents (read in order):
1. `Course Concept.md` — canonical spec (~5K words)
2. `Lesson Bookends.md` — first and last lesson, fully workshopped
3. `Game Design Patterns.md` — 20 patterns mapping game mechanics → agent architecture
4. `Research - Schell Lenses x Dwarf Fortress x The Claw.md`
5. `Research - 4CID Learning Design Bible.md`
6. `Research - Dwarf Fortress Design Philosophy.md`
7. `Research - just-bash as Game Engine.md`
8. `Research - Game Design Bibles.md` — Koster + Schell
9. `Research - Prior Art and Landscape.md`
10. `Research - Multi-Agent Frameworks as MUD Architecture.md`
11. `Research - MUD Architecture and Platform Primitives.md`

### Public gist (full design docs):
https://gist.github.com/joelhooks/99b7188fdd775b32b646ee72484774cc

## Two Versions

1. **Vercel Academy** — toned-down business version. Vercel-native stack (Workflow, Sandbox, Queues, AI Gateway, just-bash). Draft: https://vercel.com/academy/draft/agent-game-generation
2. **wizardshit.ai** — the full unfiltered version. Free to use whatever infra. Inngest, k8s, Redis, self-hosted — whatever's best.

## The Claw: Minions of Toil

The flagship course. A roguelite colony management sim where Zots (autonomous AI agents) toil in a fantasy dungeon generated from real codebases.

Core insight: **the game mechanics ARE agent architecture patterns.** Health bar = context window. Abilities = tools. Party = multi-agent delegation. Combat = error handling. The representation IS the thing.

Design foundations:
- **Koster** — fun = learning patterns in a safe space
- **Schell** — 100+ lenses for design evaluation
- **4C/ID** — whole-task from day 1, scaffolding fades, driven by what breaks
- **Dwarf Fortress** — colony management, autonomous actors, "losing is fun", emergent narrative

Tech (wizardshit version — free to choose):
- **just-bash** — the game engine (virtual filesystem sandbox)
- **AI SDK** — Zot brains
- **Inngest** — tick engine, durable workflows
- Whatever persistence/state makes sense

Linear: [DX-2875](https://linear.app/vercel/issue/DX-2875/agent-game-generation)

## Working With This Project

1. For gremlin app work: `cd ~/Code/badass-courses/gremlin` and read its AGENTS.md
2. For course design: `cd ~/Code/joelhooks/manage` and read the brain vault docs
3. For joelclaw integration: this is where wizardshit infra decisions may overlap with joelclaw patterns
4. Load the `gremlin` skill for gremlin-repo-specific guidance
