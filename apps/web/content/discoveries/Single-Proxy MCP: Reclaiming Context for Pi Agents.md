---
type: discovery
slug: single-proxy-mcp-reclaiming-context-for-pi-agents
source: "https://github.com/nicobailon/pi-mcp-adapter"
discovered: "2026-02-24"
tags: [repo, mcp, pi, cli, typescript, ai, context-management, infrastructure]
relevance: "Potential replacement for the current MCP bridge in pi-tools, giving joelclaw's long-running agent workflows a token-light tool path with lazy server activation and cached discovery."
---

# Single-Proxy MCP: Reclaiming Context for Pi Agents

Tool sprawl is where you lose context first. [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) gives [Pi](https://github.com/badlogic/pi-mono) a way to consume [Model Context Protocol](https://modelcontextprotocol.io/) servers through a **single proxy tool**, so you don't pay for the whole MCP surface every turn. That matters because the same idea that made [Mario Zechner](https://mariozechner.at/) write about MCP overhead is now practical in [pi-tools](https://github.com/badlogic/pi-mono): keep capability but drop schema weight.

The clever part is in lifecycle and metadata. Searches and descriptions use cached schemas, so `mcp({ search: "..." })` can still work before any server is live, then servers come up lazily and drop idle when configured. It supports both [stdio](https://nodejs.org/api/child_process.html#child_processexeccommand-options-callback) and HTTP-style MCP endpoints, with `lifecycle` and `idleTimeout` controls that keep expensive adapters from burning resources unnecessarily.

For practical control, `directTools` is the second big lever. You can keep the proxy-only default and selectively promote only the tools you need into the agent's direct surface, plus use `global` and per-server overrides, imports from [Cursor](https://www.cursor.com/), [Claude Code](https://github.com/anthropics/claude-code), [Claude Desktop](https://claude.ai/), and [VS Code](https://code.visualstudio.com/), and manage everything through the interactive `/mcp` overlay. In other words: this is the missing piece if you want the same behavior across global and project configs without paying a token tax at every conversation start.

## Key Ideas

- **Token compression by design**: one `mcp` tool (~200 tokens exposed) replaces hundreds of verbose MCP tool signatures, directly addressing context-window pressure during [agent loop](/system) runs.
- **Lazy lifecycle + cache**: server startup is deferred until first use, while cached metadata in `~/.pi/agent/mcp-cache.json` enables fast discovery and describe flows.
- **Transport flexibility**: `stdio` and HTTP transport options let you integrate local binary servers (via `npx`) and remote MCP endpoints without changing the Pi-facing tool model.
- **Controlled promotion via `directTools`**: promote all, some (`string[]`), or none of a server's tools to reduce prompt cost while keeping important commands directly callable.
- **Operational ergonomics**: `/mcp`, reconnect commands, OAuth flow hooks, and imported configs reduce local setup overhead when switching between [Claude](https://claude.ai/), [Cursor](https://www.cursor.com/), and [VS Code](https://code.visualstudio.com/) MCP ecosystems.
- **Adapter-friendly replacement path**: directly aligns with Joel's note that it should replace the current `mcp-bridge` in [pi-tools](https://github.com/badlogic/pi-mono).

## Links

- [pi-mcp-adapter on GitHub](https://github.com/nicobailon/pi-mcp-adapter)
- [pi-mcp-adapter npm package](https://www.npmjs.com/package/pi-mcp-adapter)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Mario Zechner's MCP critique post](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)
- [Pi mono monorepo](https://github.com/badlogic/pi-mono)
- [Nico Bailon GitHub profile](https://github.com/nicobailon)
- [Cursor MCP integration docs](https://docs.cursor.com/en/ai/mcp)
- [Claude desktop MCP docs](https://modelcontextprotocol.io/docs/learn/integrations/)
- [VS Code MCP support issue tracker](https://github.com/microsoft/vscode/issues)
- [Joelclaw project home](https://joelclaw.com)
- [Claude Code project](https://github.com/anthropics/claude-code)
