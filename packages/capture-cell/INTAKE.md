# Capture intake and pull appender

The intake owns blobs and its own outbox. It never opens the session index.
The appender runs beside the index and is its only new writer. Nothing here
installs a service, redirects a hook, or enables a writer.

## Lifecycle sketch

Statechart sketch (XState-style states/events, implemented with the package's
existing Bun/SQLite adapters rather than adding a second runtime):

```text
intake.receiving --bodyComplete--> intake.validated
intake.validated --blobFsyncAndDirectoryFsync--> intake.published
intake.published --FULLTransactionCommit--> intake.owed [reply 202]
intake.owed --appendCommittedThenAck--> intake.acked
intake.acked --sevenDays--> intake.pruned
receiving/validated/published --failure--> retryable [never reply 202]

appender.idle --tick--> pulling --page--> downloading
 downloading --digestVerified--> appending --indexCommit--> acknowledging
 acknowledging --ack--> idle
 pulling --smokeRow(writer)--> acknowledging --ack--> idle [no blob/index/forward]
 pulling --smokeRow(compareOnly)--> idle [report skip, no ack]
 downloading --compareOnly--> comparing --verdict--> idle [no index write, no ack]
 idle --loadHighAndWalOk--> pulling [3s tick budget, at least one attempted row]
 acknowledging --loadStillHigh--> load-gated --2sYield--> pulling
 normalLoad --high--> loadGated [alarm once, then every 10 min on a tick]
 loadGated --low--> normalLoad [reset entry alarm]
 idle/pulling/downloading --walOver--> backoff [no further append]
 pulling/downloading/appending/acknowledging --failure--> backoff --retry--> pulling
 any --stop--> stopped

owed --operatorTransfer--> legacyPending --legacy202--> acked
legacyPending --failure--> legacyPending [same original IDs and transfer capability]
legacyPending --operatorTransferBack--> owed [invalidate the old capability]
legacyPending --ordinaryAppenderAck--> rejected409
owed --oversizedLegacyInline--> owed [refuse before transfer]
```

A hard process death cannot send an HTTP response. A caller must treat a reset
before 202 as retryable, just like 503. Publication precedes the outbox commit;
a crash may leave an unreferenced blob, never a committed row naming an
unsynced blob. A lost reply after commit is safe to retry.

The wire contract is the hooks' JSON object, including a streamed JSON string
`jsonl`. Both wire and decoded blob size are capped at 2 GiB. Metadata is
bounded separately. No body-sized JSON parse, buffer, string or SQLite column
is used at intake. A non-cursor sender must provide a stable non-empty run ID;
a cursor without an ID gets a deterministic ID. Cursor claims are scoped by
authenticated user, source identity and starting offset. A byte-verified
extension at the same cursor returns `accepted_prefix` with the original
`to_offset`, so a coalesced hook can resend only the new tail. Prefix hashing
streams outside the write transaction. Other changed payloads at an existing
run/cursor return 409, never silent replacement. Acknowledgements include the
original run ID, digest, byte count and accepted cursor offset.

For accepted captures, the optional intake tee fires whenever `CAPTURE_INTAKE_URL` is configured,
regardless of `captureCellMode` (`off`, `both` or `cell`). Its enablement is
independent of the older capture-cell tee and writer mode. Remove the intake
URL to disable that tee; changing captureCellMode alone does not disable it.

An ingest token represents one configured user principal. A distinct pull
token protects owed pages, blob reads and acknowledgements. The authenticated
sender supplies `machine_id` and `agent_runtime` in the payload; neither comes
from a peer IP. Client user IDs and filesystem paths are never trusted. Map
the configured user to the existing route's user before teeing. Direct hook
senders using the shared ingest token must include `machine_id`; the route's
tee already does. The optional identity-token path below instead supplies it
from the authenticated identity.

## Machine-token identities

Set `CAPTURE_INTAKE_IDENTITIES_FILE` to an operator-installed JSON array of
`{token_sha256, machine_id, user_id, revoked_at}` rows. Hashes are 64 hex SHA256
characters; `revoked_at` is null for active identities or a nonnegative integer
for revoked ones. No raw tokens belong in this file. Protect it with mode 0600
and make it readable by the service user. It is not included in release archives.

