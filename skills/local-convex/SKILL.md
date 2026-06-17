---
name: local-convex
displayName: Local Convex
description: "Operate Joel's local self-hosted Convex setup with Central Postgres and NAS-backed MinIO. Use when: 'local convex', 'self-hosted convex', 'Convex S3', 'Convex MinIO', 'three-body MinIO', 'Convex buckets', 'run Convex locally', or any task wiring/debugging the local Convex runtime."
version: 0.1.0
author: joel
tags:
  - joelclaw
  - convex
  - minio
  - postgres
  - asustor
  - local
---

# Local Convex

Operate Joel's local self-hosted Convex setup. This is not generic Convex advice. It is the local joelclaw path: Central Postgres for database state, custom MinIO on `three-body` for S3-compatible object storage, and ASUSTOR MinIO CE only as a temporary smoke-test reference.

## Canonical Sources

Read these before mutating the setup:

- Project note: `/Users/joel/.brain/projects/convex-self-hosting-local.svx`
- Runbook: `/Users/joel/Documents/Codex/2026-06-17/we-re-setting-up-durable-self/outputs/three-body-convex-minio-runbook.md`
- Installer: `/Users/joel/Documents/Codex/2026-06-17/we-re-setting-up-durable-self/outputs/install-three-body-convex-minio.sh`

If those disagree, prefer the brain project note for current truth, then verify live state with non-secret health checks.

## Current Local Topology

- NAS host: `three-body`
- Tailnet IP: `100.67.156.41`
- Prefer the tailnet IP in machine config and smoke tests. Treat `three-body` as a human label, not the Convex S3 endpoint.
- NAS model: `AS6508T`
- ADM: `5.1.3.RI81`
- Database state: Central Postgres, not NAS storage.
- Canonical object storage: custom Docker/Compose MinIO on `three-body`.
- Custom MinIO API: `http://100.67.156.41:39000`
- Custom MinIO console: `http://100.67.156.41:39001`
- Custom MinIO data: `/volume1/joelclaw/s3/minio/data`
- Compose path on NAS: `/volume1/joelclaw/s3/minio-compose/compose.yaml`
- Convex S3 env on NAS: `/volume1/joelclaw/s3/minio-compose/convex-s3.env`
- Redacted Convex S3 env on NAS: `/volume1/joelclaw/s3/minio-compose/convex-s3.redacted.env`

ASUSTOR MinIO CE is not canonical:

- CE API: `http://100.67.156.41:29990`
- CE console: `http://100.67.156.41:29991`
- CE data: `/share/MinIOCE/data`
- CE login verified during setup: `minioadmin / minioadminPassWD9001`
- CE exists only as a temporary smoke-test reference and should be uninstalled after the custom path is proven through Convex.

## Convex Buckets

The custom MinIO instance should have these buckets:

- `joelclaw-local-usw2-convex-exports`
- `joelclaw-local-usw2-convex-snapshot-imports`
- `joelclaw-local-usw2-convex-modules`
- `joelclaw-local-usw2-convex-files`
- `joelclaw-local-usw2-convex-search`

## Convex Env Shape

Use the generated secret values from the NAS env file. Do not print them in chat.

```sh
AWS_REGION=usw2
S3_ENDPOINT_URL=http://100.67.156.41:39000
AWS_S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=<from /volume1/joelclaw/s3/minio-compose/convex-s3.env>
AWS_SECRET_ACCESS_KEY=<from /volume1/joelclaw/s3/minio-compose/convex-s3.env>
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

## MinIO Operations

The installer has already completed successfully. Re-run it only to reconcile the service after intentional edits:

```sh
ssh -t joel@three-body 'sudo sh /volume1/joelclaw/s3/install-three-body-convex-minio.sh'
```

The installer:

- runs `joelclaw-minio` separately from ASUSTOR MinIO CE,
- uses API port `39000` and console port `39001`,
- writes data under `/volume1/joelclaw/s3/minio/data`,
- uses pinned amd64 image digests,
- generates root and Convex-specific credentials on the NAS,
- creates the five Convex buckets,
- writes `/volume1/joelclaw/s3/minio-compose/convex-s3.env`,
- runs an upload/read/delete smoke test through the Convex-specific credentials.

Do not expose MinIO to the public internet. LAN/tailnet only.

## Secret Handling

- Never paste root or Convex MinIO credentials into chat.
- Never commit `.env`, `convex-s3.env`, root credentials, access keys, or secret keys.
- It is okay to read and report the redacted env file.
- If a command must use secrets, prefer running it on `three-body` where the env file already lives.
- If copying env values to another host, use the existing secret-management path for that project, not ad hoc notes.

## Operating Sequence

When asked to wire or debug local Convex:

1. Read the brain project note.
2. Verify custom MinIO health on `39000`.
3. Verify whether Convex env is pointing at custom MinIO by IP, not CE and not the tailnet alias.
4. Confirm Central Postgres is the DB target; do not move Postgres state to NAS.
5. Run a Convex-level export/import or file upload smoke test.
6. Capture any durable change back into the brain project note.
7. Leave MinIO CE alone until the real Convex path is proven; then uninstall CE.

## Gotchas

- The old CE smoke-test buckets do not prove the durable path. Only custom MinIO on `39000` counts.
- The NAS SSH service is sensitive to rapid probes. Parallel SSH commands can cause resets.
- MinIO image availability changed over time; if changing image tags, verify current registry availability and pin a digest.
- Newer MinIO images may require CPU compatibility attention on NAS-class Intel Atom hardware; prefer known-good pinned digests unless intentionally upgrading.
- Do not silently switch to local Flagg SSD object storage for Convex durability. The object storage target is NAS-backed MinIO.
