# Retired Typesense session indexing

The `runs_dev` and `run_chunks_dev` session projections are retired and must not be recreated during normal recovery.

Current truth:

- Native runtime transcripts are immutable evidence.
- Accepted capture receipts prove ingestion.
- `~/.joelclaw/search/sessions.db` is the current local SQLite projection.
- Flowing memory is scoped operational memory.
- Raw session search is explicit drill-down.

Use the `session-archive-maintenance` skill and these read-only checks:

```bash
session_capture_status
joelclaw sessions search "<query>" --raw --source local --runtime all --limit 5
bun scripts/validate-session-index.ts --probe --query "<query>"
```

The prior Typesense recovery runbook is preserved in the private operator archive with a metadata-only hash receipt. It is not published from this repository.
