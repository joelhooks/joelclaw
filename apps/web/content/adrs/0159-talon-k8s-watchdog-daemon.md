---
status: accepted
date: 2026-02-27
tags: [infrastructure, k8s, reliability, rust, watchdog, self-healing, worker]
deciders: [joel]
related:
  - "0029-replace-docker-desktop-with-colima"
  - "0037-gateway-watchdog-layered-failure-detection"
  - "0138-self-healing-backup-orchestrator"
  - "0148-k8s-resilience-policy"
supersedes:
  - "0158-worker-supervisor-binary"
---

# ADR-0159: Talon — Infrastructure Watchdog Daemon

## Status

accepted (deployed 2026-02-27, launchd active)

## Context

On Feb 21, the Colima launchd plist lost the ability to recover because `limactl` wasn't in PATH. For **6 days**, the recovery mechanism failed silently every 5 minutes. The k8s-reboot-heal script failed identically. The entire k8s cluster — Redis, Inngest, Typesense — was one Colima VM hiccup away from being unrecoverable without manual SSH intervention.

Separately, ADR-0158 identified that the worker process supervisor (`start.sh`) has its own class of fatal flaws: orphan bun processes, no health checking, EADDRINUSE on restart. That ADR proposed a standalone Rust supervisor.

Both problems share the same root: **bash scripts managing infrastructure with no intelligence, no escalation, and no environmental resilience.** The fix is the same shape: a compiled binary that owns its PATH, monitors health, applies fixes, and escalates when the fix doesn't work.

One talon grips the whole stack — cluster AND worker.

### What's broken today

1. **Bash scripts can't diagnose.** `k8s-reboot-heal.sh` applies a fixed checklist (start container, untaint, modprobe). When the failure is novel (e.g., node stuck in "shutting down" state, need a `docker restart` not `docker start`), the script does nothing and logs a warning nobody reads.

2. **No escalation path.** When the scripted fix fails, there's no next step. No agent investigation, no notification, no fallback. Just silent failure every 3 minutes until a human notices.

3. **Environment brittleness.** launchd runs with minimal PATH. Every homebrew dependency (`colima`, `limactl`, `kubectl`, `talosctl`, `helm`) is invisible unless explicitly configured. This is a class of bug, not a one-off.

4. **Worker orphan processes.** `bun run src/serve.ts &` + `wait $PID` means launchd's SIGTERM kills the shell, not bun. Bun becomes an orphan holding port 3111. Every subsequent restart hits EADDRINUSE.

5. **No worker crash recovery.** If bun crashes after startup, nothing restarts it. If the health check fails, nothing retries.

ADR-0037 defined three watchdog layers for the gateway. The k8s cluster and worker have **zero** intelligent watchdog layers — just dumb cron scripts and a bash wrapper.

## Decision

Build **talon** — a single compiled Rust daemon that supervises the system-bus worker process AND monitors the full k8s infrastructure stack. Applies fast fixes, escalates to an AI agent for novel failures, and falls back to local inference + iMessage SOS when the network is down.

Supersedes ADR-0158 (worker-supervisor binary) — talon absorbs all worker supervision responsibilities. One binary, one launchd plist, one state machine.

### Architecture

