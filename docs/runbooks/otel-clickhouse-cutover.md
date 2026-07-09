# OTEL ClickHouse cutover

Status: active recovery/cutover. ClickHouse is the canonical raw OTEL/log store behind the existing `/observability/emit` API. Typesense is no longer allowed to be the raw OTEL sink; at most it can receive a bounded/searchable projection after retention and query cutoffs are proven.

## Target shape

```txt
callers
  -> POST /observability/emit on Flagg
  -> system-bus OTEL store
  -> ClickHouse on three-body

Panda/old Central endpoints are relay-only:

callers on Panda
  -> POST /observability/emit on Panda or `joelclaw otel emit`
  -> forward to `http://flagg:3111/observability/emit`
  -> Flagg writes/queues to ClickHouse
```

Do not send random callers directly to ClickHouse. Keep `/observability/emit` and `emitOtelEvent` as the canonical ingest path.

## Runtime endpoints

Proof ClickHouse endpoint:

```txt
CLICKHOUSE_URL=http://192.168.1.163:8123
CLICKHOUSE_DATABASE=joelclaw
CLICKHOUSE_OTEL_TABLE=otel_events
```

NAS proof paths:

```txt
three-body:/volume2/data/clickhouse-proof
three-body:/volume1/joelclaw/backups/clickhouse-proof
```

## Flags

System-bus write path:

```txt
OTEL_STORE=clickhouse        # clickhouse | forward | typesense | dual
OTEL_STORE_MODE=clickhouse   # alias, lower precedence than OTEL_STORE
OTEL_TYPESENSE_PROJECTION=0  # set 1 only for a bounded projection, never raw unbounded OTEL
OTEL_OUTBOX_DIR=$HOME/.joelclaw/spool/otel
CLICKHOUSE_URL=http://192.168.1.163:8123
CLICKHOUSE_DATABASE=joelclaw
CLICKHOUSE_OTEL_TABLE=otel_events
OTEL_CLICKHOUSE_TTL_DAYS=180

# Relay hosts such as Panda
OTEL_STORE=forward
OTEL_FORWARD_URL=http://flagg:3111/observability/emit
OTEL_FORWARD_TIMEOUT_MS=2500
```

CLI read path:

```txt
JOELCLAW_CAPABILITY_OTEL_ADAPTER=clickhouse-otel  # default
JOELCLAW_CAPABILITY_OTEL_ADAPTER=typesense-otel   # rollback
```

Per-command rollback:

```sh
joelclaw otel list --adapter typesense-otel --hours 1
joelclaw otel stats --adapter clickhouse-otel --hours 24
```

## Durability behavior

When `OTEL_STORE=clickhouse`:

- ClickHouse write success means the event is stored.
- ClickHouse write failure writes the event to the local outbox.
- If the outbox write succeeds, `/observability/emit` returns `stored: true` with `clickhouse.queued: true`.
- The outbox drains opportunistically after later successful ClickHouse writes.
- Forward mode never writes to local Typesense or local ClickHouse. It makes a short HTTP POST to the Flagg ingest URL and reports that forward result.
- For launchd/service installs, set `OTEL_OUTBOX_DIR` to a directory that the worker user can create and write. Do not assume `/Users/Shared/joelclaw` is writable from a user LaunchAgent.

This means `stored` means “accepted durably,” not necessarily “already visible in ClickHouse.”

## Backfill

Backfill Typesense `otel_events` into ClickHouse:

```sh
CLICKHOUSE_URL=http://192.168.1.163:8123 \
TYPESENSE_URL=http://127.0.0.1:8108 \
bun run scripts/backfill-otel-clickhouse.ts
```

The script leases `typesense_api_key` via `agent-secrets` if `TYPESENSE_API_KEY` is not already set. Do not print the key.

## Proof gates before declaring canonical

1. NAS ClickHouse restart proof passes:
   ```sh
   sudo sh ~/clickhouse-proof/restart-proof.sh
   ```
2. `curl -fsS "$CLICKHOUSE_URL/?query=SELECT%201%20FORMAT%20TabSeparated"` returns `1` from Flagg.
3. `joelclaw otel list --adapter clickhouse-otel --hours 24` returns recent events.
4. `joelclaw otel stats --adapter clickhouse-otel --hours 24` returns sane totals.
5. Dual-write window compares ClickHouse vs Typesense counts by day/source/level.
6. Rollback command works:
   ```sh
   joelclaw otel stats --adapter typesense-otel --hours 24
   ```

## Things to avoid

- No raw OTEL writes to Typesense.
- No ClickHouse hot data over Flagg NFS.
- No direct client writes to ClickHouse outside the worker ingest path.
- No broad `q=*` health probes against `otel_events`; use ClickHouse aggregations or leave the probe disabled.
- No claiming canonical cutover if the outbox cannot drain.
- New canonical tables use `ReplacingMergeTree(received_at)` and adapter reads use `FINAL` when the engine supports it. Existing proof `MergeTree` tables remain readable but are not idempotency-proof.
