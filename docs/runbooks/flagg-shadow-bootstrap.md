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

Result: the account gate cannot be completed fully from a non-interactive agent session. This is correct. We should not ask for or paste a sudo password into chat.

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

Run manually on Flagg after the script is present there:

```bash
cd ~/Code/joelhooks/joelclaw
sudo ./infra/central/setup-macos-account-gate.sh
```

Do not demote `joel` until a separate admin account exists and Joel has verified login/recovery.

### Gate 2 — repo-managed runtime assets

Create `infra/central/` before installing long-running services.

Minimum contents:

- Compose file or native service definitions for Redis, Typesense, Inngest, Restate, and any object-store surface.
- `.env.example` with no secrets.
- health-check script.
- backup/snapshot script.
- start/stop/status scripts.
- LaunchDaemon plist templates in `infra/launchd/` using `UserName` / `GroupName` where possible.

No hand-edited plist is the source of truth.

### Gate 3 — tool installation

Install only after Gate 1/2 are ready or explicitly waived.

Required for Central shadow:

- `pi`
- `codex`
- Colima
- Docker CLI / Compose

Optional/dev-only:

- `claude`

All LaunchDaemons must set explicit PATH. Do not rely on `~/.zshenv` for service runtime.

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
