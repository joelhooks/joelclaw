# Flagg shadow bootstrap runbook

Flagg is the Mac Studio target for ADR-0246: Mac Studio Central runtime migration.

This runbook is for **shadow bootstrap only**. It does not cut over Central, freeze Panda writes, create split-brain, or make Flagg authoritative.

## Current reviewed state

Reviewed: 2026-05-27 by `SleepySprocket`.

Host facts from `ssh joel@100.69.174.22` while Tailscale name propagation settles:

- macOS hostname: `derry.localdomain` during review
- Tailscale DNS name observed from Panda status: `flagg.tail7af24.ts.net.`
- Tailscale short name works inside `tailscale ping flagg`, but `ssh joel@flagg` did not resolve via system DNS from Panda yet
- Tailscale IP: `100.69.174.22`
- macOS: 26.3 / 25D125
- CPU: Apple M4 Max
- RAM: 128 GB
- Disk: about 3.5 TiB free on `/`
- Repo: `~/Code/joelhooks/joelclaw` exists on `main` at `8c12b717` during review

Tooling present:

- Homebrew
- Bun
- Node / fnm
- pnpm
- jq
- ripgrep
- fd
- git
- Tailscale
- `joelclaw` wrapper

Tooling missing:

- `pi`
- `codex`
- `claude`
- Colima
- Docker CLI / Compose

Account state:

- `joel` is the only observed normal local user.
- `joel` is still in the admin group.
- No `joelclaw` service account observed.
- No separate maintenance admin account verified.

Service root state after prep-only pass:

```text
/Users/Shared/joelclaw/
  services/
  src/
  logs/
  backups/
  run/
```

These directories currently exist and are locked to `0700`, owned by `joel` until the dedicated service account exists.

## Prep already applied

### Non-interactive SSH PATH

Flagg SSH sessions originally started with:

```text
/usr/bin:/bin:/usr/sbin:/sbin
```

That made `~/.local/bin/joelclaw` fail with `exec: bun: not found`.

A guarded block was added to `~/.zshenv`:

```sh
# JOELCLAW_DERRY_BOOTSTRAP_PATH: keep non-interactive SSH shells usable for joelclaw tooling.
export PATH="/opt/homebrew/bin:$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
```

A backup was written next to the original file as `~/.zshenv.pre-derry-bootstrap-*.bak` when the file existed.

Verification:

```bash
ssh joel@100.69.174.22 'command -v bun; command -v brew; command -v joelclaw; joelclaw --version'
```

Expected:

```text
/opt/homebrew/bin/bun
/opt/homebrew/bin/brew
/Users/joel/.local/bin/joelclaw
0.2.0
```

### Service root skeleton

Created without sudo:

```bash
ssh joel@100.69.174.22 'for d in /Users/Shared/joelclaw /Users/Shared/joelclaw/services /Users/Shared/joelclaw/src /Users/Shared/joelclaw/logs /Users/Shared/joelclaw/backups /Users/Shared/joelclaw/run; do mkdir -p "$d" && chmod 700 "$d"; done'
```

Tool audit written on Flagg:

```text
/Users/Shared/joelclaw/run/tool-audit-20260527T082953.txt
```

## Next gates

### Gate 1 — account model

Do this before installing critical Central services.

- Verify or create a separate Administrator account for setup and recovery.
- Create a Standard service account, default username `joelclaw`.
- Do not demote `joel` until the separate admin login is verified by Joel.
- Move `/Users/Shared/joelclaw` ownership to the service identity after it exists.
- Keep service-private paths `0700` unless a service specifically needs group access.

Preflight on 2026-05-27:

```text
sudo -n true -> sudo: a password is required
admin users -> root _mbsetupuser joel
normal users -> joel:501
service user -> missing
```

Manual account-gate run on 2026-05-27:

```text
service user exists: joelclaw
service user is not admin: joelclaw
receipt=/Users/Shared/joelclaw/run/account-gate-20260527T160904Z.txt
blocked: no separate non-Joel admin account detected. Do not demote joel.
```

Verified after manual run:

```text
uid=502(joelclaw) gid=20(staff)
/Users/joelclaw -> drwx------ joelclaw:staff
/Users/Shared/joelclaw -> drwx------ joelclaw:staff
```

Separate admin verification on 2026-05-27:

```text
clawadmin -> user is a member of admin
admin users -> root _mbsetupuser joel clawadmin
joelclaw -> user is not a member of admin
```

Final Gate 1 completion on 2026-05-27:

```text
separate non-Joel admin account detected: clawadmin
account gate complete
receipt check verified by Joel
```

Result: Gate 1 is complete. The service account exists, `clawadmin` is the separate admin backstop, and the final account-gate run was verified. Do not demote `joel` yet; treat that as a later hardening step after Flagg is stable and boring.

Repo-managed helper script:

```bash
infra/central/setup-macos-account-gate.sh
```

The helper has also been copied into Flagg's working tree at:

```text
~/Code/joelhooks/joelclaw/infra/central/setup-macos-account-gate.sh
```

Remote dry-run verification passed with the expected blocker: no separate non-Joel admin account detected.

Known first-run behavior on macOS 26.3: `dscl . -create /Users/joelclaw` may print `eDSPermissionError` while still creating the local directory record. The helper is idempotent and now treats that partial-create as recoverable. If you hit that error, pull/reset the latest repo and rerun the same command; it should detect the existing record, create `/Users/joelclaw`, and continue.

What it does when run with sudo on Flagg:

- creates a hidden Standard `joelclaw` service user with no password hash,
- ensures `joelclaw` is not in the admin group,
- owns `/Users/Shared/joelclaw` as `joelclaw:staff`,
- keeps service directories `0700` and files `0600`,
- writes an account-gate receipt under `/Users/Shared/joelclaw/run/`,
- reports whether a separate non-Joel admin account exists,
- exits `2` if no separate non-Joel admin exists so nobody mistakes this for a completed gate.

For future receipt checks, avoid zsh expanding a private `0700` path before `sudo` runs:

```bash
sudo zsh -c 'ls -lt /Users/Shared/joelclaw/run/account-gate-*.txt | head -3'
```

Do not demote `joel` yet. The admin backstop is verified, but demotion is a later hardening step after Flagg is stable and boring.

### Gate 2 — repo-managed runtime assets

Status: scaffolded in `infra/central/` on 2026-05-27.

Contents:

- `compose.yaml` for Redis, Typesense, Inngest, Restate, and MinIO shadow services.
- `.env.example` with placeholders only. Copy to `.env` on Flagg and replace locally; never commit `.env`.
- `scripts/preflight.sh` for account/env/tool checks.
- `scripts/start-colima.sh`, `start.sh`, `stop.sh`, `status.sh`, and `health.sh`.
- `scripts/backup.sh` and `restore.sh` for shadow filesystem snapshot/restore.
- `launchd/*.plist.template` for future system LaunchDaemon install under `UserName=joelclaw`.
- `README.md` with the operator path.

Default service binds are local-only (`127.0.0.1`). Do not expose Flagg services over Tailscale/LAN until cutover planning explicitly says so.

The pillar: Flagg Central must survive a hard reboot with **no GUI login**. If services require Joel, `clawadmin`, Screen Sharing, Terminal, auto-login, the GUI Tailscale app, or a manual `colima start`, they are not Central infrastructure. They are dev toys wearing a fake moustache.

Flagg should use the open-source `tailscaled` system LaunchDaemon (`com.tailscale.tailscaled`) rather than the GUI/login-session Tailscale path. The repo-managed local migration helper is:

```bash
sudo ./infra/central/scripts/install-system-tailscaled.sh
```

Run it locally on Flagg, not over the Tailscale SSH session it is replacing. It may print an auth URL for the new system-daemon node.

Known gotcha from first migration attempt: the normal `tailscale` command can still talk to the stale GUI NetworkExtension. Target the system daemon explicitly when debugging:

```bash
/opt/homebrew/bin/tailscale --socket=/var/run/tailscaled.socket status
/opt/homebrew/bin/tailscale --socket=/var/run/tailscaled.socket up --hostname=flagg --operator=joel --ssh --accept-routes
```

