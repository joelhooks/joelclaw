# Flagg Central runtime scaffold

Repo-managed runtime assets for ADR-0246 Gate 2: Mac Studio Central shadow bootstrap.

This directory does **not** cut over Central. Panda remains authoritative until an explicit whole-Central cutover gate is approved.

## Non-negotiable reboot pillar

Central is not accepted until it survives a hard reboot with **no GUI login** and recovers itself through system `launchd`.

Proof means:

- Tailscale is the open-source `tailscaled` system LaunchDaemon (`com.tailscale.tailscaled`), not the GUI/login item;
- Central services are installed as system LaunchDaemons, not user LaunchAgents;
- LaunchDaemons run as `UserName=joelclaw` where practical;
- no auto-login, no Screen Sharing login, no Terminal session, no manual `colima start`, no manual `docker compose up`;
- after the machine reboots, another machine can SSH in and run `infra/central/scripts/reboot-proof.sh`;
- `reboot-proof.sh` passes, including `console_user=root`, system tailscaled health, launchd labels loaded, post-boot logs, Docker reachability, and service health.

If this proof fails, Flagg is not eligible for cutover. Full stop.

## Shape

```text
/Users/Shared/joelclaw/
  services/
    redis/
    typesense/
    inngest/
    restate/
    minio/
  backups/
    central/
  logs/
    central/
  src/
    joelclaw/          # eventual service-owned checkout for launchd
```

`compose.yaml` models the first shadow runtime:

- Redis `7-alpine`
- Typesense `30.1`
- Inngest self-hosted server
- Restate `1.6.2`
- MinIO S3-compatible object store

All ports bind to `127.0.0.1` by default. Do not expose this over Tailscale/LAN until cutover planning says so.

## Before running

Gate 1 must be complete:

- `joelclaw` Standard service user exists and is not admin
- `/Users/Shared/joelclaw` is owned by `joelclaw:staff`
- `clawadmin` or another non-Joel admin login is verified

Then create a local env file in the checkout that will run the services. During final launchd mode this should be the service-owned checkout:

```text
/Users/Shared/joelclaw/src/joelclaw/infra/central/.env
```

For review/preflight from Joel's dev checkout, generate shadow-only credentials:

```bash
cd /Users/joel/Code/joelhooks/joelclaw
./infra/central/scripts/write-shadow-env.sh
```

Never commit `.env`.

## Preflight

```bash
cd /Users/joel/Code/joelhooks/joelclaw
./infra/central/scripts/preflight.sh
```

This checks the account gate, system tailscaled, local env file, service root, and whether Docker/Colima are available. It does not install anything.

## System tailscaled migration

Flagg Central should not depend on the GUI Tailscale app or a logged-in user session.

Run this **locally on Flagg**, not over SSH:

```bash
cd /Users/joel/Code/joelhooks/joelclaw
sudo ./infra/central/scripts/install-system-tailscaled.sh
```

The script:

- sets the no-sleep server power profile (`sleep=0`, `disksleep=0`, `womp=1`, `tcpkeepalive=1`, `autorestart=1`),
- quits/disables the GUI login-session Tailscale path,
- moves `/Applications/Tailscale.app` into `/Users/Shared/joelclaw/backups/`,
- runs `tailscaled install-system-daemon`,
- runs `tailscale --socket=/var/run/tailscaled.socket up --hostname=flagg --operator=joel --ssh --accept-routes`,
- writes a receipt under `/Users/Shared/joelclaw/run/`.

If it prints an auth URL, open it locally and approve the new node. The old GUI node may remain in the tailnet until removed from the admin console.

Important: the normal `tailscale` command may still talk to a stale GUI NetworkExtension while both variants are present. For this migration, always target the system daemon explicitly:

```bash
/opt/homebrew/bin/tailscale --socket=/var/run/tailscaled.socket status
```

If verification says the GUI network extension is still running, reboot Flagg and verify again before any GUI login. The GUI app was moved out of `/Applications`, so it should not come back after reboot.

Rollback:

```bash
sudo ./infra/central/scripts/rollback-system-tailscaled.sh
```

## Shadow start

The service data root is `0700` and owned by `joelclaw`, so the real start path is service-user execution via launchd. Do not accidentally make Joel's dev account the runtime owner.

Gate 3 install path:

```bash
cd /Users/joel/Code/joelhooks/joelclaw
./infra/central/scripts/install-runtime-tools.sh
./infra/central/scripts/write-shadow-env.sh
sudo ./infra/central/scripts/disable-gui-tailscale-system-extension.sh
sudo ./infra/central/scripts/sync-service-checkout.sh
sudo ./infra/central/scripts/install-launchdaemons.sh --no-bootstrap
./infra/central/scripts/preflight.sh
```

`install-launchdaemons.sh --no-bootstrap` installs the system plists and explicitly disables the labels so a reboot does not start the shadow stack before Gate 4. Use `--bootstrap` in Gate 4 when the shadow runtime start is approved; it enables and starts the labels.

After Gate 3 installs Colima/Docker and mirrors the repo into `/Users/Shared/joelclaw/src/joelclaw`, the service-user commands are:

```bash
cd /Users/Shared/joelclaw/src/joelclaw
./infra/central/scripts/start-colima.sh
./infra/central/scripts/start.sh
./infra/central/scripts/health.sh
```

Stop:

```bash
./infra/central/scripts/stop.sh
```

Those are meant to run as `joelclaw` via LaunchDaemon or a batched admin command, not as Joel's dev shell.

## Launchd templates

Templates live in `infra/central/launchd/` and assume the service-owned checkout path:

```text
/Users/Shared/joelclaw/src/joelclaw
```

They are templates only. Do not install them by hand as the source of truth. Render/install with `scripts/install-launchdaemons.sh`.

The Colima and Compose templates retry on failed exit via `KeepAlive.SuccessfulExit=false`. That matters at boot because Compose can race the container substrate. Success exits cleanly; failures get another shove.

## Hard reboot proof

After Gate 3 installs LaunchDaemons and starts the shadow stack, the acceptance test is:

```bash
# From Panda, before any GUI login on Flagg after reboot:
ssh joel@flagg 'cd /Users/Shared/joelclaw/src/joelclaw && ./infra/central/scripts/reboot-proof.sh'
```

Expected final line:

```text
PASS: Central recovered after hard reboot with no GUI login.
```

If the proof requires logging into Flagg first, it failed. We do not rationalize that away.

## Sudo discipline

Most scripts here are non-privileged. Privileged work should be batched:

1. agent prepares repo-managed scripts/configs,
2. Joel runs one short sudo block,
3. agent verifies remotely,
4. repeat only when needed.

No cursed glitter sudo sprinkles.
