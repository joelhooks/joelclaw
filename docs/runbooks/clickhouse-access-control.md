# ClickHouse access-control cutover

Status: **prepared, not applied**. This runbook changes the live ClickHouse instance on three-body. Do not run the apply section without Joel present.

## Goal

- Remove wildcard access from `default`.
- Give each workload only the ClickHouse rights it needs.
- Move OTEL writes and reads to separate scoped identities without breaking the pipeline.
- Carry ClickHouse credentials only through a Flagg-local SSH tunnel, never plaintext LAN HTTP.
- Keep ClickHouse bound to the NAS LAN address. Do not expose it through Tailscale Serve/Funnel.
- Preserve a fast rollback to the current config and OTEL outbox behavior.

## Live baseline inspected 2026-07-16

Read-only inspection found:

- Host/container: three-body / `joelclaw-clickhouse-proof`.
- Image/version: `clickhouse/clickhouse-server:24.12-alpine`, server `24.12.6.70`.
- Docker publishes `192.168.1.163:8123` and `192.168.1.163:9000` only.
- The only ClickHouse identity is `default`; it has broad grant-option privileges across all databases.
- Flagg currently reaches `http://192.168.1.163:8123` with no `CLICKHOUSE_USER` or `CLICKHOUSE_PASSWORD`.
- `joelclaw.otel_events` is live as plain `MergeTree`; `joelclaw_private` does not exist yet.
- `joelclaw otel search telegram.delivery --hours 24 --limit 1` works before the cutover.

This runbook does not change the existing OTEL table engine. That is a separate data migration.

## Prepared files

| File | Destination / purpose |
|---|---|
| `infra/clickhouse/three-body/users.d/scoped-users.xml` | Complete `users.d` policy replacing the live `proof-user.xml` |
| `infra/clickhouse/three-body/docker-compose.override.yml` | Adds the local password-hash env file to the existing service |
| `infra/clickhouse/three-body/clickhouse-password-hashes.env.example` | Server-side hash-only secret template |
| `infra/clickhouse/flagg/com.joelclaw.clickhouse-tunnel.plist.template` | Flagg-local `127.0.0.1:18123` SSH tunnel |
| `infra/clickhouse/flagg/system-bus.env.example` | OTEL runtime and journal writer config |
| `infra/clickhouse/flagg/joelclaw.config.toml.example` | OTEL capability reader config |
| `infra/clickhouse/flagg/otel-reader.env.example` | Reader env for direct query commands such as `joelclaw usage` and `video trace` |
| `infra/clickhouse/flagg/message-journal-admin.env.example` | Operator-only migration identity config |
| `infra/clickhouse/flagg/message-journal-reader.env.example` | Operator-only journal reader config |

The XML was boot-tested against ClickHouse `24.12.6.70` in a disposable local container. Allow/deny probes confirmed:

- `default`: `SELECT system.one` only.
- `otel_runtime`: `SELECT`/`INSERT` on the OTEL table plus only the idempotent `CREATE DATABASE`, `CREATE TABLE`, and `ALTER ADD COLUMN` checks executed by `ensureClickHouseOtelSchema()`. `SELECT` is required because the same system-bus process runs the daily usage report.
- `otel_reader`: `SELECT` on `joelclaw.otel_events` and `system.tables`; no `INSERT`.
- `message_journal_migration`: DDL/read/write only inside `joelclaw_private`; no OTEL access.
- `message_journal_writer`: `INSERT` only on the journal table.
- `message_journal_reader`: `SELECT` only on the journal table.

## Stop conditions

Stop and roll back if any of these happen:

- The tunnel is not listening only on `127.0.0.1:18123`.
- ClickHouse fails to restart cleanly or the server error log reports access-config parsing errors.
- `SHOW GRANTS` differs from the prepared policy.
- The system-bus worker can neither write the canary nor durably queue it to the OTEL outbox.
- `joelclaw otel search` cannot read the canary through `otel_reader`.
- A scoped credential works directly against `http://192.168.1.163:8123` from Flagg.
- Any ClickHouse port appears in Tailscale Serve/Funnel state.

