---
name: local-convex
displayName: Local Convex
description: "Operate Joel's local self-hosted Convex setup with Central Postgres and NAS-backed Garage/S3-compatible object storage. Use when: 'local convex', 'self-hosted convex', 'Convex S3', 'Convex Garage', 'Garage', 'Convex MinIO', 'Convex buckets', 'run Convex locally', or any task wiring/debugging the local Convex runtime."
version: 0.1.0
author: joel
tags:
  - joelclaw
  - convex
  - garage
  - minio
  - postgres
  - asustor
  - local
---

# Local Convex

Operate Joel's local self-hosted Convex setup. This is not generic Convex advice. It is the local joelclaw path: Central Postgres for database state and Garage on `three-body` for S3-compatible object storage. The custom MinIO install is now a rollback/reference path. ASUSTOR MinIO CE is only a temporary smoke-test reference.

## Canonical Sources

Read these before mutating the setup:

- Project note: `/Users/joel/.brain/projects/convex-self-hosting-local.svx`
- Garage installer: `/Users/joel/Documents/Codex/2026-06-17/we-re-setting-up-durable-self/outputs/install-three-body-convex-garage.sh`
- Legacy MinIO runbook: `/Users/joel/Documents/Codex/2026-06-17/we-re-setting-up-durable-self/outputs/three-body-convex-minio-runbook.md`
- Legacy MinIO installer: `/Users/joel/Documents/Codex/2026-06-17/we-re-setting-up-durable-self/outputs/install-three-body-convex-minio.sh`

If those disagree, prefer the brain project note for current truth, then verify live state with non-secret health checks.

## Current Local Topology

- NAS host: `three-body`
- Tailnet IP: `100.67.156.41`
- Prefer the tailnet IP in machine config and smoke tests. Treat `three-body` as a human label, not the Convex S3 endpoint.
- NAS model: `AS6508T`
- ADM: `5.1.3.RI81`
- Database state: Central Postgres, not NAS storage.
- Central Postgres runs as the `joelclaw` service user:
  - binary: `/opt/homebrew/opt/postgresql@17/bin/postgres`
  - data: `/Users/Shared/joelclaw/data/postgres`
  - config: `/Users/Shared/joelclaw/etc/postgres/postgresql.conf`
  - TCP: `127.0.0.1:5432`
  - socket: `/Users/Shared/joelclaw/run/.s.PGSQL.5432`
  - auth: local socket uses peer auth; TCP uses SCRAM password auth.
- Canonical object storage: Garage on `three-body`.
- Garage S3 API: `http://100.67.156.41:39100`
- Garage data: `/volume1/joelclaw/s3/garage/data`
- Garage metadata: `/volume1/joelclaw/s3/garage/meta`
- Garage snapshots: `/volume1/joelclaw/s3/garage/snapshots`
- Garage Compose path on NAS: `/volume1/joelclaw/s3/garage-compose/compose.yaml`
- Garage Convex S3 env on NAS: `/volume1/joelclaw/s3/garage-compose/convex-s3.env`
- Garage redacted Convex S3 env on NAS: `/volume1/joelclaw/s3/garage-compose/convex-s3.redacted.env`

Custom MinIO is a rollback/reference path, not canonical:

- Custom MinIO API: `http://100.67.156.41:39000`
- Custom MinIO console: `http://100.67.156.41:39001`
- Custom MinIO data: `/volume1/joelclaw/s3/minio/data`
- Custom MinIO Compose path on NAS: `/volume1/joelclaw/s3/minio-compose/compose.yaml`
- Custom MinIO Convex S3 env on NAS: `/volume1/joelclaw/s3/minio-compose/convex-s3.env`

ASUSTOR MinIO CE is not canonical:

- CE API: `http://100.67.156.41:29990`
- CE console: `http://100.67.156.41:29991`
- CE data: `/share/MinIOCE/data`
- CE login verified during setup: `minioadmin / minioadminPassWD9001`
- CE exists only as a temporary smoke-test reference and should be uninstalled after the custom path is proven through Convex.

## Convex Buckets

Garage should have these Convex buckets:

- `joelclaw-local-usw2-convex-exports`
- `joelclaw-local-usw2-convex-snapshot-imports`
- `joelclaw-local-usw2-convex-modules`
- `joelclaw-local-usw2-convex-files`
- `joelclaw-local-usw2-convex-search`

## Convex Env Shape

Use the generated secret values from the NAS env file. Do not print them in chat.

```sh
AWS_REGION=usw2
S3_ENDPOINT_URL=http://100.67.156.41:39100
AWS_S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=<from /volume1/joelclaw/s3/garage-compose/convex-s3.env>
AWS_SECRET_ACCESS_KEY=<from /volume1/joelclaw/s3/garage-compose/convex-s3.env>
S3_STORAGE_EXPORTS_BUCKET=joelclaw-local-usw2-convex-exports
S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET=joelclaw-local-usw2-convex-snapshot-imports
S3_STORAGE_MODULES_BUCKET=joelclaw-local-usw2-convex-modules
S3_STORAGE_FILES_BUCKET=joelclaw-local-usw2-convex-files
S3_STORAGE_SEARCH_BUCKET=joelclaw-local-usw2-convex-search
```

