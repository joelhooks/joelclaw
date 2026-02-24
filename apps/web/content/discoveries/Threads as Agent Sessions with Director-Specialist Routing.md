---
type: discovery
slug: threads-as-agent-sessions-with-director-specialist-routing
source: "https://cordai.gg"
discovered: "2026-02-24"
tags: [tool, ai, agent-architecture, multi-agent, discord, session-management, agent-loops]
relevance: "director-to-specialist routing and thread-scoped sessions are prior art for ADR-0124 agent session lifecycle"
---

# Threads as Agent Sessions with Director-Specialist Routing

[CordAI](https://cordai.gg) is a commercial platform that turns [Discord](https://discord.com) into a multi-agent runtime. The core move is mapping Discord's native thread primitive to agent session lifecycle — every user interaction spawns a thread, the thread **is** the session, and a 15-minute idle timeout handles cleanup. No custom session store, no heartbeat protocol. The platform inherits Discord's threading model and gets session scoping for free.

The routing architecture is the interesting part. A **director agent** sits at the channel level and triages incoming messages to specialist sub-agents. Each specialist owns a domain — billing, onboarding, technical support, whatever — and the director decides who handles what. This is the same pattern as [ADR-0124](/adrs/adr-0124) but built on Discord's channel/thread topology instead of a custom event bus. Button bars give users quick-start entry points into specific agent flows, which is a nice UX shortcut past the "what can you do?" cold-start problem.

Thread triggers are worth noting: when a user messages a specific channel, the system auto-creates a thread and routes to the appropriate agent. The channel becomes a **declarative routing rule** — post in #billing, get the billing agent. `/my-sessions` lets users list and end their active sessions, giving them explicit lifecycle control. That's a pattern worth stealing regardless of the substrate.

The whole thing is commercially packaged — this isn't an open-source framework, it's a managed platform. But the architectural decisions are solid prior art for anyone building agent session management. Thread-as-session with idle timeout, director routing to specialists, channels as implicit routing config, and explicit user lifecycle commands (`/my-sessions list`, `/my-sessions end`) are all patterns that transfer cleanly outside Discord.

## Key Ideas

- **Thread-per-session model** — Discord threads map 1:1 to agent sessions, with 15-minute idle timeout handling garbage collection
- **Director-specialist routing** — a triage agent at the channel level dispatches to domain-specific sub-agents, avoiding monolithic agent design
- **Channels as declarative routing** — thread triggers auto-create agent sessions based on which channel a user messages, turning channel topology into routing config
- **Button bars for cold-start** — pre-built quick-action buttons bypass the "what should I ask?" problem that kills agent adoption
- **Explicit session lifecycle** — `/my-sessions` gives users list/end control over active sessions, making the agent runtime legible to end users
- **Idle timeout as session GC** — 15-minute inactivity window handles cleanup without requiring explicit session termination

## Links

- [CordAI](https://cordai.gg) — the platform
- [Discord Developer Docs — Threads](https://discord.com/developers/docs/topics/threads) — the threading primitive CordAI builds on
- [ADR-0124](/adrs/adr-0124) — joelclaw agent session lifecycle decision record
