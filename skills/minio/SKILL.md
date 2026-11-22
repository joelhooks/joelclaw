---
name: minio
displayName: MinIO
description: "Operate Joel's MinIO legacy/rollback services and S3-compatible object storage checks. Use for MinIO, ASUSTOR MinIO CE, custom Docker/Compose MinIO, Convex MinIO rollback, and MinIO-vs-Garage questions. For canonical local Convex object storage, use Garage/local-convex."
version: 0.1.0
author: joel
tags:
  - joelclaw
  - minio
  - s3
  - convex
  - NAS
  - asustor
  - docker
  - storage
disable-model-invocation: true
---

# MinIO

For private addresses, accounts, ports, and host roles, see `.brain/resources/operator-network-context.svx` in the private dark-wizard repo and the `tailnet-topology` skill. Replace angle-bracket placeholders with the configured values before running commands.

Operate Joel's MinIO legacy/rollback services. This is not generic MinIO advice. The canonical local Convex object store is now Garage on `<nas>` at `http://<tailnet-ip>:<service-port>`. The custom Docker/Compose MinIO service remains a working rollback/reference path; ASUSTOR MinIO CE is only a smoke-test/reference instance unless Joel explicitly says otherwise.

## When To Use

Use this skill when Joel mentions:

- MinIO
- S3-compatible object storage
- Convex S3 storage
- Convex buckets
- `<nas>` MinIO
- custom MinIO on the NAS
- ASUSTOR MinIO CE
- MinIO rollback
- MinIO vs Garage
- bucket creation, bucket health, object upload/read/delete checks, or S3 env wiring

If the task is about the full local Convex runtime or canonical Convex object storage, also read the `local-convex` skill and prefer Garage unless Joel explicitly asks for MinIO rollback. If the task is about general ASUSTOR storage, NFS, SMB, RAID, or NAS health, also read the `<nas>` skill.

## Current Topology

Host:

- NAS label: `<nas>`
- Tailnet IP: `<tailnet-ip>`
- Prefer the IP in machine config and smoke tests, not the tailnet alias.
- NAS model: ASUSTOR AS6508T
- ADM: `5.1.3.RI81`

Canonical Garage for local Convex:

- S3 API: `http://<tailnet-ip>:<service-port>`
- Data: `<nas-hdd-export>/s3/garage/data`
- Metadata: `<nas-hdd-export>/s3/garage/meta`
- Compose file: `<nas-export>/s3/garage-compose/compose.yaml`
- Convex S3 env: `<nas-hdd-export>/s3/garage-compose/convex-s3.env`
- Redacted env: `<nas-hdd-export>/s3/garage-compose/convex-s3.redacted.env`

Custom MinIO rollback/reference:

- API: `http://<tailnet-ip>:<service-port>`
- Console: `http://<tailnet-ip>:<service-port>`
- Data: `<nas-hdd-export>/s3/minio/data`
- Compose file: `<nas-export>/s3/minio-compose/compose.yaml`
- Convex S3 env: `<nas-hdd-export>/s3/minio-compose/convex-s3.env`
- Redacted env: `<nas-hdd-export>/s3/minio-compose/convex-s3.redacted.env`
- MinIO client helper: use the pinned `MC_IMAGE` from `<nas-hdd-export>/s3/minio-compose/.env`; do not assume `mc` is installed directly on ADM.

ASUSTOR MinIO CE reference instance:

- CE API: `http://<tailnet-ip>:<service-port>`
- CE console: `http://<tailnet-ip>:<service-port>`
- CE data: `/share/MinIOCE/data`
- CE is smoke-test/reference only. It is not the canonical durable object store for joelclaw or Convex.

Do not expose MinIO or Garage publicly. Keep API and console access LAN/tailnet only.

## Canonical Sources

Read these before mutating the setup:

- Project note: `/Users/joel/.brain/projects/convex-self-hosting-local.svx`
- Known custom installer in the current project outputs: `/Users/joel/Documents/Codex/2026-06-17/we-re-setting-up-durable-self/outputs/install-three-body-convex-minio.sh`
- NAS compose file: `<nas-export>/s3/minio-compose/compose.yaml`
- NAS redacted env: `<nas-hdd-export>/s3/minio-compose/convex-s3.redacted.env`

If sources disagree, prefer the brain project note, then verify live state with redaction-safe health checks. Do not print raw env files to resolve disagreement.

## Safety And Secret Handling

Never print, paste, summarize, commit, or log:

- root MinIO credentials
- Convex MinIO credentials
- raw `convex-s3.env`
- access keys
- secret keys
- full environment dumps
- shell history containing secrets

It is okay to read and report the redacted env file. It is okay to say whether required keys exist. It is not okay to reveal their values.

When a command needs secrets, prefer running it on `<nas>` where the env file already lives. If secrets must move to another host, use that project's existing secret-management path. Do not invent an ad hoc note, paste, or scratch file.

For ad hoc MinIO client checks on `<nas>`, prefer the dockerized `minio/mc` pattern from the installer. Do not assume `mc` is installed directly on ADM. Do not leave new credential-bearing aliases in a persistent MinIO client config unless Joel explicitly asks for that.

Before sharing command output, scan it for:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `MINIO_ROOT_USER`
- `MINIO_ROOT_PASSWORD`
- `access_key`
- `secret_key`
- `convex-s3.env`

Redact first, then report.

## NAS Access Rules

Use one SSH session to `<nas>` at a time. NAS SSH is sensitive to bursts and can reset handshakes after rapid parallel probes.

Default read-only SSH shape:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=8 <ssh-user>@<nas> 'uptime; pwd'
```

Operational rules:

- Back off after `kex_exchange_identification`, `Not allowed at this time`, or repeated SSH resets.
- Do not run parallel SSH loops against the NAS.
- `<ssh-user>@<nas>` can inspect system state.
- Docker operations require `sudo` or an ADM/admin path.
- Treat ADM as an appliance environment, not a normal Debian server.
- Inspect first. Summarize risk before changing service state, compose files, buckets, or data paths.

## Health Checks

For canonical local Convex storage, check Garage first:

```sh
nc -vz -w 5 <tailnet-ip> <object-api-port>
curl -sS -m 5 -o /tmp/garage-root.out -w '%{http_code}\n' http://<tailnet-ip>:<service-port>/
```

Garage returns `403 AccessDenied` for unsigned root requests; that still proves the S3 API is reachable.

For custom MinIO rollback/reference, prefer network and HTTP checks that do not require credentials:

```sh
tailscale ping --timeout=5s --c 2 <nas>
nc -vz -w 5 <tailnet-ip> <s3-api-port>
nc -vz -w 5 <tailnet-ip> <object-console-port>
curl -fsS -m 5 http://<tailnet-ip>:<service-port>/minio/health/live
curl -fsS -m 5 http://<tailnet-ip>:<service-port>/minio/health/ready
```

For the CE reference instance only:

```sh
nc -vz -w 5 <tailnet-ip> <reference-s3-port>
nc -vz -w 5 <tailnet-ip> <reference-console-port>
curl -fsS -m 5 http://<tailnet-ip>:<service-port>/minio/health/ready
```

If the API is healthy but the console is unreachable, keep the distinction clear. Convex depends on the API path, not the browser console.

## Service And Docker Checks

Use one SSH session and keep output narrow:

```sh
ssh <ssh-user>@<nas> 'sudo docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}" | grep -Ei "minio|<s3-api-port>|<object-console-port>" || true'
ssh <ssh-user>@<nas> 'cd <nas-hdd-export>/s3/minio-compose && sudo docker compose ps'
ssh <ssh-user>@<nas> 'test -f <nas-export>/s3/minio-compose/compose.yaml && echo compose-present'
ssh <ssh-user>@<nas> 'test -d <nas-hdd-export>/s3/minio/data && echo data-dir-present'
```

Do not run `docker compose logs` without a reason. If logs are needed, bound them and redact:

```sh
ssh <ssh-user>@<nas> 'cd <nas-hdd-export>/s3/minio-compose && sudo docker compose logs --tail=120 minio'
```

Do not re-run the installer casually. Re-run only to reconcile the service after intentional edits or a failed install:

```sh
ssh -t <ssh-user>@<nas> 'sudo sh <nas-export>/s3/install-three-body-convex-minio.sh'
```

## Bucket Operations

Canonical Convex buckets on custom MinIO:

- `joelclaw-local-usw2-convex-exports`
- `joelclaw-local-usw2-convex-snapshot-imports`
- `joelclaw-local-usw2-convex-modules`
- `joelclaw-local-usw2-convex-files`
- `joelclaw-local-usw2-convex-search`

Bucket rules:

- Perform bucket operations against `http://<tailnet-ip>:<service-port>`, not CE on `<reference-s3-port>`.
- Use Convex-specific credentials for Convex bucket checks, not root credentials.
- Do not create extra buckets unless the requesting workload names them.
- Do not delete buckets or objects without explicit authorization and a backup/recovery note.
- Do not infer durability from bucket existence alone. Prove upload, read, and delete with the workload credentials.

