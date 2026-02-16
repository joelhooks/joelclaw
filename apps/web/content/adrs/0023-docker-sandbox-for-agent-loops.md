---
title: Docker Sandbox for Agent Loops
status: accepted
date: 2026-02-15
deciders: Joel Hooks
related:
  - "[ADR-0015 — Loop architecture TDD roles](0015-loop-architecture-tdd-roles.md)"
  - "[ADR-0019 — Event naming past tense](0019-event-naming-past-tense.md)"
---

# ADR-0023: Docker Sandbox for Agent Loops

## Context and Problem Statement

Agent loop iterations (IMPLEMENTOR, TEST-WRITER) currently spawn `codex exec` and `claude -p` directly on the host machine via `Bun.spawn()`. This means:

- Agent tools have full access to the host filesystem, not just the project
- A rogue `rm -rf` or misconfigured git operation can damage the system
- `git add -A` scoops up unrelated files if anything else is modified
- No process isolation — agents share the same PID namespace, env, and network
- Can't safely do "revert on rejection" because reverting affects the real worktree

The existing `spawnInContainer()` in `utils.ts` was written for a custom `agent-loop-runner` Docker image that was never built. It's dead code.

## Decision Drivers

- **Safety**: Agents must not be able to damage the host outside the project workspace
- **Subscription reuse**: Both Claude Max and ChatGPT Pro subscriptions must work (no per-token API billing)
- **Speed**: Sandbox setup must happen BEFORE the loop, not per-story (which adds 14-19s each time)
- **Workspace bidirectionality**: Changes in sandbox must be visible on host for git operations
- **Simplicity**: Use Docker Desktop's built-in `docker sandbox` (v0.11.0), not custom Dockerfiles

## Considered Options

1. **Custom Docker image (`agent-loop-runner`)** — Build our own image with all tools
2. **Docker sandbox pre-warm** — Create sandbox once at loop start, reuse via `exec`
3. **E2B cloud sandboxes** — Remote sandbox API
4. **Git worktrees only (no container)** — Isolate via git, not OS

## Decision

**Option 2: Docker sandbox pre-warm with `docker sandbox create` + `exec`**

### How It Works

#### Auth (one-time setup, stored in `agent-secrets`)

| Tool | Auth Mechanism | Secret Name | Lifetime |
|------|---------------|-------------|----------|
| Claude | `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` env var | `claude_setup_token` | 1 year |
| Codex | `~/.codex/auth.json` copied into sandbox | `codex_auth_json` | Until subscription renewal |

Both use existing Max/Pro subscriptions — no API key billing.

#### Lifecycle (per loop)

```
Loop Start (PLANNER)
  │
  ├── docker sandbox create --name loop-{loopId} claude {workDir}
  │     (~14s, cached image — amortized across all stories)
  │
  ├── Inject auth:
  │     docker sandbox exec -e CLAUDE_CODE_OAUTH_TOKEN=... loop-{loopId} ...
  │     docker sandbox exec loop-{loopId} bash -c 'mkdir -p ~/.codex && cat > ~/.codex/auth.json' <<< ...
  │
  ├── For each story:
  │     docker sandbox exec -w {workDir} -e CLAUDE_CODE_OAUTH_TOKEN=... loop-{loopId} \
  │       claude -p "PROMPT" --output-format text --dangerously-skip-permissions
  │     # ~90ms overhead per exec (vs 14s for create)
  │     # Workspace changes visible on host immediately (bidirectional mount)
  │
  └── Loop Complete / Cancel
        docker sandbox rm loop-{loopId}
```

#### Tool Selection in Sandbox

The claude sandbox template includes: `claude`, `git`, `node`, `npm`
The codex sandbox template includes: `codex`, `git`, `node`, `npm`

Since the loop uses claude for review and codex for implementation, and the workspace is shared, we create a **claude sandbox** (which is our primary tool) and exec codex commands by installing it or using the host for codex steps while keeping claude sandboxed.

**Pragmatic approach**: Create one sandbox per agent type needed. Most loops use claude for review + codex for implement:
- `loop-{loopId}-claude` — for test-writer and review steps
- `loop-{loopId}-codex` — for implement steps (if codex is the implementor)

Or: use a single claude sandbox and pass `OPENAI_API_KEY` for codex-via-API fallback when sandbox doesn't have the right tool.

### Timing Data (from spike)

| Operation | Time |
|-----------|------|
| `docker sandbox create` (first pull) | ~19s |
| `docker sandbox create` (cached image) | ~14s |
| `docker sandbox exec` (warm) | ~90ms |
| `docker sandbox stop` | ~11s |
| `docker sandbox rm` | ~150ms |
| claude -p in sandbox | ~7s (same as host) |
| codex exec in sandbox | ~7s (same as host) |

**Net overhead per loop**: ~14s create + ~90ms×N exec = negligible for a loop running 5-10 stories at 5-15min each.

### Fallback

If Docker is unavailable (`docker info` fails), fall back to host-mode execution (current behavior). Log a warning. Set `AGENT_LOOP_HOST=1` to force host mode.

## Consequences

### Positive
- Agents can't damage the host filesystem outside the mounted workspace
- Safe to implement "revert on rejection" — sandbox process can't touch unrelated files
- Auth uses existing subscriptions (no additional cost)
- Pre-warm makes per-story overhead negligible (~90ms vs ~14s)
- `docker sandbox` is maintained by Docker — we don't own a custom image

### Negative
- Docker Desktop must be running (OrbStack)
- 14s added to loop start time for sandbox creation
- Auth tokens need periodic refresh (1 year for claude, varies for codex)
- Two sandbox types needed if loop uses both claude and codex

### Follow-up Tasks
- [ ] Update `utils.ts`: replace dead `spawnInContainer()` with `docker sandbox` implementation
- [ ] Add sandbox create/destroy to PLANNER and COMPLETE functions
- [ ] Create sandbox management skill doc
- [ ] Add `codex_auth_json` refresh reminder (calendar or cron)
- [ ] Test loop end-to-end with sandbox enabled
- [ ] Add `--sandbox` flag to `igs loop start`

## Implementation Plan

### Affected Paths
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/agent-loop/utils.ts` — sandbox create/destroy/exec helpers
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/agent-loop/plan.ts` — create sandbox at loop start
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/agent-loop/implement.ts` — use sandbox exec
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/agent-loop/review.ts` — use sandbox exec
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/agent-loop/test-writer.ts` — use sandbox exec
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/agent-loop/complete.ts` — destroy sandbox
- `~/.agents/skills/docker-sandbox/` — new skill

### Pattern
1. `createLoopSandbox(loopId, tool, workDir)` — creates sandbox, injects auth
2. `execInSandbox(loopId, tool, cmd, env)` — runs command in existing sandbox
3. `destroyLoopSandbox(loopId)` — removes sandbox(es)
4. All three exported from `utils.ts`, called from step functions

### Verification
- [ ] `docker sandbox exec` runs claude -p with CLAUDE_CODE_OAUTH_TOKEN and gets authenticated response
- [ ] `docker sandbox exec` runs codex exec with copied auth.json and gets authenticated response
- [ ] File created in sandbox is visible on host at same path
- [ ] File created on host is visible in sandbox
- [ ] Sandbox creation adds ≤15s to loop start
- [ ] Per-story exec overhead is ≤200ms
- [ ] Loop completes end-to-end with sandbox enabled
- [ ] Host mode fallback works when Docker is unavailable
