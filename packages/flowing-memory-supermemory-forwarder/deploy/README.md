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

Lease the source credential inside the private wrapper or environment setup. Never place it in the policy, command arguments, manifest, logs, or repository. The database role needs `SELECT` only on `fm_projection_commits`, `fm_memory_records`, and `fm_scope_heads`.

## 3. Record the forward-only baseline and review one exact canary

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

## 4. Install but do not load the service

Render the LaunchAgent template by replacing `__RELEASE_ROOT__`, `__ENV_FILE__`, and `__LOG_ROOT__`, then validate it:

```sh
plutil -lint "/private/launch-agents/com.example.flowing-memory-supermemory-forwarder.plist"
```

Load it only after the exact canary succeeds and the owner authorizes activation:

```sh
launchctl bootstrap "gui/$(id -u)" "/private/launch-agents/com.example.flowing-memory-supermemory-forwarder.plist"
launchctl print "gui/$(id -u)/com.example.flowing-memory-supermemory-forwarder"
"$release/deploy/run-forwarder" status
```

Run only this transport daemon. Do not start another semantic collector, projection worker, or acceptance worker.

## Rollback

```sh
launchctl bootout "gui/$(id -u)/com.example.flowing-memory-supermemory-forwarder"
```

Keep the SQLite state and sealed release for reconciliation. The daemon never blindly resubmits `accepted` or `indeterminate` saves. Provider-side forgetting remains a separate explicitly authorized operation.