## Preparation before the window

### 1. Capture the baseline

On Flagg:

```sh
set -eu
joelclaw otel search telegram.delivery --hours 24 --limit 1
joelclaw otel stats --adapter clickhouse-otel --hours 24
curl -fsS 'http://192.168.1.163:8123/?query=SELECT%20version()%20FORMAT%20TabSeparated'
curl -fsS 'http://192.168.1.163:8123/?query=SELECT%20count()%2C%20max(timestamp)%20FROM%20joelclaw.otel_events%20FORMAT%20TabSeparated'
OTEL_OUTBOX_DIR="${OTEL_OUTBOX_DIR:-$HOME/.joelclaw/spool/otel}"
printf 'otel_outbox_files='; find "$OTEL_OUTBOX_DIR" -maxdepth 1 -type f \
  \( -name '*.json' -o -name '*.processing' \) 2>/dev/null | wc -l | tr -d ' '
ssh -o BatchMode=yes joel@three-body \
  'netstat -tln 2>/dev/null | grep -E "192[.]168[.]1[.]163:(8123|9000)"'
tailscale serve status
```

Save the OTEL count/newest timestamp and spool count in the cutover receipt. Do not print the existing password or environment values.

### 2. Generate six independent passwords

Create secrets outside the repo with `umask 077`. The server receives SHA-256 hashes only; Flagg receives plaintext values for the identities it uses.

Required identities:

```txt
default
message_journal_migration
message_journal_writer
message_journal_reader
otel_runtime
otel_reader
```

Use 48-character values from the env/TOML-safe alphabet `[A-Za-z0-9_-]`. Do not use spaces, quotes, backslashes, `$`, or shell metacharacters. One safe generator is:

```sh
PASSWORD="$(openssl rand -base64 48 | tr '+/' '_-' | tr -d '=\n' | cut -c1-48)"
case "$PASSWORD" in (*[!A-Za-z0-9_-]*|'') echo 'unsafe password encoding' >&2; exit 1;; esac
printf '%s' "$PASSWORD" | shasum -a 256 | awk '{print $1}'
```

Populate a private `clickhouse-password-hashes.env` from the provided example. Every hash must be exactly 64 lowercase hex characters. Populate the Flagg config copies separately. Never copy plaintext credentials to three-body.

### 3. Prepare backups, but do not change services yet

On Flagg:

```sh
cp -p ~/.config/system-bus.env ~/.config/system-bus.env.pre-clickhouse-acl
mkdir -p ~/.joelclaw
if [ -f ~/.joelclaw/config.toml ]; then
  cp -p ~/.joelclaw/config.toml ~/.joelclaw/config.toml.pre-clickhouse-acl
  printf 'present\n' > ~/.joelclaw/config.toml.pre-clickhouse-acl.state
else
  printf 'absent\n' > ~/.joelclaw/config.toml.pre-clickhouse-acl.state
fi
```

On three-body, create one timestamped backup of the whole proof config directory before replacing files. The backup must include `docker-compose.yml`, `users.d/`, and `config.d/`. Do not touch `/volume2/data/clickhouse-proof/data`.

## Apply sequence

This section is intentionally not automated. One operator performs it in order while Joel watches the receipts.

### 1. Install and prove the SSH tunnel first

Create `~/.joelclaw/logs`, copy the plist template to `~/Library/LaunchAgents/com.joelclaw.clickhouse-tunnel.plist`, bootstrap it, then verify:

```sh
launchctl print gui/$(id -u)/com.joelclaw.clickhouse-tunnel
lsof -nP -iTCP:18123 -sTCP:LISTEN
curl -fsS 'http://127.0.0.1:18123/?query=SELECT%201%20FORMAT%20TabSeparated'
```

Expected listener: `127.0.0.1:18123` only. The remote leg terminates at the NAS LAN endpoint `192.168.1.163:8123`; ClickHouse itself remains off the tailnet.

### 2. Stage server access files on three-body

