---
status: accepted
date: 2026-02-14
decision-makers: "Joel Hooks"
consulted: "Claude (pi session 2026-02-14)"
informed: "All agents operating on this machine"
---

# Adopt PARA vault + OpenClaw orchestration for always-on personal assistant

## Context and Problem Statement

A Mac Mini is being set up as a prototype always-on AI personal assistant/copilot/life management system. The machine needs a unified architecture that connects:

- **Agent tooling**: pi, Claude Code, and their extensions (pi-tools, skills)
- **Orchestration**: OpenClaw as the central agent framework (already cloned at `~/Code/openclaw/openclaw/`)
- **Knowledge management**: A persistent, structured knowledge base accessible to both humans and agents
- **System configuration**: Audit trail of all setup decisions and config changes
- **Networking**: Tailscale for secure remote access to the always-on machine

The core question: **How should the knowledge layer, agent infrastructure, and orchestration layer be organized so that multiple agents can collaborate effectively while a human retains full visibility and control?**

### Current State (as of 2026-02-14)

- macOS with Homebrew, fnm (Node 24), Bun 1.3.9
- pi v0.52.12 with pi-tools (repo-autopsy, ts-check, codex-exec, MCQ, web search, MCP bridge, agent-secrets, session-reader, ralph-loop)
- Skills: adr-skill, skill-creator, frontend-design, agent-browser, obsidian-markdown, obsidian-bases
- Agent-secrets daemon running with `brave_api_key` stored
- Tailscale installed (pending auth)
- OpenClaw cloned at `~/Code/openclaw/openclaw/`
- System log at `~/.agents/system-log.jsonl` (14 entries)
- `~/.claude/CLAUDE.md` → `~/.agents/AGENTS.md` → `~/Vault/AGENTS.md` (transitive symlink chain)
- `~/.pi/AGENTS.md` → `~/.agents/AGENTS.md` → `~/Vault/AGENTS.md` (transitive symlink chain)

## Decision Drivers

* **Agent-first design**: Every structure must be readable, writable, and navigable by agents without human hand-holding
* **Single source of truth**: No duplicated state across locations — one canonical place for each type of information
* **Short paths**: Agents traverse paths constantly; `~/Vault` beats `~/Documents/Personal/KnowledgeBase`
* **Hybrid scope**: Start technical, design for expansion into full life management
* **Self-maintaining documentation**: `AGENTS.md` and system state should be updated by agents as they make decisions
* **iCloud sync**: Vault must be accessible from other Apple devices
* **Full agent read/write**: No restricted zones — agents can create, update, and manage all vault content

## Considered Options

* **Option A: Vault as single source of truth** — Move everything (system log, ADRs, agent config) into `~/Vault`. Agents.md stays at `~/.agents/` but points into vault content.
* **Option B: Federated sources** — Keep `~/.agents/` for agent infra, `~/Code/` for code, vault only for knowledge/notes. Each system owns its domain.
* **Option C: Vault as view layer** — Keep originals where they are, vault contains rendered/linked copies for human browsing.

## Pros and Cons of the Options

### Option A: Vault as single source of truth

* Good, because agents only need one root path (`~/Vault`) — no multi-location searching
* Good, because Obsidian gives humans a rich UI over the same flat files agents read/write
* Good, because iCloud sync exposes all system state to mobile, not just "notes"
* Good, because ADRs, logs, and knowledge share one backup/sync strategy
* Bad, because iCloud can race with agent writes causing `.icloud` conflict files
* Bad, because symlink chains (`~/.pi/` → `~/.agents/` → `~/Vault/`) add indirection that complicates disaster recovery

### Option B: Federated sources

* Good, because each tool owns its canonical location — no symlinks needed
* Good, because agent infra (`~/.agents/`) is isolated from human knowledge
* Bad, because agents must search multiple roots to build context
* Bad, because keeping `~/.agents/system-log.jsonl` and `~/Vault/system/` in sync requires mirroring logic
* Bad, because there's no single place a human can browse to see everything

### Option C: Vault as view layer

