---
type: discovery
slug: ship-transformation-instructions-not-pull-requests
source: "https://github.com/qwibitai/nanoclaw"
discovered: "2026-02-22"
tags: [repo, ai, agent-architecture, claude, skills, open-source, containers]
relevance: "skills-as-fork-transformations pattern parallels joelclaw's skill system but pushes the contribution model further — contributors ship instructions, not code"
---

# Ship Transformation Instructions, Not Pull Requests

[NanoClaw](https://github.com/qwibitai/nanoclaw) is a minimal personal Claude assistant running in containers — [WhatsApp](https://www.whatsapp.com/) in, [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/sdk) processing in an isolated [Apple Container](https://github.com/apple/container) or [Docker](https://www.docker.com/) sandbox, response back out. Single Node process, a handful of files, ~35k tokens. The whole thing fits in a context window. That part is neat but not new — the contribution model is where it gets interesting.

The rule: **don't add features, add skills.** Want Telegram support? Don't PR a Telegram module alongside WhatsApp. Instead, contribute a [Claude Code skill](https://code.claude.com/docs/en/skills) file — `/add-telegram` — that teaches Claude Code how to *transform a user's fork* to use Telegram. The user runs the skill, gets clean code that does exactly what they need, and their fork stays minimal. No feature flags, no provider abstractions, no config sprawl. The contribution isn't code — it's instructions for an AI to reshape working software.

This inverts the standard open source scaling problem. Traditional projects bloat because every contributor adds their thing and the maintainer has to keep all the things working together. [OpenClaw](https://github.com/openclaw/openclaw) — the project NanoClaw explicitly positions against — has 52+ modules, 45+ dependencies, and abstractions for 15 channel providers. NanoClaw sidesteps that entirely. The codebase stays small because complexity lives in transformation recipes, not in the runtime. Each fork is a clean, purpose-built variant.

The "customization = code changes" stance is worth sitting with. No config files. No `.env` sprawl. You tell [Claude Code](https://code.claude.com/docs/en/overview) what you want and it modifies the source directly. The codebase being ~35k tokens means the AI can hold the whole thing in context and make safe changes. **Smallness is a security property** — not just for humans reading it, but for AI modifying it.

## Key Ideas

- **Skills as fork transformations** — open source contributions are instructions that teach AI to reshape a codebase, not code that gets merged into a shared trunk
- **Complexity in recipes, not runtime** — the project stays minimal because feature variance lives in skill files that transform forks, not in the main codebase
- **Context-window-sized software** — at ~35k tokens, the whole project fits in a single LLM context, making AI-driven customization safe and predictable
- **Container isolation over permission checks** — agents run in actual [Linux containers](https://github.com/apple/container) with filesystem isolation, not behind application-level allowlists
- **AI-native setup** — no install wizard, you clone and run `claude` then `/setup` — [Claude Code](https://code.claude.com/docs/en/overview) handles the rest
- **[Agent Swarms](https://code.claude.com/docs/en/agent-teams) support** — teams of specialized agents collaborating within a chat, claiming first personal assistant to ship this
- **Per-group isolated context** — each WhatsApp group gets its own `CLAUDE.md` memory, filesystem, and container sandbox

## Links

- [NanoClaw repo](https://github.com/qwibitai/nanoclaw)
- [NanoClaw site](https://nanoclaw.dev)
- [NanoClaw Discord](https://discord.gg/VDdww8qS42)
- [OpenClaw](https://github.com/openclaw/openclaw) — the maximalist project NanoClaw positions against
- [Claude Code Skills docs](https://code.claude.com/docs/en/skills)
- [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/sdk)
- [Agent Swarms / Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [Apple Container](https://github.com/apple/container) — lightweight macOS container runtime
- [qwibitai on GitHub](https://github.com/qwibitai)
- [Baileys](https://github.com/WhiskeySockets/Baileys) — WhatsApp Web API library used for the messaging layer
