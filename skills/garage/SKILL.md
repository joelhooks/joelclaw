---
name: garage
displayName: Garage
description: "Operate Joel's Garage S3-compatible object storage on three-body. Use for Garage, Convex Garage, Garage S3, three-body Garage, port 39100, Garage buckets, and MinIO-to-Garage migration."
version: 0.1.0
author: joel
tags:
  - joelclaw
  - garage
  - s3
  - convex
  - three-body
  - asustor
  - docker
  - storage
---

# Garage

Operate Joel's canonical S3-compatible object storage for local self-hosted Convex. This is not generic Garage advice. The canonical path is the Docker/Compose Garage service running on the ASUSTOR NAS `three-body`.

Custom MinIO is now a rollback/reference path. ASUSTOR MinIO CE is only a smoke-test/reference instance.

## When To Use

Use this skill when Joel mentions:

- Garage
- Convex Garage
- Garage S3
- S3-compatible object storage for local Convex
- `three-body` Garage
- port `39100`
- Garage buckets, keys, env wiring, smoke tests, or MinIO-to-Garage migration

If the task is about the full local Convex runtime, also read the `local-convex` skill. If the task is about general ASUSTOR storage, NFS, SMB, RAID, or NAS health, also read the `three-body` skill. If the task is explicitly about MinIO rollback or CE cleanup, also read the `minio` skill.

## Current Topology

Host:

- NAS label: `three-body`
- Tailnet IP: `100.67.156.41`
- Prefer the IP in machine config and smoke tests, not the tailnet alias.
- NAS model: ASUSTOR AS6508T
- ADM: `5.1.3.RI81`

Canonical Garage:

- S3 API: `http://100.67.156.41:39100`
- Data: `/volume1/joelclaw/s3/garage/data`
- Metadata: `/volume1/joelclaw/s3/garage/meta`
- Metadata snapshots: `/volume1/joelclaw/s3/garage/snapshots`
- Compose file: `/volume1/joelclaw/s3/garage-compose/compose.yaml`
- Garage config: `/volume1/joelclaw/s3/garage-compose/garage.toml`
- Convex S3 env: `/volume1/joelclaw/s3/garage-compose/convex-s3.env`
- Redacted env: `/volume1/joelclaw/s3/garage-compose/convex-s3.redacted.env`
- Installer on NAS: `/volume1/joelclaw/s3/install-three-body-convex-garage.sh`
- Local installer copy: `/Users/joel/Documents/Codex/2026-06-17/we-re-setting-up-durable-self/outputs/install-three-body-convex-garage.sh`
- Image: `dxflrs/garage@sha256:dac0c92add4f1a0b41035e94b41036a270ffbe88a37c7ac9c3f19e6dc5bdccf2`

Do not expose Garage publicly. Keep S3 API access LAN/tailnet only.

## Canonical Sources

Read these before mutating the setup:

- Project note: `/Users/joel/.brain/projects/convex-self-hosting-local.svx`
- Local installer: `/Users/joel/Documents/Codex/2026-06-17/we-re-setting-up-durable-self/outputs/install-three-body-convex-garage.sh`
- NAS compose file: `/volume1/joelclaw/s3/garage-compose/compose.yaml`
- NAS redacted env: `/volume1/joelclaw/s3/garage-compose/convex-s3.redacted.env`

If sources disagree, prefer the brain project note, then verify live state with redaction-safe health checks. Do not print raw env files to resolve disagreement.

## Safety And Secret Handling

Never print, paste, summarize, commit, or log:

- Garage RPC secret
- Garage admin token
- Garage metrics token
- Convex Garage access key
- Convex Garage secret key
- raw `convex-s3.env`
- raw `.env`
- full environment dumps
- shell history containing secrets

It is okay to read and report the redacted env file. It is okay to say whether required keys exist. It is not okay to reveal their values.

Before sharing command output, scan it for:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `GARAGE_RPC_SECRET`
- `GARAGE_ADMIN_TOKEN`
- `GARAGE_METRICS_TOKEN`
- `CONVEX_ACCESS_KEY_ID`
- `CONVEX_SECRET_ACCESS_KEY`
- `convex-s3.env`

Redact first, then report.

## NAS Access Rules

Use one SSH session to `three-body` at a time. NAS SSH is sensitive to bursts and can reset handshakes after rapid parallel probes.

