---
name: agent-mail
displayName: Agent Mail
description: >-
  Coordinate between agents via agent mail — send messages, check inboxes,
  reserve files before editing, release after commit. Use when multiple agents
  operate on shared code, when handing off tasks between agents, when reserving
  files to prevent edit conflicts, or checking coordination status. Triggers on:
  'send a message to', 'check inbox', 'mail status', 'reserve files',
  'release files', 'agent coordination', 'file lock', 'mail an agent',
  'who has this file', or any multi-agent coordination task.
version: 0.2.0
author: joel
tags:
  - coordination
  - multi-agent
  - cli
  - infrastructure
---

# Agent Mail

Inter-agent messaging and file reservation system. CLI wraps mcp_agent_mail
server (ADR-0172). All operations go through `joelclaw mail`.

## Architecture

```
pi session → mail_* tools (extension)
           → joelclaw mail CLI
           → mcp_agent_mail HTTP API (:8765)
           → SQLite + Git storage
```

- **Server**: mcp_agent_mail at `http://127.0.0.1:8765`, managed by launchd (`com.joelclaw.agent-mail`)
- **CLI**: `joelclaw mail {status|register|send|inbox|read|reserve|renew|release|locks|search}`
- **Extension**: `~/.pi/agent/extensions/agent-mail/` — 6 tools (mail_send, mail_inbox, mail_read, mail_reserve, mail_release, mail_status)
- **Project key**: `/Users/joel/Code/joelhooks/joelclaw` (absolute path, required by server)
- **Agent naming**: AdjectiveNoun format (e.g. BlueFox, RedStone). Server rejects non-conforming names.

## Quick Reference

### Check status
```bash
joelclaw mail status
```

### Register an agent
```bash
joelclaw mail register --agent RedFox --program pi --model claude-sonnet-4 --task "gateway daemon"
```

### Send a message
```bash
joelclaw mail send --from BlueFox --to RedStone --subject "Task complete" "Finished refactoring the content pipeline. All tests pass."
```

### Check inbox
```bash
joelclaw mail inbox --agent RedStone
joelclaw mail inbox --agent RedStone --unread
```

### Read a message
```bash
joelclaw mail read --agent RedStone --id 1
```

### Reserve files before editing (short TTL)
```bash
joelclaw mail reserve --agent BlueFox --paths "packages/cli/src/cli.ts,packages/cli/src/commands/mail.ts" --ttl-seconds 900
```

### Renew active reservations if work continues
```bash
joelclaw mail renew --agent BlueFox --paths "packages/cli/src/cli.ts" --extend-seconds 900
# or renew all active reservations for the agent:
joelclaw mail renew --agent BlueFox --extend-seconds 900
```

### Release files after commit
```bash
joelclaw mail release --agent BlueFox --all
# or specific paths:
joelclaw mail release --agent BlueFox --paths "packages/cli/src/cli.ts"
```

### Check active file locks
```bash
joelclaw mail locks
```

### Search messages
```bash
joelclaw mail search --query "refactor"
```

## Coordination Patterns

### Required coordination protocol (default)
1. `joelclaw mail inbox --unread` — read pending coordination before starting.
2. `joelclaw mail send --to <agent|team> --subject "Starting: ..." "scope + files + intent"` — announce active work.
3. `joelclaw mail reserve --paths "..." --ttl-seconds 900` — claim file intent with short lease.
4. If work runs long: `joelclaw mail renew --paths "..." --extend-seconds 900`.
5. On completion/handoff: send status update via `joelclaw mail send`.
6. Always `joelclaw mail release --paths "..."` or `--all` after commit/handoff.

### Task handoff
1. `joelclaw mail send --to OtherAgent --subject "Task: ..." "Description + context + reserved paths"`
2. Other agent checks `joelclaw mail inbox --unread`
3. Other agent reads and acts
4. Other agent reports back via `joelclaw mail send`

### Loop worker coordination (Phase 3 — shipped)
- Workers `reserve` before editing and `release` after commit/exit path
- Story pipeline checks reservations before dispatching
- Conflicts are surfaced and must be coordinated explicitly

## Pi Extension Tools

Available in all pi sessions automatically:

| Tool | Purpose |
|------|---------|
| `mail_send` | Send message to another agent |
| `mail_inbox` | Check inbox (optional --unread filter) |
| `mail_read` | Read specific message by ID |
| `mail_reserve` | Reserve file paths (advisory lock) |
| `mail_release` | Release file reservations |
| `mail_status` | Server health + inbox summary |

## Troubleshooting

### Server down
```bash
launchctl list | grep agent-mail
# If not running:
launchctl load ~/Library/LaunchAgents/com.joelclaw.agent-mail.plist
# Check logs:
tail -50 ~/.joelclaw/logs/agent-mail.stderr.log
```

### Agent name rejected
Server requires AdjectiveNoun format from its internal dictionary.
If a name is rejected, the server auto-generates one. Use `joelclaw mail register`
and note the assigned name.

### Project not found
The `register` command auto-calls `ensure_project`, but if it fails:
```bash
# Manually ensure project exists
curl -X POST http://127.0.0.1:8765/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ensure_project","arguments":{"human_key":"/Users/joel/Code/joelhooks/joelclaw"}}}'
```

## Related
- ADR-0172: Agent Mail via MCP Agent Mail
- `joelclaw mail --help` for full CLI docs
- Extension source: `~/.pi/agent/extensions/agent-mail/index.ts`
- Server source: `~/Code/Dicklesworthstone/mcp_agent_mail/`
