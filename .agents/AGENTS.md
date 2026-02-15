# Agent Instructions

## Core Principles

### 1. Consult and update the Vault

`~/Vault` is the single source of truth for this system. Before starting work, check the vault for relevant context — projects, ADRs, tool inventory, system log. After making changes, update the vault: log config changes, update project status, create/revise ADRs, and keep this file current. If it's not in the vault, it doesn't exist.

### 2. Observability over opacity

**If you can't see it, you can't fix it.** Every pipeline, function, service, and automated action must produce observable output — structured logs, status endpoints, error traces. Silent failures are system bugs.

Concretely:
- **Log every action** via `slog write` — installs, config changes, pipeline steps, failures
- **Check Inngest Docker logs** (`docker logs ... | grep ERROR`) when functions don't execute — the worker swallows errors, the server sees them
- **Surface errors explicitly** — never `.quiet()` without a try/catch that logs the failure
- **Expose health endpoints** — every service returns JSON status at its root (`/`)
- **Prefer structured output** — HATEOAS JSON (like `slog`, future `igs`) over unstructured text
- **Trace event chains** — when a pipeline spans multiple Inngest functions, log each step so the full chain is reconstructable from `system-log.jsonl`

When debugging: Docker logs first (dispatch errors), then worker stderr (runtime errors), then dashboard (per-step traces), then system-log.jsonl (what actually completed).

### 3. Credit your sources

When adopting patterns, tools, or ideas from other projects or people, **always attribute them** — in code comments, commit messages, vault notes, and documentation. If a design was inspired by someone's work, say so. This applies to open-source repos, conversations, blog posts, and any external knowledge that shapes the system.

## System Identity

This is Joel's always-on Mac Mini — a prototype personal AI assistant, copilot, and life management system. It runs 24/7, accessible via Tailscale SSH from any device on the tailnet.

**Architecture**: See [ADR-0002](docs/decisions/0002-personal-assistant-system-architecture.md)

## Key Locations

| Path | Purpose |
|------|---------|
| `~/Vault` | Obsidian vault — single source of truth (PARA method) |
| `~/Vault/AGENTS.md` | This file — agent contract (symlinked to `~/.agents/`, `~/.claude/`, `~/.pi/`) |
| `~/Vault/system/system-log.jsonl` | Config audit trail — append-only, auto-synced to `system/log/` as markdown notes |
| `~/Vault/docs/decisions/` | Architecture Decision Records |
| `~/Vault/Projects/` | Active projects (PARA) |
| `~/Vault/Resources/tools/` | Tool inventory — one note per tool with frontmatter |
| `~/Code/joelhooks/joelclaw/` | joelclaw monorepo (system-bus, web, .agents/) |
| `~/Code/system-bus-worker/` | Dedicated worker clone (launchd runs from here) |
| `~/Code/openclaw/openclaw/` | OpenClaw agent framework (reference, not deployed) |
| `~/.joelclaw/workspace/` | Agent memory workspace (MEMORY.md, daily logs) |
| `~/Projects/` | Code projects directory |
| `joel@three-body:/volume1/home/joel/video/` | NAS video archive (SSH, by year) |
| `~/Vault/Resources/videos/` | Video notes — summaries, transcripts, concept tags |
| `~/Vault/Daily/` | Daily notes (append-only log of activity) |
| `~/.agents/skills/` | Shared agent skills |

## Active Projects

0. **Agent Identity** (`~/Vault/Projects/00-agent-identity/`) — System soul, identity, personality ✅ bootstrapped
1. **System Setup** (`~/Vault/Projects/01-system-setup/`) — Bootstrap this machine (~97%)
2. ~~**OpenClaw Deployment**~~ — Superseded by Project 09 (joelclaw)
3. **Vault Design** (`~/Vault/Projects/03-vault-design/`) — Refine vault structure & conventions
4. **pi-tools Fixes** (`~/Vault/Projects/04-pi-tools-fixes/`) — PR upstream fixes for install/load issues
5. **Search & State** (`~/Vault/Projects/05-search-and-state/`) — Qdrant + Redis (running)
6. **Video Ingest** (`~/Vault/Projects/06-video-ingest/`) — Durable pipeline (download → transcribe → enrich) ✅ proven
7. **Event Bus** (`~/Vault/Projects/07-event-bus/`) — Inngest server + worker + agent loop functions
8. **Memory System** (`~/Vault/Projects/08-memory-system/`) — 4-layer architecture (designed, not yet implemented)
9. **joelclaw** (`~/Vault/Projects/09-joelclaw/`) — Personal AI OS: AT Proto bedrock, agent loops, blog-as-book

## Agent Conventions

### Consult Before Acting

Before starting any task:
1. Read this file for system context and conventions
2. Check `~/Vault/docs/decisions/` for relevant ADRs
3. Check `~/Vault/Projects/` for active project context
4. Check `~/Vault/Resources/tools/` for tool state

### System Configuration Logging

Use `slog` (global CLI) for every install, configure, or remove action:

```bash
slog write --action install --tool caddy --detail "installed caddy 2.10" --reason "need HTTPS proxy"
```