When listing buckets, avoid printing credentials. Prefer the dockerized `mc` helper from the installer:

```sh
ssh <ssh-user>@<nas> 'cd <nas-hdd-export>/s3/minio-compose && set -eu; . ./.env; . ./convex-s3.env; docker run --rm --network "container:joelclaw-minio" -e "MC_HOST_convex=http://${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}@127.0.0.1:9000" "${MC_IMAGE}" ls convex'
```

If `mc` output includes only bucket names, it is safe to report. If a command prints env values, stop and redact.

## MinIO Rollback Env Shape

The current canonical Convex endpoint is Garage at `http://<tailnet-ip>:<service-port>`. Only use this MinIO env shape when explicitly rolling Convex back to custom MinIO:

```sh
AWS_REGION=usw2
S3_ENDPOINT_URL=http://<tailnet-ip>:<service-port>
AWS_S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=<from <nas-hdd-export>/s3/minio-compose/convex-s3.env>
AWS_SECRET_ACCESS_KEY=<from <nas-hdd-export>/s3/minio-compose/convex-s3.env>
S3_STORAGE_EXPORTS_BUCKET=joelclaw-local-usw2-convex-exports
S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET=joelclaw-local-usw2-convex-snapshot-imports
S3_STORAGE_MODULES_BUCKET=joelclaw-local-usw2-convex-modules
S3_STORAGE_FILES_BUCKET=joelclaw-local-usw2-convex-files
S3_STORAGE_SEARCH_BUCKET=joelclaw-local-usw2-convex-search
```

Validation rules:

- For MinIO rollback, `S3_ENDPOINT_URL` must be `http://<tailnet-ip>:<service-port>`.
- For current canonical Convex, `S3_ENDPOINT_URL` must be `http://<tailnet-ip>:<service-port>`.
- `AWS_S3_FORCE_PATH_STYLE` must be true.
- Bucket names must match the custom Convex buckets above.
- Do not use the tailnet alias in durable machine config.
- Do not point Convex at ASUSTOR MinIO CE unless the task is an explicit CE comparison.

Redaction-safe env check:

```sh
ssh <ssh-user>@<nas> 'awk -F= "/^(AWS_REGION|S3_ENDPOINT_URL|AWS_S3_FORCE_PATH_STYLE|S3_STORAGE_)/ {print}" <nas-hdd-export>/s3/minio-compose/convex-s3.env'
```

Presence-only secret check:

```sh
ssh <ssh-user>@<nas> 'awk -F= "/^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)=/ {print $1\"=<present>\"}" <nas-hdd-export>/s3/minio-compose/convex-s3.env'
```

## Smoke Tests

Start with unauthenticated readiness:

```sh
curl -fsS -m 5 http://<tailnet-ip>:<service-port>/minio/health/ready
```

Then prove the Convex credentials can write, read, and delete through the custom MinIO endpoint. Run on the NAS so secrets stay local, using the dockerized `mc` helper:

```sh
ssh <ssh-user>@<nas> 'cd <nas-hdd-export>/s3/minio-compose && set -eu; . ./.env; . ./convex-s3.env; tmp="smoke-$(date +%s).txt"; mkdir -p smoke; trap "rm -f \"smoke/$tmp\"" EXIT; printf "minio smoke %s\n" "$(date -u +%FT%TZ)" > "smoke/$tmp"; docker run --rm --network "container:joelclaw-minio" -v "$PWD/smoke:/smoke:rw" -e "MC_HOST_convex=http://${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}@127.0.0.1:9000" "${MC_IMAGE}" cp "/smoke/$tmp" "convex/${S3_STORAGE_FILES_BUCKET}/$tmp" >/dev/null; docker run --rm --network "container:joelclaw-minio" -e "MC_HOST_convex=http://${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}@127.0.0.1:9000" "${MC_IMAGE}" cat "convex/${S3_STORAGE_FILES_BUCKET}/$tmp" >/dev/null; docker run --rm --network "container:joelclaw-minio" -e "MC_HOST_convex=http://${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}@127.0.0.1:9000" "${MC_IMAGE}" rm "convex/${S3_STORAGE_FILES_BUCKET}/$tmp" >/dev/null; echo "custom-minio-convex-smoke-ok"'
```

Report only success/failure, bucket name, endpoint, and any redacted error shape. Never report credentials.

If the smoke test fails:

1. Check readiness on `<s3-api-port>`.
2. Check the compose service state.
3. Check whether the data directory exists and has space.
4. Check the redacted env shape.
5. Check bucket existence.
6. Only then inspect bounded logs.

## CE Cleanup Guidance

ASUSTOR MinIO CE is not the canonical path. Treat it as temporary scaffolding.

Before removing or disabling CE:

- Prove Garage-backed Convex is healthy on `<object-api-port>`.
- Prove the Convex-level smoke test passes against Garage.
- Optionally prove custom MinIO readiness on `<s3-api-port>` if keeping it as the rollback path.
- Confirm no current workload still depends on CE.
- Do not disable custom MinIO until Garage has remained healthy and Joel explicitly accepts losing the immediate MinIO rollback path.
- Confirm Joel wants CE removed or disabled.

Do not delete `/share/MinIOCE/data` unless Joel explicitly asks for data deletion. Prefer ADM/package-level disable or uninstall first, then summarize remaining data paths.

CE checks should stay clearly labeled as reference checks. Do not use CE success to claim the canonical Garage path is healthy.

## Operating Sequence

For MinIO debugging:

1. Read the brain project note and this skill.
2. Use one SSH session at a time.
3. Run public readiness checks against `<tailnet-ip>:<service-port>`.
4. Inspect compose and data path state on `<nas>`.
5. Validate redacted Convex env shape.
6. Run the Convex credential smoke test on the NAS.
7. If changing anything, make the smallest change and verify again.
8. Capture durable discoveries back to the project note if Joel asked for documentation or the fact changed.

## Gotchas

- `<nas>` is a host label; `<tailnet-ip>` is the preferred endpoint value for machine config and smoke tests.
- The custom MinIO API is `<s3-api-port>`; CE is `<reference-s3-port>`.
- A green CE check does not prove the custom MinIO service.
- A green console check does not prove API correctness for Convex.
- Docker socket access on ADM may require `sudo` even when `joel` is an administrator.
- `mc` may only be available as the pinned Docker image, not as an ADM host binary.
- NAS SSH can react badly to rapid probes. Slow down before assuming the service is broken.
- Do not move Convex object storage to a local SSD fallback just to get a smoke test green. The current durable target is NAS-backed Garage.
