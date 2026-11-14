# Offline intake install

This deliverable contains the bundled application, its exact Linux x64 Bun
runtime, `BUN_VERSION`, runtime SHA256, unit and example environment. It needs
no checkout, package install or outbound network access. Build with
`CAPTURE_INTAKE_SOURCE_REF=<reviewed-commit> bun packages/capture-cell/scripts/package-intake.ts <new-output-directory>`
on the authorized build host. Match `SOURCE_COMMIT` against that reviewed commit. `SHA256SUMS` authenticates files against the separately
reviewed artifact checksum; a checksum is not a signature.

The runtime pin is **Bun 1.3.14**. Verify its version and binary hash before
installing. The archive is Linux x64; the installer must check runtime/CPU
compatibility locally with `bin/bun --version`. Do not substitute a newer Bun
without rebuilding and rerunning the gates.

## Install (the deployment owner runs this)

1. Verify the delivered tarball against its accompanying `.sha256`. Extract it
   to a fresh versioned directory, then run `sha256sum -c SHA256SUMS` there.
2. Create the system account if absent:
   `useradd --system --home-dir /var/lib/capture-intake --shell /usr/sbin/nologin capture-intake`.
3. Install the extracted contents at `/opt/capture-intake` (or point that path
   at the reviewed versioned directory). Keep binaries root-owned and not
   writable by the service account. Run `/opt/capture-intake/bin/bun --version`
   and confirm `1.3.14`.
4. Create `/etc/capture-intake` with mode 0700. Copy `env.example` to
   `/etc/capture-intake/env`, root-owned mode 0600. Set two **distinct** tokens
   and the existing capture user ID. Keep tokens out of command output.
5. Ensure `/var/lib/capture-intake/blobs` is the intended blob mount, writable
   only by `capture-intake`. Keep the database and its `-wal`/`-shm` files on
   rootfs at `/var/lib/capture-intake/intake.db`. Do not place the database on
   the excluded blob mount. The rootfs backup captures the SQLite database and
   its WAL; blobs are **not backed up** by this package. Restore them separately
   or replay missing captures. Intake refuses missing committed blob reads;
   a verified duplicate POST can repair a missing unpruned copy.
6. Install `capture-intake.service` in `/etc/systemd/system/`. Run
   `systemd-analyze verify /etc/systemd/system/capture-intake.service`, then
   `systemctl daemon-reload` and `systemctl enable --now capture-intake`.
   These are deployment actions, not build steps.

The service runs non-root, binds the configured wildcard address on TCP 3114,
and accepts both ingestion and pull/ack inbound on that port. It makes no
outbound calls. A gateway may rewrite all peer addresses; the implementation
never uses a peer IP for identity. A sender supplies `machine_id` and
`agent_runtime` in its authenticated payload. The configured token principal
supplies the user ID. Scope access at the network boundary as well as with the
two bearer tokens.

`MemoryMax=1536M`, `MemorySwapMax=0`, `CPUQuota=90%`, `Restart=always` are in
the unit. Large requests stream to disk; the 2 GiB cap is on wire/decoded
bytes, not an allocation target. At most four ingest bodies are active.

## Local smoke test

Use the delivered runtime so no other tools or network downloads are needed:

```sh
sudo /opt/capture-intake/bin/bun /opt/capture-intake/smoke.js
```

The smoke script reads the root-owned environment file without printing its
tokens. It requests local `/health`, POSTs a tiny synthetic `/api/runs` capture
with bearer auth, and repeats that ID to prove duplicate acknowledgement. It
prints only statuses and the synthetic run ID. This leaves one small owed
synthetic capture; let the appender process it normally. It does not prune or
start a service.

## Optional machine-token identities

Configure `CAPTURE_INTAKE_IDENTITIES_FILE` in the protected environment to accept
existing Central machine app passwords without changing hook credentials. See
the full identity export/reload contract in the repository's `INTAKE.md`.
Run `identities-export --db <existing-central-auth-db>` on the appender host;
Central selects `RUN_CAPTURE_AUTH_DATABASE` or `~/.joelclaw/capture-auth.db`.
Export contains only hashes, IDs and revocation times, never raw tokens.
Operator-install the file mode 0600, readable by the service user, using atomic
replacement. Startup, next-ingest file-version checks and SIGHUP load it.
Bad or missing replacements retain the last good set and log a sanitized warning;
the configured ingest token stays usable. Identity tokens cannot pull or ack.
Neither the real file nor any credentials belong in this offline release.

## Pull appender and rollback

Run the same bundle beside the session index with `append --compare-only`
first. Supply `CAPTURE_INTAKE_URL`, `CAPTURE_INTAKE_PULL_TOKEN`,
`SESSION_INDEX_PATH` and `CAPTURE_APPENDER_DIR` through that process's own
protected environment. No outbound access from the intake is required.
`--once` is a bounded proof pass. Compare-only never writes the index or acks.
The normal loop retries delivery failures indefinitely with capped backoff.
An index WAL above 2 GiB remains a hard stop to protect disk; it is checked
before pull and again before index work. Host load1/CPUs above 0.8 instead
permits rows until three seconds have elapsed since tick entry, then yields
two seconds using the existing cancellable wait. The budget includes setup
and failed attempts, is checked between rows and always permits at least one
row. A slow in-flight row finishes even if it overruns. Normal load restores
page throughput. Successful high-load trickles never escalate failure backoff.
The `capture.intake.appender.load_gated` warning fires once on entry and at most
once every ten minutes while still gated; metadata includes load and intake
depth (or null if the bounded health probe fails). Normal load resets it. Alarm
failure cannot block capture. Retain the appender's verified local blobs:
indexed rows reference them for overlap checks.

