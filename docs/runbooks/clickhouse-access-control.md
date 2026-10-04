# ClickHouse access-control cutover

Status: **prepared, not applied**. This runbook changes live credentials and access on three-body and Flagg. Run it only in an approved operator window with Joel present. Repository preparation does not authorize live changes.

## Goal and current baseline

Move Central's OTEL writes to `otel_runtime` and operator reads to `otel_reader`, then remove wildcard access from `default`. Preserve the OTEL outbox and a configuration-only rollback. Do not change table data, engines, or network exposure.

The 2026-10-03 inspection found:

- Flagg uses `com.joelclaw.clickhouse-tunnel` at `http://127.0.0.1:18123` to reach ClickHouse on three-body.
- Central has `CLICKHOUSE_URL`, `CLICKHOUSE_DATABASE`, and `CLICKHOUSE_OTEL_TABLE`, but no user/password; it writes as passwordless `default`.
- The complete `scoped-users.xml` policy has not been applied. Installing it first would cut off the writer.
- ClickHouse has had memory failures and a large queued OTEL backlog. A running tunnel, `/ping`, or `stored:true` is not proof of a successful insert. Resolve store failures before narrowing `default`.

The direct NAS LAN URL is not a Flagg default. Use the tunnel for credential-bearing requests. Keep ClickHouse off Tailscale Serve/Funnel. Verify live paths, container name, active XML fragments, and Compose service before applying; old proof paths are not deployment discovery.

## Prepared files

| File under `infra/clickhouse/` | Purpose |
|---|---|
| `three-body/users.d/otel-users.xml` | Stage 1: add only OTEL users/profiles; leave the existing `default` fragment active |
| `three-body/users.d/restricted-default.xml` | Stage 2: replace the old default fragment after the write/readback gate |
| `three-body/users.d/scoped-users.xml` | Combined final OTEL + journal policy, not the first rollout step |
| `three-body/docker-compose.override.yml` | Supply server-side password hashes |
| `three-body/clickhouse-password-hashes.env.example` | Hash-only template; never commit a populated file |
| `flagg/system-bus.env.example` | OTEL runtime env; journal keys are a separate rollout |
| `flagg/otel-reader.env.example` | Direct queries (`usage`, `video trace`) with reader credentials |
| `flagg/joelclaw.config.toml.example` | OTEL capability reader credentials |
| `flagg/com.joelclaw.clickhouse-tunnel.plist.template` | Loopback SSH tunnel template, not a second tunnel to launch |

`otel_runtime` needs SELECT/INSERT on `joelclaw.otel_events`, CREATE DATABASE on `joelclaw.*`, CREATE TABLE and ALTER ADD COLUMN on the OTEL table, and SELECT on `system.tables`. Central performs schema checks and daily usage reads as well as inserts. `otel_reader` gets SELECT on the OTEL table and `system.tables`, with a read-only profile. `default` ends with SELECT on `system.one` only.

## Ordered rollout and rollback at each step

One operator performs these steps in order. Keep a secret-free receipt with timestamps and outcomes. Never dump env files, plaintext passwords, hashes, or credential-bearing command arguments into logs.

### 1. Capture baseline and backups

Verify the existing tunnel listens only on `127.0.0.1:18123`; do not start a duplicate. Inspect ClickHouse version, active users/config and grants through the current operator connection. Record `count(), max(timestamp)` from `joelclaw.otel_events`, the OTEL outbox count, and recent worker errors. Count a large spool asynchronously rather than blocking the operator.

Back up the actual three-body Compose files, `users.d/`, `config.d/`, and existing hash file to a timestamped private directory. Preserve ownership and mode. Do not touch ClickHouse data directories. On Flagg, back up `~/.config/system-bus.env`, the reader env file if present, and `~/.joelclaw/config.toml`. Record whether each file existed so rollback can remove a newly created config by moving it aside rather than inventing an empty replacement.

**Rollback:** none needed; this step is read-only apart from private backups. If baseline queries fail, stop before applying ACL changes. Recover the store first.

