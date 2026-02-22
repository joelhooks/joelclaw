---
type: discovery
slug: three-layer-memory-heartbeat-crons-autonomous-agent-infrastructure
source: "https://youtu.be/nSBKCZQkmYw"
discovered: "2026-02-22"
tags: [video, ai, agent-loops, memory, infrastructure, autonomy, openclaw]
relevance: "3-layer memory + heartbeat cron + delegation pattern maps directly to Vault memory tiers, Inngest crons, and gateway heartbeat architecture"
---

# Three-Layer Memory and Heartbeat Crons as Autonomous Agent Infrastructure

<YouTubeEmbed url="https://youtu.be/nSBKCZQkmYw" />

[Nat Eliason](https://x.com/nateliason) gave an [OpenClaw](https://openclaw.com) bot named [Felix](https://x.com/felixcraftai) $1,000 and told it to build a business. Three weeks later it had made $14,718 — launching its own [website](https://felixcraft.ai), info product, and X account. [Peter Yang](https://creatoreconomy.so) walked through the full setup in a [35-minute interview](https://youtu.be/nSBKCZQkmYw).

The architecture is what's worth paying attention to. Felix runs on a **three-layer memory system** that separates context into tiers — presumably something like working memory, episodic recall, and long-term knowledge. That layered approach is what lets the agent maintain coherent goals across sessions instead of starting from scratch every time. On top of that, **heartbeat crons** keep the agent alive and proactive — it doesn't just respond to prompts, it wakes up on a schedule, checks state, and decides what to do next. And when it needs heavy lifting, it **delegates to [Codex](https://openai.com/index/codex/)** for implementation work.

The multi-threaded chat setup is also notable — running five parallel projects from one agent by splitting work across separate conversation threads. Combined with prompt injection defenses for its public [X presence](https://x.com/felixcraftai), the whole thing is less "chatbot with a wallet" and more "autonomous agent with an operational architecture." The $100K+ in crypto it somehow accumulated is a wild footnote.

What's interesting is how much of this maps to primitives that already exist in different forms: durable cron functions, layered memory stores, multi-agent fan-out, heartbeat monitoring. The difference is someone wired them together with the explicit goal of **economic autonomy** — the agent isn't assisting a human workflow, it's running its own.

## Key Ideas

- **Three-layer memory** separates agent context into tiers (working / episodic / long-term) enabling coherent behavior across sessions
- **Heartbeat crons** make agents proactive rather than reactive — wake up, check state, decide next action
- **Delegation to [Codex](https://openai.com/index/codex/)** for implementation keeps the orchestrator agent focused on decisions
- **Multi-threaded chats** enable parallel project execution from a single agent identity
- **Prompt injection defense** is a real concern when an agent has a public-facing [X account](https://x.com/felixcraftai)
- The pattern is: layered memory + scheduled heartbeat + delegation + parallel execution = autonomous economic agent

## Links

- [Full interview (YouTube)](https://youtu.be/nSBKCZQkmYw)
- [Written takeaways (Creator Economy)](https://creatoreconomy.so/p/use-openclaw-to-build-a-business-that-runs-itself-nat-eliason)
- [Nat Eliason on X](https://x.com/nateliason)
- [Felix on X](https://x.com/felixcraftai)
- [FelixCraft website](https://felixcraft.ai)
- [Peter Yang's channel](https://www.youtube.com/@peteryang)
- [OpenClaw](https://openclaw.com)
- [Codex (OpenAI)](https://openai.com/index/codex/)