The appender retains one canonical SQLite handle and its on-demand 32 MiB cache
for the process lifetime, using the legacy cache/connection policy. Optional
`SESSION_INDEX_CACHE_KIB` changes apply on handle open/restart. Stop writers
before replacing an index DB or its WAL/SHM files. Append events now use
`memory.run.session-index.append` with component `capture-appender` through the
existing OTEL configuration, with duration and stage timings. Keep OTEL settings
in this appender process's protected environment; the intake role still makes
no outbound calls. See the repository's `INTAKE.md` for timing interpretation.

Before starting the new appender, stop it and quiesce any legacy index writes,
then prepare the covering index using the platform-native Bun 1.3.14:

```sh
bun "$RELEASE/capture-intake.js" index-migrate --db "$SESSION_INDEX_PATH"
```

This uses only the explicitly named existing DB, with no credentials or network.
`BEGIN IMMEDIATE` serializes schema work across processes. The first build can
exceed ordinary writer busy timeouts; intake keeps buffering while writers are
quiesced. The one-shot waits up to 60 seconds for the lock and reports whether
it created the index and the migration timings. A second success reports
`created: false`, without rebuilding. Do not replace DB/WAL/SHM files.
Only this explicit command may build the covering index. Ordinary opens skip
that build, emit `capture.session_index.cursor_index_missing` with the command,
and continue using the old index. Compatible opens take no schema writer lock;
alarm delivery cannot block capture. Prepare the index during a quiesced window
rather than relying on an automatic build during restart.

Append OTEL top-level duration is rounded to UInt32 milliseconds; metadata keeps
precision. The associated Central worker patch must also be deployed to normalize
all callers and replay old floating-duration outbox entries. A queued HTTP 200
is accepted custody, not a ClickHouse row. Central logs/counts deferred writes;
optional `/` counter exposure is deferred until the separately reviewed server
changes land. Do not overwrite an unlanded drain handler for that status hunk.
The ClickHouse mapper drops non-finite durations to null. Successful writes
trigger bounded queue drains. No manual deletion of floating-duration events is needed.

Writing needs explicit `CAPTURE_APPENDER_MODE=writer` and cutover approval.
For rollback, stop that writer. **Run `drain-to-legacy` on the appender host**
with `CAPTURE_INTAKE_URL`, `CAPTURE_INTAKE_PULL_TOKEN` and a local
`CAPTURE_APPENDER_DIR`; do not run outbound forwarding on the intake. First
run `drain-to-legacy --dry-run --json`, inspect the IDs, then supply
`CAPTURE_LEGACY_URL` and `CAPTURE_LEGACY_TOKEN` and run without dry-run. The
remote command pulls the blobs inbound, commits transfer ownership through
an inbound API before forwarding, then acks only after the legacy 202.
Retry failed/ambiguous sends with the same command. The command requires the
remote URL and pull token even for dry-run; it cannot silently inspect an empty
local store. A local-store library helper remains available for tests and
other authorized adapters.

Upgrade both intake and appender to the capability-fenced protocol before
writer cutover, and stop old drain binaries. Each successful transfer returns
a row-scoped capability for its ack; ordinary appender acks cannot settle
legacy-owned work. The inline rollback checks legacy's 10,000,000-byte JSON
wire cap **before transfer**. Larger or heavily escaped captures remain owed
to the appender rather than entering an endless legacy 413 retry.

### Drain and transfer-back runbook

1. **One drain at a time.** Run or retry the drain serially. Renewing a pending
   legacy transfer returns the same token without an epoch bump, so concurrent
   drains can both forward. Run-ID dedupe is protection, not an operator lock.
2. **Stop all drains and confirm they have exited before transfer-back.**
   Never overlap a drain with transfer-back. An already in-flight legacy POST
   still relies on canonical run-ID dedupe.
3. From the same remote host, inspect `transfer-back --dry-run --json`.
4. Run `transfer-back --json`. It invalidates old drain capabilities and
   restores unacked legacy work to appender discovery, including oversized work
   stranded by an older version. It needs no legacy credentials, blob download
   or index access.
5. Inspect restored discovery before restarting the approved writer. Keep
   compare-only until the existing soak and cutover gates pass.

Legacy indexes new forwarded rows under the receiving token's machine identity,
not the original body machine ID. The drain preserves original-machine
provenance in a `forwarded-from:<original machine_id>` tag alongside existing
tags. This does not change legacy's auth boundary or its stored machine ID.
If that restamp is unacceptable, do not use inline legacy rollback until a
forwarder-scoped identity contract is approved.

A hard process crash resets the HTTP connection rather than returning 503;
clients must retry any request lacking a durable 202 acknowledgement.

The serving process prunes one bounded batch each minute. `prune` also runs a
manual batch under the service account. Each batch removes at most 100 blobs,
only at least seven days after their first ack. Identity tombstones remain in SQLite;
unacknowledged captures are never pruned. A separate bounded sweep removes
UUID-named `.jsonl` files with no row only when older than one day. It skips
active publications, symlinks, partial files and all referenced blobs. Each
invocation examines at most 1,000 entries and removes at most 100 orphans;
`prune` runs both batches. Inspect restored storage before garbage collection.
Watch disk-free and oldest-owed age in `/health`; a full disk fails intake with 503.

To roll back the binary, stop the service, preserve both state directories and
its protected environment, restore the previous reviewed application directory,
then restart and smoke-test. Do not roll back by deleting the outbox or blobs.