The file loads at startup. Each ingest checks its file version (mtime, inode,
ctime and size); SIGHUP forces a reload. A valid snapshot atomically replaces
the old one. Missing, malformed, duplicate-hash or oversized files keep the last
good set and emit a sanitized warning, once per failed version or explicit reload.
Cold failure leaves machine-token auth unavailable but **never disables the
configured ingest token**. A valid empty array deliberately clears identities.
The file is bounded to 4 MiB and 10,000 rows to bound auth memory and CPU.
Reduce or refresh an oversized source before use; export never silently emits
a partial authorization set.

Machine tokens are SHA256-hashed and compared with constant-time digest
comparisons against non-revoked identities. That identity stamps both machine
and user, ignoring payload claims. The configured ingest token retains its
existing user principal and payload machine behavior. Identity tokens never
permit pull, blob reads, acknowledgements or ownership transfer. The pull token
is unchanged. Intake never queries Central or Typesense.

On the appender/Central host, export the **existing** local auth cache:

```sh
umask 077
capture-intake identities-export --db "$CENTRAL_CAPTURE_AUTH_DB" > identities.json.next
```

Central's `packages/system-bus/src/serve.ts` selects `RUN_CAPTURE_AUTH_DATABASE`
or defaults to `~/.joelclaw/capture-auth.db`. Set the explicit `--db` path to that
running instance's selected DB. Export is read-only and cannot create a missing
DB. It emits only the four documented fields, including revocations, never raw
tokens. It does not refresh Typesense; ensure Central's cache is current first.
Protect the output with `umask 077`, validate it, then have the operator transfer
and atomically install it at the configured intake path. SIGHUP or the next
ingest picks it up. Use existing machine tokens with only the hook endpoint URL
changed. Export, installation, endpoint changes and service reload are operator
actions, not automatic steps performed by this package.

## Pull contract

All pull endpoints use the distinct pull bearer token, on the intake's own
listener. No callback or outbound access is required.

- `GET /owed?after=<seq>&limit=<1..100>` returns `{items, next_after}`. Each
  item has a stable UUID `id`, monotonically increasing `seq`, original run
  metadata and receipt time. An empty page ends a scan; restart at zero to
  retry unresolved work. Legacy-transferred rows are excluded by default;
  the rollback client uses `include_legacy=1` to retry transferred debt.
- `GET /blob/<id>` streams the decoded JSONL, with its length and SHA256 in
  response headers. A pruned blob returns 410; an unexpectedly missing owed
  blob fails closed with 503.
- `POST /ack` accepts `{id, jsonl_sha256}` for appender-owned work. On
  legacy-owned work it also requires that transfer's `transfer_token`;
  ordinary appender acks return 409. Repeated valid ack keeps the first ack
  time. Transfer-back invalidates the old capability, including late replies.
- `POST /transfer` accepts the same digest-bound ID and returns
  `{ok, transferred, transfer_token?}`. `transferred` comes from the update's
  changes, not a preceding read. Drains forward only when it is true and ack
  using that capability. Retrying a pending transfer returns the same token.
  Owed pages expose a non-secret `transfer_epoch`, not transfer capabilities.
  Drains echo `expected_epoch`; the update compares it again after preflight,
  so an old request cannot reclaim a returned ownership generation (ABA).
  All calls use the pull token.
- The legacy inline limit is **10,000,000 JSON wire bytes**, including metadata
  and string escapes. The drain and intake check that limit before transferring;
  oversized work stays visible to the appender. This packet deliberately
  refuses oversized inline rollback rather than inventing remote claim-check
  paths. A larger configured legacy cap still uses this conservative default.
