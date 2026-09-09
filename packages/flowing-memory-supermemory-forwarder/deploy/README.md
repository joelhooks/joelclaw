# Forwarder activation plan

Do not run this from an unreviewed checkout. Keep runtime policy, source credentials, state, logs, and canary review files outside the public repository.

## 1. Build a self-contained release

```sh
pnpm --filter @joelclaw/flowing-memory-supermemory-forwarder test
pnpm --filter @joelclaw/flowing-memory-supermemory-forwarder check-types
pnpm --filter @joelclaw/flowing-memory-supermemory-forwarder build

release="/private/runtime/releases/<git-sha>"
install -d -m 0700 "$release"
pnpm --filter @joelclaw/flowing-memory-supermemory-forwarder deploy --prod "$release"
chmod 0700 "$release/deploy/run-forwarder"
(
  cd "$release"
  find dist node_modules -type f -print0 | sort -z | xargs -0 shasum -a 256
) > "$release/MANIFEST.sha256"
```

`pnpm deploy --prod` copies the built package and its production dependency closure. Prove it does not resolve dependencies from the workspace:

```sh
(
  cd /tmp
  JOELCLAW_MEMORY_RUNTIME_DATABASE_URL='postgres://unused.invalid/example' \
  JOELCLAW_SUPERMEMORY_FORWARDER_POLICY="/private/config/policy.json" \
  JOELCLAW_SUPERMEMORY_FORWARDER_STATE="/private/state/portable-check.db" \
  node "$release/dist/cli.js" status
)
```

Expected result: `ok:true` and an empty local state. Remove the portable-check state afterward.

## 2. Create private runtime config

Copy `policy.example.json` outside the repository, replace every placeholder with locally discovered values, and keep it mode 0600. The destination must have `visibility: private`; `doctor` fails closed otherwise. `allowedScopes` must list reviewed source scopes. `canaryRecordId` must name one reviewed, current, committed source record.

```sh
config_root="/private/config"
state_root="/private/state"
install -d -m 0700 "$config_root" "$state_root"
install -m 0600 deploy/policy.example.json "$config_root/policy.json"
install -m 0600 /dev/null "$config_root/runtime.env"
```

The private environment file contains:

```text
NODE_BINARY=<absolute reviewed Node 24 binary>
FLOWING_MEMORY_FORWARDER_RELEASE_ROOT=<sealed release path>
JOELCLAW_MEMORY_RUNTIME_DATABASE_URL=<leased read-only source URL>
JOELCLAW_SUPERMEMORY_FORWARDER_POLICY=<private policy path>
JOELCLAW_SUPERMEMORY_FORWARDER_STATE=<fresh private state.db path>
JOELCLAW_SUPERMEMORY_FORWARDER_CANARY_REVIEW_PATH=<private mode-0600 review JSON path>
JOELCLAW_OTEL_INGEST_URL=<local OTEL ingest URL>
```

Lease the source credential inside the private wrapper or environment setup. Never place it in the policy, command arguments, manifest, logs, or repository. The runtime database role needs `SELECT` only on `fm_projection_commits`, `fm_memory_records`, and `fm_scope_heads`. It also opens one PostgreSQL `LISTEN` connection on the fixed `flowing_memory_committed` channel.

## 3. Install the commit wake explicitly

The daemon does not create or alter source schema. A migration role must apply the additive trigger separately:

```sh
# Connection fields come from a private PG* environment or service file, not argv.
psql -v ON_ERROR_STOP=1 -f deploy/install-commit-notifications.sql
```

The installer is idempotent. It verifies the expected function and trigger ownership markers, refuses unexpected same-name objects, and fails with an explicit migration-privilege error when it cannot create the objects. It emits a payload-free notification after projection-commit inserts and current scope-head changes. PostgreSQL exposes the notification only after the source transaction commits, so rollback emits nothing.