```
launchd (com.joel.talon)
  └─ talon binary (~/.local/bin/talon)
      │
      ├─ Worker Supervisor (replaces start.sh + com.joel.system-bus-worker)
      │   ├─ Pre-start: kill orphan on port 3111
      │   ├─ Spawn: bun run src/serve.ts (child process)
      │   ├─ Signal forwarding: SIGTERM/SIGINT → bun, drain timeout
      │   ├─ Stdout/stderr → log files
      │   ├─ Crash recovery: restart with exponential backoff (1s→30s)
      │   ├─ Health: poll localhost:3111/api/inngest every 30s
      │   ├─ PUT sync: localhost:3111/api/inngest after healthy
      │   └─ 3 consecutive health failures → restart bun
      │
      ├─ Infrastructure Probe Loop (60s interval)
      │   ├─ Colima VM alive?
      │   ├─ Docker socket responding?
      │   ├─ Talos container running?
      │   ├─ k8s API reachable?
      │   ├─ Node Ready + schedulable?
      │   ├─ Flannel healthy?
      │   ├─ Redis PONG?
      │   ├─ Inngest /health 200?
      │   ├─ Typesense /health ok?
      │   └─ Worker /api/inngest 200? (from probe loop, not supervisor)
      │
      ├─ State Machine
      │   healthy → degraded (1 critical probe failure)
      │   degraded → failed (3 consecutive failures)
      │   failed → investigating (agent spawned)
      │   investigating → healthy (agent fixed it)
      │   investigating → critical (agent failed)
      │   critical → sos (iMessage sent)
      │   any → healthy (all probes pass)
      │
      ├─ Tier 1: Fast Fix (bash heal script + worker restart)
      │   Infra failures: runs k8s-reboot-heal.sh (timeout: 90s)
      │   Worker failures: restarts bun child (already handled by supervisor)
      │   If probes pass after, back to healthy.
      │
      ├─ Tier 2: Agent Investigation (pi with cloud model)
      │   Spawns: pi -p --no-session --model anthropic/claude-sonnet-4
      │   Prompt includes: which probes failed, heal script output,
      │   recent logs, k8s skill context, worker supervisor state
      │   Timeout: 120s. Cooldown: 10min between spawns.
      │
      ├─ Tier 3: Local Agent Fallback (Ollama)
      │   If pi cloud model fails (network down, auth expired):
      │   Spawns: pi -p --no-session --model ollama/qwen3:8b
      │   Same diagnostic prompt. Reduced capability but can
      │   still run kubectl, docker commands, parse logs.
      │
      └─ Tier 4: SOS (iMessage)
          If all tiers fail or critical state persists >15min:
          imsg send --to joelhooks@gmail.com
          "🚨 TALON SOS: k8s cluster down, all recovery failed.
           Failed probes: [list]. SSH to panda and investigate."
          Cooldown: 30min between SOS messages.
```

### Worker Supervision Details (absorbed from ADR-0158)

Talon replaces both `start.sh` and the `com.joel.system-bus-worker` launchd plist. The worker is a child process of talon, not a separate launchd service.

**Pre-start cleanup**: Find and kill any process holding port 3111 (handles orphans from previous crashes).

**Environment setup**: Load secrets from `agent-secrets` CLI, set INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY, etc. as env vars for the child.

**Signal forwarding**: SIGTERM to talon → SIGTERM to bun → wait drain_timeout → SIGKILL if needed.

**Crash recovery**: Bun exits → restart with exponential backoff (1s, 2s, 4s, ..., 30s max). Backoff resets after a successful health check.

**Health loop**: Every 30s, GET `localhost:3111/api/inngest`. 3 consecutive failures → restart bun. Successful response → PUT same endpoint (Inngest SDK sync).

### Probe Definitions

Each probe is a subprocess with a timeout:

| Probe | Command | Timeout | Critical? |
|-------|---------|---------|-----------|
| colima | `colima status` | 5s | Yes |
| docker | `docker ps` (via DOCKER_HOST) | 5s | Yes |
| talos-container | `docker inspect joelclaw-controlplane-1` (via SSH) | 10s | Yes |
| k8s-api | `kubectl get nodes` | 10s | Yes |
| node-ready | `kubectl get nodes -o jsonpath=...` | 5s | Yes |
| node-schedulable | Check for taints + cordon state | 5s | Yes |
| flannel | `kubectl get pods -n kube-system` + parse | 10s | No |
| redis | `kubectl exec redis-0 -- redis-cli ping` | 5s | Yes |
| inngest | `curl localhost:8288/health` | 5s | No |
| typesense | `curl localhost:8108/health` | 5s | No |
| worker | `curl localhost:3111/api/inngest` | 5s | No |