* Good, because originals stay where tools expect them — zero migration risk
* Good, because vault can present curated views (rendered markdown, dashboards) rather than raw files
* Bad, because rendered copies go stale — requires a sync/build step
* Bad, because agents writing to the vault don't update the originals, causing drift
* Bad, because it violates single-source-of-truth — same information lives in two places

## Decision Outcome

Chosen option: **"Option A: Vault as single source of truth"**, because the whole point of this system is unified agent-accessible knowledge. Splitting across locations creates sync problems and forces agents to search multiple roots. With full agent read/write, the vault IS the system of record.

### Consequences

* Good, because agents only need to know one root path (`~/Vault`) to find anything
* Good, because Obsidian provides a human-friendly UI over the same files agents read/write
* Good, because iCloud sync gives mobile access to all system state, not just notes
* Good, because ADRs live alongside the knowledge they govern
* Bad, because `~/.agents/AGENTS.md` must be kept in sync (symlink into vault)
* Bad, because iCloud sync can cause conflicts if agents and iCloud race on writes
* Neutral, because OpenClaw's own config (`~/Code/openclaw/`) stays separate as a codebase — it consumes the vault but isn't stored in it

**Mitigations**:
- iCloud conflict risk: Agent writes are append-mostly (logs, new notes). Obsidian handles conflict files well. If this becomes a problem, switch to Obsidian Sync.
- AGENTS.md sync: Symlink `~/.agents/AGENTS.md` → `~/Vault/AGENTS.md`. All agents already follow the symlinks.

## Implementation Plan

### 1. Vault Structure (`~/Vault`)

```
~/Vault/
├── AGENTS.md                    # Living agent instructions (symlinked from ~/.agents/, ~/.claude/, ~/.pi/)
├── Projects/                    # PARA: Active work with clear outcomes
│   ├── 01-system-setup/         # This machine's bootstrap
│   ├── 02-openclaw-deployment/  # Getting OpenClaw running
│   └── 03-vault-design/         # Vault structure & conventions
├── Areas/                       # PARA: Ongoing responsibilities
│   ├── system-maintenance/      # Machine health, updates, monitoring
│   └── agent-infrastructure/    # pi, Claude Code, skills, extensions
├── Resources/                   # PARA: Reference material
│   ├── tech-docs/               # Technical documentation
│   ├── tools/                   # Tool-specific notes & config
│   └── reference/               # General reference
├── Archive/                     # PARA: Completed/inactive
├── docs/
│   └── decisions/               # ADRs
│       ├── README.md            # ADR index
│       ├── 0001-adopt-architecture-decision-records.md
│       └── 0002-personal-assistant-system-architecture.md  # This ADR
└── system/
    ├── system-log.jsonl         # Config audit trail (moved from ~/.agents/)
    └── state/                   # Machine state snapshots, health checks
```

### 2. Symlink Strategy

* **Affected paths**: `~/.agents/AGENTS.md`, `~/.claude/CLAUDE.md`, `~/.pi/AGENTS.md`, `~/.agents/system-log.jsonl`
* **Action**:
  - Move `~/.agents/AGENTS.md` content to `~/Vault/AGENTS.md`
  - Symlink `~/.agents/AGENTS.md` → `~/Vault/AGENTS.md`
  - `~/.claude/CLAUDE.md` already points to `~/.agents/AGENTS.md` (transitive)
  - `~/.pi/AGENTS.md` already points to `~/.agents/AGENTS.md` (transitive)
  - Move `~/.agents/system-log.jsonl` to `~/Vault/system/system-log.jsonl`
  - Symlink `~/.agents/system-log.jsonl` → `~/Vault/system/system-log.jsonl`

### 3. AGENTS.md Content

AGENTS.md should contain:
- System identity (what this machine is, what it does)
- Active projects and their locations
- Agent conventions (logging, ADR creation, vault write patterns)
- Links to relevant ADRs
- Current tool inventory

Agents update this file as they make decisions. It's the contract between the human and all agents.

### 4. OpenClaw Integration

