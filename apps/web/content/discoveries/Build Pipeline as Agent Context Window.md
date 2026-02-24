---
type: discovery
slug: build-pipeline-as-agent-context-window
source: "https://github.com/frontman-ai/frontman"
discovered: "2026-02-24"
tags: [repo, ai, typescript, agent-architecture, frontend, open-source, protocol-design]
relevance: "protocol-first client/server/adapter separation maps to joelclaw gateway's channel-agnostic event routing (ADR-0124/0125/0126)"
---

# Build Pipeline as Agent Context Window

[Frontman](https://github.com/frontman-ai/frontman) does something most AI coding tools get wrong: instead of working from screenshots or pasted code, it **hooks directly into the framework's build pipeline** — [Next.js](https://nextjs.org/), [Astro](https://astro.build/), [Vite](https://vite.dev/) — so the agent actually understands components, routes, and compilation errors. You click an element in the browser, describe what you want changed, and Frontman edits the real source file. Not a sandbox. Not a copy-paste suggestion. The actual code, hot-reloaded, ready for review.

The architecture is where it gets interesting. The [libs/](https://github.com/frontman-ai/frontman/tree/main/libs) directory splits into `frontman-protocol`, `frontman-client`, `frontman-core`, and per-framework adapters (`frontman-nextjs`, `frontman-vite`, `frontman-astro`). There's a [`context-loader`](https://github.com/frontman-ai/frontman/tree/main/libs/context-loader) that feeds codebase understanding into the agent, and their docs reference both [MCP schemas](https://github.com/frontman-ai/frontman/blob/main/docs/mcp_schema.ts) and what looks like an "ACP" protocol layer ([acp-plan.md](https://github.com/frontman-ai/frontman/blob/main/docs/acp-plan.md), [acp-toolcalls.md](https://github.com/frontman-ai/frontman/blob/main/docs/acp-toolcalls.md)). The client, server, and framework adapters are fully decoupled — they call it an "open protocol" and they mean it structurally.

The **split licensing** is smart too. Client libraries and framework integrations are [Apache 2.0](https://github.com/frontman-ai/frontman/blob/main/LICENSE), the server is [AGPL-3.0](https://github.com/frontman-ai/frontman/blob/main/apps/frontman_server/LICENSE). Encourages adoption of the protocol while protecting the core. The pattern of "intent capture surface → protocol layer → framework-specific execution" is the same shape as a gateway that routes from [Telegram](/adrs/adr-0124-discord-gateway-architecture) or Discord through an event bus to domain-specific handlers. Different domain, same decomposition.

## Key Ideas

- **Build pipeline as context** — hooking into the framework's compiler gives the agent structural understanding (components, routes, errors) that screenshot-based tools can't match
- **Protocol-first agent architecture** — [`frontman-protocol`](https://github.com/frontman-ai/frontman/tree/main/libs/frontman-protocol) decouples intent capture (browser overlay) from execution (framework adapter), making the system extensible without rewriting the core
- **Context loader as a first-class concern** — dedicated [`context-loader`](https://github.com/frontman-ai/frontman/tree/main/libs/context-loader) library for feeding codebase structure to the agent, separate from the protocol and client
- **MCP/ACP protocol surface** — [MCP schema](https://github.com/frontman-ai/frontman/blob/main/docs/mcp_schema.ts) and ACP planning docs suggest they're building toward standardized agent communication, not a proprietary API
- **Split open-source licensing** — [Apache 2.0](https://github.com/frontman-ai/frontman/blob/main/LICENSE) for client/adapters, [AGPL-3.0](https://github.com/frontman-ai/frontman/blob/main/apps/frontman_server/LICENSE) for server — grow the protocol ecosystem, protect the business
- **Browser overlay as intent surface** — the "click and describe" interaction model is a clean separation of user intent from implementation detail

## Links

- [Frontman GitHub](https://github.com/frontman-ai/frontman)
- [Frontman website](https://frontman.sh)
- [Frontman docs](https://frontman.sh/docs)
- [Demo video](https://www.youtube.com/watch?v=-4GD1GYwH8Y)
- [Discord community](https://discord.gg/xk8uXJSvhC)
- [Changelog](https://github.com/frontman-ai/frontman/blob/main/CHANGELOG.md)
- [npm: @frontman-ai/nextjs](https://www.npmjs.com/package/@frontman-ai/nextjs)
