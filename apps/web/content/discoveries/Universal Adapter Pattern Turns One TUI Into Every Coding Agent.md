---
type: discovery
slug: universal-adapter-pattern-turns-one-tui-into-every-coding-agent
source: "https://github.com/rivet-dev/sandbox-agent/tree/main/gigacode"
discovered: "2026-02-22"
tags: [repo, ai, rust, typescript, agent-loops, infrastructure, cli, pattern]
relevance: "universal event schema + agent adapter pattern maps directly to normalizing multi-agent observability in the joelclaw event bus"
---

# Universal Adapter Pattern Turns One TUI Into Every Coding Agent

[Rivet](https://rivet.dev) built [Sandbox Agent](https://github.com/rivet-dev/sandbox-agent), a Rust server that sits inside a sandbox and exposes a single HTTP/SSE API to control [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://openai.com/index/codex/), [OpenCode](https://opencode.ai), [Amp](https://amp.dev), [Cursor](https://cursor.com), and [pi](https://github.com/mariozechner/pi-coding-agent). The interesting part isn't the server itself — it's what [Gigacode](https://github.com/rivet-dev/sandbox-agent/tree/main/gigacode) does with it. Gigacode connects [OpenCode's TUI](https://opencode.ai/docs/cli/) to **any** coding agent by implementing an [OpenCode-compatible API surface](https://sandboxagent.dev/docs/opencode-compatibility) that translates requests into the universal agent protocol. You type in OpenCode's interface, but Claude Code's actual tool loop — `Read`, `Write`, `Bash` — runs underneath.

The adapter pattern here is the real contribution. Each coding agent has its own proprietary event format, tool schema, and permission model. Sandbox Agent defines a [universal event schema](https://github.com/rivet-dev/sandbox-agent/blob/main/server/packages/sandbox-agent/src/universal_events.rs) — `session.started`, `turn.started`, `item.delta`, `permission.requested`, etc. — and each agent gets an adapter that translates its native events into this schema. The `opencode_compat.rs` layer then translates *back* from the universal schema into OpenCode's expected format. Two translation layers, but you only write each adapter once, and any UI that speaks the universal protocol works with every agent.

This is **not a fork** of OpenCode. Gigacode uses OpenCode's [`attach`](https://opencode.ai/docs/cli/#attach) feature to connect to the Sandbox Agent compatibility endpoint. The Rust binary is tiny — `main.rs` is ~30 lines that parse CLI args and dispatch to the Sandbox Agent library. All the heavy lifting lives in the SDK. The [TypeScript SDK](https://www.npmjs.com/package/sandbox-agent) supports both embedded mode (spawns agents locally) and server mode (connects over HTTP to a remote sandbox), which means you can run this against [E2B](https://e2b.dev), [Daytona](https://www.daytona.io/), or [Vercel Sandboxes](https://vercel.com/docs/sandboxes) in production.

The universal event schema pattern is worth studying independent of whether you'd use this tool. Normalizing heterogeneous agent outputs into a single stream with typed event enums, sequence numbers, and session scoping is exactly the kind of contract that makes observability and replay possible across agent backends.

## Key Ideas

- **Agent adapter pattern**: one adapter per coding agent translates proprietary events into a [universal schema](https://github.com/rivet-dev/sandbox-agent/blob/main/server/packages/sandbox-agent/src/universal_events.rs), decoupling UI from agent implementation
- **Protocol compatibility as a multiplexer**: implementing [OpenCode's API contract](https://sandboxagent.dev/docs/opencode-compatibility) lets any OpenCode-compatible client drive any agent — no forks, no patches
- **Not model switching, agent switching**: [OpenCode](https://opencode.ai) natively swaps inference providers; Gigacode swaps entire agent harnesses (tool loops, permission models, sandbox strategies)
- **Universal event types** include `session.started/ended`, `turn.started/ended`, `item.started/delta/completed`, `permission.requested/resolved`, `question.requested/resolved`, and `error` — a clean taxonomy for any agent interaction
- **Single static Rust binary** — fast startup, no runtime dependencies, designed to run inside constrained sandbox environments
- **Session streaming via SSE** with sequence-numbered events enables replay, persistence to [Postgres](https://www.postgresql.org/) / [ClickHouse](https://clickhouse.com/), and external observability — sessions aren't trapped in the sandbox

## Links

- [Sandbox Agent repo](https://github.com/rivet-dev/sandbox-agent) — the full project including Gigacode
- [Gigacode README](https://github.com/rivet-dev/sandbox-agent/tree/main/gigacode) — install and usage
- [Sandbox Agent docs](https://sandboxagent.dev/docs) — architecture, deployment guides, API reference
- [OpenCode compatibility docs](https://sandboxagent.dev/docs/opencode-compatibility) — the endpoint coverage that makes Gigacode work
- [Rivet](https://rivet.dev) — the company behind Sandbox Agent, builds actor-based infrastructure
- [OpenCode](https://opencode.ai) — the TUI that Gigacode drives, with its own [CLI docs](https://opencode.ai/docs/cli/)
- [Universal events source](https://github.com/rivet-dev/sandbox-agent/blob/main/server/packages/sandbox-agent/src/universal_events.rs) — the Rust enum taxonomy for normalized agent events
- [TypeScript SDK on npm](https://www.npmjs.com/package/sandbox-agent) — `sandbox-agent` package for embedded or remote control
