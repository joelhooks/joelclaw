---
status: proposed
date: 2026-02-19
decision-makers: Joel
consulted: oh-my-pi (can1357/oh-my-pi) LSP implementation
informed: pi-tools consumers
tags:
  - pi-tools
  - lsp
  - developer-experience
  - multi-language
supersedes: null
---

# ADR-0059: Multi-Language LSP Extension for pi-tools

## Context and Problem Statement

The current `ts-check` extension in pi-tools is unreliable. It spawns a tsgo LSP process per project root but frequently fails to return useful diagnostics, hover info times out, and the JSON-RPC lifecycle has edge cases that silently swallow errors. The extension was written as a single-language hack — there's no path to supporting additional languages without duplicating the entire extension.

Native app work is on the horizon (ADR-0054 proposed). Swift via sourcekit-lsp, Kotlin via kotlin-language-server, and other language servers will be needed. The current architecture cannot grow to support this.

oh-my-pi (`can1357/oh-my-pi`) has a production-quality multi-language LSP implementation that manages 40+ language server configurations through a data-driven `defaults.json` + user override system. Their architecture — config-driven server discovery, per-file server routing, client lifecycle with idle timeouts, format-on-write via LSP, diagnostic batching — is the reference for this ADR.

## Decision Drivers

- ts-check is broken — agents can't reliably get TypeScript diagnostics or type info
- Native app work (ADR-0054) requires Swift LSP at minimum
- Adding a language should be a config entry, not a code change
- Must remain a pi extension — no core changes to pi itself
- oh-my-pi's LSP system is well-engineered reference architecture to learn from

## Decision

Replace the `ts-check` extension with a new `lsp` extension that manages N language server clients via configuration.

### Architecture

#### Config-Driven Server Discovery

Ship a bundled `defaults.json` in pi-tools with server configs for common languages. Each entry:

```json
{
  "tsgo": {
    "command": "tsgo",
    "args": ["--lsp", "--stdio"],
    "fileTypes": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    "rootMarkers": ["tsconfig.json", "jsconfig.json"],
    "initOptions": {}
  },
  "sourcekit-lsp": {
    "command": "sourcekit-lsp",
    "args": [],
    "fileTypes": [".swift"],
    "rootMarkers": ["Package.swift", "*.xcodeproj", "*.xcworkspace"]
  }
}
```

**Server config schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | yes | Binary name or path |
| `args` | string[] | no | CLI arguments |
| `fileTypes` | string[] | yes | File extensions this server handles |
| `rootMarkers` | string[] | yes | Files that identify a project root for this server |
| `initOptions` | object | no | LSP `initializationOptions` |
| `settings` | object | no | LSP workspace settings |
| `isLinter` | boolean | no | If true, treated as supplementary linter (can coexist with primary server) |
| `formatOnWrite` | boolean | no | Enable format-on-write for this server (default: true) |
| `diagnosticsOnWrite` | boolean | no | Enable auto-diagnostics after write/edit (default: true) |
| `warmupTimeoutMs` | number | no | Max time to wait for server initialization |
| `idleTimeoutMs` | number | no | Shutdown after this period of inactivity |

**Override locations (in priority order):**
1. `.pi/lsp.json` or `.pi/lsp.yml` — per-project override
2. `~/.pi/lsp/config.json` or `config.yml` — user global override
3. `pi-tools/lsp/defaults.json` — bundled defaults

Overrides merge by server name. Set `"enabled": false` to disable a bundled default.

#### Client Lifecycle

- One LSP client per (server-config, project-root) pair
- Clients spawned lazily on first file touch for that language
- Idle timeout (default 120s) — shutdown after no activity
- Graceful shutdown on session end (shutdown request → 1s grace → kill)
- Crash recovery: if process exits unexpectedly, respawn on next request
- Client state: `pending → initializing → ready → idle → shutdown`

#### File-to-Server Routing

When a file is written/edited/opened:
1. Match file extension against all server configs' `fileTypes`
2. Walk up from file to find project root via `rootMarkers`
3. Check if the server binary exists (`which` / `Bun.which()`)
4. Get or create client for (server, root) pair

Multiple servers can handle the same file (e.g., typescript-language-server + eslint + biome). Diagnostics are merged and deduplicated.

#### Format-on-Write

Default: **enabled** (disable per-project via config).

Flow:
1. Agent calls write/edit tool
2. Extension intercepts via `tool_result` hook
3. Sync content to LSP server(s) via `textDocument/didOpen` or `textDocument/didChange`
4. Request `textDocument/formatting` from server
5. Apply formatting edits to content
6. Write formatted content to disk
7. Send `textDocument/didSave` notification

If formatting times out (3s), write original content — never block the agent.

#### Diagnostics Pipeline

**Auto-diagnostics** (after write/edit):
- Debounce window: 500ms after last file change in a batch
- After debounce, request diagnostics for all touched files
- Report summary at end of agent turn via `ctx.ui.notify` + widget
- Batch rapid multi-file edits (agent writes 5 files → one diagnostic pass)

**On-demand tool** (`lsp` tool):
- `hover` — type info at cursor position
- `definition` — go to definition
- `references` — find all references
- `symbols` — document symbols (with file) or workspace symbol search (with query)
- `diagnostics` — explicit diagnostic request for file(s) or whole workspace
- `rename` — rename symbol across files (with preview/apply modes)
- `status` — show active LSP servers and their state

#### JSON-RPC Transport

Rewrite the JSON-RPC layer from ts-check. Current issues:
- Buffer parsing has edge cases with split messages
- No proper error propagation from server responses
- Notifications aren't distinguished from requests
- No request cancellation support

