---
name: executor
displayName: Executor
description: "Operate Rhys Sullivan's Executor under Joel's Central launchd service. Use when Joel mentions executor, executor daemon, task executor, Central Executor, <shared-root>/data/executor, port <executor-app-port>, port <executor-dashboard-port>, dashboard access, or executor database options."
version: 0.1.0
author: joel
tags:
  - joelclaw
  - executor
  - central
  - launchd
  - sqlite
  - libsql
  - services
disable-model-invocation: true
---

# Executor

For private addresses, accounts, ports, and host roles, see `.brain/resources/operator-network-context.svx` in the private dark-wizard repo and the `tailnet-topology` skill. Replace angle-bracket placeholders with the configured values before running commands.

Operate Rhys Sullivan's Executor as a pinned Central service on central host. This is not generic Executor advice. The local target is the repo-owned LaunchDaemon in `joelclaw-central`, running as the existing `joelclaw` service account with explicit state and log directories.

Use `system-architecture` too when the task changes Central topology, service ownership, gateway exposure, or central host vs NAS placement. Use `<nas>` only when Joel explicitly asks about NAS placement or storage.

## When To Use

Use this skill when Joel mentions:

- Executor
- `rhyssullivan/executor`
- `executor daemon`
- Central Executor
- task execution service
- port `<executor-app-port>`
- `/Users/Shared/joelclaw/data/executor`
- Executor database, storage, state, logs, or launchd wiring

## Current Central Contract

Host:

- Run Executor on central host, not `<nas>`.
- Keep it a native macOS launchd service, not a Docker container and not an Executor-installed background service.
- Supervise it with the repo-owned system LaunchDaemon.

Service shape:

- LaunchDaemon label: `com.joelclaw.central.executor`
- Easy dashboard LaunchDaemon label: `com.joelclaw.central.executor-dashboard`
- Service user: `joelclaw`
- Raw daemon bind: `0.0.0.0:<executor-app-port>`
- Easy dashboard bind: `0.0.0.0:<executor-dashboard-port>`
- Primary easy dashboard URL: `http://<tailnet-host>:<service-port>/`
- Optional root easy dashboard URL: `http://<tailnet-host>:<service-port>/`
- Local URL: `http://127.0.0.1:<executor-app-port>/`
- LAN URL: `http://<private-ip>:<service-port>/`
- Tailnet app-node URL: `http://<tailnet-ip>:<service-port>/`
- Tailnet MagicDNS URL: `http://<tailnet-host>:<service-port>/`
- Optional root Tailscale node URL: `http://<tailnet-ip>:<service-port>/` / `http://<tailnet-host>:<service-port>/`
- Pinned package version at time of service creation: `executor@1.5.12`
- Wrapper: `/Users/Shared/joelclaw/bin/central-executor`
- Installed package prefix: `/Users/Shared/joelclaw/opt/executor/1.5.12`
- State: `/Users/Shared/joelclaw/data/executor`
- Config/scope: `/Users/Shared/joelclaw/etc/executor`
- Logs: `/Users/Shared/joelclaw/logs/executor`
- Easy dashboard logs: `/Users/Shared/joelclaw/logs/executor-dashboard`

Central source files:

```sh
/Users/joel/Code/joelhooks/joelclaw-central/infra/launchd/bin/central-executor
/Users/joel/Code/joelhooks/joelclaw-central/infra/launchd/bin/central-executor-dashboard
/Users/joel/Code/joelhooks/joelclaw-central/infra/launchd/com.joelclaw.central.executor.plist
/Users/joel/Code/joelhooks/joelclaw-central/infra/launchd/com.joelclaw.central.executor-dashboard.plist
/Users/joel/Code/joelhooks/joelclaw-central/infra/config/executor/executor.jsonc
/Users/joel/Code/joelhooks/joelclaw-central/scripts/executor-dashboard-proxy.mjs
/Users/joel/Code/joelhooks/joelclaw-central/scripts/install-executor-launchdaemon.sh
/Users/joel/Code/joelhooks/joelclaw-central/scripts/apply-executor-slice.sh
/Users/joel/Code/joelhooks/joelclaw-central/scripts/open-executor-dashboard.sh
/Users/joel/Code/joelhooks/joelclaw-central/scripts/verify-executor-runtime.sh
```

