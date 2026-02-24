---
type: discovery
slug: discord-components-as-agent-control-plane
source: "https://github.com/openclaw/openclaw/releases/tag/v2026.2.15"
discovered: "2026-02-24"
tags: [repo, ai, agents, discord, agent-loops, governance, prior-art, typescript]
relevance: "Prior art for ADR-0124/0125 — Discord CV2 buttons as exec approval gates map directly to gateway command approval UX"
---

# Discord Components as Agent Control Plane

[OpenClaw](https://github.com/openclaw/openclaw) v2026.2.15 ships full [Discord Components V2](https://discord.com/developers/docs/components/overview) support and the result is a chat platform that functions as a legitimate agent governance layer. Buttons for exec approval, selects for routing, modals for structured input, attachment-backed file blocks for artifacts. [steipete](https://github.com/steipete) and the team turned Discord's component primitives into the surface where humans approve, reject, and steer autonomous agent work.

The **exec approval UX via Discord buttons** is the piece worth studying. Instead of building a custom web UI for "should this agent run this command," they render an inline button row in the chat thread. The agent proposes an action, the human taps approve or reject, the agent proceeds or halts. That's the same pattern [the gateway](/system) needs for command approval — right now it's a text-based ack in Telegram, but a structured button would eliminate ambiguity and make the approval chain auditable. This is direct prior art for [ADR-0124](/adrs/adr-0124) and [ADR-0125](/adrs/adr-0125).

**Nested sub-agents with configurable `maxSpawnDepth`** is the other standout. OpenClaw lets a parent agent spawn children, and those children can spawn their own — but you set a ceiling. That's a clean answer to the recursive agent problem: let them fan out, but put a hard cap on depth so you don't get runaway chains burning tokens into the void. The [agent loop](/adrs/adr-0015) currently handles this with a flat story queue, but a spawn-depth model could give the implementor step more autonomy to decompose work without needing the planner to pre-slice everything.

Per-channel ack reaction overrides and LLM hook payloads for extensions round it out. The reaction overrides mean different channels can have different approval semantics — a deploy channel requires explicit button clicks, a sandbox channel auto-approves. The hook payloads let extensions inject context into LLM calls without modifying core, which is the same extension pattern the [system-bus worker](https://github.com/joelhooks/joelclaw/tree/main/packages/system-bus) would benefit from for custom Inngest middleware.

## Key Ideas

- **[Discord Components V2](https://discord.com/developers/docs/components/overview) as structured agent UI** — buttons, selects, modals, and file blocks turn a chat thread into a real control surface, not just a log stream
- **Exec approval via inline buttons** — agent proposes action, human taps approve/reject in-chat, no context switch to a separate dashboard
- **`maxSpawnDepth` for nested sub-agents** — hard ceiling on recursive agent spawning prevents runaway token burn while allowing autonomous decomposition
- **Per-channel ack semantics** — different channels enforce different approval policies (strict button clicks vs auto-approve), useful for staging vs production agent behavior
- **LLM hook payloads** — extensions inject context into model calls without forking core, clean middleware pattern for plugin architectures

## Links

- [OpenClaw v2026.2.15 release](https://github.com/openclaw/openclaw/releases/tag/v2026.2.15)
- [OpenClaw repo](https://github.com/openclaw/openclaw)
- [steipete on GitHub](https://github.com/steipete)
- [Discord Components V2 docs](https://discord.com/developers/docs/components/overview)
- [ADR-0015: Agent Loop Architecture](/adrs/adr-0015)
