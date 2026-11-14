# @joelclaw/capture-cell

The capture ingest cell: a small Bun process that owns a SQLite outbox for
`memory/run.captured` payloads. In **shadow mode** (`off`/`both`), its
`append` step only reads sessions.db; Inngest stays the writer. With
`CAPTURE_CELL_MODE=cell`, the cell runs the real idempotent append itself.
The route sends nothing to Inngest and returns 202 only after the cell
commits the capture and its owed markers. Failed or lost acknowledgements
return 503 so the client retries the original run.

## Remote intake and local appender

`CAPTURE_CELL_MODE=intake capture-cell serve` (or `capture-intake serve`) runs
only a streamed `/api/runs` intake, its own blob store and its own FULL-WAL
outbox. It never opens sessions.db or makes outbound calls. A separate
`capture-intake append --compare-only` process runs beside the existing index.
Writing requires explicit `CAPTURE_APPENDER_MODE=writer` and cutover approval.

The legacy route optionally tees every accepted run to `CAPTURE_INTAKE_URL`
using `CAPTURE_INTAKE_TOKEN`, independently of the old cell tee. It reuses the
detached retry budget and streams inline JSONL from the immutable capture
blob. `CAPTURE_INTAKE_TIMEOUT_MS` and `CAPTURE_INTAKE_TOTAL_BUDGET_MS` override
the existing 4s/13s defaults. A missing intake URL leaves the old route unchanged.

See [the intake contract](INTAKE.md) and the [offline install, systemd and
rollback guide](systemd/README.md). Packaging includes pinned Bun 1.3.14 and
checksums, not development dependencies. Nothing is deployed by this package.

## Shape

- `decide(state, event) -> { facts, owed }` (`src/decide.ts`) is the pure fold.
  Events are `captured`, `step_succeeded`, `step_failed` and `replayed`.
  Owed markers are keyed `(run_id, step)` and never carry the attempt or the outcome.
- `apply(db, facts, owed)` and `fold(db, event)` (`src/outbox.ts`) write one
  decision in one `BEGIN IMMEDIATE` on the outbox, with `synchronous=FULL`.
  Arrival is `INSERT OR IGNORE`.
- The drain (`src/drain.ts`) runs after each commit, on boot and on a tick.
  It takes the oldest due marker whose session key (`source_identity`, else
  `run_id`) isn't in flight. It goes in arrival order and never waits for a gap.
  - Deterministic failures go `dead` with the reason and `capture-cell replay <run_id>`.
    These are a missing or unreadable blob, a byte or SHA mismatch, or an OTEL 4xx.
  - Transient failures back off, capped at 5 min, and never go dead.
- Shadow `append` (`src/shadow-append.ts`) uses the identity checks shared with
  `appendSessionCapture` (`@joelclaw/memory`).
  - It parses outside the read and opens one read-only transaction per verdict.
  - `busy_timeout` bounds the transaction, and a read over the bound is discarded as transient.
  - It pauses while `sessions.db-wal` is over the stop size.
- The stable-outcome rule: `already_indexed` for the same run, while `append`
  is still owed, records `appended` with the stored `chunk_count`. The first
  verdict wins.
- The otel step posts one `capture.cell.shadow.verdict` event per run with id
  `capture-cell:<run_id>:append` to `/observability/emit`.

## Commands

```sh
capture-cell serve                        # POST /capture (bearer), GET /health on 127.0.0.1:$CAPTURE_CELL_PORT
capture-cell status [--json]
capture-cell status --alerts              # one line per new dead row; one when the oldest owed marker is > 15 min
capture-cell replay <run_id>
capture-cell handback --dry-run [--json]
capture-cell handback [--json]
capture-cell compare --since <iso> [--direction cell-to-index|index-to-cell] [--json]
```

`compare` checks each verdict against sessions.db and lists two kinds of mismatch apart:

- **verdict:** the outcome, the matched run or `source_identity` differs.
- **computed:** the cell's own parse (`computed_chunk_count`, `computed_turn_count`)
  differs from the stored `chunk_count` and `turn_count`. Every verdict keeps
  the cell's parse, even when the writer won the race and the stable outcome
  recorded the stored `chunk_count`.

- Runs not yet indexed are pending for 10 minutes.
- It also lists runs indexed since `--since` that the cell never saw. That
  check is bounded by the `ended_at` index, with 24 h of slack.
