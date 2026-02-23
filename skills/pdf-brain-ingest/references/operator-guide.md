# PDF-Brain Ingest Operator Guide (Joelclaw)

Date: 2026-02-23  
Scope: Ingest new `pdf`/`md` files into the `docs` + `docs_chunks` memory pipeline on joelclaw.

## 0) aa-book End-to-End Acquisition (Recommended for books)

Queue acquisition + inference + download + ingest in one durable workflow:

```bash
joelclaw send pipeline/book.download -d '{
  "query": "designing data-intensive applications",
  "format": "pdf",
  "reason": "memory backfill"
}'
```

Optional direct MD5 (skip search/inference):

```bash
joelclaw send pipeline/book.download -d '{
  "md5": "0123456789abcdef0123456789abcdef"
}'
```

## 1) Preflight

```bash
joelclaw status
joelclaw inngest status
joelclaw docs status
```

If worker registration looks stale:

```bash
joelclaw inngest sync-worker --restart
```

## 2) Ingest a Single File

Queue one file:

```bash
joelclaw docs add "/absolute/path/to/file.pdf"
joelclaw docs add "/absolute/path/to/file.md"
```

Optional metadata:

```bash
joelclaw docs add "/absolute/path/to/file.pdf" \
  --title "Readable Title" \
  --tags "manifest,catalog-fill" \
  --category programming
```

Notes:
- Use absolute paths.
- Supported file types are `pdf`, `md`, `txt`.
- Ingest writes document records into `docs` and hierarchical section/snippet chunks into `docs_chunks`.

## 3) Monitor Runs

```bash
joelclaw runs --count 20 --hours 1
joelclaw run <run-id>
```

Healthy run shape for `docs-ingest`:
- `validate-file`
- `extract-text`
- `classify-taxonomy`
- `ensure-docs-collections`
- `upsert-document`
- `chunk-and-index`
- `emit-completed`
- `cleanup-text-artifact`
- `Finalization`

## 4) Verify Index + Retrieval

```bash
joelclaw docs list --limit 20
joelclaw docs show <doc-id>
joelclaw docs search "your query"
joelclaw docs context <chunk-id> --mode snippet-window
```

## 5) Reconcile Coverage Against Manifest

Use dual coverage to avoid false missing churn:

```bash
joelclaw docs reconcile --sample 20
```

This reports:
- `path_exact` coverage: exact `nas_path` match.
- `content_equivalent` coverage: category-insensitive book path equivalence.

Interpretation:
- If `content_equivalent > path_exact`, missing churn is mostly path-variant noise.
- `falseMissingChurn` sample shows paths that look missing by exact path but are content-equivalent matches.

## 6) Path Alias Behavior (Important)

Docs now store both:
- `nas_path` (canonical)
- `nas_paths[]` (all known aliases for same doc id/content)

Result:
- Re-ingesting the same content via a different absolute path appends to `nas_paths[]`.
- Canonical `nas_path` stays stable, preventing category/path flip-flop.

## 7) OTEL Checks

Core ingest telemetry:

```bash
joelclaw otel search "docs.file.validated" --hours 1
joelclaw otel search "docs.taxonomy.classified" --hours 1
joelclaw otel search "docs.chunks.indexed" --hours 1
joelclaw otel search "docs.path.aliases.updated" --hours 24
```

Timeout signal (taxonomy subprocess guard):

```bash
joelclaw otel search "docs.taxonomy.classify.timeout" --hours 24
```

## 8) Troubleshooting

### Stuck running at validate step with NAS paths

Symptom in run trace:
- `validate-file` retries/fails with `EINTR: interrupted system call, open '/Volumes/three-body/...`

Find quickly:

```bash
joelclaw otel search "EINTR: interrupted system call" --hours 1
```

Mitigation:
- Requeue affected files once NAS path is stable.
- Avoid blasting high-concurrency retries on flaky mounts.
- Keep observing run queue and OTEL until the file validates cleanly.

### Finalization/network anomalies

```bash
joelclaw run <run-id>
joelclaw logs worker --lines 120
joelclaw otel search "docs." --hours 1
```

## 9) Useful Maintenance Commands

```bash
joelclaw docs enrich <doc-id>
joelclaw docs reindex --doc <doc-id>
joelclaw docs reindex
```

Use `reindex` to normalize earlier runs after taxonomy/path logic changes.
