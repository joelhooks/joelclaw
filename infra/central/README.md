# Flagg Central runtime scaffold

Repo-managed runtime assets for ADR-0246 Gate 2: Mac Studio Central shadow bootstrap.

This directory does **not** cut over Central. Panda remains authoritative until an explicit whole-Central cutover gate is approved.

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

For review/preflight from Joel's dev checkout, use:

```bash
cd /Users/joel/Code/joelhooks/joelclaw/infra/central
cp .env.example .env
$EDITOR .env
```

Never commit `.env`.

## Preflight

```bash
cd /Users/joel/Code/joelhooks/joelclaw
./infra/central/scripts/preflight.sh
```

This checks the account gate, local env file, service root, and whether Docker/Colima are available. It does not install anything.

## Shadow start

The service data root is `0700` and owned by `joelclaw`, so the real start path is service-user execution via launchd. Do not accidentally make Joel's dev account the runtime owner.

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

They are templates only. Do not install them by hand as the source of truth. Render/install with a repo-managed script when Gate 3 starts.

## Sudo discipline

Most scripts here are non-privileged. Privileged work should be batched:

1. agent prepares repo-managed scripts/configs,
2. Joel runs one short sudo block,
3. agent verifies remotely,
4. repeat only when needed.

No cursed glitter sudo sprinkles.