- `POST /transfer-back` accepts `{id, jsonl_sha256, transfer_token}` and restores
  unacked legacy work to the appender. Stop drains first, inspect
  `capture-intake transfer-back --dry-run --json`, then run it without dry-run.
  The remote command renews only existing legacy capabilities (`legacy_only`
  on `/transfer`), so it can rescue old oversized or missing-blob debt without
  reclaiming a row already returned to the appender. Stale capabilities cannot
  ack or return a subsequent ownership generation. An in-flight legacy POST
  cannot be recalled; original run IDs retain canonical memory dedupe.
- Remote drain and transfer-back run on the appender host, so intake needs no
  outbound access or session index.
- `GET /health` reports `depth`, `oldest_owed_age_ms` (including legacy debt)
  and `blob_disk_free_bytes`. It contains no tokens, paths or peer identities.
- The server prunes at most 100 acknowledged copies per minute after seven
  days. It also sweeps UUID-named `blobs/*.jsonl` with no row and an mtime older
  than one day. The resumable sweep checks at most 1,000 entries and deletes at
  most 100 files per invocation. Referenced files, active publications, symlinks,
  unknown filenames and `.part` files survive. `capture-intake prune` runs both
  batches manually. Inspect restored storage before allowing garbage collection.

## Rollback operator runbook

1. Stop any appender writer before starting rollback. Keep compare-only until
   the approved soak and cutover gates pass.
2. **One drain at a time.** Inspect `drain-to-legacy --dry-run --json`, then
   run or retry the real command serially. Renewing a current legacy transfer
   returns the same token without bumping its epoch; concurrent drains can both
   get `transferred: true` and forward. Legacy run-ID dedupe absorbs duplicate
   writes, but that is not permission to run competing drains.
3. **Stop all drains and confirm they have exited before transfer-back.**
   Never run a drain and transfer-back concurrently. An already in-flight
   legacy POST cannot be recalled and still relies on canonical run-ID dedupe.
4. Inspect `capture-intake transfer-back --dry-run --json`, then run
   `capture-intake transfer-back --json` to abandon the stopped drain's debt.
5. Inspect restored `/owed` discovery and `/health` before restarting a writer.
   Restart only with the existing cutover approval; recovery does not grant it.

## Load pressure and WAL safety

The gates have different harms. An index WAL above `walStopBytes` (the library
option, default 2 GiB) can grow disk debt, so it
remains a hard stop: no pull at tick entry and no append if it grows during
download. The appender checks it again before each row and before index I/O.

Host load1 divided by available CPUs above 0.8 is soft pressure, not proof that
this writer is causing harm. With a safe WAL, high load permits rows until
elapsed time since tick entry reaches `loadBudgetMs` (library option, default
3,000 ms). The budget includes page/health I/O and row work, including failed
attempts. It is checked between rows, never by cancelling an in-flight row:
always attempt at least one, even if setup or that row exceeds the budget.
Three one-second rows fit a default tick; one row taking over three seconds
still completes before yielding. Each tick starts a fresh budget.

The result reports `paused: true, pauseReason: "load"` and the last attempted
row's cursor, not the end of the fetched page. The serial loop reuses its
existing cancellable wait for a fixed two-second yield. Successful trickles do
not accumulate failure backoff; actual delivery errors and hard WAL stops
retain existing backoff. Observed recovery restores normal page throughput;
rising pressure applies the budget measured from that tick's original entry.

`capture.intake.appender.load_gated` is a warning OTEL event on state entry and
on the first tick at least ten minutes after the previous reminder. Metadata
contains normalized `load`, raw `load1`, `cpus` and global intake `depth` sampled
before work. Health is probed only when an alarm is due, with a one-second
request deadline; unavailable/invalid depth is null. Alarm or health failure
cannot stop the trickle. Observing normal load resets the entry/reminder state.
No separate timer, daemon or durable queue owns these reminders.

This guarantees progress under load alone, not that total depth must shrink
when new capture arrival exceeds the trickle rate. The intake retains failed
or unacknowledged rows. Compare-only still does not write or ack. Explicit
legacy recovery adapters retain their existing ungated behavior and do not
pretend to own a local index WAL.

## Appender connection and append timings