If `verify-system-tailscaled.sh` reports that the GUI network extension is still running, reboot Flagg and verify again before any GUI login. The GUI app has been moved out of `/Applications`, so it should not come back after reboot.

Rollback helper:

```bash
sudo ./infra/central/scripts/rollback-system-tailscaled.sh
```

The real runtime owner is `joelclaw`, not the `joel` dev account. Start/stop scripts are intended for the future service-owned checkout at `/Users/Shared/joelclaw/src/joelclaw` via launchd or a batched admin command. Running them from Joel's dev shell would recreate the Panda coupling ADR-0246 is trying to kill. Bad trade. Don't.

Gate 2 now includes `scripts/reboot-proof.sh`. It is expected to fail until Gate 3 installs system LaunchDaemons, system tailscaled, and the shadow stack. It becomes mandatory before Gate 5.

Next non-sudo check on Flagg after pulling the latest repo:

```bash
cd /Users/joel/Code/joelhooks/joelclaw
./infra/central/scripts/preflight.sh
```

Verified on Flagg after syncing commit `3a1798b6`:

```text
ok   service user exists
ok   service user is not admin
ok   separate non-Joel admin exists
ok   service root owned by service user
warn env file exists
warn colima installed
warn docker installed
```

After adding the system tailscaled gate, expected pre-Gate-3 warnings are `.env`, system tailscaled, Colima, and Docker. After the first local migration attempt, `com.tailscale.tailscaled` existed but the system socket still needed login while the stale GUI NetworkExtension was still answering the default CLI path; patch `584945d5` was followed by a socket-targeting fix so all migration helpers use `/var/run/tailscaled.socket` explicitly.

No hand-edited plist is the source of truth.

### Gate 3 — tool installation

Install only after Gate 1/2 are ready or explicitly waived.

Required for Central shadow:

- system `tailscaled` LaunchDaemon (`com.tailscale.tailscaled`) replacing GUI/login-session Tailscale
- `pi`
- `codex`
- Colima
- Docker CLI / Compose

Optional/dev-only:

- `claude`

All LaunchDaemons must set explicit PATH. Do not rely on `~/.zshenv` for service runtime.

Gate 3 is not complete until system LaunchDaemons are installed in `/Library/LaunchDaemons` and configured to run as `UserName=joelclaw` where practical. User LaunchAgents do not count. GUI Tailscale does not count.

### Gate 4 — shadow runtime

Start Flagg services without touching Panda's active Central writes.

Shadow mode is read/verify only unless a migration step explicitly authorizes a controlled write.

Required checks:

- Redis responds on Flagg-local endpoint.
- Typesense health passes.
- Inngest health passes.
- Restate health passes.
- `system-bus-worker` can start against Flagg services.
- OTEL emit/query works.
- Run capture/search path from ADR-0243 works in a shadow-safe way.
- Hard-reboot/no-login proof passes from Panda before any GUI login on Flagg:

```bash
ssh joel@100.69.174.22 'cd /Users/Shared/joelclaw/src/joelclaw && ./infra/central/scripts/reboot-proof.sh'
```

Expected:

```text
PASS: Central recovered after hard reboot with no GUI login.
```

### Gate 5 — cutover

Cutover needs a separate go/no-go confirmation.

Do not perform it from this runbook.

## Rollback for prep-only changes

Remove PATH block from `~/.zshenv` using the `JOELCLAW_DERRY_BOOTSTRAP_PATH` markers, or restore the backup:

```bash
ssh joel@100.69.174.22 'ls -1t ~/.zshenv.pre-derry-bootstrap-*.bak | head -1'
```

Remove the temporary service root only if it contains no useful audit artifacts:

```bash
ssh joel@100.69.174.22 'rm -rf /Users/Shared/joelclaw'
```

Do not remove it after real service state lands there.

## Related

- `CONTEXT.md`
- `~/Vault/docs/decisions/0246-mac-studio-central-runtime-migration.md`
- `~/.brain/projects/family-claw-migration.svx`