"Critical" probes trigger Tier 1 immediately on failure. Non-critical probes only escalate after 3 consecutive failures.

### Environment Handling

Talon owns its own PATH — compiled into the binary, not inherited from launchd:

```rust
const PROBE_PATH: &str = "/opt/homebrew/bin:/Users/joel/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
```

This eliminates the entire class of "homebrew not in PATH" bugs that caused the 6-day outage.

### State Persistence

Minimal file-based state at `~/.local/state/talon/`:
- `state.json` — current state machine position, consecutive failures, last action timestamps
- `talon.log` — structured JSON log (append-only, rotated at 10MB)
- `last-probe.json` — results of most recent probe cycle (for debugging)

State survives daemon restarts. On startup, talon reads `state.json` and resumes from where it was (with a grace period for probes to pass before escalating).

### Configuration

TOML at `~/.config/talon/config.toml`:

```toml
check_interval_secs = 60
heal_script = "/Users/joel/Code/joelhooks/joelclaw/infra/k8s-reboot-heal.sh"
heal_timeout_secs = 90
services_file = "~/.joelclaw/talon/services.toml"

[worker]
dir = "/Users/joel/Code/joelhooks/joelclaw/packages/system-bus"
command = ["bun", "run", "src/serve.ts"]
port = 3111
health_endpoint = "/api/inngest"
sync_endpoint = "/api/inngest"
log_stdout = "~/.local/log/system-bus-worker.log"
log_stderr = "~/.local/log/system-bus-worker.err"
env_file = "~/.config/system-bus.env"
drain_timeout_secs = 5
health_interval_secs = 30
health_failures_before_restart = 3
restart_backoff_max_secs = 30
startup_sync_delay_secs = 5
http_timeout_secs = 5

[escalation]
agent_cooldown_secs = 600       # 10min between agent spawns
sos_cooldown_secs = 1800        # 30min between SOS notifications
sos_recipient = "joelhooks@gmail.com"
sos_telegram_chat_id = "7718912466"
sos_telegram_secret_name = "telegram_bot_token"
critical_threshold_secs = 900   # 15min in critical before SOS

[agent]
cloud_command = "pi -p --no-session --no-extensions --model anthropic/claude-sonnet-4"
local_command = "pi -p --no-session --no-extensions --model ollama/qwen3:8b"
timeout_secs = 120

[probes]
colima_timeout_secs = 5
k8s_timeout_secs = 10
service_timeout_secs = 5
consecutive_failures_before_escalate = 3

[health]
enabled = true
bind = "127.0.0.1:9999"
```

Service-specific monitors live in `~/.joelclaw/talon/services.toml`:

```toml
[launchd.gateway]
label = "com.joel.gateway"
critical = true
timeout_secs = 5

[launchd.voice_agent]
label = "com.joel.voice-agent"
critical = true
timeout_secs = 5

[http.voice_agent]
url = "http://127.0.0.1:8081/"
critical = true
timeout_secs = 5
```

Talon hot-reloads `services.toml` on file mtime changes and supports immediate reload via `SIGHUP`.

Health endpoint:
- `GET http://127.0.0.1:9999/health`
- returns current Talon state, failed probe names/count, and worker restart count

### Agent Prompt Template

When talon spawns an agent, it constructs a prompt with full diagnostic context:

```
You are an emergency infrastructure repair agent for the joelclaw k8s cluster.

FAILED PROBES:
{list of failed probes with error output}

HEAL SCRIPT OUTPUT:
{stdout+stderr from k8s-reboot-heal.sh}

RECENT TALON LOG:
{last 20 log entries}

YOUR TASK:
1. Diagnose why the probes are failing
2. Run kubectl, docker, talosctl commands to investigate
3. Apply fixes
4. Verify the probes would pass now

CONSTRAINTS:
- Do NOT recreate the cluster (talosctl cluster destroy) without explicit approval
- Do NOT delete PVCs (data loss)
- Do NOT kill the Lima SSH mux socket
- Prefer the least destructive fix that restores health
- Log what you did and why to slog
```

