---
status: proposed
date: 2026-02-19
deciders: joel
tags:
  - architecture
  - evaluation
  - elixir
  - beam
---

# ADR-0064: Evaluate Elixir/BEAM as joelclaw Backbone

## Context

joelclaw runs on a TypeScript/Bun stack with Inngest for durable workflows, Redis for state + pub/sub, Qdrant for vector search, and K8s (Talos/Colima) for container orchestration. The system works — 47 registered functions, gateway daemon, video pipeline, memory system, heartbeat fan-out.

But several architectural pain points map to things BEAM solves natively:

| Pain point | Current solution | BEAM equivalent |
|-----------|-----------------|-----------------|
| Durable workflows with retries | Inngest (external server + worker) | OTP GenServers + Supervisors (built-in) |
| Pub/sub + message passing | Redis (two ioredis clients needed) | Built-in process messaging, Phoenix PubSub |
| Process supervision / restarts | launchd + K8s pod restarts + watchdog ADR-0037 | Supervision trees (let it crash) |
| Hot code reload | Worker restart + launchctl kickstart | Hot code swapping (native) |
| Concurrency | Inngest concurrency limits, single-threaded Bun | Lightweight processes, preemptive scheduling |
| Gateway long-lived connections | Custom Redis bridge + extension polling | Phoenix Channels / LiveView |
| Agent isolation | Docker sandboxes | Lightweight BEAM processes |

Counter-arguments for staying on TS:

- **LLM SDKs are JS-first** — Anthropic, OpenAI, Vercel AI SDK all TypeScript-native
- **Inngest is battle-tested** for the event-driven patterns we use
- **Ecosystem gravity** — npm has everything, Hex is smaller
- **Migration cost** — working system, 47 functions, extensive skills/tooling
- **Joel's expertise** — deep JS/TS, Elixir would be a learning investment

## Evaluation Criteria

1. **Supervision model** — does OTP's "let it crash" genuinely improve on Inngest retry + launchd watchdog?
2. **Agent orchestration** — can BEAM processes model agent loops better than Inngest step chains?
3. **Interop story** — can Elixir call TS/JS tools, or would everything need porting?
4. **Selective adoption** — could a BEAM node handle specific subsystems (gateway, pub/sub, supervision) while TS handles LLM integration?
5. **LiveView for TUI/web** — does Phoenix LiveView offer advantages over current Vercel + pi TUI?

## Source Material

- [ ] Video: YouTube `JvBT4XBdoUE` — Elixir/BEAM talk (ingesting now, vault note pending)
- [ ] Video: YouTube `raX9fCy8Lfc` — also ingesting

## Decision

**Pending.** Watch the videos, document findings, then decide whether to spike a proof-of-concept or shelve.

## Options Under Consideration

### Option A: Full replacement
Replace TS+Inngest+Redis with Elixir/Phoenix+OTP. Rewrite agent loops as GenServers, gateway as Phoenix Channel, workflows as supervised process trees.

### Option B: Selective adoption
Keep TS for LLM integration + existing functions. Add an Elixir node for: gateway (Phoenix Channels), process supervision (OTP), real-time pub/sub. Communicate via events/HTTP.

### Option C: Study and shelve
Document the tradeoffs, keep as a reference for future pain points, continue iterating on current stack.
