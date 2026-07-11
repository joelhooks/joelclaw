ultracode

Build a working v0 of Joel's private work/business personal wiki as a Claude Code dynamic workflow. Use the workflow to investigate, implement, integrate, and verify the vertical slices below. Do not stop at a plan.

## Where to work

Create the new local project at:

`/Users/joel/Code/joelhooks/joelclaw-wiki`

The destination repo does not exist yet. Scaffold it locally. Do not create a GitHub repository, commit, push, deploy publicly, or mutate production schemas without explicit approval.

Read these canonical planning artifacts first:

- `/Users/joel/Code/joelhooks/joelclaw/.brain/projects/wayfinder/joelclaw-personal-wiki-map.svx`
- every ticket under `/Users/joel/Code/joelhooks/joelclaw/.brain/projects/wayfinder/`
- `/Users/joel/Code/joelhooks/tufte-mdsvx/AGENTS.md`
- `/Users/joel/Code/joelhooks/tufte-mdsvx/README.md`
- `/Users/joel/Code/joelhooks/dark-wizard/.brain/resources/wzrrd-tufte-mdsvx-standard.svx`
- `/Users/joel/Code/joelhooks/joelclaw/AGENTS.md`
- `/Users/joel/Code/joelhooks/joelclaw/BRAIN.md`

Treat the Wayfinder map as the product contract. This run is an execution override for a narrow v0 prototype; do not pretend it resolves every open Wayfinder decision.

## Dynamic workflow and model routing

Use Claude Code's native dynamic workflow rather than one monolithic agent turn.

- Opus is the coordinator and is responsible for architecture, domain boundaries, synthesis, integration decisions, and final adversarial review.
- Use Sonnet for bounded repository/source investigation, source-adapter implementation, UI implementation, and focused test lanes.
- Use only Opus and Sonnet. Do not silently substitute another model.
- Split work into vertical slices that each produce observable end-to-end value. Do not split into horizontal “all schemas, then all adapters, then all UI” layers.
- Keep one writer at a time in the destination repo unless the workflow gives writers isolated worktrees. Parallelize read-only source investigation, source-contract analysis, and validation.
- If a product/security/storage decision is not settled by the map or real evidence, choose the smallest reversible seam, document it, and avoid irreversible production changes.

## Product

This is Joel's private work/business wiki. The dated landing page should feel like a calm newspaper or Wikipedia front page:

- lead story: the most consequential active open loop
- theme of the day: a source-backed connection across current work
- meaningful changes across projects, research, experiments, and goals
- active, blocked, waiting, or stale open loops
- useful new notes/connections
- questions requiring Joel
- system weather only when it affects the work

It must be concise, readable, technically accurate, and free of generic LLM recap voice. Preserve source links and provenance one click deeper. Do not expose raw chain-of-thought-like session narrative.

PARA is the organizing lifecycle. Small durable linked notes should evoke Zettelkasten/How to Take Smart Notes without forcing every source item into a note. Raw source evidence is not canonical wiki prose.

## Fixed technical backbone

- SvelteKit + Svelte 5 + MDSvX
- use `/Users/joel/Code/joelhooks/tufte-mdsvx` as the visual/authoring base, preserving license and attribution
- TypeScript 7 with a verified maximally strict configuration informed by Matt Pocock's current recommendations
- Oxfmt and Oxlint using current Ultracite presets
- XState v5 for explicit lifecycle/actor state
- Effect v4 beta from `Effect-TS/effect-smol`; inspect current official source/docs and pin an exact compatible beta version
- current inspected receipt was `effect@4.0.0-beta.97`, with `effect/unstable/cli`, `effect/unstable/ai`, and `Context.Service`; verify before coding because beta APIs move
- Convex may be useful, but do not make it canonical or mutate the existing database until real evidence settles the boundary
- Pi agents are the background judgment/synthesis substrate after deterministic collection; invoke Pi with the exact approved model `openai-codex/gpt-5.5`

Hard architecture rule:

- XState owns finite lifecycle, actor state, cancellation, and resumability.
- Effect owns typed services, errors, resources, concurrency, retries, source adapters, CLI, and observability.
- Pi agents perform bounded investigation, open-loop detection, and editorial synthesis through versioned schemas with source receipts.
- Do not create two competing workflow engines or bury lifecycle in boolean soup.

## Real sources

No fake product data. Use read-only access to real sources available on this machine:

1. Pi, Claude, and Codex local session transcripts plus current Typesense session indexes
2. system and project `.brain/**/*.svx`
3. Slack
4. Discord
5. Granola
6. Front
7. GitHub and joelclaw webhook/runtime receipts
8. all configured Google accounts through `gog`
9. Todoist only as read-only context

Inspect existing joelclaw skills and CLIs before inventing integrations. Prefer canonical existing command surfaces (`joelclaw`, `gog`, Granola tooling, Front/Slack/Discord skills or CLIs) over direct bespoke API calls. Never print or persist secrets.