### Relationship to Existing Components

| Component | Talon's relationship |
|-----------|---------------------|
| k8s-reboot-heal.sh | Talon calls it as Tier 1. Script remains for standalone use. |
| start.sh + com.joel.system-bus-worker | **Replaced.** Talon owns the worker process. Remove the worker launchd plist. |
| ADR-0037 gateway watchdog | Integrated. Gateway heartbeat now includes Talon `/health` signal in addition to local process/Redis checks. |
| ADR-0138 self-healing | Complementary. Self-healing handles Inngest function failures. Talon handles infra. |
| ADR-0158 worker-supervisor | **Superseded.** All worker supervision absorbed into talon. |
| ADR-0090 O11y triage | Talon fires before o11y triage — triage needs a working cluster to run. |
| com.joel.colima plist | Still needed for Colima VM auto-start. Talon monitors but doesn't manage the VM lifecycle. |
| com.joel.k8s-reboot-heal plist | **Replaced.** Talon calls the script directly; the launchd timer is redundant. |

## Implementation Plan

### Affected paths

- `~/Code/joelhooks/joelclaw/infra/talon/` — Rust watchdog crate
- `~/Code/joelhooks/joelclaw/infra/talon/src/main.rs` — daemon entry + watchdog loop/signal handling
- `~/Code/joelhooks/joelclaw/infra/talon/src/probes.rs` — health probe definitions (includes flannel)
- `~/Code/joelhooks/joelclaw/infra/talon/src/state.rs` — state machine + probe history persistence
- `~/Code/joelhooks/joelclaw/infra/talon/src/escalation.rs` — tier 1-4 handlers + service-specific heal + telegram/imessage SOS fan-out
- `~/Code/joelhooks/joelclaw/infra/talon/src/worker.rs` — bun process supervisor (port cleanup, spawn, signal forwarding, crash recovery)
- `~/Code/joelhooks/joelclaw/infra/talon/src/config.rs` — TOML config loading + dynamic service monitor parsing + health endpoint config
- `~/Code/joelhooks/joelclaw/infra/talon/src/health.rs` — tiny localhost health endpoint (`/health`)
- `~/Code/joelhooks/joelclaw/infra/talon/config.default.toml` — default runtime config template
- `~/Code/joelhooks/joelclaw/infra/talon/services.default.toml` — template for dynamic service monitor config
- `~/Code/joelhooks/joelclaw/packages/gateway/src/heartbeat.ts` — gateway watchdog now incorporates Talon health signal
- `~/Code/joelhooks/joelclaw/infra/launchd/com.joel.talon.plist` — launchd service (replaces com.joel.system-bus-worker AND com.joel.k8s-reboot-heal)
- `~/.config/talon/config.toml` — runtime config
- `~/.joelclaw/talon/services.toml` — runtime dynamic service monitors (launchd/http)
- `~/.local/state/talon/` — state + logs

### Removed paths (on deploy)

- `~/Library/LaunchAgents/com.joel.system-bus-worker.plist` — replaced by talon
- `~/Library/LaunchAgents/com.joel.k8s-reboot-heal.plist` — replaced by talon
- `~/Code/joelhooks/joelclaw/packages/system-bus/start.sh` — kept as documentation/fallback but no longer used

### Build

```bash
cd ~/Code/joelhooks/joelclaw/infra/talon
cargo build --release
cp target/release/talon ~/.local/bin/talon
```

### Dependencies (Cargo.toml)

```toml
[dependencies]
# intentionally empty
```

Implementation is std-only (no tokio/serde/toml crates). Probes and integrations use subprocess commands (`curl`, `kubectl`, `docker`, `launchctl`, `secrets`) and hand-rolled parsing to keep recovery paths dependency-light.

### Verification

