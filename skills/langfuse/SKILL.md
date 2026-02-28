---
name: langfuse
displayName: Langfuse Observability
description: Instrument joelclaw LLM calls with Langfuse tracing. Covers the @langfuse/tracing SDK, observation hierarchy (spans, generations, tools, agents), propagateAttributes for userId/sessionId/tags, the pi-session extension (langfuse-cost), and the system-bus OTEL integration. Use when adding Langfuse traces, debugging missing/broken traces, checking cost data, or improving observability on any LLM surface.
version: 0.2.0
author: joel
tags:
  - observability
  - langfuse
  - tracing
  - llm
---

# Langfuse Observability

Langfuse is the LLM observability layer for joelclaw. Every LLM call produces a Langfuse trace with nested hierarchy, I/O, usage, cost, and attribution.

## Architecture

joelclaw has **two Langfuse integration points**:

### 1. Pi-session extension (`langfuse-cost`)
- **Source**: `~/Code/joelhooks/pi-tools/langfuse-cost/index.ts`
- **Runtime**: `~/.pi/agent/git/github.com/joelhooks/pi-tools/langfuse-cost/index.ts` (copy, NOT symlink)
- **What it traces**: Every gateway + interactive pi session LLM call
- **How**: Hooks into pi session events (`session_start`, `message_start`, `message_end`, `tool_call`, `tool_result`, `session_shutdown`)
- **Dedup**: `globalThis.__langfuse_cost_loaded__` guard prevents duplicate instances from symlink/realpath module resolution split
- **Optional dependency behavior**: `langfuse` is lazily loaded (no top-level hard import). Missing module must disable telemetry, not crash extension import. Regression test: `pi/extensions/langfuse-cost/index.test.ts`

### 2. System-bus OTEL bridge (`langfuse.ts`)
- **Source**: `packages/system-bus/src/lib/langfuse.ts`
- **What it traces**: All Inngest function LLM calls (reflect, triage, email cleanup, docs ingest)
- **How**: `@langfuse/otel` `LangfuseSpanProcessor` + `@langfuse/tracing` `startObservation()`
- **Produces**: `joelclaw.inference` traces with generation children

## Current Trace Hierarchy (pi-session)

The `langfuse-cost` extension produces a 4-level nested span hierarchy:

```
joelclaw.session (trace)
  └── session (span) — entire session lifetime
        └── turn-1 (span) — user message → final assistant response
        │     ├── tool:bash (span) — individual tool execution
        │     ├── tool:read (span)
        │     └── llm.call (generation) — the LLM API call with usage/cost
        └── turn-2 (span)
              ├── tool:edit (span)
              ├── tool:bash (span)
              └── llm.call (generation)
```

### What each level captures

| Level | Created on | Ended on | Contains |
|-------|-----------|----------|----------|
| `joelclaw.session` trace | `session_start` | `session_shutdown` | userId, sessionId, tags, turn count |
| `session` span | `session_start` | `session_shutdown` | Channel, session type, turn count |
| `turn-N` span | `message_start[user]` | `message_end[assistant]` with text output | User input (clean), sourceChannel metadata |
| `tool:name` span | `tool_call` event | `tool_result` event | Tool input, output (truncated 500 chars) |
| `llm.call` generation | `message_end[assistant]` | immediate | Model, usage, cache tokens, cost, I/O |

### Channel header stripping

User messages from Telegram arrive with a `---\nChannel:...\n---` header. The extension:
1. Strips the header from trace `input` (clean user text only)
2. Parses known keys (`channel`, `date`, `platform_capabilities`) into `sourceChannel` metadata
3. Skips multi-line values (e.g. `formatting_guide`)

## Credentials

Langfuse creds in `agent-secrets`:
- `langfuse_public_key` — `pk-lf-cb8b...`
- `langfuse_secret_key` — `sk-lf-c86f...`
- `langfuse_base_url` — `https://us.cloud.langfuse.com`

Gateway gets them via `gateway-start.sh` env exports. System-bus resolves via env → `secrets lease` fallback.

## Trace Conventions

### Naming
- Pi-session: `joelclaw.session` (trace) → `session` → `turn-N` → `tool:name` → `llm.call`
- System-bus: `joelclaw.inference` (trace) → generation children

