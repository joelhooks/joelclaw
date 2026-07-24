# Central service log rotation

This mechanism bounds three continuously written service logs without restarting their writers:

- `/Users/Shared/joelclaw/logs/inngest/launchd.err.log`
- `/Users/Shared/joelclaw/logs/inngest/launchd.out.log`
- `/Users/Shared/joelclaw/logs/typesense/typesense.log`

It does not cover the smaller user LaunchAgent logs under `/Users/joel/.joelclaw/logs/`. Add those only after choosing whether their owning LaunchAgents should share a user-domain rotator.

## Why this is not `newsyslog`

`newsyslog` renames the live file and creates a new inode. Launchd does not reopen `StandardOutPath` or `StandardErrorPath` after that rename.

The isolated proof used a user LaunchAgent that wrote every 50 ms. After forced `newsyslog` rotation:

- old inode: `82656220`
- new live inode: `82656252`
- the new live file stayed at 78 bytes
- the renamed `.0` file grew from 132 to 186 bytes
- the writer's fd 1 resolved to `live.log.0`

The proof files remain under:

```text
/private/tmp/claude-501/-Users-joel-Code-badass-courses-aihero-support/bf664c3d-2216-439d-9431-c0ba7693142e/scratchpad/newsyslog-fd-proof
```

A plain copy-then-truncate script also has a race: bytes written after the copy and before truncation disappear. This implementation removes that race with an APFS copy-on-write snapshot:

1. Send `SIGSTOP` to the one expected writer.
2. Clone each due live file with `cp -c`.
3. Truncate the existing live inode.
4. Send `SIGCONT`.
5. Reduce each point-in-time clone to its newest 64 MiB after the writer resumes.

The process is not restarted. Cold log pages do not need to be read while the writer is stopped because APFS `clonefile(2)` copies file metadata and shares data blocks. If `cp -c` falls back to a byte copy on another filesystem, the pause guard aborts before truncation.

## Pause budget and lease margin

Every stop-to-continue interval is measured with `Time::HiRes`. The rotator writes `pause_ms` to stderr, the macOS unified log tag `com.joelclaw.central.log-rotation`, and `${CENTRAL_ROOT}/state/log-rotation/last-pause.latest`.

The offline drill exercised a complete 67,108,864-byte retained archive. On this APFS volume, the final writer pause was **80 ms**; an earlier repeat measured 66 ms. The archive was reduced to exactly 64 MiB after the writer resumed.

The production pause budget is **500 ms across the whole service group**, not per file. The watchdog terminates a slow clone, resumes the writer, records an error, and leaves every live inode untruncated. A separate test forces a 1 ms budget and proves this fail-closed path.

The slowest realistic case is a cold page cache on a slow disk at the 64 MiB threshold. APFS cloning still does not read or write 64 MiB of payload, so cache temperature should not control the pause. Metadata or filesystem trouble can still make cloning slow. The 500 ms guard is the hard bound; on a filesystem that falls back to a full copy, rotation skips instead of extending the pause.

Inngest v1.28.0 source at release commit `195554d829637ea013c5d2e5ac542dff18d06b86` defines:

- partition, shadow-partition, and backlog-normalization leases: **4 seconds**;
- queue-item leases: **30 seconds**, renewed every **15 seconds**;
- role and shard leases: **10 seconds**; roles renew every one-third of their lease.