## Database And State

Executor has multiple database shapes depending on deployment mode:

- Local CLI daemon: libSQL/SQLite under `EXECUTOR_DATA_DIR`, normally `data.db` plus WAL/SHM files.
- Self-host container: libSQL/SQLite, with `EXECUTOR_DATA_DIR` and optional `EXECUTOR_DB_PATH`.
- Cloudflare host: D1, with optional R2 blob storage.
- Hosted Executor cloud app: Postgres via `DATABASE_URL` / Hyperdrive.

For Central, use the local CLI daemon shape:

```sh
EXECUTOR_DATA_DIR=/Users/Shared/joelclaw/data/executor
```

Expected state files after a successful start:

```sh
/Users/Shared/joelclaw/data/executor/data.db
/Users/Shared/joelclaw/data/executor/data.db-wal
/Users/Shared/joelclaw/data/executor/data.db-shm
/Users/Shared/joelclaw/data/executor/server-control/auth.json
```

Do not move Central Executor to Central Postgres unless Executor exposes and documents a supported local Postgres backend. The hosted app using Postgres is not proof that the local CLI daemon should.

Do not put Executor state on `<nas>` or a NAS mount. NAS storage can disappear, block boot, or add latency. Executor belongs on local central host disk with explicit backups later.

## LAN And Tailnet Exposure

Executor is intentionally available to joelclaw machines over LAN and tailnet. The daemon binds `0.0.0.0:<executor-app-port>`; do not "repair" it back to localhost unless Joel explicitly reverses the service-access decision.

For humans, prefer the easy dashboard proxy on `<executor-dashboard-port>`. It runs as `joelclaw`, reads the local bearer token server-side, injects `Authorization: Bearer ...` only on upstream requests to `127.0.0.1:<executor-app-port>`, and allows only loopback, central host LAN `<private-cidr>`, Tailscale IPv4 `<tailnet-ip>`, and Tailscale IPv6 `fd7a:115c:a1e0::/48`.

Easy dashboard URLs:

```sh
http://127.0.0.1:<executor-dashboard-port>/
http://<private-ip>:<service-port>/
http://<tailnet-ip>:<service-port>/
http://<tailnet-host>:<service-port>/
http://<tailnet-ip>:<service-port>/
http://<tailnet-host>:<service-port>/
```

The bearer token is still the gate for `/api`, `/mcp`, MCP approval/OAuth await paths, and agent access. Executor mints/loads it from:

```sh
/Users/Shared/joelclaw/data/executor/server-control/auth.json
```

Never print that file or put the token in plists, process args, docs, chat, or shell history. For agent configuration, use a redacted instruction or have the operator read the token locally.

Raw daemon URLs:

```sh
http://127.0.0.1:<executor-app-port>/
http://<private-ip>:<service-port>/
http://<tailnet-ip>:<service-port>/
http://<tailnet-host>:<service-port>/
http://<tailnet-ip>:<service-port>/
http://<tailnet-host>:<service-port>/
```

Resolve current dashboard endpoints from the installed Executor configuration and verified network identity. Verify the exact URL returns the expected page before sharing it. Historical IPs and hostnames above are diagnostic history, not routing defaults.

Do not use Tailscale Serve for Executor without preserving the existing Serve config for `/`, `/notes`, Vite asset paths, and the Convex TCP forwards. Direct ports `<executor-app-port>` and `<executor-dashboard-port>` are the current contract.

## Install And Apply

Run from the Central repo:

```sh
cd /Users/joel/Code/joelhooks/joelclaw-central
scripts/install-executor-launchdaemon.sh --dry-run
scripts/check-contract.sh
scripts/check-contract.sh --runtime
pnpm run brain:check
```

Apply requires root because it installs a system LaunchDaemon:

```sh
cd /Users/joel/Code/joelhooks/joelclaw-central
sudo scripts/apply-executor-slice.sh
```

For Joel-friendly dashboard access on central host, use:

```sh
cd /Users/joel/Code/joelhooks/joelclaw-central
scripts/open-executor-dashboard.sh
```