- OpenClaw codebase stays at `~/Code/openclaw/openclaw/` (it's a code project, not knowledge)
- OpenClaw's config will reference `~/Vault` as its knowledge/memory store
- OpenClaw's `AGENTS.md` / `CLAUDE.md` at repo root governs development workflow
- The vault `Areas/agent-infrastructure/` tracks OpenClaw operational state

### 5. Tailscale

- Installed via `brew install --formula tailscale` (v1.94.1)
- Daemon: `sudo brew services start tailscale`
- Auth: `sudo tailscale up --ssh`
- Enables remote access to this always-on machine from any device on the tailnet
- SSH access means agents on other machines can reach this one

### 6. Dependencies

* No new packages required — vault is plain markdown
* iCloud: Enable Desktop & Documents sync, or manually place vault in `~/Library/Mobile Documents/`
* Obsidian: Install Obsidian.app, open `~/Vault` as vault

### 7. Patterns to Follow

* **PARA discipline**: Everything goes in Projects, Areas, Resources, or Archive. No orphan top-level folders.
* **ADR for architecture**: Any decision that changes how the system is built → ADR in `docs/decisions/`
* **System log for config**: Any install, configure, remove action → append to `system/system-log.jsonl`
* **AGENTS.md for contracts**: Any change to agent behavior or conventions → update AGENTS.md

### 8. Patterns to Avoid

* Do NOT store secrets in the vault (use agent-secrets daemon)
* Do NOT put code projects inside the vault (they live in `~/Code/` or `~/Projects/`)
* Do NOT create deeply nested folder hierarchies — PARA is intentionally flat
* Do NOT duplicate information between AGENTS.md and ADRs — AGENTS.md links to ADRs

### Verification

#### Agent-checkable (automatable)

- [x] `test -d ~/Vault/Projects && test -d ~/Vault/Areas && test -d ~/Vault/Resources && test -d ~/Vault/Archive` passes
- [x] `test -f ~/Vault/docs/decisions/README.md` passes
- [x] `readlink ~/.agents/AGENTS.md` output ends with `/Vault/AGENTS.md`
- [x] `readlink ~/.agents/system-log.jsonl` output ends with `/Vault/system/system-log.jsonl`
- [x] `~/Vault/AGENTS.md` contains the strings `System Identity`, `Agent Conventions`, and `Tool Inventory`
- [ ] `sudo tailscale status` exits 0 and output contains a `100.x.x.x` IP address
- [ ] `test -d ~/Vault/.obsidian && ls ~/Vault/.obsidian/*.json 2>/dev/null | grep -q .` passes
- [x] `tail -1 ~/Vault/system/system-log.jsonl | grep -q "ADR-0002"` passes (or references this ADR)

#### Manual/external (require human or cross-device verification)

- [ ] SSH into this machine from another tailnet device: `ssh joel@<tailscale-hostname>` succeeds
- [ ] iCloud sync: confirm `~/Vault` contents appear on another Apple device (iPhone, iPad, or Mac)
- [ ] Obsidian: open Obsidian.app, select "Open folder as vault", choose `~/Vault`

## More Information

### Related Decisions
- ADR-0001: Adopt architecture decision records
- Future: ADR for OpenClaw deployment configuration
- Future: ADR for agent memory/context strategy
- Future: ADR for backup and disaster recovery

### Revisit Triggers
- If iCloud sync causes frequent conflicts → switch to Obsidian Sync or git
- If full agent read/write causes data loss → introduce structured zones
- If vault grows beyond 10,000 notes → evaluate performance, consider categorized ADR subdirs
- If OpenClaw needs real-time state → evaluate database-backed memory vs flat files

### References
- [PARA Method](https://fortelabs.com/blog/para/) — Tiago Forte's organizational system
- [OpenClaw](https://github.com/openclaw) — Open-source AI agent framework
- [Codex Vault](https://github.com/mateo-bolanos/codex-vault) — Reference implementation for Obsidian + agent workflows
- [pi-tools](https://github.com/joelhooks/pi-tools) — Agent extensions installed on this machine
