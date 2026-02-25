---
type: discovery
slug: legacy-clis-as-the-native-substrate-for-ai-agents
source: "https://x.com/karpathy/status/2026360908398862478"
discovered: "2026-02-25"
tags: [article, ai, cli, agents, mcp, skills, agent-loops, event-bus]
relevance: "Validates the joelclaw CLI-first architecture: agent loops become more composable when every capability is reachable via terminal contracts and visible in /system/events telemetry."
---

# Legacy CLIs as the Native Substrate for AI Agents

[Andrej Karpathy](https://karpathy.ai/) makes a sharp point in this [post](https://x.com/karpathy/status/2026360908398862478): [CLI](https://en.wikipedia.org/wiki/Command-line_interface) tools are “legacy,” and that’s exactly why they’re **agent-ready right now**. A terminal gives an [AI agent](https://en.wikipedia.org/wiki/Intelligent_agent) structured input/output, composable commands, and a huge existing ecosystem without inventing a new interface layer.

The clever part is the stack, not just the demo: expose capability through a [CLI](https://en.wikipedia.org/wiki/Command-line_interface), make docs exportable to [Markdown](https://www.markdownguide.org/), add reusable [Skills](https://docs.anthropic.com/en/docs/claude-code/skills), and optionally expose it via [MCP](https://modelcontextprotocol.io/introduction). That turns a product from “human app” into **machine-usable infrastructure**. His example around [Polymarket](https://polymarket.com/) and a fast [Rust](https://www.rust-lang.org/) path to agent-driven dashboards captures the pattern cleanly.

For [joelclaw](https://joelclaw.com/system), this is immediately practical: keep building around command surfaces ([joelclaw CLI](https://github.com/joelhooks/joelclaw), [GitHub CLI](https://cli.github.com/), and system tooling) that agents can chain into larger workflows. If a capability can be called from a terminal and observed in [system events](https://joelclaw.com/system/events), it’s much easier to plug into [agent loops](https://github.com/joelhooks/joelclaw/tree/main/packages/system-bus) without bespoke glue code.

## Key Ideas

- “Legacy” [CLI](https://en.wikipedia.org/wiki/Command-line_interface) interfaces are often the fastest path to agent integration because they already provide deterministic text I/O and scriptable composition.
- The “build for agents” checklist in the [post](https://x.com/karpathy/status/2026360908398862478) is concrete: [Markdown](https://www.markdownguide.org/) docs, [Skills](https://docs.anthropic.com/en/docs/claude-code/skills), [CLI](https://en.wikipedia.org/wiki/Command-line_interface), and [MCP](https://modelcontextprotocol.io/introduction).
- Agent value compounds when tools become modules in bigger pipelines, not one-off assistants; this maps directly to [event-driven workflows](https://www.inngest.com/docs).
- [Prediction markets](https://en.wikipedia.org/wiki/Prediction_market) are a good stress test because the workload mixes querying, filtering, ranking, and execution from one terminal surface.
- For [joelclaw](https://github.com/joelhooks/joelclaw), the design implication is to keep each capability exposed as a CLI contract plus observability in [/system/events](https://joelclaw.com/system/events).

## Links

- [Source post — Andrej Karpathy on X](https://x.com/karpathy/status/2026360908398862478)
- [Andrej Karpathy site](https://karpathy.ai/)
- [Andrej Karpathy on X](https://x.com/karpathy)
- [Polymarket](https://polymarket.com/)
- [Polymarket docs](https://docs.polymarket.com/)
- [Polymarket Rust CLOB client (GitHub)](https://github.com/Polymarket/rs-clob-client)
- [GitHub CLI](https://cli.github.com/)
- [Claude Code overview](https://docs.anthropic.com/en/docs/claude-code/overview)
- [Claude Code Skills docs](https://docs.anthropic.com/en/docs/claude-code/skills)
- [Model Context Protocol (MCP) intro](https://modelcontextprotocol.io/introduction)
- [Markdown Guide](https://www.markdownguide.org/)
- [joelclaw system view](https://joelclaw.com/system)
- [joelclaw system events](https://joelclaw.com/system/events)
- [joelclaw repo](https://github.com/joelhooks/joelclaw)
- [Inngest docs](https://www.inngest.com/docs)
