---
status: implemented
date: 2026-02-18
decision-makers: Joel Hooks
tags: [gateway, session, codex, agent-loop, openclaw]
---

# ADR-0050: Gateway session resume via fixed file path and codex model pinning

## Context and Problem Statement

Two operational issues were discovered simultaneously:

### Gateway context loss on restart

The gateway daemon (`com.joel.gateway`, ADR-0049) creates a pi session via `createAgentSession()` from the pi SDK. Every time launchd restarts the daemon — whether from a crash, deploy, or system reboot — it creates a **brand new session**, obliterating all conversation context. The gateway loses awareness of what it was working on, active loops, prior instructions, and accumulated context. This is a severe observability and continuity problem for an always-on system (ADR-0002).

The pi SDK's `SessionManager` stores sessions as append-only JSONL files in `~/.pi/agent/sessions/<encoded-cwd>/`. The gateway's sessions (`cwd: ~`) were mixed in with interactive pi sessions from the same directory, making even a "resume most recent" heuristic unreliable — it might resume a human's interactive session instead of the gateway's.

### Codex model not specified in agent loops

The agent-loop implementor (ADR-0005, ADR-0007) spawns codex as a subprocess via `codex exec --full-auto`, but **never specifies a model**. This means codex uses whatever its built-in default is, not the intended `gpt-5.3-codex`. The bug existed in three code paths: host-mode `spawnToolHost()`, Docker-mode `spawnInContainer()`, and the default/fallback cases in both. The separate `agent-dispatch` function (ADR-0026) correctly passed `--model` through event data, but the loop implementor was written earlier and never got the flag.

## Decision

### Gateway: Fixed session file path (OpenClaw pattern)

Use a **deterministic, well-known session file** instead of any "most recent" heuristic.

- Session file: `~/.joelclaw/sessions/gateway/gateway.jsonl`
- On startup: `SessionManager.open(path)` if file exists, `SessionManager.create(cwd, sessionDir)` if not
- Session ID persisted to `~/.joelclaw/gateway.session` for inspectability
- Session ID file cleaned up on graceful shutdown

This pattern is borrowed from [OpenClaw](https://github.com/openclaw/openclaw) (credit: OpenClaw team), which uses named session keys mapped to fixed file paths via `resolveSessionFilePath()`. OpenClaw **never uses `continueRecent()`** — every conversation channel gets a deterministic session file. The gateway is effectively a single persistent channel.

**Non-goals:**
- Session rotation/compaction (future concern — when the JSONL grows too large, add rotation like OpenClaw's `rotateSessionFile()`)
- Multi-gateway sessions (only one gateway daemon runs)

### Codex: Pin model via env var with default

All codex invocations in agent-loop functions now pass `-m <model>` where model is:
1. `CODEX_MODEL` env var if set
2. `gpt-5.3-codex` as default

This covers host-mode, Docker-mode, and fallback cases. The env var allows overriding without code changes (useful for testing new models).

## Consequences

* Good, because gateway restarts no longer lose context — conversation history, tool state, and accumulated instructions survive launchd restarts and reboots
* Good, because gateway sessions are isolated from interactive pi sessions in their own directory
* Good, because `cat ~/.joelclaw/gateway.session` instantly tells you which session the gateway is running
* Good, because `rm ~/.joelclaw/sessions/gateway/gateway.jsonl` gives a clean reset when needed
* Good, because codex workers in loops now use the correct model consistently
* Good, because model is configurable via env var without code changes
* Bad, because the session file will grow indefinitely until rotation is implemented (mitigated: single file, append-only, acceptable for months of use)
* Bad, because a corrupted session file would require manual deletion to recover (mitigated: pi SDK has session file repair utilities)

## Implementation Plan

* **Affected paths**:
  - `packages/gateway/src/daemon.ts` — session resume logic, session ID file
  - `packages/system-bus/src/inngest/functions/agent-loop/implement.ts` — codex model flag
  - `packages/system-bus/src/inngest/functions/agent-loop/utils.ts` — codex model flag in Docker mode
* **New files**: `~/.joelclaw/sessions/gateway/gateway.jsonl` (created at first boot), `~/.joelclaw/gateway.session` (runtime)
* **Dependencies**: No new dependencies. Uses existing `SessionManager` from `@mariozechner/pi-coding-agent`
* **Patterns to follow**: OpenClaw's deterministic session routing (`src/config/sessions/paths.ts`)
* **Patterns to avoid**: `SessionManager.continueRecent()` for daemon sessions — it's a heuristic that can pick the wrong session

### Verification

- [x] Gateway typecheck passes: `bunx tsc --noEmit -p packages/gateway/tsconfig.json`
- [x] System-bus typecheck passes: `bunx tsc --noEmit -p packages/system-bus/tsconfig.json`
- [ ] Gateway restart preserves session: restart daemon, verify session ID matches previous
- [ ] `cat ~/.joelclaw/gateway.session` shows active session ID while daemon runs
- [ ] `ls ~/.joelclaw/sessions/gateway/` shows single `gateway.jsonl` file
- [ ] Agent loop codex invocations include `-m gpt-5.3-codex` (visible in loop output logs)
- [ ] `CODEX_MODEL=gpt-5.3-codex-mini` env override works when set

## Alternatives Considered

* **`SessionManager.continueRecent(HOME)`**: Simplest API, but resumes the most recent session for `~/` which mixes gateway and interactive sessions. Rejected because it's a heuristic that can pick the wrong session.
* **`SessionManager.continueRecent(HOME, gatewaySessionDir)`**: Scoped to a gateway-only directory. Better, but still a "most recent" heuristic — if multiple session files accumulate (e.g., from bugs), it could pick the wrong one. Rejected in favor of the deterministic fixed-path approach.
* **Hardcoded model string**: Could hardcode `gpt-5.3-codex` directly instead of reading an env var. Rejected because env var override is free and useful for testing new models.

## More Information

- Related: [ADR-0005 — Durable multi-agent coding loops](0005-durable-multi-agent-coding-loops.md)
- Related: [ADR-0007 — Agent loop v2 improvements](0007-agent-loop-v2-improvements.md)
- Related: [ADR-0049 — Gateway TUI via WebSocket](0049-gateway-tui-via-websocket.md)
- Related: [ADR-0002 — Personal assistant system architecture](0002-personal-assistant-system-architecture.md)
- Credit: OpenClaw session routing pattern (`src/config/sessions/paths.ts`, `src/agents/pi-embedded-runner/run/attempt.ts`)
- Revisit when: session file exceeds ~50MB, or if multi-gateway support is needed
