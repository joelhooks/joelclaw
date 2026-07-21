# joelclaw-gateway Claude Code plugin

This is the production plugin for the long-lived Fable gateway session from ADR-0249.

## Bundle

- `agents/joelclaw-gateway.md`: loop contract and retire path.
- `prompts/`: the only comms-policy surface.
- `server/`: one MCP server with stream, Herdr, and wake tool families.
- `hooks/session-start.mjs`: prompt files → latest advisory handoff → authoritative gateway-cursor replay → fresh Herdr snapshot.
- `hooks/post-compact.mjs`: silent `gateway.compaction.recorded` OTEL receipt. It never pages Joel.

The plugin has no transport policy and no Herdr policy. It calls `@joelclaw/message-event-log` through its public package boundary.

## Install dependencies

```bash
cd prototypes/agent-comms-gateway/claude-plugin
bun install
```

## Validate

```bash
bun test
bun run mcp:list
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | bun server/index.mjs
```

## Replay-only rehearsal

Start Claude Code with this plugin and the `joelclaw-gateway` agent. The SessionStart hook reads the real stream but does not advance its cursor. Tool mutations happen only when the agent calls an append, route, wake, or cursor tool.

Every external input needs exactly one read-back `gateway.decision.recorded` receipt before `stream_advance_after_decision` will move the gateway cursor. Gateway-authored output uses `stream_advance_own_output`.

The old journal-spool adapter, Pi replay runner, and review renderer were prototype-only and are deleted.
