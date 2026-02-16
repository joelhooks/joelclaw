---
type: discovery
slug: multi-model-fan-out-llm-verification
source: "https://github.com/steipete/oracle"
discovered: "2026-02-16"
tags: [repo, ai, cli, agent-loops, mcp, typescript, multi-model, browser-automation]
relevance: "fan-out verification pattern maps to agent loop reviewer step; MCP server enables integration as system-bus tool"
---

# Multi-Model Fan-Out as LLM Output Verification

Oracle by steipete (Peter Steinberger) bundles a prompt plus relevant files and fires them at **multiple models in a single run**. GPT-5.1 Pro, Gemini 3 Pro, Claude Sonnet 4.5, Claude Opus 4.1 — pick two or more, get aggregated results with cost tracking. The interesting bit isn't "yet another CLI wrapper." It's the cross-checking pattern: send the same context to N models, compare what comes back, and surface disagreements. That's a verification primitive.

The fallback chain is well thought out. API mode when you have keys, browser automation when you don't (it pulls Chrome cookies to authenticate with ChatGPT and Gemini web UIs), and `--copy` for manual paste when all else fails. Browser mode even handles GPT-5 Pro's long-running detached responses — it'll poll the ChatGPT tab and reattach when the answer lands. Sessions are persistent and replayable via `oracle status` and `oracle session <id>`.

It also ships as an **MCP server** (`oracle-mcp`), which means any MCP-aware agent can invoke it as a tool. That's the leverage play — an agent that's stuck can call Oracle to get a second opinion from a completely different model family. Steinberger ships it with an AGENTS.md snippet designed to be dropped into Claude Code or Codex projects: "Use when stuck/bugs/reviewing." The escape hatch is built into the contract.

The multi-model fan-out pattern is worth stealing. Right now the agent loop reviewer is a single model making a judgment call. Fanning that out — ask Claude and Gemini independently whether the implementation passes, flag when they disagree — would add a real verification layer without much complexity. The MCP surface makes it pluggable.

## Key Ideas

- **Multi-model fan-out**: send identical prompt + context to N models, aggregate results with per-model cost tracking
- **Browser automation as API fallback**: uses Chrome cookies to authenticate with ChatGPT/Gemini web UIs when no API key is available
- **Session persistence**: long-running Pro model responses detach by default, reattach later via CLI — handles the "GPT-5 Pro takes 10 minutes" problem
- **MCP server**: exposes Oracle as a tool other agents can invoke, turning "get a second opinion" into a function call
- **Render/copy mode**: bundles prompt + files into a pasteable format when automation isn't an option — pragmatic degradation
- **OpenRouter support**: mix first-party model IDs with OpenRouter IDs in the same multi-model run

## Links

- [oracle repo](https://github.com/steipete/oracle)
- [MCP setup docs](https://github.com/steipete/oracle/blob/main/docs/mcp.md)
- [mcporter — MCP config manager](https://github.com/steipete/mcporter)