New implementation:
- Proper `Content-Length` header parsing with incremental buffer
- Request/response correlation via message ID
- Notification handling (no ID, no response expected)
- Server-initiated requests (e.g., `window/showMessage`) — handle or ack
- Push diagnostics via `textDocument/publishDiagnostics` — update diagnostic cache
- Request timeout with cleanup (15s default, configurable)
- `$/cancelRequest` support for aborting long operations

### v1 Shipped Languages

Ship defaults for these servers (agent only needs tsgo working for v1, rest are config-ready):

| Language | Server | Priority |
|----------|--------|----------|
| TypeScript/JavaScript | tsgo | v1 — must work |
| Swift | sourcekit-lsp | v1 — config only, tested when ADR-0054 starts |
| Go | gopls | config only |
| Rust | rust-analyzer | config only |
| Python | pyright | config only |
| Bash | bash-language-server | config only |
| JSON | vscode-json-language-server | config only |
| YAML | yaml-language-server | config only |
| CSS | vscode-css-language-server | config only |
| HTML | vscode-html-language-server | config only |

Additional servers can be added by users or in future pi-tools releases — just a JSON entry.

## Consequences

### Positive

- Agents get reliable TypeScript diagnostics and intelligence
- Adding a language is a config entry, not a code change
- Format-on-write catches style issues before they're committed
- Diagnostic batching prevents LSP hammering during rapid edits
- Idle timeouts prevent zombie LSP processes
- Architecture ready for native app work (ADR-0054) — just install sourcekit-lsp

### Negative

- More complex than ts-check — managing N server lifecycles vs one
- Format-on-write may conflict with project-specific formatters (mitigated: disable per-project)
- Depends on language servers being installed on the system (not managed by pi-tools)

### Follow-up Tasks

- [ ] Remove `ts-check` extension from pi-tools
- [ ] Create `lsp` extension directory with new architecture
- [ ] Implement JSON-RPC transport layer (rewrite from ts-check)
- [ ] Implement client lifecycle manager (spawn, init, idle, shutdown, crash recovery)
- [ ] Implement config loading (defaults.json + user overrides + project overrides)
- [ ] Implement file-to-server routing
- [ ] Implement format-on-write pipeline
- [ ] Implement auto-diagnostics with debounce
- [ ] Implement on-demand `lsp` tool (hover, definition, references, symbols, diagnostics, rename, status)
- [ ] Ship `defaults.json` with v1 language configs
- [ ] Test: write a .ts file → get diagnostics back
- [ ] Test: hover a symbol → get type info
- [ ] Test: add Swift config → sourcekit-lsp starts when .swift file touched
- [ ] Update pi-tools README and extension registration

## Implementation Plan

### Affected Paths

- `pi-tools/ts-check/` — **remove** (superseded)
- `pi-tools/lsp/` — **new** extension directory
  - `index.ts` — extension entry point (hooks, tool registration)
  - `client.ts` — LSP client lifecycle (spawn, init, send, receive, shutdown)
  - `config.ts` — config loading and merging (defaults + user + project)
  - `defaults.json` — bundled server configs
  - `transport.ts` — JSON-RPC over stdio
  - `router.ts` — file-to-server routing
  - `format.ts` — format-on-write pipeline
  - `diagnostics.ts` — diagnostic collection, batching, deduplication
  - `tool.ts` — on-demand `lsp` tool implementation
  - `types.ts` — LSP protocol types (minimal, no vscode-languageserver dep)
- `pi-tools/package.json` — update extension list (remove ts-check, add lsp)

### Patterns to Follow

- oh-my-pi's `packages/coding-agent/src/lsp/` is the reference — adapt the architecture, don't copy the code (different extension API)
- Config schema matches oh-my-pi's `defaults.json` format for potential config sharing
- Use pi's `ExtensionAPI` hooks (`tool_result` for write/edit interception, `agent_end` for diagnostic reporting)
- No `vscode-languageserver-protocol` dependency — raw JSON-RPC like ts-check, but done properly
- Idle cleanup via `setInterval` with configurable timeout

### What to Avoid

- Don't copy oh-my-pi's lspmux multiplexing — unnecessary complexity for v1
- Don't implement code actions / auto-fix — future scope
- Don't manage language server installation — that's the user's responsibility
- Don't block on LSP operations — always timeout and fallback gracefully

### Verification

- [ ] Agent writes a `.ts` file with a type error → diagnostics reported within 3s
- [ ] Agent calls `lsp` tool with `hover` action → gets type info for symbol
- [ ] Agent calls `lsp` tool with `definition` action → gets file:line:col
- [ ] Agent writes 5 `.ts` files rapidly → one batched diagnostic report (not 5)
- [ ] Format-on-write: agent writes unformatted `.ts` → file on disk is formatted
- [ ] Idle timeout: LSP server shuts down after 120s of no activity
- [ ] Adding Swift: create `.pi/lsp.json` with sourcekit-lsp config → server starts on `.swift` write
- [ ] `lsp` tool `status` action → shows active servers and their state
- [ ] tsgo crash → next file write respawns the server transparently

## More Information

### Reference Implementation

oh-my-pi LSP system (`can1357/oh-my-pi`):
- `packages/coding-agent/src/lsp/client.ts` — client lifecycle, JSON-RPC, idle management
- `packages/coding-agent/src/lsp/config.ts` — config loading with user override merging
- `packages/coding-agent/src/lsp/defaults.json` — 40+ server configs
- `packages/coding-agent/src/lsp/index.ts` — tool implementation, format-on-write, diagnostic pipeline
- `packages/coding-agent/src/lsp/types.ts` — LSP protocol types

Credit: Can Boluk (@can1357) for the architecture patterns. MIT licensed.

### Related ADRs

- **ADR-0054** (proposed) — Native App Development: will need Swift LSP (sourcekit-lsp)
- This ADR supersedes the implicit decision to use tsgo-only via ts-check