All source access in v0 must be read-only. Do not send messages, archive mail, mutate tasks, edit source records, create filters, change webhooks, or alter provider settings.

Using every real source is the target architecture. Do not make the first runnable path impossible to debug: build a shared versioned source contract, then land real vertical slices in a sensible order. The first runnable edition must include real Brain and agent-session evidence. Add at least one real external communication source end to end. For every remaining source, either land a read-only adapter with a verified real canary or leave an evidence-backed capability report and explicit blocker—never fake success.

## Data contract

Preserve these separations:

- raw source artifacts/transcripts are authoritative evidence
- normalized observations are versioned, stable-ID records with provenance
- open-loop candidates are derived and correctable
- reviewed Brain `.svx` remains durable curated knowledge
- Typesense remains a rebuildable index
- dated editions are immutable snapshots/projections
- editorial prose never silently becomes source truth

Every derived item needs stable source/artifact/observation IDs, source timestamps, collection timestamp, privacy/visibility, content hash where possible, derivation metadata, and exact source pointers.

Design a storage interface before choosing a permanent backing store. A local deterministic store is acceptable for the v0 if Convex truth boundaries remain unsettled, but the interface must make a Convex adapter possible without rewriting the domain.

## Vertical slices

Organize the dynamic workflow around end-to-end slices like these, adapting only when evidence demands it:

### Slice 1: real Brain + session edition

- scaffold the strict toolchain and domain contracts
- collect current Brain project pages and recent real agent sessions read-only
- normalize observations with provenance
- run a bounded Pi-agent extraction using a versioned output schema
- detect and rank real open-loop candidates
- create and preserve one dated edition snapshot
- render it through the Tufte-style SvelteKit front page
- expose the same edition through agent-readable JSON and Markdown
- verify with unit/integration tests and a browser-agent smoke test

### Slice 2: one real external stream

- choose the safest high-signal available source, likely Slack, based on actual access
- collect a bounded recent window read-only
- dedupe and normalize it through the same contract
- show source-backed changes/open-loop evidence in a second edition build
- prove failure and missing-auth behavior are explicit and non-destructive

### Slice 3: source fleet and CLI

- implement or verify the remaining read-only adapters incrementally
- provide a CLI that can list source capability/health, gather bounded windows, inspect observations, build an edition, and print provenance
- every command supports concise human text plus structured JSON; use stable exit codes and never dump secret/customer payloads by default

### Slice 4: adversarial agent verification

- test semantic HTML, keyboard/accessibility basics, stable URLs, JSON/Markdown projections, source links, deterministic fixtures at adapter boundaries, and browser-agent navigation
- test cancellation, retries, partial source failure, stale snapshots, and rerun idempotency through the XState machine
- run a final Opus review for privacy leaks, invented claims, dual sources of truth, Effect/XState overlap, needless platform work, and AI-slop

## CLI expectations

Use Effect v4 CLI unless current source evidence proves it unsuitable. Exact command names may adapt, but the v0 should cover:

- source list/health
- bounded gather by source and time window
- observation inspection with provenance
- open-loop candidate inspection
- edition build and edition show
- machine-readable JSON output
- readable Markdown/text output

Keep output context-protecting. Summaries first, details on explicit request.

## Acceptance criteria

Do not call the v0 complete unless:

- `/Users/joel/Code/joelhooks/joelclaw-wiki` contains a coherent local project with concise AGENTS/Brain operating guidance
- install, TypeScript check, Oxlint, Oxfmt check, unit tests, integration tests, and production build pass
- an explicit XState v5 machine models gathering/build lifecycle and tests cover success, partial failure, retry, cancellation, and idempotent rerun
- Effect v4 services expose typed errors and adapter layers without hiding state-machine transitions
- at least one dated edition is built from actual Brain + agent-session data
- at least one external communication source is exercised read-only with real data or an exact evidence-backed access blocker
- no committed fixture pretends to be real source data; sanitized deterministic test fixtures may be derived and clearly labeled only for tests
- source evidence and generated prose are visibly distinguishable
- JSON and Markdown edition projections exist alongside the visual page
- a browser agent can load the local app, understand the page hierarchy, follow a provenance link, and inspect an open loop
- no secrets, raw private message bodies, customer data, or unsafe machine topology are copied into source control or logs
- Todoist and all external providers remain unmodified
- the final report lists changed files, commands with outcomes, real sources exercised, blocked sources, security decisions, remaining Wayfinder fog, and exact local run instructions

## Stop rules

- Stop and ask Joel before any external write, production schema migration, public deployment, GitHub repo creation, commit/push, or destructive operation.
- Never weaken privacy to make the demo work.
- Never invent claims, source data, successful access, or test receipts.
- Preserve unrelated existing work.
- If a source cannot be accessed safely, record the exact blocker and continue with other vertical slices.
- Keep the v0 deep and runnable rather than broad and theatrical.