The trigger skips notification when PostgreSQL reports at least 50% notification-queue usage and catches ordinary `pg_notify` errors so wake delivery remains advisory. A queue-capacity failure discovered by PostgreSQL during transaction commit cannot be caught inside a trigger. The 15-minute durable reconciliation scan remains the lossless authority, so inspect queue usage before installing on a database where listeners routinely hold transactions open.

Rollback the additive objects with the equally guarded script:

```sh
psql -v ON_ERROR_STOP=1 -f deploy/rollback-commit-notifications.sql
```

Neither script belongs in daemon startup. Never pass source credentials in process arguments on a shared machine; the examples assume a private environment or `.pgpass`-style wrapper.

## 4. Record the forward-only baseline and review one exact canary

```sh
export JOELCLAW_SUPERMEMORY_FORWARDER_ENV="$config_root/runtime.env"
export FLOWING_MEMORY_FORWARDER_RELEASE_ROOT="$release"
"$release/deploy/run-forwarder" init-boundary
"$release/deploy/run-forwarder" eligibility
"$release/deploy/run-forwarder" doctor
"$release/deploy/run-forwarder" dry-run
"$release/deploy/run-forwarder" prepare-canary
"$release/deploy/run-forwarder" status
```

- `init-boundary` stores all existing projection commit IDs from one repeatable-read snapshot. Historical records are not queued.
- `eligibility` returns aggregate counts only, including `strictEligible` after applying the same body, privacy, evidence, scope, and content guards used by delivery.
- `doctor` verifies one configured Executor connection, the exact space, and `visibility: private`.
- `prepare-canary` reads only `canaryRecordId`, revalidates current authority and policy, and writes its derived payload to the private review path. It does not queue or send.
- `dry-run` and `prepare-canary` never call `add_memory`.

After the owner approves that exact private review file:

```sh
"$release/deploy/run-forwarder" queue-canary
"$release/deploy/run-forwarder" run-canary
"$release/deploy/run-forwarder" status
```

`queue-canary` reads and queues only the selected record ID, even if its source commit contains siblings. `run-canary` operates only that delivery: it performs no normal discovery and verifies private destination visibility again before sending. Run `run-canary` again after indexing to reconcile the exact marker; it never resubmits an accepted save. A save first becomes `accepted`; it becomes `delivered` only when exact source-marker search finds it. Verify one save, one document ID, one later memory ID, and no sibling deliveries.

## 5. Install but do not load the service

Render the LaunchAgent template by replacing `__RELEASE_ROOT__`, `__ENV_FILE__`, and `__LOG_ROOT__`, then validate it:

```sh
plutil -lint "/private/launch-agents/com.example.flowing-memory-supermemory-forwarder.plist"
```

Load it only after the exact canary succeeds, the commit-wake SQL is installed and verified, and the owner authorizes activation:

```sh
launchctl bootstrap "gui/$(id -u)" "/private/launch-agents/com.example.flowing-memory-supermemory-forwarder.plist"
launchctl print "gui/$(id -u)/com.example.flowing-memory-supermemory-forwarder"
"$release/deploy/run-forwarder" status
```

Run only this transport daemon. It establishes `LISTEN` before startup and reconnect catch-up scans, coalesces notification bursts, and serializes every pass. While idle it performs one recovery scan every `recoveryScanIntervalMs` (15 minutes by default), not every 30 seconds. `pollIntervalMs` is now the short reconciliation cadence used only while accepted or indeterminate delivery work remains. Do not start another semantic collector, projection worker, acceptance worker, or listener daemon.

`SIGINT` and `SIGTERM` cancel timers and close the listener immediately. An already-running pass is allowed to settle before the query pool and local state close, preventing an overlapping or half-closed pass.

## Rollback

```sh
launchctl bootout "gui/$(id -u)/com.example.flowing-memory-supermemory-forwarder"
```

Keep the SQLite state and sealed release for reconciliation. The daemon never blindly resubmits `accepted` or `indeterminate` saves. If rolling back the source wake too, run `rollback-commit-notifications.sql` only after the daemon is stopped. Provider-side forgetting remains a separate explicitly authorized operation.
