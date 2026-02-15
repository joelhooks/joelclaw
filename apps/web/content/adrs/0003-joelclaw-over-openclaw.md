---
status: "accepted"
date: 2026-02-14
decision-makers: "Joel Hooks"
consulted: "Claude (pi session 2026-02-14 session-6)"
informed: "All agents operating on this machine"
supersedes-partially: "0002 — replaces OpenClaw as orchestration layer"
---

# Build joelclaw instead of deploying OpenClaw

## Context and Problem Statement

ADR-0002 assumed OpenClaw would be the orchestration layer for the personal assistant system. After 6 sessions of infrastructure work, the system has evolved beyond what OpenClaw provides in several key areas. The question is no longer "how do we deploy OpenClaw" but "do we still need it?"

### What We Built (Sessions 1-6)

| Layer | What | Depth |
|-------|------|-------|
| Event bus | Inngest — durable workflows, event chains, step functions, retries | Deeper than OpenClaw's basic job queue |
| Search | Qdrant — hybrid dense + sparse + BM25, RRF fusion | Deeper than OpenClaw's SQLite + vectors |
| State | Redis — persistent cache, dedup, pub/sub | OpenClaw has no equivalent |
| Observability | slog + igs — Effect CLIs, HATEOAS JSON, agent-first | OpenClaw has JSONL transcripts but no agent-first tooling |
| Network | Tailscale mesh + Caddy HTTPS, hub + edge architecture | OpenClaw assumes localhost + SSH tunnels |
| Pipelines | video-download → transcript → summarize (event chain, proven) | OpenClaw has no media pipeline |
| Memory design | 4-layer architecture (session + playbook + timeline + soul), credited research from 4 open-source projects | OpenClaw has MEMORY.md + basic vector search |
| Config | Centralized ~/.config/system-bus.env | OpenClaw has its own config system |

### What OpenClaw Provides That We Don't Have

1. **Messaging gateway** — WhatsApp, iMessage, Telegram, Discord, Slack, Signal adapters
2. **Unified agent loop** — LLM receives message → plans → executes tools → responds
3. **Session management** — conversation state, compaction, per-user sandboxing
4. **100+ bundled skills** — bash, browser, calendar, email, smart home
5. **Canvas** — visual output served locally

## Decision Drivers

* **Ownership**: Every layer should be inspectable and modifiable with tools we built
* **Composability**: Components should evolve independently, not be locked into one framework's opinions
* **Memory as moat**: The 4-layer memory design backed by Qdrant hybrid search is the core differentiator — it can't live inside OpenClaw's memory model
* **Infrastructure already deeper**: Deploying OpenClaw would mean running two event systems, two memory systems, two config systems — redundant complexity
* **Agent-first tooling**: slog and igs are designed for agents. OpenClaw's tooling is designed for humans using messaging apps

## Considered Options

* **Option A: Deploy OpenClaw** — Use OpenClaw as designed, adapt our stack to feed it
* **Option B: Build joelclaw** — Build our own system using existing infrastructure, inspired by OpenClaw's vision
* **Option C: Hybrid** — Deploy OpenClaw for messaging/gateway, keep our stack for infra/memory

## Decision Outcome

**Option B: Build joelclaw.** The infrastructure we've already built is deeper than what OpenClaw provides in every overlapping layer. What OpenClaw has that we don't (messaging, agent loop, session management) is buildable on top of Inngest + Qdrant. Deploying OpenClaw would create redundant systems competing for the same responsibilities.

### What We're Taking From OpenClaw (with credit)

- **The vision**: Self-hosted agent-as-OS, messaging as primary interface, skills as extensions
- **Trust levels**: operator (full access) → dm (sandboxed) → group (restricted)
- **Channel adapter pattern**: each messaging platform normalized into a common event format
- **Session compaction**: summarize older conversation turns to stay within context limits

### What We're Not Taking

- OpenClaw's Gateway (replaced by Inngest event routing)
- OpenClaw's memory system (replaced by 4-layer design + Qdrant)
- OpenClaw's Node.js runtime (replaced by Bun + Hono)
- OpenClaw's skill system (replaced by pi skills)
- OpenClaw's config management (replaced by ~/.config/system-bus.env)

## Consequences

* Good, because every layer is owned, inspectable, and evolvable with our tooling
* Good, because no redundant systems — one event bus, one search engine, one config source
* Good, because memory architecture can be as deep as we want without framework constraints
* Good, because Projects 01-08 become coherent components of one system, not disconnected infra
* Bad, because messaging adapters are real work — WhatsApp/iMessage/Telegram each have gnarly APIs
* Bad, because no community of OpenClaw users/contributors to lean on
* Bad, because more surface area to maintain long-term
* Neutral, because OpenClaw can still be referenced as a pattern library when building specific features

**Risk mitigation**: Build messaging one channel at a time. Start with Telegram (cleanest bot API). iMessage last (requires macOS native bridge).

## Implementation Plan

See [[../../Projects/09-joelclaw/index]] for full build order.

**Phase 1 (immediate)**: Memory — Qdrant vault collection, embedding pipeline, session recall
**Phase 2**: Identity — SOUL.md, USER.md, IDENTITY.md
**Phase 3**: Agent runtime — Inngest-based agent loop with context loading
**Phase 4**: Messaging — channel adapters, one at a time
**Phase 5**: Self-healing — health monitoring, auto-recovery

### Affected Paths

- `~/Vault/Projects/02-openclaw-deployment/` — status → **superseded by Project 09**
- `~/Vault/Projects/09-joelclaw/` — **new project, active**
- `~/Code/system-bus/` — agent runtime functions will be added here
- `~/Vault/AGENTS.md` — update to reflect joelclaw as the system identity

### Verification

- [ ] Project 09 index.md exists with architecture diagram and build order
- [ ] Project 02 status updated to `superseded`
- [ ] This ADR is linked from both project indexes
- [x] Handoff document updated with session 6 summary
- [ ] AGENTS.md updated to reference joelclaw

## More Information

### Credits
- **Nick Steinberger** (OpenClaw) — self-hosted agent-as-OS vision, messaging integration, trust levels
- **Alex Hillman** — session recall (kuato), narrative memory (andy-timeline), self-healing (defib)
- **John Lindquist** — reflection → playbook → MEMORY.md (lamarck)
- **Ray Fernando** — the 4hr "openclaw on a mac mini" stream that started this exploration

### Revisit Triggers
- If messaging adapter work proves prohibitively complex → reconsider OpenClaw for gateway layer only (Option C)
- If OpenClaw adds Inngest/Qdrant integration → re-evaluate
- If agent loop implementation is significantly harder than expected → study OpenClaw's Gateway code as reference