Copy these three prepared files into `/volume1/home/joel/clickhouse-proof/`:

- `users.d/scoped-users.xml`
- `docker-compose.override.yml`
- populated `clickhouse-password-hashes.env` with mode `0600`

Move the old `users.d/proof-user.xml` out of `users.d/` into the timestamped backup. Do not leave both files active: both define `default`, and mixed authentication fields can prevent ClickHouse from starting.

Inventory every active fragment before restart:

```sh
cd /volume1/home/joel/clickhouse-proof
find users.d -maxdepth 1 -type f -name '*.xml' -print -exec \
  grep -nE '<(default|message_journal_|otel_|profiles)>' {} \;
test "$(find users.d -maxdepth 1 -type f -name '*.xml' | wc -l | tr -d ' ')" = 1
```

The only active XML must be `users.d/scoped-users.xml`. If any other fragment is required, stop and merge it into a complete reviewed policy first.

Validate Compose without rendering the hash environment into a receipt or temp file:

```sh
cd /volume1/home/joel/clickhouse-proof
docker compose config --quiet
```

### 3. Restart ClickHouse once

```sh
cd /volume1/home/joel/clickhouse-proof
docker compose up -d --force-recreate clickhouse-proof
docker compose ps
```

Check server logs immediately. If the service is not healthy, restore the old `users.d` and compose files before doing anything on Flagg.

### 4. Verify the access policy through the tunnel

Use the scoped plaintext credentials from private Flagg files. Do not place passwords on command lines or in receipts.

Required `SHOW GRANTS` results:

```txt
default: GRANT SELECT ON system.one
otel_runtime: CREATE DATABASE ON joelclaw.*; CREATE TABLE, ALTER ADD COLUMN, SELECT, INSERT on joelclaw.otel_events; SELECT on system.tables
otel_reader: SELECT on joelclaw.otel_events and system.tables
message_journal_migration: CREATE DATABASE/TABLE, ALTER TABLE, DROP TABLE, SELECT, INSERT on joelclaw_private.*
message_journal_writer: INSERT on joelclaw_private.message_journal_events
message_journal_reader: SELECT on joelclaw_private.message_journal_events
```

Also prove negative rights: `message_journal_writer` cannot `SELECT`; reader identities cannot `INSERT`; `otel_runtime` cannot access `joelclaw_private`; the migration identity cannot read `joelclaw.otel_events`; and unauthenticated access fails.

From Flagg, a scoped credential must fail against the direct LAN URL and succeed against `http://127.0.0.1:18123`. This proves credentials are not accepted over plaintext LAN transport.

### 5. Run journal migrations with the migration identity

Export the private copy of `message-journal-admin.env.example`, then run:

```sh
set -a
. ~/.config/clickhouse-message-journal-admin.env
set +a
bun -e '
import { Effect } from "effect";
import { runMessageJournalMigrationsFromEnvironment } from "./packages/message-journal/src/migrations.ts";
console.log(await Effect.runPromise(runMessageJournalMigrationsFromEnvironment()));
'
```

Expected: migrations `0001` and `0002` apply, and the migration ledger exists in `joelclaw_private`. Immediately clear the operator-only values:

```sh
unset MESSAGE_JOURNAL_CLICKHOUSE_URL MESSAGE_JOURNAL_DATABASE MESSAGE_JOURNAL_TABLE \
  MESSAGE_JOURNAL_ADMIN_USER MESSAGE_JOURNAL_ADMIN_PASSWORD
```

Do not add the admin credential to `~/.config/system-bus.env`.

### 6. Move OTEL runtime and CLI reader config

Merge the prepared system-bus keys into `~/.config/system-bus.env` and the OTEL reader section into `~/.joelclaw/config.toml`; keep both files mode `0600`.

The split is deliberate:

- system-bus gets `otel_runtime`, scoped to the OTEL table for writes, schema checks, and the daily usage query;
- the OTEL capability config overrides that shared environment with `otel_reader` and cannot write;
- direct query commands that do not use capability TOML yet (`joelclaw usage`, `joelclaw video trace`) must run with a private copy of `otel-reader.env.example` sourced. Verify both during the window so narrowing `default` does not silently break them.