The writer reuses the canonical memory package's process-lifetime SQLite
connection per index path. It ports the legacy connection/cache lifecycle:
WAL, foreign keys, unchanged SQLite synchronous policy (FULL in validation),
a default 32 MiB
on-demand SQLite page-cache budget, and a passive checkpoint every 100 commits.
There is no per-append open, schema migration or truncate checkpoint.
`SESSION_INDEX_CACHE_KIB` optionally overrides the cache (1–524288 KiB), read
when opening a handle. Restart to apply a changed budget.

Connection lifecycle sketch: closed → opening/schema → ready; ready commits
return to ready. Non-domain failure rolls back then closes; the next append
reopens. An inode/device replacement poisons the path until explicit process
shutdown/restart, rather than risking writes through an old WAL. Before restart,
recover a matching DB/WAL/SHM snapshot; do not replay an old WAL into a replaced
DB. Clean shutdown
closes cached handles. A domain dedupe conflict rolls back but keeps its healthy
handle. Never replace the DB/WAL/SHM under an active writer.

Blob read, SHA verification and analysis occur once through the canonical
append API, before the immediate write transaction. Run/cursor/overlap checks,
run rows, chunks and FTS remain in that transaction. Incoming analysis counts
remain available even when an existing indexed row wins dedupe; no transcript
body is returned through durable step state.

Writer appends emit `memory.run.session-index.append` through the existing
telemetry adapter, with component `capture-appender` and top-level
integer `duration_ms` (rounded for ClickHouse UInt32). Metadata and structured
logs retain the original floating-point observation duration. Metadata
includes runtime, status, input bytes, inserted text bytes, counts and
`phase_ms`: connection/open/schema, blob read/hash, analysis, begin-lock wait,
dedupe, run insert, chunks/FTS, commit and optional checkpoint. The parent
`connection_ms` includes open/schema on a cold handle; do not add nested stages
twice. Commit timing includes SQLite's synchronous I/O; it is not a separate
kernel fsync measurement. Download and its stream hash precede append duration
and are not included. Compare-only and skipped smoke do not emit successful
append events. Telemetry never owns commit or acknowledgement.

Small chunk counts can conceal large JSONL metadata. Compare latency against
`jsonl_bytes` as well as counts; do not infer cheap parsing from two chunks.

## Covering-index preparation

The overlap predicate is unchanged. `runs_source_cursor_to` indexes
`(source_identity, from_offset, to_offset)`. The range query selects an implicit
rowid using this covering index, then fetches at most one winning run ID. A
normal no-overlap append does not fetch a table row for every candidate. The
exact-cursor predicates also use the new index; returning that cursor's metadata
still needs one table lookup. The older two-column index remains for older
writers. Query-plan tests require the new covering scan.

Only the explicit `index-migrate` command may build the covering index, inside
`BEGIN IMMEDIATE`. SQLite's database-wide writer lock serializes manual creators;
a later creator rechecks `IF NOT EXISTS` under that lock and does not rebuild.
Normal opens check `sqlite_master`. If the covering index is absent they emit
`capture.session_index.cursor_index_missing`, naming `capture-intake index-migrate`,
and continue using the old index. The appender ships the alarm through OTEL;
other canonical callers also get a structured warning. Alarm failure cannot
block append or ack. An already-compatible baseline schema opens without a
schema write transaction, even while another writer holds the write lock.
Older baseline-column/index compatibility DDL is retained when needed; it never
creates the covering index. Normal warm appends never enter schema preparation.

The one-time build can exceed ordinary writer busy timeouts. Before deployment:

1. Stop the appender and quiesce any legacy index writes. Intake can keep buffering.
2. Use the new portable entry point with platform-native Bun 1.3.14 and an
   explicit existing index path. No intake credentials or network are required:

   ```sh
   bun "$RELEASE/capture-intake.js" index-migrate --db "$SESSION_INDEX_PATH"
   ```

   The command waits up to 60 seconds to acquire the write lock. It prints
   `created`, `cursor_index_ms`, `migration_begin_wait_ms` and
   `migration_write_lock_ms` (the BEGIN-through-COMMIT transaction span, an upper
   bound on time holding the SQLite writer lock). A repeated successful command
   reports `created: false`; it does not rescan/rebuild the index. Missing DBs
   are not created. Do not replace DB/WAL/SHM files.