## Health Checks

Prefer checks that do not reveal secrets:

```sh
tailscale ping --timeout=5s --c 2 three-body
nc -vz -w 5 100.67.156.41 39100
curl -sS -m 5 -o /tmp/garage-root.out -w '%{http_code}\n' http://100.67.156.41:39100/
```

Garage does not allow anonymous S3 access; a `403 AccessDenied` response from `/` proves the API is reachable.

For MinIO rollback/reference only:

```sh
curl -fsS -m 5 http://100.67.156.41:39000/minio/health/ready
nc -vz -w 5 100.67.156.41 39000
nc -vz -w 5 100.67.156.41 39001
```

For CE reference only:

```sh
curl -fsS -m 5 http://100.67.156.41:29990/minio/health/ready
```

## NAS Access Rules

- Use one SSH session at a time. `three-body` has reset SSH handshakes after bursts of concurrent probes.
- Back off after `kex_exchange_identification` or `Not allowed at this time`; do not hammer SSH.
- `joel@three-body` can inspect system state.
- `joel` is in `administrators`, but Docker socket access is still denied because `/var/run/docker.sock` is `root:root` with mode `660`.
- Docker operations require `sudo` or an ADM/admin path.
- Do not probe `admin@three-body` or `root@three-body` repeatedly; earlier bad auth contributed to lockout symptoms.

## Central Postgres Rules

- Do not start a separate Postgres container for Convex. The target is Central Postgres.
- Do not move Postgres data to NAS.
- Bootstrap/admin work goes through the `joelclaw` service user over the local socket:

```sh
sudo -u joelclaw psql -h /Users/Shared/joelclaw/run -p 5432 -d postgres
```

- Dockerized Convex reaches Central Postgres over TCP at `host.docker.internal:5432`.
- Convex's `POSTGRES_URL` should omit the database name. Convex derives the database name from `INSTANCE_NAME`; `INSTANCE_NAME=joelclaw-convex` maps to database `joelclaw_convex`.
- For local Central Postgres, set `DO_NOT_REQUIRE_SSL=1`.

## Garage Operations

The Garage installer has already completed successfully. Re-run it only to reconcile the service after intentional edits:

```sh
ssh -t joel@three-body 'sudo sh /volume1/joelclaw/s3/install-three-body-convex-garage.sh'
```

The installer:

- runs `joelclaw-garage` separately from custom MinIO and ASUSTOR MinIO CE,
- uses S3 API port `39100`,
- writes data under `/volume1/joelclaw/s3/garage/data`,
- writes metadata under `/volume1/joelclaw/s3/garage/meta`,
- writes metadata snapshots under `/volume1/joelclaw/s3/garage/snapshots`,
- uses a pinned amd64 Garage image digest,
- generates Garage admin/RPC tokens and Convex-specific S3 credentials on the NAS,
- creates the five Convex buckets,
- writes `/volume1/joelclaw/s3/garage-compose/convex-s3.env`,
- mirrors existing objects from custom MinIO into Garage,
- runs an upload/read/delete smoke test through the Convex-specific credentials.

Do not expose Garage to the public internet. LAN/tailnet only.

## Local Convex Runner

The current projectless setup staged a local runner at:

```sh
/Users/joel/Documents/Codex/2026-06-17/we-re-setting-up-durable-self/work/local-convex
```

Important files:

- `prepare-env.sh` imports `/volume1/joelclaw/s3/garage-compose/convex-s3.env` from the NAS and writes a local `.env` without printing secrets.
- `prepare-env.sh` preserves the existing `CONVEX_POSTGRES_PASSWORD` and `INSTANCE_SECRET` when switching S3 endpoints; do not rotate database credentials just to change object storage.
- `bootstrap-postgres.sh` creates/updates the `convex` Postgres role and `joelclaw_convex` database via `sudo -u joelclaw`.
- `compose.yaml` starts `ghcr.io/get-convex/convex-backend` and `ghcr.io/get-convex/convex-dashboard`.
- `generate-admin-env.sh` stores the generated self-hosted admin key in `app-admin.env` without printing it.
- `run.sh` performs the bootstrap, starts the backend/dashboard, and writes the admin env.
- `smoke-self-hosted-convex.sh` deploys `apps/web/convex`, writes/reads/removes a temporary row, exports a snapshot, and verifies the export ZIP.

## Selective Exposure

Convex is intentionally exposed by named interfaces and ports only. Do not change this to a wildcard `0.0.0.0` bind.

Current verified URLs:

```sh
# Local
http://127.0.0.1:3210
http://127.0.0.1:3211
http://127.0.0.1:6791

# LAN on Flagg
http://192.168.1.10:3210
http://192.168.1.10:3211
http://192.168.1.10:6791

# Tailnet on Flagg
http://100.99.76.47:3210
http://100.99.76.47:3211
http://100.99.76.47:6791
```

