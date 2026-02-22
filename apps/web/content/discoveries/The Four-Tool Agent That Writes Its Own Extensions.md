---
type: discovery
slug: four-tool-agent-self-extending
source: "https://lucumr.pocoo.org/2026/1/31/pi/"
discovered: "2026-02-22"
tags: [article, ai, agent-architecture, pi, cli, extensions, minimalism]
relevance: "Joel's entire skill/extension/gateway stack runs on Pi's four-primitive architecture — this is a rigorous articulation of why that minimalism works"
---

# The Four-Tool Agent That Writes Its Own Extensions

[Armin Ronacher](https://lucumr.pocoo.org/about/) — the person behind [Flask](https://flask.palletsprojects.com/), [Jinja2](https://jinja.palletsprojects.com/), [Click](https://click.palletsprojects.com/), and VP of Engineering at [Sentry](https://sentry.io/) — wrote up why he uses [Pi](https://github.com/badlogic/pi-mono/) as his primary coding agent. The core argument: **an agent with four tools (Read, Write, Edit, Bash) and the shortest system prompt of any agent he's aware of beats feature-rich alternatives**. Not despite the minimalism, but because of it.

The architecture is deliberate. No [MCP](https://modelcontextprotocol.io/) support — and it won't be added. The philosophy is that if you want the agent to do something new, you don't download a plugin. You ask the agent to extend itself. It writes code, hot-reloads, tests, and iterates until the extension works. [Pi's extension system](https://github.com/badlogic/pi-mono/) persists state into sessions, and sessions are **trees** — you can branch into a side-quest (fix a broken tool, do a code review) without burning context in the main thread. When you rewind, Pi summarizes what happened on the other branch. That's a structural solution to the context-management problem that most agents just ignore.

Armin's own extensions illustrate the pattern. [`/answer`](https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/answer.ts) reformats the agent's questions into a clean input box. [`/todos`](https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/todos.ts) gives the agent a local issue tracker stored as markdown files. [`/review`](https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/review.ts) branches into a fresh review context using Pi's session trees — so you get agent code review without polluting the implementation session. He replaced all his browser automation CLIs and MCP tools with a single [skill that uses CDP directly](https://github.com/mitsuhiko/agent-stuff/blob/main/skills/web-browser/SKILL.md). Every skill is hand-crafted by the agent to his specifications, not downloaded from a marketplace. He throws skills away when he doesn't need them anymore.

The article also traces the line from Pi to [OpenClaw](https://openclaw.ai/) — [Peter Steinberger](https://x.com/steipete)'s viral project that connects Pi to a communication channel and lets it just run code. Pi is the engine; OpenClaw is what happens when you remove the UI. [Mario Zechner](https://mariozechner.at/) built Pi, Peter built the "sci-fi with a touch of madness" layer on top. Same foundational bet: **LLMs are good at writing and running code, so embrace that instead of wrapping it in abstraction layers**.

## Key Ideas

- **Four primitives are sufficient**: Read, Write, Edit, Bash — everything else is built on top by the agent itself
- **No MCP by design**: the agent extends itself by writing code, not by loading protocol-based tool registries into the system context
- **Sessions as trees**: branching enables side-quests (reviews, tool fixes) without context pollution, with summarization on rewind
- **Extension hot-reloading**: the agent writes an extension, reloads, tests it, iterates — a tight feedback loop for self-modification
- **TUI extensibility**: extensions render custom terminal components — [Doom runs in it](https://x.com/badlogicgames/status/2008702661093454039), so dashboards and debugging interfaces are trivial
- **Skills are disposable**: hand-crafted by the agent, thrown away when no longer needed — the opposite of a curated marketplace
- **Portable sessions across providers**: Pi's SDK stores messages so sessions aren't locked to a single model provider
- **Agent-as-platform**: Pi's component architecture lets you build custom agents on top ([OpenClaw](https://openclaw.ai/), Telegram bots, [Mario's mom bot](https://github.com/badlogic/pi-mono/tree/main/packages/mom))

## Links

- [Article: Pi: The Minimal Agent Within OpenClaw](https://lucumr.pocoo.org/2026/1/31/pi/) — Armin Ronacher
- [Pi mono-repo](https://github.com/badlogic/pi-mono/) — Mario Zechner
- [OpenClaw](https://openclaw.ai/) — Peter Steinberger
- [Armin's agent extensions and skills](https://github.com/mitsuhiko/agent-stuff) — includes all referenced extensions
- [Armin's earlier post on agents and tools](https://lucumr.pocoo.org/2025/7/3/tools/)
- [Armin's post on plan mode](https://lucumr.pocoo.org/2025/12/17/what-is-plan-mode/)
- [Mario Zechner's site](https://mariozechner.at/)
- [mcporter — MCP-to-CLI bridge](https://github.com/steipete/mcporter) by Peter Steinberger
- [Nico's subagent extension for Pi](https://github.com/nicobailon/pi-subagents)
- [pi-interactive-shell](https://www.npmjs.com/package/pi-interactive-shell) — autonomous interactive CLI in TUI overlay
- [Beads — agent todo system](https://github.com/steveyegge/beads) by Steve Yegge (referenced as comparison)