Sources: [`pkg/execution/queue/consts.go`](https://github.com/inngest/inngest/blob/v1.28.0/pkg/execution/queue/consts.go#L12-L61), [`process.go`](https://github.com/inngest/inngest/blob/v1.28.0/pkg/execution/queue/process.go#L103-L146), and [`role.go`](https://github.com/inngest/inngest/blob/v1.28.0/pkg/execution/queue/role.go#L140-L200).

The final 80 ms measurement is 2% of the shortest 4-second lease. The 500 ms hard guard is 12.5%. Timer alignment means no pause can claim a fresh four seconds of margin, but this bound limits the damage to a possible partition retry rather than a long queue stall. A slow clone fails closed instead of gambling with queue ownership.

## Bounds

The LaunchDaemon checks every 60 seconds. Each non-empty log rotates at 64 MiB or 24 hours, whichever comes first. It keeps seven 64 MiB archives plus the live file.

The retained ceiling is:

- 512 MiB per log after a rotation
- 1 GiB for the two Inngest logs
- 512 MiB for `typesense.log`
- 1.5 GiB total, plus growth during one 60-second check interval

A full copy-on-write snapshot exists briefly while its retained tail is finalized after resume. It shares APFS data blocks rather than duplicating the source bytes. A failed finalization leaves the named snapshot and an error receipt for operator recovery instead of deleting evidence.

At the measured Inngest rate of about 187 MiB per day, this keeps about 2.4 days in the noisy stderr stream. A burst larger than 64 MiB keeps only its newest 64 MiB. That is deliberate retention, not an in-flight write loss.

The first installed run will reduce the current 3.5 GB Inngest file to an empty live inode plus a 64 MiB `.0` archive. Review or sample the existing file before installation.

Typesense already limits its database logs with `db-max-log-file-size` and `db-keep-log-file-num`. Those settings do not bound its separate 116 MiB `typesense.log`, so this daemon includes that file.

## Source-volume recommendation

Inngest v1.28.0 exposes one log-level flag but no documented stdout/stderr routing option:

```text
--log-level string  trace, debug, info, warn, error
```

The current wrapper hard-codes `--log-level info`. INFO records include `received event`, `initializing fn`, `publishing event`, database migration, startup, and shutdown messages. Switching to `warn` removes that local event-by-event timeline and startup detail. WARN and ERROR records remain.

Standing recommendation: switch to `warn` after confirming that the Inngest run store and joelclaw OTEL receipts provide enough event and startup diagnosis. The measured recent sample suggests a roughly 97% source reduction during steady state, but an older 32 MiB window still contained the fixed lease-error storm. Rotation remains necessary either way.

**Decision — 2026-07-24:** keep `--log-level info`. The local event timeline is still useful while the new alarm loops are being hardened. Rotation bounds the retained footprint, so the source-volume cost is accepted for now. Revisit this decision once the staleness alarms and registration/run assertions are proven.

The installer does not change `/Users/Shared/joelclaw/bin/central-inngest`.

## Validate without live services

```bash
infra/central/native/test-log-rotation.sh
```

The drill starts a disposable writer, forces size rotation, and proves:

- the writer PID survives;
- the live inode stays the same;
- the sequence is contiguous across `.0` and the live log;
- the writer adds records after rotation;
- archive count stays within the configured limit;
- a full 64 MiB retained path stays below the 500 ms pause budget;
- an impossible pause budget fails closed without truncating the live inode;
- an internal failure returns non-zero instead of producing a false PASS.

The drill leaves its fixture under the supplied scratchpad. It does not touch `/Users/Shared/joelclaw/logs/`.

## Install

This needs sudo because it installs a system LaunchDaemon. Review the first-rotation warning above, then Joel can run exactly:

```bash
cd /Users/joel/Code/joelhooks/joelclaw
sudo infra/central/native/install-log-rotation.sh --acknowledge-first-rotation
```

The LaunchDaemon runs as `joelclaw:staff`. Routine rotation needs no sudo. Errors go to the bounded macOS unified log under tag `com.joelclaw.central.log-rotation`; the daemon does not create another unbounded launchd log.

## Post-install drill

```bash
sudo launchctl print system/com.joelclaw.central.log-rotation | grep -E 'state =|runs =|last exit code'
log show --last 10m --predicate 'senderImagePath ENDSWITH "/logger" AND eventMessage CONTAINS "log-rotation"'
stat -f 'inode=%i bytes=%z %N' \
  /Users/Shared/joelclaw/logs/inngest/launchd.err.log \
  /Users/Shared/joelclaw/logs/inngest/launchd.out.log \
  /Users/Shared/joelclaw/logs/typesense/typesense.log
pgrep -U joelclaw -fl '^/Users/Shared/joelclaw/opt/inngest/[^/]*/inngest '
```

After the next forced or natural rotation, compare the Inngest PID and live inode with the pre-rotation values. Confirm the live file grows after its size resets. The automated fixture drill is the safe forced proof; do not inflate or truncate the live log for a test.
