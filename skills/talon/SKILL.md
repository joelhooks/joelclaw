# Talon — Infrastructure Watchdog Daemon

Compiled Rust binary that supervises the system-bus worker AND monitors the full k8s infrastructure stack. ADR-0159.

## Quick Reference

```bash
talon validate         # Parse/validate config + services files, print summary JSON
talon --check          # Single probe cycle, print results, exit
talon --status         # Current state machine position
talon --dry-run        # Print loaded config, exit
talon --worker-only    # Supervisor only, no infra probes
talon                  # Full daemon mode (worker + probes + escalation)
```

## Paths

| What | Where |
|------|-------|
| Binary | `~/.local/bin/talon` |
| Source | `~/Code/joelhooks/joelclaw/infra/talon/src/` |
| Config | `~/.config/talon/config.toml` |
| Service monitors | `~/.joelclaw/talon/services.toml` |
| Default config | `~/Code/joelhooks/joelclaw/infra/talon/config.default.toml` |
| Default services template | `~/Code/joelhooks/joelclaw/infra/talon/services.default.toml` |
| State | `~/.local/state/talon/state.json` |
| Probe results | `~/.local/state/talon/last-probe.json` |
| Log | `~/.local/state/talon/talon.log` (JSON lines, 10MB rotation) |
| Launchd plist | `~/Code/joelhooks/joelclaw/infra/launchd/com.joel.talon.plist` |
| Worker stdout | `~/.local/log/system-bus-worker.log` |
| Worker stderr | `~/.local/log/system-bus-worker.err` |
| Talon launchd log | `~/.local/log/talon.err` |

## Build

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd ~/Code/joelhooks/joelclaw/infra/talon
cargo build --release
cp target/release/talon ~/.local/bin/talon
```

## Architecture

```
talon (single binary)
├── Worker Supervisor Thread
│   ├── Kill orphan on port 3111
│   ├── Spawn bun (child process)
│   ├── Signal forwarding (SIGTERM → bun)
│   ├── Health poll every 30s
│   ├── PUT sync after healthy startup
│   └── Crash recovery: exponential backoff 1s→30s
│
├── Infrastructure Probe Loop (main thread, 60s)
│   ├── Colima VM alive?
│   ├── Docker socket responding?
│   ├── Talos container running?
│   ├── k8s API reachable?
│   ├── Node Ready + schedulable?
│   ├── Flannel daemonset ready?
│   ├── Redis PONG?
│   ├── Inngest /health 200?
│   ├── Typesense /health ok?
│   └── Worker /api/inngest 200?
│
└── Escalation (on failure)
    ├── Tier 1: k8s-reboot-heal.sh (90s timeout)
    ├── Tier 2: pi agent (cloud model, 10min cooldown)
    ├── Tier 3: pi agent (Ollama local, network-down fallback)
    └── Tier 4: Telegram + iMessage SOS fan-out (15min critical threshold)
```

## State Machine

```
healthy → degraded (1 critical probe failure)
degraded → failed (3 consecutive failures)
failed → investigating (agent spawned)
investigating → healthy (probes pass again)
investigating → critical (agent failed to fix)
critical → sos (SOS sent via Telegram + iMessage)
any → healthy (all probes pass)
```

## Probes

| Probe | Command | Critical? |
|-------|---------|-----------|
| colima | `colima status` | Yes |
| docker | `docker ps` (Colima socket) | Yes |
| talos_container | `docker inspect joelclaw-controlplane-1` | Yes |
| k8s_api | `kubectl get nodes` | Yes |
| node_ready | kubectl jsonpath for Ready condition | Yes |
| node_schedulable | kubectl jsonpath for spec (taints/cordon) | Yes |
| flannel | `kubectl -n kube-system get daemonset kube-flannel -o jsonpath=...` | No |
| redis | `kubectl exec redis-0 -- redis-cli ping` | Yes |
| inngest | `curl localhost:8288/health` | No |
| typesense | `curl localhost:8108/health` | No |
| worker | `curl localhost:3111/api/inngest` | No |

Critical probes trigger escalation immediately. Non-critical need 3 consecutive failures.

### Dynamic service probes

Add probes in `~/.joelclaw/talon/services.toml` without rebuilding talon:

```toml
[launchd.voice_agent]
label = "com.joel.voice-agent"
critical = true
timeout_secs = 5

[http.voice_agent]
url = "http://127.0.0.1:8081/"
critical = true
timeout_secs = 5
```

- `launchd.<name>` passes when `launchctl list <label>` reports a non-zero PID
- `http.<name>` passes on HTTP `200`
- `critical = true` escalates immediately when the probe fails
- Talon hot-reloads service probes when `services.toml` mtime changes (no restart required)
- `kill -HUP $(launchctl print gui/$(id -u)/com.joel.talon | awk '/pid =/{print $3; exit}')` forces immediate reload

### Health endpoint

- `GET http://127.0.0.1:9999/health` returns Talon state JSON
- Gateway heartbeat consumes this as an additional watchdog signal
- Configure via `[health]` in `~/.config/talon/config.toml`

### SOS channel config

- Tier 4 sends to both Telegram and iMessage
- Telegram fields in `[escalation]`:
  - `sos_telegram_chat_id`
  - `sos_telegram_secret_name` (defaults to `telegram_bot_token`)
- iMessage recipient remains `sos_recipient`

## Launchd Management

**Talon is active as `com.joel.talon`:**
```bash
launchctl print gui/$(id -u)/com.joel.talon | rg "state =|pid =|program =|last exit code ="
```

**Reload binary/config after deploy:**
```bash
launchctl kickstart -k gui/$(id -u)/com.joel.talon
```

**Legacy services should stay disabled:**
```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.joel.system-bus-worker.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.joel.k8s-reboot-heal.plist
```

## Troubleshooting

```bash
# Validate config + service monitor files
talon validate | python3 -m json.tool

# Check what talon sees right now
talon --check | python3 -m json.tool

# Check state machine
talon --status | python3 -m json.tool

# Check health endpoint payload
curl -sS http://127.0.0.1:9999/health | python3 -m json.tool

# Check talon's own logs
tail -20 ~/.local/state/talon/talon.log | python3 -m json.tool

# Check launchd
launchctl list | grep talon
tail -50 ~/.local/log/talon.err

# Manual probe test
DOCKER_HOST=unix:///Users/joel/.colima/default/docker.sock docker inspect --format '{{.State.Status}}' joelclaw-controlplane-1
kubectl exec -n joelclaw redis-0 -- redis-cli ping
```

## Key Design Decisions

- **Zero external deps** — no tokio, no serde, no reqwest. Pure std. Keeps binary at ~444KB.
- **Compiles its own PATH** — immune to launchd environment brittleness (the class of bug that caused the 6-day outage).
- **Worker is a child process** — not a separate launchd service. Signal forwarding prevents orphans.
- **TOML config parsed by hand** — same pattern as worker-supervisor. No dependency just for config.
- **Probes use Colima docker socket** — not SSH to Talos internal Docker.

## Related

- ADR-0159: Talon proposal
- ADR-0158: Worker supervisor (superseded by talon)
- `infra/k8s-reboot-heal.sh`: Tier 1 heal script
- `infra/worker-supervisor/`: Original standalone worker supervisor (superseded)
- Ollama + qwen3:8b: Tier 3 local fallback model