### 2. Generate and store passwords

Generate independent 48-character values from `[A-Za-z0-9_-]` outside the repository with `umask 077`. For example, assign without printing:

```sh
PASSWORD="$(openssl rand -base64 48 | tr '+/' '_-' | tr -d '=\n' | cut -c1-48)"
case "$PASSWORD" in (*[!A-Za-z0-9_-]*|'') echo 'unsafe password encoding' >&2; exit 1;; esac
test "${#PASSWORD}" -eq 48
```

Store the two OTEL plaintext values in agent-secrets under exactly:

- `clickhouse_otel_runtime_password`
- `clickhouse_otel_reader_password`

Use the current agent-secrets CLI help for its secure input/storage interface; do not pass passwords in argv or print lease results. If these names exist, preserve their prior values and consumers before rotating. Generate a separate default password for the later restriction step and keep it in the approved private operator store. Journal passwords are not required for the staged OTEL rollout.

Compute lowercase SHA-256 digests from each value using `printf '%s'` (no newline). Populate a private copy of the hash env example, mode `0600`. The staged policies require `CLICKHOUSE_OTEL_RUNTIME_PASSWORD_SHA256`, `CLICKHOUSE_OTEL_READER_PASSWORD_SHA256`, and, at step 6, `CLICKHOUSE_DEFAULT_PASSWORD_SHA256`. Validate each used hash is exactly 64 lowercase hex characters. Copy only hashes to three-body. Lease plaintext into private Flagg config copies without logging it. Clear temporary shell values after use.

**Rollback:** before any consumer switches, restore previous secret values if rotated; revoke leases and retire only newly created unused credentials. Retain the old credentials until all consumers have passed verification. Never overwrite an existing secret without its recovery copy.

### 3. Install hashes and add users, preserving default

Install the hash env file and Compose override on three-body, keeping the file mode `0600`. Run `docker compose config --quiet` in the verified active Compose directory, not `docker compose config` (which can print hashes).

Add **only** `users.d/otel-users.xml`. Keep the existing live fragment defining `default` unchanged. Do not install `scoped-users.xml` or `restricted-default.xml` yet. Inventory all active fragments for duplicate users/profiles and stop if either OTEL name already exists with a conflicting definition. Recreate the verified ClickHouse service if necessary for Docker to load the new hash environment; inspect access-config errors immediately.

Through the tunnel, prove both OTEL users authenticate and their `SHOW GRANTS` match the prepared policy. Prove `otel_reader` can SELECT but cannot INSERT; prove `otel_runtime` cannot access unrelated databases. Confirm the unchanged default connection still works. Keep credentials in private client config or a protected request file, never URL query parameters or argv. Check the listener and Serve/Funnel state without exposing credentials.

**Rollback:** move the additive OTEL fragment aside and restore the prior Compose/hash files, then recreate the service if necessary. Default has not changed, so Central keeps its old credential path. Preserve failed config and redacted error excerpts. Do not touch tables.

### 4. Switch Central and reader config

Merge only the OTEL keys from `flagg/system-bus.env.example` into `~/.config/system-bus.env`:

```txt
OTEL_STORE=clickhouse
CLICKHOUSE_URL=http://127.0.0.1:18123
CLICKHOUSE_DATABASE=joelclaw
CLICKHOUSE_OTEL_TABLE=otel_events
CLICKHOUSE_USER=otel_runtime
CLICKHOUSE_PASSWORD=<private lease of clickhouse_otel_runtime_password>
```

Keep the file mode `0600`. The placeholder above is explanatory, not a shell command. Reload the owning Central/system-bus service using its verified current supervisor procedure. For an installation owned by `com.joel.system-bus-worker`, the command is `launchctl kickstart -k gui/$(id -u)/com.joel.system-bus-worker`; verify ownership first.