Run `slog` with no args for full API surface (schema, all commands, next actions). Other useful commands: `slog tail --count 5`, `slog validate`, `slog sync`.

Schema: `{timestamp (auto), action, tool, detail, reason?}` — validated with Effect.Schema before writing. A launchd watcher generates markdown notes in `~/Vault/system/log/` from the JSONL for Obsidian indexing.

### Update After Acting

After completing work:
1. Append to system-log.jsonl if you installed, configured, or removed anything
2. Update project `index.md` if task status changed
3. Create/update tool notes in `Resources/tools/` if tools were added or changed
4. Write an ADR if an architecture decision was made
5. Update this AGENTS.md if projects, conventions, or tool inventory changed

### Architecture Decisions

Any decision that changes how the system is built → write an ADR in `~/Vault/docs/decisions/`. Follow the [ADR skill](~/.agents/skills/adr-skill/SKILL.md) workflow. Reference ADRs in code with `ADR-NNNN` comments.

### Vault Writes

- **PARA discipline**: Everything in Projects, Areas, Resources, or Archive
- **Frontmatter minimum**: Every note gets `type` and `tags` in YAML frontmatter
- **No secrets in vault** — use `agent-secrets` daemon (`secrets add/lease`)
- **No code projects in vault** — code lives in `~/Code/` or `~/Projects/`
- **Keep it flat** — avoid deep nesting
- **Full read/write access** — agents can create, update, and manage all vault content

## OpenClaw Integration

OpenClaw has a **layered AGENTS.md** at its repo root (`~/Code/openclaw/openclaw/AGENTS.md`) that inherits from this file for shared conventions and adds orchestration-specific instructions. When working in the OpenClaw codebase, follow both this file and the OpenClaw-specific one.

## Tool Inventory

### CLI Tools

| Tool | Version | Managed By | Purpose |
|------|---------|------------|---------|
| pi | 0.52.12 | bun | AI coding agent (primary interface) |
| pi-tools | 0.2.0 | bun | Extensions: repo-autopsy, ts-check, codex-exec, MCQ, web search, MCP bridge, agent-secrets, session-reader, ralph-loop |
| Claude Code | 2.1.42 | npm | AI coding (via ~/.claude/) |
| OpenClaw | — | git | Agent orchestration framework (cloned, not yet deployed) |
| agent-secrets | 0.4.1 | bun | Secret leasing with TTLs |
| agent-browser | 0.10.0 | bun | Browser automation CLI |
| defuddle-cli | — | npm | Extract clean markdown from web pages |
| Tailscale | 1.94.1 | homebrew | Mesh VPN + SSH access (running, SSH enabled) |
| tsgo | — | npm | TypeScript 7 native compiler |
| slog | 0.2.0 | bun link | System log CLI (Effect, agent-first HATEOAS JSON, ~/Code/joelhooks/slog/) |
| Bun | 1.3.9 | homebrew | JS runtime & package manager |
| Node | 24.13.1 | fnm | JS runtime |
| yt-dlp | 2026.02.04 | homebrew | Video downloader (YouTube + many sites) |
| mlx-whisper | 0.4.3 | uv | Local speech-to-text on Apple Silicon (Whisper via MLX) |
| ffmpeg | 8.0.1 | homebrew | Audio/video processing |

### Mac Apps

| App | Location | Purpose |
|-----|----------|---------|
| Google Chrome | /Applications/ | Browser — provides cookies for yt-dlp YouTube auth |
| Obsidian | /Applications/ | Vault UI — markdown editor + iCloud sync |
| Docker Desktop | /Applications/ | Container runtime (installed, needs sudo for cli-plugins) |

### Agent Skills (`~/.agents/skills/`)

All skills are installed to `~/.agents/skills/` (universal) and symlinked to Claude Code + Pi. Install via `npx skills add <repo> --skill <name> --yes --global`.

| Skill | Source | Purpose |
|-------|--------|---------|
| aa-book | joelhooks/aa-download | Anna's Archive → pdf-brain pipeline (search, download, convert, ingest) |
| adr-skill | custom | Architecture Decision Records |
| agent-browser | custom | Browser automation for agents |
| defuddle | custom | Clean markdown extraction from web pages |
| docx | anthropics/skills | Word document creation/editing |
| ffmpeg | digitalsamba (customized) | Video/audio processing — format conversion, compression, platform export |
| frontend-design | custom | Production-grade frontend UI design |
| inngest | custom | Event bus operations — send events, check status, add functions, manage workflows |
| obsidian-bases | custom | Obsidian Bases (.base files) |
| obsidian-markdown | custom | Obsidian-flavored markdown |
| pdf | anthropics/skills | PDF creation/editing |
| pptx | anthropics/skills | PowerPoint creation/editing |
| remotion-best-practices | remotion-dev/skills | React video production (Remotion) |
| skill-creator | custom | Guide for creating new skills |
| vercel-composition-patterns | vercel-labs/agent-skills | Vercel/Next.js composition patterns |
| video-ingest | custom (pi only) | Download → transcribe → archive → Vault note pipeline |
| xlsx | anthropics/skills | Excel spreadsheet creation/editing |

## Archived Projects

_(none yet)_