**Worker supervision:**
- [ ] `talon` starts bun child, port 3111 responds within 10s
- [ ] SIGTERM to talon → bun receives SIGTERM → clean exit
- [ ] Kill bun manually → talon restarts it within backoff window
- [ ] Port 3111 held by orphan → talon kills it and starts clean
- [ ] 3 consecutive health failures → automatic bun restart
- [ ] Successful health check → PUT sync fires

**Infrastructure monitoring:**
- [ ] `talon` runs probe cycle, logs results as JSON
- [ ] All probes pass → state stays `healthy`, no actions taken
- [ ] Kill Redis pod → talon detects within 60s, runs heal script
- [ ] Heal script restores Redis → talon returns to `healthy`
- [ ] Stop Colima → talon detects, runs heal, heal fails → spawns pi agent
- [ ] Pi agent unavailable (mock network down) → falls back to Ollama
- [ ] All recovery fails for 15min → sends iMessage SOS
- [ ] SOS cooldown prevents spam (only 1 per 30min)

**General:**
- [ ] Binary compiles for aarch64-apple-darwin, <5MB
- [ ] State persists across daemon restart
- [ ] `talon validate` parses and validates `~/.config/talon/config.toml` and `~/.joelclaw/talon/services.toml`
- [ ] `talon --check` runs single probe cycle and exits (for manual/CI use)
- [ ] `talon --status` prints current state + worker state + last probe results
- [ ] Editing `~/.joelclaw/talon/services.toml` updates runtime probes without daemon restart (mtime-triggered reload)
- [ ] `SIGHUP` triggers immediate service-probe reload without shutting down talon
- [ ] `GET http://127.0.0.1:9999/health` returns Talon state JSON
- [ ] `talon --worker-only` mode for testing worker supervision without infra probes

## Consequences

### Positive

- **Eliminates the 6-day silence class of bug.** Talon compiles its PATH — no launchd env dependency.
- **No more orphan bun processes.** Proper signal forwarding + pre-start port cleanup.
- **Intelligent escalation.** Novel failures get diagnosed by an agent, not ignored by a bash script.
- **Last resort channels.** Tier 4 fans out to Telegram + iMessage, giving both cloud and local delivery paths.
- **Local model fallback.** Ollama on M4 Pro can run 8B models fast enough for emergency diagnosis.
- **Replaces dumb cron with a state machine.** No more "heal script runs every 3 minutes even when everything is fine."
- **One binary, one plist.** Replaces 3 launchd services (worker, heal timer, future supervisor) with one. Fewer moving parts.
- **Observable.** Structured JSON logs, state file, `--status` flag. Easy to debug talon itself.

### Negative

- Rust binary to maintain (but infrastructure daemons should be compiled, and this replaces 3 bash scripts)
- Ollama adds ~500MB disk + model weight download (~5GB for 8B model)
- Agent spawning is slow (~30s) compared to bash fixes (~5s) — but that's the point of tiering
- Tier 4 now fans out to Telegram + iMessage, but each channel still has its own failure mode (network/API outage for Telegram, local imsg-rpc availability for iMessage)
- Worker + infra in one process means a talon crash takes down both. Mitigated by: Rust stability, launchd KeepAlive, and the binary being simple.

### Non-goals

- Not a general monitoring/alerting system (that's what o11y triage is for)
- Not replacing Inngest health checks (those run inside the cluster)
- Not doing application-level health checks (e.g., "is this Inngest function returning correct results")
- Not managing Colima VM lifecycle (com.joel.colima plist still handles that)

### Follow-up work

- [x] Add Telegram notification as parallel to iMessage SOS (shipped 2026-02-27)
- [x] Expose a tiny HTTP status endpoint (`localhost:9999/health`) for remote monitoring (shipped 2026-02-27)
- [x] Wire Talon health into the gateway watchdog (ADR-0037) as an additional signal (shipped 2026-02-27)
- [x] Supervise the gateway pi session via dynamic launchd probe (`launchd.gateway`) with Talon service-heal restart path (shipped 2026-02-27)