3. Confirm success and the covering query plan before restarting a single
   appender and resuming the other existing writer. A busy failure leaves the
   schema unchanged and can be retried after quiescing writers.

`SESSION_INDEX_REPLACED` emits one sanitized
`capture.intake.appender.session_index_replaced` error event per detected
replacement. The poisoned index remains fenced and the row remains owed. The
alert does not include the path, and does not authorize automatic recovery.

## OTEL duration and queued writes

The validated Central ingest normalizes a floating duration before storage.
The ClickHouse mapper also rounds finite durations for existing outbox entries
that bypass HTTP ingestion on replay. NaN and either infinity map to a null
duration, preserving the rest of the event. This needs a Central worker rollout as well as
the appender rollout; updating the appender alone does not repair old queued
float events. IDs and precision inside metadata are unchanged.

HTTP 200 with `clickhouse.written: false, queued: true` means durable queue
custody, not a stored ClickHouse row. Central logs `[otel] clickhouse write
deferred`, including process-local monotonic `clickhouse_write_failures` and
`clickhouse_queued` counters. The optional `/` → `observability.storeCounters`
integration is deferred until the separately reviewed server changes land;
do not overwrite an unlanded drain handler just to expose it. The warnings and
store helper remain usable without that integration. Counters reset when the
worker restarts; no recursive OTEL emit is used for the warning.

Before the mapper fix, a float can fail and requeue indefinitely. After the
Central rollout, a successful ClickHouse write triggers a background drain of
at most 100 queued events. The mapper rounds old floats; accepted batches remove
only their delivered queue files. No manual deletion of float events is needed.
The existing outbox drainer can also be invoked explicitly by the operator.
Unrelated invalid events can still block/requeue a batch; inspect those rather
than deleting a backlog. This code does not repair crash-stranded `.processing`
files or historical index data.

## Synthetic smoke captures

The appender never indexes a row whose machine ID is exactly `intake-smoke`
or whose tags include the exact marker `synthetic:intake-smoke`. A `smoke-`
run-ID prefix alone does not suppress a capture. It skips blob download, append and legacy
forwarding, acknowledges in writer mode, and reports `observed: "smoke-skipped"`.
Compare-only reports the skip without acknowledging or touching the index.
Failed/ambiguous acknowledgements remain retryable under the same intake row.
Legacy-owned rows still need their transfer capability before acknowledgement.

The bundled smoke keeps its `smoke-` run ID and adds `synthetic:intake-smoke`.
That tag explicitly marks synthetic input and is itself sufficient to skip.
The exact machine rule covers older untagged smoke captures. Similar real
machine/tag names are not excluded; payload-controlled run IDs never decide
whether a capture is synthetic.
This prevents future appender pollution; it does not remove existing indexed
smoke rows or change the independent legacy route's behavior.

## Legacy machine attribution

The intake preserves payload `machine_id`. Legacy `/api/runs` does **not**
trust that field: its existing authentication boundary stamps newly forwarded
runs with the receiving token's `auth.machine_id` (the drain principal).
Forwarding retains the original field in the body and adds
`forwarded-from:<original machine_id>` to the tags without changing that auth
boundary. Existing tags survive and retries do not duplicate the provenance
tag. The shared body builder includes it in the legacy wire-size preflight.
Tests assert both the stored machine ID and `tags_json` under a distinct drain
principal, not just the outgoing request. An already-indexed run keeps its first identity
through idempotent append. If preserving the original `runs.machine_id` value
is a cutover requirement, do not use this inline legacy rollback; approve and add a
forwarder-scoped identity contract first.

Compare-only does not write the index **or acknowledge intake work**. Keep it
on during shadow; old Inngest still owns writes. Enabling the appender writer
requires the existing cutover approval. Local appender blobs become the index's
capture paths and must be retained; the seven-day prune applies only to the
intake's acknowledged copies.
