# Gap reconciler (separate, opt-in job)

`src/reconcile.mjs` owns gap classification and durable state. Its Node
composition root is `src/reconcile-cli.mjs` (`capture-reconcile`). It belongs
here because the cell verdicts are its source of truth. It does not change
shadow mode, the cell drain, or native outbox replay. Node's built-in SQLite
keeps this scheduled command independent of the serving Bun process.

```sh
node packages/capture-cell/src/reconcile-cli.mjs --help
node --env-file="$CONFIG" packages/capture-cell/src/reconcile-cli.mjs --dry-run
node --env-file="$CONFIG" packages/capture-cell/src/reconcile-cli.mjs --apply --limit 20
pnpm --filter @joelclaw/capture-cell test:reconcile
```

Requires Node >=22.16 (24 recommended) and `psql` on PATH. It does not read
credentials from local auth files. Configure all paths and endpoints explicitly
in a private, mode-0600 environment file:

| Variable                                | Meaning                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `CAPTURE_CELL_DB`                       | Existing cell outbox; always opened read-only                                            |
| `SESSION_INDEX_PATH`                    | Existing index; always opened read-only, including `skipped_runs`                        |
| `CAPTURE_RECONCILE_DB`                  | Separate durable SQLite file next to the cell outbox                                     |
| `INNGEST_POSTGRES_URI`                  | Runtime PostgreSQL URI with explicit host, database and user; prefer a read-only DB role |
| `INNGEST_CAPTURE_FUNCTION_ID`           | Capture function UUID; excludes unrelated function runs                                  |
| `INNGEST_BASE_URL`, `INNGEST_EVENT_KEY` | Event API base URL and runtime key; required for apply                                   |
| `OTEL_EMIT_URL`, `OTEL_EMIT_TOKEN`      | OTEL endpoint and optional token; endpoint required for apply                            |
| `SLOG_SYSTEM_ID`                        | Optional telemetry system label                                                          |
| `CAPTURE_RECONCILE_LOOKBACK_DAYS`       | Bounded event scan horizon, default 2, maximum 365                                       |
| `RECONCILE_WAIT_ALARM_MS`               | Wait alarm ceiling from first seen, default 7200000 (two hours)                          |

The Postgres adapter batches up to 200 run ids per query. It uses `psql -X`,
`ON_ERROR_STOP`, a read-only transaction, a read-only session default, a 10s
statement timeout and a 15s child deadline. The received-at bound is mandatory:
this is a JSON scan, not an indexed lookup by run id. Events outside that
horizon are treated as absent. Review the horizon before reconciling an old
backlog. A PG error or malformed response aborts the pass, never becoming
"no event".

Only `appended` verdicts with both capture arrival and verdict older than ten
minutes qualify. Existing `runs` or `skipped_runs` rows settle the run. Completed
empty outputs (`chunks_indexed: 0`) settle it as empty. Queued/running runs,
unknown finish statuses and completed nonempty outputs wait. Missing events,
events without a capture function run, and failed/cancelled runs can be resent.
Across duplicate events, an empty completion wins, otherwise any live or
completed nonempty run waits. Event data comes from the newest Postgres event,
or the cell payload if no event exists.

Waiting has an alarm ceiling of two hours from the run's first persisted
observation (`created_at`), configurable with `RECONCILE_WAIT_ALARM_MS`.
Crossing the ceiling sets a persistent `wait_alarmed` flag and queues one alarm
through the same durable error/desk path as give-up. It is **alarm-only**: the
run remains waiting, keeps checking the index, and cannot be resent even if PG
history later disappears. A later index row settles it as indexed and clears
the flag. Completed empty output can also settle it. The pass counter
`wait_alarmed` counts newly raised wait alarms, not repeated waiting passes.
The state upgrade adds the flag without replacing existing receipts or their
first-seen timestamps.

Each send verifies the blob's existence, byte count and SHA-256 by streaming
one file descriptor, then rechecks the index. Invalid blobs or payloads stop
that run and alarm without sending. The reconciler never writes source DBs,
blobs or retry outbox receipts, and never prunes its own receipts.

A fenced, two-minute SQLite pass lease protects overlapping processes. A send
reserves its attempt and immutable envelope before POST. Crash recovery and
unknown HTTP outcomes reuse that envelope's `reconcile:<run_id>:<attempt>` id.
Every reservation counts against the three-send ceiling, including crashes.
An acknowledged send waits ten minutes before reconsideration; a 2xx receipt
alone is **not** handled. At most `--limit` POSTs occur per pass (default 20),
including failed POSTs. After three unindexed attempts, the next eligible pass
alarms rather than sending again. A crash before POST can conservatively spend
one reservation. Stable ids rely on the event API's own deduplication window;
they are not a claim of exactly-once function execution.

A 1-minute load over `--load-limit` (default 40) skips the pass and logs it.
Dry-run does not send, emit remote telemetry, claim leases, or persist state.
It still reads Postgres and validates blobs. Use fixture tests, not dry-run,
when no live reads are authorized.

### Schedule, signals and rollback

Use its **own** ten-minute user agent, not the native replay wrapper. The
provided `launchd/com.joelclaw.capture-reconcile.plist.template` is inert. Render
`__NODE__`, `__PACKAGE_DIR__`, `__ENV_FILE__`, `__PATH__` (must include `psql`),
and `__LOG_DIR__` with XML escaping before loading. It has no RunAtLoad, so
bootstrap does not immediately send. Set `CONFIG`, `PACKAGE`, `LOG_DIR`, and
`PLIST` to approved installation paths; validate with `plutil -lint "$PLIST"`,
then the owner can install with:

```sh
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl print "gui/$(id -u)/com.joelclaw.capture-reconcile"
```

Rollback is independent of capture ingress and native replay:

```sh
launchctl bootout "gui/$(id -u)/com.joelclaw.capture-reconcile"
```

Keep the state DB and logs on rollback. Bootout cannot recall already accepted
events. No launch agent is installed by tests or package commands.

Each pass emits `capture.reconcile.found`, `.resent`, `.empty`, `.waiting`,
`.wait_alarmed`, and `.gave_up` with pass counts (`attempted` counts POST reservations;
`resent` counts acknowledged POSTs). Skips and fatal errors emit `.skipped` and
`.failed`. Terminal and wait-ceiling alarms also emit `.gave_up` at error level and a
`notifyAgent capture.reconcile.gave_up ...` log line for the desk. Alarm receipts
remain pending until OTEL flush succeeds. The log line is not a new gateway or
an automatic outward message transport. Normal restarts retain handled rows,
attempt counts and pending alarms; never remove state to clear an alarm.

Tests generate private fixture DBs and blobs, and inject network adapters.
Fixture directories remain under the caller's temporary directory for inspection;
use a caller-owned `TMPDIR` and clean that disposable directory afterwards.
Set `CAPTURE_RECONCILE_TEST_PG_BIN` to a local PostgreSQL binary directory to
also run the optional integration test. It creates its own cluster with a Unix
socket only, exercises COPY decoding and the read-only guard, and stops that
cluster in `finally`. It never uses runtime PG credentials. Without that
variable, the optional PG fixture test is skipped.