Default read-only SSH shape:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=8 joel@three-body 'uptime; pwd'
```

Operational rules:

- Back off after `kex_exchange_identification`, `Not allowed at this time`, or repeated SSH resets.
- Do not run parallel SSH loops against the NAS.
- Docker operations require `sudo` or an ADM/admin path.
- Treat ADM as an appliance environment, not a normal Debian server.
- Inspect first. Summarize risk before changing service state, compose files, buckets, or data paths.

## Health Checks

Prefer network checks that do not require credentials:

```sh
nc -vz -w 5 100.67.156.41 39100
curl -sS -m 5 -o /tmp/garage-root.out -w '%{http_code}\n' http://100.67.156.41:39100/
sed -n '1,3p' /tmp/garage-root.out
```

Garage does not support anonymous S3 access; `403 AccessDenied` from `/` proves the API is reachable.

Redaction-safe env check:

```sh
ssh joel@three-body 'awk -F= "/^(AWS_REGION|S3_ENDPOINT_URL|AWS_S3_FORCE_PATH_STYLE|S3_STORAGE_)/ {print}" /volume1/joelclaw/s3/garage-compose/convex-s3.env'
```

Presence-only secret check:

```sh
ssh joel@three-body 'awk -F= "/^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)=/ {print $1\"=<present>\"}" /volume1/joelclaw/s3/garage-compose/convex-s3.env'
```

Service checks usually need sudo:

```sh
ssh joel@three-body 'sudo docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}" | grep -Ei "garage|39100" || true'
ssh joel@three-body 'cd /volume1/joelclaw/s3/garage-compose && sudo docker compose ps'
```

Do not run logs without a reason. If logs are needed, bound them and redact:

```sh
ssh joel@three-body 'cd /volume1/joelclaw/s3/garage-compose && sudo docker compose logs --tail=120 garage'
```

## Convex Buckets

Garage should have these Convex buckets:

- `joelclaw-local-usw2-convex-exports`
- `joelclaw-local-usw2-convex-snapshot-imports`
- `joelclaw-local-usw2-convex-modules`
- `joelclaw-local-usw2-convex-files`
- `joelclaw-local-usw2-convex-search`

Bucket rules:

- Perform bucket operations against `http://100.67.156.41:39100`.
- Use Convex-specific credentials for Convex bucket checks.
- Do not create extra buckets unless the requesting workload names them.
- Do not delete buckets or objects without explicit authorization and a backup/recovery note.
- Do not infer durability from bucket existence alone. Prove upload, read, and delete with the workload credentials.

## Convex Env Shape

Convex should point at the Garage IP endpoint:

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

Validation rules:

- `S3_ENDPOINT_URL` must be `http://100.67.156.41:39100`.
- `AWS_S3_FORCE_PATH_STYLE` must be true.
- Bucket names must match the custom Convex buckets above.
- Do not use the tailnet alias in durable machine config.
- Do not point Convex at MinIO or ASUSTOR MinIO CE unless the task is an explicit rollback/comparison.

## Operating Sequence

When wiring or debugging Garage for local Convex:

1. Read the brain project note and this skill.
2. Verify Garage reachability on `39100`.
3. Validate the redacted Convex env shape.
4. Confirm local Convex backend runtime env has `S3_ENDPOINT_URL=http://100.67.156.41:39100`.
5. Run the Convex-level smoke:

```sh
cd /Users/joel/Documents/Codex/2026-06-17/we-re-setting-up-durable-self/work/local-convex
./smoke-self-hosted-convex.sh
```

6. Verify the smoke export ZIP contains `custom-garage` and `http://100.67.156.41:39100`.
7. Capture durable discoveries back to the brain project note if facts changed.

## Gotchas

- Garage is not MinIO with a different name; it uses its own key/bucket permission model instead of S3 bucket policies.
- Garage does not support anonymous S3 access; `403 AccessDenied` from `/` is expected.
- The Garage S3 API is `39100`; custom MinIO is `39000`; CE is `29990`.
- A green MinIO or CE check does not prove Garage.
- Docker socket access on ADM may require `sudo`.
- NAS SSH can react badly to rapid probes. Slow down before assuming the service is broken.
- Do not move Convex object storage to a local SSD fallback just to get a smoke test green. The durable target is NAS-backed Garage.
