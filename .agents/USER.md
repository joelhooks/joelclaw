# User: Joel Hooks

## Who

Co-founder of egghead.io — bootstrapped developer education platform to $250K+/mo MRR. Education at Vercel. Builds tools for people who teach developers. The platform powers courses from Matt Pocock (Total TypeScript, AI Hero), Kent C. Dodds (Epic AI), and others through course-builder and badass.dev.

Vancouver, WA. Five kids, home-educates them.

Career path: 3D modeler/animator → self-taught programmer (2009) → consultant → co-founded egghead with John Lindquist (2013) → DevRel at Inngest → Education at Vercel.

First code: Logo on a TRS-80, third grade, 1982. "The tactile feedback of telling this little turtle and then watching it do what you tell it to do was awesome."

## How he thinks

- Systems thinker. Sees architecture before tasks.
- "Ideas are worthless. Execution is everything."
- Will throw away perfectly good code if the direction is wrong — killed 6 months of work when a multi-site approach was confusing.
- "Distributed systems are easy" (asterisk) — because good tools make them tractable now.
- Finds the human aspect of technology harder than the technical part.
- "I love to sink into impossible technical tasks and rise superior to the machine and curse it with my dominance when I'm finished."
- Treats learning design like UX — Understanding by Design, backwards from outcomes.
- "My blog is a digital garden, not a blog."

## Working style

- Prefers small bets that compound over big bang rewrites
- Wants to see the loop earn its pass — won't hand-wave failures
- Moves fast when direction is clear, slows down to think when it isn't
- Uses ADRs to make decisions durable
- Logs infrastructure decisions, doesn't log routine work
- "egghead style" — concise, in depth, well thought out, focused, to the point. No fluff. Respects the reader's time. This applies to everything he builds, not just courses.

## Tech preferences

- **Effect ecosystem** for TypeScript (Effect, @effect/cli, @effect/schema, @effect/platform)
- **Bun** as runtime and package manager
- **Inngest** for durable workflows and event-driven pipelines (worked there, knows it deeply)
- **Redis** for ephemeral state (loop PRDs, caches)
- **Obsidian** vault as knowledge base (PARA method)
- **pnpm workspaces** for monorepos
- **Next.js + RSC** for web
- **Mux** for video infrastructure
- **Docker sandbox** for agent isolation
- Agent-first CLI design (JSON always, HATEOAS next_actions)
- Symlink single sources of truth, don't copy files
- Visible source ("not open source — there is no support implied or given")

## Projects

- **joelclaw** — personal AI system monorepo (web, system-bus, CLI)
- **course-builder** — next-gen CMS for developer education (powers AI Hero, Total TypeScript, Epic AI)
- **badass.dev** — consulting + case studies on building developer courses
- **egghead.io** — co-founder, original platform
- **Content** — technical writing at joelhooks.com (digital garden)
- **Video pipeline** — ingest → transcribe → archive → vault notes
- **swarm-tools** — multi-agent swarm coordination for OpenCode
- **pdf-brain** — local PDF knowledge base with vector search
- **semantic-memory** — local semantic memory with PGlite + pgvector

## Hardware

- M4 Pro Mac Mini "Panda" — 64GB RAM, always-on, Tailscale SSH
- NAS "three-body" — video archive, backups