- `--direction index-to-cell` starts from the index, then checks the cell's
  verdict, identity, digest and computed counts. Use it for the seven days
  after cutover, with `--since` set to the cutover timestamp. Both directions
  report the 24 h last-turn scope explicitly. Each index page contains at most
  200 rows, uses a keyset cursor, and closes its read transaction and connection
  before checking the cell or moving to the next page. Over-budget reads fail
  instead of returning a partial match report.

## Writer and rollback

Set `CAPTURE_CELL_MODE=cell` in **both** the route process and the cell process
only after the cutover gate is approved. The route bypasses its Inngest retry
outbox entirely in this mode. An authoritative POST carries
`X-Capture-Cell-Mode: cell`; a shadow-configured cell refuses it with 503.
Shadow tee posts remain read-only even if the cell process is already in writer
mode. In cell mode, clients without a source cursor must supply a non-empty
string `run_id` and reuse it on every retry; otherwise the route returns 400
before writing a blob. Cursor clients may omit it because the route persists
their source-cursor claim and reuses its run ID after a lost acknowledgement. Each capture saves its original writer/shadow ownership in the separate
outbox. The cell drains saved work on boot and retries transient append failures. One append runs at a time; the shared memory append
keeps its existing run/cursor/overlap identity checks. No new sessions.db
migration is introduced.

The shared append API returns only chunk counts. The cell keeps an independent
parse for its verdict and reverse compare, including crash recovery. New runs
are also parsed inside the shared append; this preserves the existing memory
contract rather than introducing a second index writer implementation.

For rollback, switch the route and cell back to `both` (or route `off` with a
non-writing cell). Existing writer debts stay paused, not converted into
read-only verdicts, until handback takes ownership. Historical shadow captures
stay read-only on boot. An authoritative retry after cutover adopts the original
stored payload and owes a real append; subsequent duplicates are no-ops. Drain
the old Inngest retry backlog before cutover. Then run `capture-cell handback --dry-run --json`. Inspect
the run IDs, then run `capture-cell handback --json` with `INNGEST_URL` (or
`INNGEST_BASE_URL`) and `INNGEST_EVENT_KEY` supplied in the environment.

Handback includes every owed append, including dead rows. It commits a durable
transfer marker before sending `memory/run.captured`, with `id` equal to the
original `run_id` and the original stored payload. The drain skips transferred
runs, even if it was scheduled before handback. A failed or ambiguous send
remains transfer-pending; rerun the command to resend the same event ID. A
successful acknowledgement settles the cell's append debt. Repeated commands
do not resend acknowledged rows, and `replay` cannot take them back from Inngest.
The receiver's idempotent append also covers a crash after its index commit but
before the handback acknowledgement. Dry-run sends nothing and writes no
transfer markers. Keep the old Inngest function registered during rollback.

Keep the existing cutover match gate and stall watchdog. The flag remains off
by default; this package does not deploy or flip it.

## Environment

| Variable                                                     | Default                              |
| ------------------------------------------------------------ | ------------------------------------ |
| `CAPTURE_CELL_DB`                                            | `~/.joelclaw/capture-cell/outbox.db` |
| `SESSION_INDEX_PATH`                                         | `~/.joelclaw/search/sessions.db`     |
| `CAPTURE_CELL_PORT`, `CAPTURE_CELL_TOKEN`                    | required for `serve`                 |
| `CAPTURE_CELL_READ_TIMEOUT_MS`                               | `3000`                               |
| `CAPTURE_CELL_WAL_STOP_BYTES`                                | 2 GiB                                |
| `OTEL_EMIT_URL` or `JOELCLAW_CENTRAL_URL`, `OTEL_EMIT_TOKEN` | none: otel stays owed until set      |

The route side lives in system-bus (`src/routes/run-capture-cell.ts`).
`CAPTURE_CELL_MODE` is `off` (default), `both` or `cell`. `both` and `cell`
also read `CAPTURE_CELL_URL` (or `CAPTURE_CELL_PORT`), `CAPTURE_CELL_TOKEN`
and `CAPTURE_CELL_TIMEOUT_MS` (default 4000). Shadow posts run detached after
the response, with two jittered retries and a total `CAPTURE_CELL_TOTAL_BUDGET_MS`
(default 13000). Authoritative `cell` posts wait for one bounded acknowledgement;
a timeout returns 503 rather than masking an uncertain commit.

`launchd/com.joelclaw.capture-cell.plist.template` is a template. Nothing
installs it.