That helper installs the dashboard LaunchDaemon with `sudo` if needed, checks `http://<tailnet-host>:<service-port>/`, then opens it.

If the shell does not have passwordless sudo, do not fake success. Report the actual file and dry-run results, including failures or checks not run, then identify the exact privileged step that remains.

Do not run:

```sh
executor service install
```

The service belongs to the Central repo. Executor's own service installer bypasses the Central boot contract and can hide state/log paths.

## Health Checks

After apply:

```sh
launchctl print system/com.joelclaw.central.executor
launchctl print system/com.joelclaw.central.executor-dashboard
curl -fsS -m 5 http://127.0.0.1:<executor-app-port>/ >/dev/null
curl -fsS -m 5 http://127.0.0.1:<executor-dashboard-port>/ >/dev/null
curl --noproxy '*' -fsS -m 5 http://<private-ip>:<service-port>/ >/dev/null
curl --noproxy '*' -fsS -m 5 http://<private-ip>:<service-port>/ >/dev/null
curl --noproxy '*' -fsS -m 5 http://<tailnet-ip>:<service-port>/ >/dev/null
curl --noproxy '*' -fsS -m 5 http://<tailnet-ip>:<service-port>/ >/dev/null
curl --noproxy '*' -fsS -m 5 http://<tailnet-host>:<service-port>/ >/dev/null
curl --noproxy '*' -fsS -m 5 http://<tailnet-host>:<service-port>/ >/dev/null
scripts/verify-executor-runtime.sh
```

Useful narrow checks:

```sh
pgrep -fl "executor.*daemon run"
lsof -nP -iTCP:<executor-app-port> -sTCP:LISTEN
lsof -nP -iTCP:<executor-dashboard-port> -sTCP:LISTEN
test -f /Users/Shared/joelclaw/data/executor/data.db
test -f /Users/Shared/joelclaw/data/executor/server-control/auth.json
tail -n 120 /Users/Shared/joelclaw/logs/executor/launchd.err.log
tail -n 120 /Users/Shared/joelclaw/logs/executor/launchd.out.log
tail -n 120 /Users/Shared/joelclaw/logs/executor-dashboard/launchd.err.log
tail -n 120 /Users/Shared/joelclaw/logs/executor-dashboard/launchd.out.log
```

Version check:

```sh
/Users/Shared/joelclaw/opt/executor/1.5.12/bin/executor --version
```

Status check:

```sh
EXECUTOR_DATA_DIR=/Users/Shared/joelclaw/data/executor \
  /Users/Shared/joelclaw/opt/executor/1.5.12/bin/executor daemon status
```

## Safety Rules

- Keep Executor available only on Joel-controlled LAN/tailnet paths. Do not expose it publicly without a separate auth/gateway decision.
- Do not pass bearer tokens or auth secrets in process args. Process args are visible through `ps`.
- Do not print, paste, or URL-encode the dashboard bearer token. Use the `<executor-dashboard-port>` proxy for browser access instead.
- Do not print `server-control/auth.json`.
- Do not delete `data.db`, WAL files, or `server-control/` without an explicit backup and recovery plan.
- Do not replace the pinned version casually. Check upstream release notes/source first, then update wrapper, installer, docs, and contract checks together.
- Do not run long log tails without bounds. Use `tail -n`.
- Treat Executor as an execution surface. Be suspicious of public exposure, broad filesystem scopes, and ambient credentials.

## Source Checks

Primary upstream:

- `https://github.com/RhysSullivan/executor`
- `https://github.com/RhysSullivan/executor/blob/main/docs/self-hosting/guide.mdx`

Before changing version or storage assumptions, verify current upstream behavior from source or release docs. Executor changed quickly around June 2026; do not rely on stale package memory.

Local source inspection pattern:

```sh
tmpdir="$(mktemp -d)"
git clone --depth 1 https://github.com/RhysSullivan/executor "$tmpdir/executor"
rg -n "EXECUTOR_DATA_DIR|EXECUTOR_DB_PATH|DATABASE_URL|data.db|libsql|sqlite|D1|Hyperdrive" "$tmpdir/executor"
```

When using web or GitHub sources in an answer, cite the upstream URLs and distinguish source-grounded facts from local Central decisions.