### Required Attributes
Every trace MUST have:
- `userId: "joel"`
- `sessionId` — pi session ID for grouping
- `tags` — minimum: `["joelclaw", "pi-session"]`
- Dynamic tags: `provider:anthropic`, `model:claude-opus-4-6`, `channel:central`, `session:central`

### Metadata Shape (flat, filterable)
```typescript
{
  channel: "central",           // GATEWAY_ROLE env
  sessionType: "central",       // "gateway" | "interactive" | "codex" | "central"
  component: "pi-session",
  model: "claude-opus-4-6",
  provider: "anthropic",
  stopReason: "toolUse",        // or "endTurn"
  turnCount: 5,                 // Updated on each turn
  sourceChannel: {              // Only on first user message per turn
    channel: "telegram",
    date: "...",
    platform_capabilities: "..."
  },
  tools: ["bash", "read"],      // Tool names used this turn
}
```

### Generation usageDetails
```typescript
{
  input: 1,                      // Non-cached input tokens
  output: 97,                    // Output tokens
  total: 68195,                  // Total tokens
  cache_read_input_tokens: 67877, // 90% discount
  cache_write_input_tokens: 220,  // 25% premium (NOT priced by Langfuse — known gap)
}
```

## Known Gaps

| Issue | Severity | Notes |
|-------|----------|-------|
| `cache_write_input_tokens` not priced | Medium | Langfuse platform limitation — no cache write rate in their pricing table |
| Some continuation turns `totalCost: 0` | Low | Dedup key collision edge case |
| No `completionStartTime` on first turn | Low | `lastAssistantStartTime` not set before first `message_start[assistant]` |
| `tool_result` matching | Low | Relies on `toolCallId` — if pi changes the field name, spans won't close |

## Debugging

### Check recent traces
```bash
LF_PK=$(secrets lease langfuse_public_key --ttl 5m)
LF_SK=$(secrets lease langfuse_secret_key --ttl 5m)
curl -s -u "$LF_PK:$LF_SK" "https://us.cloud.langfuse.com/api/public/traces?limit=5" \
  | jq '[.data[] | {name, ts: .timestamp[:19], obs: (.observations | length), output: (.output // "" | tostring | .[0:60])}]'
```

### Check nested observations on a trace
```bash
TRACE_ID="<id>"
curl -s -u "$LF_PK:$LF_SK" "https://us.cloud.langfuse.com/api/public/observations?traceId=$TRACE_ID" \
  | jq '[.data[] | {name, type, model, startTime: .startTime[:19], endTime: .endTime[:19]}]'
```

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Double traces | Extension loaded twice via symlink/realpath split | globalThis dedup guard (already fixed) |
| `[toolUse]` output instead of tool names | `tool_call` events not firing | Check pi version, verify `toolName` field on event |
| No traces at all | Langfuse creds missing | Check `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` env |
| `channel:interactive` on gateway | `GATEWAY_ROLE` not set | Must be in `gateway-start.sh` |
| Stale extension code | Runtime copy not updated | Copy dev → `~/.pi/agent/git/.../langfuse-cost/index.ts` |
| OTEL emit errors in gateway | system-bus-worker port-forward down | `kubectl port-forward -n joelclaw svc/system-bus-worker 3111:3111` |

## Key Files

- Pi extension (dev): `~/Code/joelhooks/pi-tools/langfuse-cost/index.ts`
- Pi extension (runtime): `~/.pi/agent/git/github.com/joelhooks/pi-tools/langfuse-cost/index.ts`
- System-bus bridge: `packages/system-bus/src/lib/langfuse.ts`
- Gateway start: `~/.joelclaw/scripts/gateway-start.sh`
- Extension deps: `~/Code/joelhooks/pi-tools/langfuse-cost/node_modules/langfuse/`

## Deployment Workflow

After editing `langfuse-cost/index.ts`:
1. `cd ~/Code/joelhooks/pi-tools && git add -A && git commit -m "..." && git push`
2. `cp langfuse-cost/index.ts ~/.pi/agent/git/github.com/joelhooks/pi-tools/langfuse-cost/index.ts`
3. Restart gateway: kill process, `bash ~/.joelclaw/scripts/gateway-start.sh`
4. For interactive sessions: `/reload` or start new session

## ADRs

- **ADR-0146**: Inference Cost Monitoring and Control — `shipped`
- **ADR-0147**: Named Agent Profiles (trace attribution by role)
