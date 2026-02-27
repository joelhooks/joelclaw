---
status: proposed
date: 2026-02-27
tags: [cli, agents, observability, codex, sessions]
related: [0155-three-stage-story-pipeline, 0156-graceful-worker-restart]
---

# ADR-0157: Agent Lifecycle CLI — `joelclaw agent`

## Context

When agents (codex, claude, pi) run background work — story pipeline steps, codex exec calls, background_agent tasks — there's no way to observe, manage, or interact with them from the operator CLI. The only option is manually finding session transcript files and parsing JSONL.

This became acute with the story pipeline (ADR-0155): codex implement steps run 5-10 minutes with no visibility. When they fail, diagnosis requires knowing which session file to read, what the JSONL schema looks like, and how to extract signal from noise.

Agents are first-class runtime resources in joelclaw. They deserve a first-class management interface.

## Decision

Add `joelclaw agent` command group with five subcommands:

### `joelclaw agent find`

Discover active agent sessions across all runtimes.

```bash
joelclaw agent find                        # all active sessions
joelclaw agent find --runtime codex        # codex only
joelclaw agent find --since 1h             # started in last hour
```

Sources to scan:
- **Codex**: `~/.codex/sessions/YYYY/MM/DD/*.jsonl` — active if mtime recent + process alive
- **Claude**: `~/.claude/projects/*/sessions/*.jsonl` — same heuristic
- **Pi**: `ps aux | grep pi` + gateway session metadata in Redis

Output: session ID, runtime, start time, working directory, last activity summary (latest reasoning text).

### `joelclaw agent watch`

Tail a session transcript in real-time, extracting readable signal.

```bash
joelclaw agent watch                       # auto-detect most recent active session
joelclaw agent watch <session-id>          # specific session
joelclaw agent watch --raw                 # full JSONL (no filtering)
joelclaw agent watch --tools-only          # just tool calls
```

Default output streams:
- **Reasoning summaries** from `payload.type: "reasoning"` → `payload.summary[].text`
- **Tool calls** from `payload.type: "function_call"` → name + truncated args
- **Errors** from function_call_output containing error/exception patterns

Codex JSONL schema:
```
{ type: "response_item", timestamp, payload: { type: "reasoning"|"function_call"|"function_call_output"|"custom_tool_call", ... } }
{ type: "event_msg", timestamp, payload: { ... } }
{ type: "turn_context", timestamp, payload: { ... } }
```

### `joelclaw agent kill`

Terminate an agent session.

```bash
joelclaw agent kill <session-id>           # graceful SIGTERM
joelclaw agent kill <session-id> --force   # SIGKILL
joelclaw agent kill --all                  # kill all agent sessions
```

Find the PID from the session metadata or process table, send signal.

### `joelclaw agent branch`

Show what git branch/worktree an agent is operating in.

```bash
joelclaw agent branch                      # all active agents
joelclaw agent branch <session-id>         # specific session
```

Derives from: codex session's `workdir` in tool call args, or worktree listing cross-referenced with PIDs.

### `joelclaw agent notify`

Push a message into an agent's context (when supported by the runtime).

```bash
joelclaw agent notify <session-id> "stop working on X, switch to Y"
joelclaw agent notify --active "deploying, pause git operations"
```

Implementation depends on runtime:
- Pi: Redis pub/sub to gateway session
- Codex: write to a watched file or stdin if interactive
- Claude: write to a watched file

This is the hardest subcommand — may be runtime-limited. Start with pi (Redis channel exists), defer others.

## Implementation Plan

### Affected paths
- `~/Code/joelhooks/joelclaw/packages/cli/src/commands/agent.ts` — new command group
- `~/Code/joelhooks/joelclaw/packages/cli/src/commands/agent/find.ts`
- `~/Code/joelhooks/joelclaw/packages/cli/src/commands/agent/watch.ts`
- `~/Code/joelhooks/joelclaw/packages/cli/src/commands/agent/kill.ts`
- `~/Code/joelhooks/joelclaw/packages/cli/src/commands/agent/branch.ts`
- `~/Code/joelhooks/joelclaw/packages/cli/src/commands/agent/notify.ts`
- `~/.pi/agent/skills/joelclaw/SKILL.md` — add agent subcommand docs

### Phases
1. **`find` + `watch`** — highest value, enables monitoring. Ship together.
2. **`kill` + `branch`** — lifecycle management. Ship together.
3. **`notify`** — requires runtime-specific work. Ship per-runtime.

### Patterns
- Follow existing CLI patterns in `packages/cli/src/commands/`
- HATEOAS JSON output with `next_actions`
- Compact mode (`-c`) for human/monitoring use
- Effect-TS for the CLI layer

### Verification
- [ ] `joelclaw agent find` discovers an active codex session during a story pipeline run
- [ ] `joelclaw agent watch` streams reasoning summaries in real-time
- [ ] `joelclaw agent kill` terminates a codex session and the process exits
- [ ] `joelclaw agent branch` shows the correct working directory/branch
- [ ] All commands produce valid HATEOAS JSON and compact output

## Consequences

### Positive
- Full visibility into agent work without manual JSONL parsing
- Enables automated monitoring (nanny patterns, heartbeat checks)
- Kill gives operator control over runaway agents
- Branch prevents accidental git conflicts
- Notify enables mid-flight course corrections

### Negative
- New CLI surface to maintain
- Session transcript format is runtime-specific (codex vs claude vs pi)
- Notify is hard to make reliable across runtimes

### Non-goals
- Not building a TUI dashboard (yet) — CLI-first
- Not replacing `joelclaw runs` for Inngest run monitoring — this is agent-level, not function-level
- Not managing gateway sessions — those have their own lifecycle via `joelclaw gateway`