Restart the user LaunchAgent:

```sh
launchctl kickstart -k gui/$(id -u)/com.joel.system-bus-worker
```

### 7. Verify OTEL before and after

Emit a body-free canary through the normal worker path, then read it through the CLI reader:

```sh
joelclaw otel emit clickhouse.access.cutover.canary \
  --source operator \
  --component clickhouse-access \
  --metadata '{"transport":"ssh-tunnel"}'
joelclaw otel search clickhouse.access.cutover.canary --hours 1 --limit 5
joelclaw otel stats --adapter clickhouse-otel --hours 24
set -a; . ~/.config/clickhouse-otel-reader.env; set +a
joelclaw usage --hours 1
# Use a known recent target for the live `joelclaw video trace` read probe.
unset CLICKHOUSE_PASSWORD CLICKHOUSE_USER CLICKHOUSE_QUERY_URL CLICKHOUSE_URL \
  CLICKHOUSE_DATABASE CLICKHOUSE_OTEL_TABLE
```

Verify:

1. The canary is newer than the captured baseline timestamp.
2. The OTEL outbox did not grow, or any temporary queued row drained.
3. `joelclaw otel search telegram.delivery --hours 24 --limit 1` still works.
4. Worker logs contain no `ACCESS_DENIED`, authentication, or ClickHouse schema errors.
5. Direct unauthenticated LAN access now fails.
6. `tailscale serve status` contains no ClickHouse listener or proxy.

### 8. Verify journal writer and reader

After migrations:

- Insert one non-sensitive canary row with `message_journal_writer`.
- Confirm the same row with `message_journal_reader` using `FINAL`.
- Confirm writer `SELECT` fails.
- Confirm reader `INSERT` fails.
- Confirm the migration identity cannot select OTEL rows.

Do not use real Telegram text for this infrastructure canary.

## Rollback

Rollback is configuration-only. Do not touch ClickHouse data directories or drop databases/tables.

1. Restore the timestamped three-body copies of `docker-compose.yml`, `users.d/`, and `config.d/`; remove the new override/hash files from the active compose directory by moving them into the failed-cutover receipt directory.
2. Recreate `clickhouse-proof` with the restored config and verify the old direct endpoint with the pre-cutover credentials.
3. Restore `~/.config/system-bus.env.pre-clickhouse-acl`. Read `~/.joelclaw/config.toml.pre-clickhouse-acl.state`: restore the TOML backup when it says `present`; when it says `absent`, move the cutover-created TOML into the failed-cutover receipt directory so no stale tunnel credential config survives.
4. Restart `com.joel.system-bus-worker`.
5. Run the original `joelclaw otel search` and stats commands.
6. Re-run the exact OTEL `count(), max(timestamp)` query and the `OTEL_OUTBOX_DIR` file-count command from the baseline section. The newest timestamp must advance and the queued-file count must return to its baseline.
7. Stop and boot out `com.joelclaw.clickhouse-tunnel` only after OTEL is healthy. Leaving the loopback-only tunnel running is safe during investigation, but it is not proof of a successful cutover.
8. Preserve the failed config, ClickHouse error log excerpt, worker error excerpt, baseline/post row counts, and exact rollback time. Redact every credential.

If ClickHouse cannot start with the restored config, stop. Do not modify table data, run repair commands, or widen network exposure.

## Success receipt

The live half is complete only when one receipt records:

- three-body config backup path;
- ClickHouse version and container state;
- exact `SHOW GRANTS` output with no secrets;
- allow/deny probe results for all six identities;
- tunnel listener proof (`127.0.0.1:18123` only);
- direct-LAN credential rejection;
- OTEL baseline and post-cutover canary/readback;
- OTEL outbox count before and after;
- journal migration receipt and writer/reader canary;
- Tailscale Serve/Funnel check;
- rollback files and command path.
