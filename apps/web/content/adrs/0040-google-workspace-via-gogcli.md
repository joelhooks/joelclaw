---
status: accepted
date: 2026-02-18
decision-makers: Joel Hooks
---

# ADR-0040: Google Workspace Access via gogcli

## Context

joelclaw nodes need access to Google Workspace — email triage, calendar awareness, drive file operations, task management, contact lookup. This is foundational for a personal AI OS: an agent that can't see your calendar or read your email is blind to half your life.

Options considered:

1. **Google APIs directly** — raw REST calls with OAuth token management. Maximum flexibility, maximum plumbing. Every agent session needs token refresh logic, scope management, pagination handling.

2. **gogcli (`gog`)** — open-source Go CLI by @steipete. JSON-first output, multi-account, least-privilege scopes, covers Gmail/Calendar/Drive/Contacts/Tasks/Sheets/Docs/Slides/Forms/Chat/Classroom/Apps Script. Designed for scripting and agent use.

3. **MCP Google Workspace server** — Model Context Protocol bridge. Adds a layer of indirection. No mature, maintained implementation covers the full Workspace suite.

## Decision

**Use gogcli as the standard Google Workspace interface for all joelclaw agents and nodes.**

- Installed via Homebrew: `brew install steipete/tap/gogcli`
- Auth stored in encrypted file backend (not macOS Keychain — headless-friendly)
- `GOG_KEYRING_PASSWORD` stored in `agent-secrets` as `gog_keyring_password`
- `GOG_ACCOUNT` set per-session to `joelhooks@gmail.com`
- All agent commands use `--json` for structured output
- Skill at `~/.pi/agent/skills/gogcli/` provides agent-facing reference

## Consequences

### Positive

- **Immediate access** to 13+ Google services from any agent session with two env vars
- **JSON-first** output designed for programmatic consumption — no HTML parsing
- **Least-privilege scopes** — agents can be restricted to read-only or specific services via `--enable-commands`
- **File keyring backend** works headless — no macOS Keychain lockout on SSH sessions
- **Multi-account ready** — can add work accounts later with `--client` isolation
- **Agent loop integration** — calendar/email awareness enables time-aware scheduling, inbox triage, meeting prep

### Negative

- **OAuth token refresh** depends on Google not revoking the app's client credentials (personal OAuth app in testing mode)
- **File keyring** trades Keychain security for headless convenience — password in agent-secrets is the security boundary
- **CLI overhead** — each `gog` call spawns a Go process. Fine for agent use, not for high-frequency polling

### Follow-up tasks

- [ ] Build Inngest functions for scheduled inbox triage (`google/gmail.triage`)
- [ ] Build calendar-aware scheduling (check freebusy before proposing times)
- [ ] Add `gog` to gateway session environment (auto-export `GOG_KEYRING_PASSWORD` + `GOG_ACCOUNT`)
- [ ] Consider `--enable-commands` sandboxing for loop agents (calendar,tasks only)
- [ ] Add multi-account support when work Google account is needed
- [ ] Monitor OAuth app testing-mode user limit (100 users, but only 1 needed)

## Implementation Plan

### Affected paths

- `~/.pi/agent/skills/gogcli/SKILL.md` — agent skill (done)
- `~/.pi/agent/skills/joelclaw-system-check/scripts/health.sh` — health check (done)
- `~/.pi/agent/skills/joelclaw/SKILL.md` — event types (done)
- `~/Library/Application Support/gogcli/config.json` — gog config (keyring_backend: file)
- `agent-secrets: gog_keyring_password` — keyring encryption password

### Verification

- [x] `gog auth list --check` returns valid token for joelhooks@gmail.com
- [x] `gog calendar events primary --today --json` returns events
- [x] `gog gmail search 'is:unread' --max 5 --json` returns messages
- [x] Health check includes gogcli component (10/10 when authed)
- [ ] Gateway session auto-exports gog env vars
- [ ] Inngest gmail triage function registered