Configure the OTEL capability TOML with `otel_reader`. Populate a private reader env file from `otel-reader.env.example` using `clickhouse_otel_reader_password`. Direct usage queries already forward `CLICKHOUSE_USER` and `CLICKHOUSE_PASSWORD`; they do not read capability TOML. Run them in a subshell sourcing that reader file so the runtime password cannot leak into the operator shell. `CLICKHOUSE_QUERY_URL` takes precedence over `CLICKHOUSE_URL`, then defaults to the tunnel; verify any override deliberately.

**Rollback:** restore the Flagg env/TOML/reader backups (move new files aside when previously absent) and reload the owning service. Leave additive users available while investigating. Default is still unchanged, so the prior writer configuration remains valid.

### 5. Gate on a real write and scoped readback

Emit a body-free canary with a unique action through the normal ingest path, for example `clickhouse.access.cutover.canary.<unique-id>`:

```sh
joelclaw otel emit <unique-canary-action> --source operator \
  --component clickhouse-access --metadata '{"transport":"ssh-tunnel"}'
joelclaw otel search <unique-canary-action> --hours 1 --limit 5
joelclaw otel stats --adapter clickhouse-otel --hours 1
(
  set -a
  . ~/.config/clickhouse-otel-reader.env
  set +a
  joelclaw usage --hours 1
)
```

Confirm the emit reports `clickhouse.written:true`, not just `stored:true` or `queued:true`. Read the exact unique canary row as `otel_reader`, confirm a fresh timestamp, and verify server query evidence identifies the INSERT user as `otel_runtime`. Confirm schema checks and the daily usage query work, with no authentication/access/schema errors. With a historical backlog, record fresh-canary readback and actual drain progress separately; a full-spool baseline need not immediately reach zero. A successful usage aggregate alone is not the canary readback.

**Rollback:** on any failed gate, stop. Restore the step 4 client configs and reload Central; leave default unrestricted. If failure is server-side, also use step 3 rollback. Preserve queued events. Do not proceed on a queued-only canary.

### 6. Only now restrict default

After step 5 passes, move the old fragment defining `default` into the private backup and install `users.d/restricted-default.xml`. Keep `otel-users.xml` active. The default SHA-256 env value must already be loaded into the container. Inventory fragments again: exactly one definition per user/profile, with no legacy wildcard default fragment remaining. Reload/recreate the service as required and inspect startup errors.

Repeat the scoped write/readback canary after restriction. Prove authenticated `default` can SELECT `system.one` but cannot read or insert into `joelclaw.otel_events`. Prove unauthenticated OTEL access fails and reader INSERT still fails. Inspect Central errors and spool drain progress. No ClickHouse port may appear in Serve/Funnel state. A default-config file on disk is not proof that the running server has narrowed grants.

**Rollback:** first move the restricted-default fragment aside and restore the old default fragment. Reload/recreate ClickHouse and verify the prior default rights return. Only then restore client env/TOML and reload Central if needed. Restoring client default credentials while the restricted policy is still active would keep the writer broken. Leave additive OTEL users active until all consumers have reverted; then step 3 can remove them. No database/table changes are part of rollback.

## Separate journal rollout

Do not mix the journal migration into this OTEL access window. The combined `scoped-users.xml` also requires independent credentials for `message_journal_migration`, `message_journal_writer`, and `message_journal_reader`. Before a later consolidation, back up the staged policy, configure all hash env values, migrate `joelclaw_private` with the operator-only migration identity, and verify journal writer/reader allow/deny canaries without real message text. Keep migration credentials out of Central's runtime env.

When replacing the staged policy with the combined policy, move both staged fragments aside atomically with activation of the reviewed combined policy; never load duplicate definitions. Repeat the OTEL canary gates. Roll back to the staged fragments if any journal or OTEL grant/probe fails. Consolidation is not required to finish the OTEL rollout.

## Success receipt

Record backup locations, server version/state, secret names (not values), redacted grants, scoped allow/deny outcomes, the tunnel-only listener, Central's active user, unique canary ID and timestamp before/after default restriction, spool drain evidence, Serve/Funnel check, and each rollback path. The live rollout is complete only when both scoped canaries land and read back and default no longer has OTEL access.
