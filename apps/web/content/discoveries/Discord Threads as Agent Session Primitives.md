---
type: discovery
slug: discord-threads-as-agent-session-primitives
source: "https://github.com/remorses/kimaki"
discovered: "2026-02-24"
tags: [repo, ai, agent-loops, discord, cli, thread-forking, prior-art]
relevance: "thread=session model with /fork, /queue, /undo, /redo maps directly to ADR-0124 thread-forked sessions"
---

# Discord Threads as Agent Session Primitives

[Kimaki](https://github.com/remorses/kimaki) treats Discord threads as first-class coding agent sessions. Each channel maps to a project directory, each thread maps to an [OpenCode](https://opencode.ai) session, and the conversation history **is** the session state. That's the interesting part — not the Discord bot wrapper, but the decision to use a chat platform's native threading model as the session primitive for a coding agent.

The command surface is worth studying. `/fork` branches a new session from any message in the conversation, carrying context forward. `/queue` lets you stack follow-up prompts while the agent is still working — they fire sequentially when the current response finishes. `/resume` picks up a previous session. `/undo` and `/redo` operate on the agent's file changes. This is a **full session lifecycle** built on top of Discord's existing primitives, and it maps almost 1:1 to what [ADR-0124](/adrs/adr-0124) describes for thread-forked sessions.

The architecture is one-bot-per-machine by design — the CLI runs locally, spawns OpenCode servers for local project directories, and bridges them to Discord channels. Voice messages get transcribed via [Gemini](https://ai.google.dev/) with codebase-aware context, so it recognizes function names and file paths from speech. There's also a CI-triggerable mode where you can start sessions from GitHub Actions or any CLI environment, which is the kind of thing that makes this useful beyond "chat with your code."

Built by [Tommaso De Rossi](https://github.com/remorses) (also behind [Fumadocs](https://github.com/fuma-nama/fumadocs) and other OSS tools). 485 stars as of discovery. The repo itself uses an `AGENTS.md` convention for agent instructions, similar to what the joelclaw repo does. Worth revisiting when implementing thread-forked sessions.

## Key Ideas

- **Thread = session**: Discord's native thread model becomes the session container — no custom session UI needed, the chat platform provides persistence, history, and collaboration for free
- **Fork from any message**: `/fork` branches a new session from an arbitrary point in conversation history, preserving upstream context — this is the [ADR-0124](/adrs/adr-0124) pattern implemented in the wild
- **Message queuing**: `/queue` lets you stack prompts while the agent is busy, firing them sequentially — solves the "agent is working, I have three more things" problem
- **Undo/redo on file changes**: Session-level undo/redo for agent modifications to the filesystem, not just chat history
- **Voice-to-code with codebase context**: Transcription uses the project's file tree to improve accuracy on function names and paths — a small detail that makes voice input actually usable for coding
- **One bot per machine**: Architectural decision to keep the agent local to the machine it controls, using Discord as the remote interface rather than trying to abstract away locality
- **CI-triggerable sessions**: Sessions can be started from [GitHub Actions](https://github.com/features/actions) or CLI, bridging interactive and automated workflows
- **Permission model via Discord roles**: Uses a "Kimaki" role for access control and a "no-kimaki" role as a kill switch — leveraging existing platform primitives instead of building custom auth

## Links

- [Kimaki repo](https://github.com/remorses/kimaki)
- [OpenCode](https://opencode.ai) — the underlying coding agent Kimaki orchestrates
- [Tommaso De Rossi (remorses)](https://github.com/remorses) — author
- [Discord Developer Portal](https://discord.com/developers/applications) — where you create the bot
- [Gemini API](https://ai.google.dev/) — used for voice transcription