Implementation:

- Docker Compose keeps the Convex backend and dashboards bound to `127.0.0.1` only.
- LAN exposure is a user launchd TCP forwarder:
  - plist: `/Users/joel/Documents/Codex/2026-06-17/we-re-setting-up-durable-self/work/local-convex/com.joelclaw.local-convex.lan-forwarder.plist`
  - forwarder: `/Users/joel/Documents/Codex/2026-06-17/we-re-setting-up-durable-self/work/local-convex/lan-forwarder.mjs`
  - binds `192.168.1.10:{3210,3211,6791}` and forwards to `127.0.0.1:{3210,3211,6791}`
- Tailnet exposure is Tailscale Serve TCP forwarding:
  - `100.99.76.47:3210 -> 127.0.0.1:3210`
  - `100.99.76.47:3211 -> 127.0.0.1:3211`
  - `100.99.76.47:6791 -> 127.0.0.1:6792`
- The tailnet dashboard uses a second local dashboard container on `127.0.0.1:6792` so its `NEXT_PUBLIC_DEPLOYMENT_URL` points at `http://100.99.76.47:3210`.
- The LAN/local dashboard on `127.0.0.1:6791` is configured with `NEXT_PUBLIC_DEPLOYMENT_URL=http://192.168.1.10:3210`.

Known Docker Desktop gotcha:

- Docker could not bind directly to `192.168.1.10` or `100.99.76.47` on this Mac; attempts failed with `cannot assign requested address`.
- Keep Docker localhost-only and expose selected services through host-level forwarders.

Manage LAN forwarder:

```sh
cd /Users/joel/Documents/Codex/2026-06-17/we-re-setting-up-durable-self/work/local-convex
./start-lan-forwarder.sh
./stop-lan-forwarder.sh
launchctl print gui/$(id -u)/com.joelclaw.local-convex.lan-forwarder
```

Manage tailnet forwards without disturbing unrelated Tailscale Serve config:

```sh
tailscale serve --bg --yes --tcp 3210 127.0.0.1:3210
tailscale serve --bg --yes --tcp 3211 127.0.0.1:3211
tailscale serve --bg --yes --tcp 6791 127.0.0.1:6792
tailscale serve status --json

# Disable only the Convex forwards if needed.
tailscale serve --tcp=3210 off
tailscale serve --tcp=3211 off
tailscale serve --tcp=6791 off
```

Do not run `tailscale serve reset` casually; there may be unrelated Serve routes on this node.

Exposure checks:

```sh
curl -fsS -m 5 http://127.0.0.1:3210/version
curl -fsS -m 5 http://192.168.1.10:3210/version
curl -fsS -m 5 http://100.99.76.47:3210/version

curl -fsSI -m 5 http://127.0.0.1:6791
curl -fsSI -m 5 http://192.168.1.10:6791
curl -fsSI -m 5 http://100.99.76.47:6791

lsof -nP -iTCP:3210 -iTCP:3211 -iTCP:6791 -iTCP:6792 -sTCP:LISTEN
```

The healthy self-hosted backend `/version` response is currently `unknown`.

## Secret Handling

- Never paste Garage admin/RPC tokens, Convex Garage credentials, root MinIO credentials, or Convex MinIO credentials into chat.
- Never commit `.env`, `convex-s3.env`, admin tokens, root credentials, access keys, or secret keys.
- It is okay to read and report the redacted env file.
- If a command must use secrets, prefer running it on `three-body` where the env file already lives.
- If copying env values to another host, use the existing secret-management path for that project, not ad hoc notes.

## Operating Sequence

When asked to wire or debug local Convex:

1. Read the brain project note.
2. Verify Garage S3 API reachability on `39100`.
3. Verify whether Convex env is pointing at Garage by IP, not MinIO CE and not the tailnet alias.
4. Confirm Central Postgres is the DB target; do not move Postgres state to NAS.
5. Run a Convex-level export/import or file upload smoke test.
6. If exposing Convex beyond localhost, keep Docker bound to localhost and use the selective LAN/Tailscale forwarding model above.
7. Capture any durable change back into the brain project note.
8. Leave custom MinIO and MinIO CE alone until the Garage-backed Convex path is proven and Joel explicitly wants cleanup.

## Gotchas

- The old CE smoke-test buckets do not prove the durable path. Only Garage on `39100` counts for the current canonical path.
- Do not expose Convex with `0.0.0.0` just because Docker port binding is convenient. Use selected LAN/tailnet forwards.
- Tailscale Serve has unrelated routes on this node; do not reset the whole Serve config when only changing Convex ports.
- The dashboard bakes in one public deployment URL. Keep separate LAN and tailnet dashboard instances if both access paths need to work cleanly.
- The NAS SSH service is sensitive to rapid probes. Parallel SSH commands can cause resets.
- Garage image availability can change; if changing image tags, verify current registry availability and pin a digest.
- Do not silently switch to local Flagg SSD object storage for Convex durability. The object storage target is NAS-backed Garage.
