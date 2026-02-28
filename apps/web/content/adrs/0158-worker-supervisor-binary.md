---
status: superseded
superseded-by: "0159-talon-k8s-watchdog-daemon"
date: 2026-02-27
tags: [infrastructure, worker, reliability, rust]
related: [0156-graceful-worker-restart]
supersedes: []
---

# ADR-0158: Compiled Worker Supervisor Binary

## Context

The system-bus worker is managed by a bash script (`start.sh`) that backgrounds bun and waits. This architecture has three fatal flaws:

1. **Orphan processes**: `bun run src/serve.ts &` + `wait $PID` means launchd's SIGTERM kills the shell, not bun. Bun becomes an orphan holding port 3111 forever. Every subsequent restart hits EADDRINUSE.

2. **No health checking**: The script does a single PUT sync after 5s sleep. If bun crashes after startup, nothing restarts it. If the PUT fails, nothing retries.

3. **No crash recovery**: Launchd's KeepAlive restarts the *script*, which hits EADDRINUSE because the orphaned bun still holds the port.

These failures compound: orphan → EADDRINUSE → restart fails → Inngest loses SDK URL → all runs fail → "Unable to reach SDK URL" until manual intervention.

Shell scripts cannot solve this. Process supervision requires proper signal handling, health monitoring, and crash recovery — exactly what compiled languages excel at.

## Decision

Build a Rust binary (`worker-supervisor`) that replaces `start.sh` as the launchd-managed process.

### Responsibilities

1. **Pre-start cleanup**: Kill any process holding port 3111
2. **Environment setup**: Load secrets from `agent-secrets`, set env vars (replaces bash secret loading)
3. **Child process management**: Spawn `bun run src/serve.ts` as a child with stdout/stderr piped to log files
4. **Signal forwarding**: SIGTERM/SIGINT/SIGHUP → forward to bun child, wait for drain, force-kill after timeout
5. **Health checking**: Poll `http://127.0.0.1:3111/api/inngest` after startup, PUT sync when healthy
6. **Crash recovery**: If bun exits, restart with exponential backoff (1s→2s→4s→...→30s max). Reset backoff on successful health check.
7. **Watchdog**: Periodic health checks (every 30s). If 3 consecutive failures, restart bun.

### Non-responsibilities

- Does NOT replace Inngest — just supervises the bun process
- Does NOT manage k8s or Docker — launchd-only
- Does NOT do code deployment — that stays in publish scripts

## Implementation Plan

### Affected paths
- `~/Code/joelhooks/joelclaw/infra/worker-supervisor/` — new Rust crate
- `~/Code/joelhooks/joelclaw/infra/worker-supervisor/src/main.rs`
- `~/Library/LaunchAgents/com.joel.system-bus-worker.plist` — point at binary
- `~/Code/joelhooks/joelclaw/packages/system-bus/start.sh` — kept as fallback but no longer primary

### Binary interface
```
worker-supervisor [--config path] [--dry-run]

Config (TOML):
  worker_dir = "~/Code/joelhooks/joelclaw/packages/system-bus"
  command = ["bun", "run", "src/serve.ts"]
  port = 3111
  health_endpoint = "/api/inngest"
  sync_endpoint = "/api/inngest"  # PUT after healthy
  log_stdout = "~/.local/log/system-bus-worker.log"
  log_stderr = "~/.local/log/system-bus-worker.err"
  drain_timeout_secs = 5
  health_interval_secs = 30
  health_failures_before_restart = 3
  restart_backoff_max_secs = 30
```

### Verification
- [ ] `worker-supervisor` starts bun, port 3111 responds within 10s
- [ ] SIGTERM to supervisor → bun receives SIGTERM → clean exit
- [ ] Kill bun manually → supervisor restarts it within backoff window
- [ ] Port 3111 held by orphan → supervisor kills it and starts clean
- [ ] 3 consecutive health check failures → automatic restart
- [ ] Binary compiles for aarch64-apple-darwin, <5MB

## Consequences

### Positive
- Worker restarts are always clean — no more orphans, no more EADDRINUSE
- Automatic crash recovery without manual intervention
- Health monitoring catches silent bun hangs
- Single binary, no runtime dependencies, no bash edge cases
- Launchd signal handling works correctly

### Negative
- Rust compilation step in the build process
- Another binary to maintain (but it's <500 lines and changes rarely)
- Secret loading needs to be reimplemented (or shell to `secrets` CLI)

### Non-goals
- Not a general-purpose process supervisor (use systemd/launchd for that)
- Not replacing launchd — complementing it
