---
type: discovery
slug: tmux-and-sqlite-as-a-surprisingly-practical-multi-agent-control-plane
source: "https://github.com/TinyAGI/tinyclaw"
discovered: "2026-02-25"
tags: [repo, ai, infrastructure, multi-agent, orchestration, cli, tmux, sqlite, nextjs, messaging, agent-loops, gateway]
relevance: "Maps directly to joelclaw’s gateway + loop architecture: steal `team visualize`-style observability and workspace isolation patterns for multi-agent runs."
---

# tmux and SQLite as a Surprisingly Practical Multi-Agent Control Plane

[TinyClaw](https://github.com/TinyAGI/tinyclaw) from [TinyAGI](https://github.com/TinyAGI) is a 24/7 [multi-agent system](https://en.wikipedia.org/wiki/Multi-agent_system) that runs isolated agents and teams across [Discord](https://discord.com), [WhatsApp](https://www.whatsapp.com), and [Telegram](https://telegram.org). The core idea is simple: treat agents like always-on workers with handoffs, fan-out, and persistent sessions, instead of treating everything like a single chat thread.

The clever part is how un-fancy the stack is. It leans on [Bash](https://www.gnu.org/software/bash/), [tmux](https://github.com/tmux/tmux/wiki), and an [SQLite](https://sqlite.org/index.html) queue with retries and dead-letter handling, then adds two operator surfaces: a live TUI via [`tinyclaw team visualize`](https://github.com/TinyAGI/tinyclaw#-commands) and a browser control plane in [TinyOffice](https://github.com/TinyAGI/tinyclaw/tree/main/tinyoffice) built with [Next.js](https://nextjs.org). **It’s a full agent ops layer built from boring parts that are easy to run and reason about.**

For [joelclaw](https://github.com/joelhooks/joelclaw), this is a useful reference because the shape matches what we care about: durable orchestration, multi-channel ingress, and human-visible operations. We already have [Inngest](https://www.inngest.com/) + [Redis](https://redis.io/) + gateway plumbing; [TinyClaw](https://github.com/TinyAGI/tinyclaw) is a reminder that **operator UX (team visualization, explicit workspace boundaries, fast local setup) is a feature, not garnish**. Also notable: provider routing through [Claude Code CLI](https://claude.com/claude-code) and [Codex CLI](https://platform.openai.com/docs/codex/overview) using existing subscriptions.

## Key Ideas

- One daemonized [CLI](https://en.wikipedia.org/wiki/Command-line_interface) can unify multi-channel bot operations across [Discord](https://discord.com), [WhatsApp](https://www.whatsapp.com), and [Telegram](https://telegram.org).
- Team-level execution patterns (chain + fan-out) become much easier to debug when there is a first-class visualizer (`team visualize`) and log surfaces.
- A local [SQLite](https://sqlite.org/index.html) queue with atomic writes, retries, and dead-letter semantics is still a strong reliability baseline for agent pipelines.
- A lightweight web portal ([TinyOffice](https://github.com/TinyAGI/tinyclaw/tree/main/tinyoffice)) gives non-terminal operators a practical control surface for tasks, logs, and settings.
- Subscription-aware provider adapters ([Anthropic](https://www.anthropic.com/) via [Claude Code CLI](https://claude.com/claude-code), [OpenAI](https://openai.com/) via [Codex CLI](https://platform.openai.com/docs/codex/overview)) are a pragmatic way to avoid bespoke auth complexity.
- The install path ([remote-install.sh](https://github.com/TinyAGI/tinyclaw/blob/main/scripts/remote-install.sh) + setup wizard) is optimized for “running tonight,” which is often the difference between experimentation and abandonment.

## Links

- [TinyClaw repository](https://github.com/TinyAGI/tinyclaw)
- [TinyClaw README](https://github.com/TinyAGI/tinyclaw#readme)
- [TinyClaw latest release](https://github.com/TinyAGI/tinyclaw/releases/latest)
- [TinyClaw Discord community](https://discord.com/invite/jH6AcEChuD)
- [TinyOffice (web portal) source](https://github.com/TinyAGI/tinyclaw/tree/main/tinyoffice)
- [TinyClaw AGENTS docs](https://github.com/TinyAGI/tinyclaw/blob/main/docs/AGENTS.md)
- [TinyClaw TEAMS docs](https://github.com/TinyAGI/tinyclaw/blob/main/docs/TEAMS.md)
- [TinyClaw QUEUE docs](https://github.com/TinyAGI/tinyclaw/blob/main/docs/QUEUE.md)
- [Claude Code CLI](https://claude.com/claude-code)
- [OpenAI Codex CLI docs](https://platform.openai.com/docs/codex/overview)
- [tmux](https://github.com/tmux/tmux/wiki)
- [SQLite](https://sqlite.org/index.html)
- [Next.js](https://nextjs.org)
- [Inngest](https://www.inngest.com/)
- [joelclaw system view](https://joelclaw.com/system)
- [joelclaw system events view](https://joelclaw.com/system/events)
