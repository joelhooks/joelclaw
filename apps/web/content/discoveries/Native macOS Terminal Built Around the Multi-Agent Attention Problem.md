---
type: discovery
slug: native-macos-terminal-multi-agent-attention
source: "https://github.com/manaflow-ai/cmux"
discovered: "2026-02-28"
tags: [repo, tool, terminal, ai, agent-loops, macos, cli, ghostty, infrastructure]
relevance: "Notification ring pattern and per-session sidebar metadata (branch, PR, ports) map directly to monitoring parallel agent loops — and the 'primitives not orchestrators' philosophy echoes ADR-0144"
---

# Native macOS Terminal Built Around the Multi-Agent Attention Problem

[cmux](https://github.com/manaflow-ai/cmux) from [manaflow-ai](https://x.com/manaflowai) is a macOS terminal built specifically for the problem of running multiple [Claude Code](https://claude.ai/code) or [Codex](https://openai.com/codex) sessions in parallel without losing track of which one is waiting on you. Built in Swift/AppKit on top of [libghostty](https://github.com/ghostty-org/ghostty) — so it reads your existing `~/.config/ghostty/config` and gets GPU-accelerated rendering for free — not another [Electron](https://www.electronjs.org/) wrapper.

The core insight is that macOS system notifications are useless for agent workflows. They all say "Claude is waiting for your input." No context. No differentiation. When you've got eight sessions open, that's noise, not signal. cmux solves this with **notification rings** — panes get a blue visual ring, the sidebar tab lights up — wired to [OSC 9/99/777 terminal escape sequences](https://iterm2.com/documentation-escape-codes.html) via a `cmux notify` CLI you hook into Claude Code or [OpenCode](https://opencode.ai/) agent hooks. The sidebar also surfaces per-session metadata: git branch, linked PR status/number, working directory, listening ports, and the latest notification text. At a glance you know what every session is doing.

The in-app browser is the other interesting piece. It ports the scriptable API from [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser), so agents can snapshot the accessibility tree, click elements, fill forms, and evaluate JS directly against your dev server — split right next to the terminal pane without switching windows. There's also a full socket + CLI API for creating workspaces, splitting panes, and sending keystrokes programmatically, which opens up some interesting automation surface.

The [Zen of cmux](https://cmux.dev/blog/zen-of-cmux) is worth reading. The philosophy is "primitives, not solutions" — give developers composable building blocks and let them figure out their own workflow rather than locking them into an opinionated orchestrator. The same instinct behind [[ADR-0144]] (hexagonal architecture, adapters over integration). Running many parallel sessions and needing per-session awareness is the exact shape of the [agent loop](https://github.com/joelhooks/joelclaw/tree/main/skills/agent-loop) problem, and this is a native macOS take on that surface without prescribing how you wire it together.

## Key Ideas

- **Notification rings via OSC escape sequences** — `cmux notify` CLI hooks into Claude Code / OpenCode agent hooks; pane gets a blue ring and sidebar tab lights up when agent is waiting; Cmd+Shift+U jumps to most recent unread
- **Sidebar as per-session metadata surface** — git branch, linked PR status + number, working directory, listening ports, latest notification text — all visible without switching to the pane
- **libghostty not Electron** — built in Swift/AppKit, reads `~/.config/ghostty/config`, GPU-accelerated via [libghostty](https://github.com/ghostty-org/ghostty); fast startup, low memory
- **Embedded scriptable browser** — ports the [agent-browser](https://github.com/vercel-labs/agent-browser) API; agents can snapshot accessibility tree, click, fill forms, evaluate JS; split next to terminal pane
- **Socket + CLI automation API** — create workspaces, split panes, send keystrokes, open URLs — full programmatic control from outside the app
- **"Primitives not solutions" philosophy** — no opinionated workflow lock-in; composable building blocks, you design the workflow
- **Homebrew install** — `brew tap manaflow-ai/cmux && brew install --cask cmux`; auto-updates via Sparkle

## Links

- [cmux GitHub](https://github.com/manaflow-ai/cmux)
- [cmux.dev — The Zen of cmux](https://cmux.dev/blog/zen-of-cmux)
- [Demo video](https://www.youtube.com/watch?v=i-WxO5YUTOs)
- [manaflow-ai on X](https://x.com/manaflowai)
- [agent-browser (vercel-labs)](https://github.com/vercel-labs/agent-browser) — the browser API cmux ported
- [Ghostty](https://github.com/ghostty-org/ghostty) — terminal emulator cmux builds on
- [OSC escape code docs (iTerm2)](https://iterm2.com/documentation-escape-codes.html) — notification protocol used
- [OpenCode](https://opencode.ai/) — another agent workflow cmux targets
