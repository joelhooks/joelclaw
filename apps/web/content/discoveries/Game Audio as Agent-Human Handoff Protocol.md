---
type: discovery
source: "https://github.com/PeonPing/peon-ping"
discovered: "2026-02-16"
tags: [repo, ai, cli, agent-loops, developer-experience, open-standard]
relevance: "agent loops on headless Mac Mini need a notification layer for task completion and permission gates"
---

# Game Audio as Agent-Human Handoff Protocol

The dirty secret of agentic coding is the attention gap. Your agent finishes a task or hits a permission gate, and you're three tabs deep in something else. Fifteen minutes evaporate before you notice. peon-ping fixes this by playing Warcraft peon voice lines — *"Work, work"* on task complete, *"Something need doing?"* when it needs input.

The implementation is straightforward (Claude Code hooks, CLI adapters for Codex/Cursor/OpenCode/Kiro/Windsurf/Antigravity), but the interesting move is **CESP — the Coding Event Sound Pack Specification**. They've defined a standard taxonomy of coding events (`session.start`, `task.complete`, `input.required`, `task.error`, `resource.limit`, `user.spam`) and published it as an open spec that any IDE can adopt. Sound packs are swappable — GLaDOS, StarCraft Kerrigan, Zelda, whatever. The event categories are the real product.

The `user.spam` category is a nice touch — fire off 3+ prompts in 10 seconds and the peon yells *"Me busy, leave me alone!"* There's also a **silent window** config that suppresses notifications for fast tasks, so you only hear sounds when the agent actually spent time working. Desktop notifications fire when your terminal isn't focused. Remote dev support pipes audio back over SSH via a relay daemon.

Worth watching as CESP matures. The event taxonomy maps cleanly to agent lifecycle states, and the "sound pack as personality layer" pattern is a surprisingly effective way to make agentic workflows feel less robotic.

## Key Ideas

- **Agent attention gap is a real UX problem** — agents don't notify when done, humans context-switch, minutes wasted on every handoff
- **CESP open standard** defines a taxonomy of coding events (`session.start`, `task.complete`, `input.required`, etc.) that any IDE can implement
- **Sound packs as swappable personality** — same event categories, different audio (Warcraft peons, GLaDOS, StarCraft units)
- **Smart suppression** — silent windows ignore fast tasks, spam detection prevents notification fatigue from rapid prompts
- **Remote-friendly** — audio relay daemon for SSH/devcontainer/Codespace workflows where the agent runs headless
- **Multi-IDE adapter pattern** — single hook system with adapters for Claude Code, Codex, Cursor, OpenCode, Kiro, Windsurf, Antigravity

## Links

- [PeonPing/peon-ping](https://github.com/PeonPing/peon-ping) — main repo
- [CESP Spec (OpenPeon)](https://github.com/PeonPing/openpeon) — Coding Event Sound Pack Specification
- [peonping.com](https://peonping.com/) — demo site with interactive pack picker
