# Runbook: Typesense session indexing recovery

Use this when Pi sessions, especially `dark-wizard` sessions, stop appearing in Typesense `runs_dev` / `run_chunks_dev`.

Backed by ADR-0243. Raw Run blobs are authoritative. Typesense is the rebuildable search index.

## State machine

```text
healthy
  └─ latest runs_dev/run_chunks_dev match fresh raw blobs

stale-derived-index
  └─ raw blobs fresh, Typesense latest timestamp old

runtime-wedged
  └─ Inngest accepts memory/run.captured events, but runs stay queued/running or GQL hangs

embed-failing
  └─ memory/run.captured fails at embed, often Ollama 500 unsupported value: NaN

backfilling
  └─ rebuild missing Typesense docs from raw blobs

verified
  └─ latest dark-wizard runs and chunks are current; memory/run.captured completes
```

## 0. Rules

- Do not print secrets.
- Do not mutate Inngest SQLite directly.
- Do not replay thousands of `memory/run.captured` events unless you intend to stress Inngest. Backfill from blobs instead.
- Log restarts/fixes before final response:

```bash
joelclaw log write \
  --session <session-handle> \
  --system panda \
  --action restart \
  --tool inngest \
  --detail "Restarting Inngest to clear stale memory/run.captured queue leases" \
  --reason "runs_dev/run_chunks_dev stale while raw run blobs are fresh"
```

## Fast path: search sessions before diagnosing

Use the bridge first. It searches the Central Typesense derived index and raw Pi session files, locally when running on that Machine or remotely over SSH.

```bash
joelclaw sessions search "<query>" \
  --source both \
  --machine dark-wizard \
  --ssh-target joel@dark-wizard \
  --limit 8
```

If `source=typesense` has nothing but `source=local` or `source=ssh` finds hits, raw sessions exist and the derived Typesense index is stale. Continue with this runbook. If `sessions search --source both` reports `typesenseUnavailable` but still returns raw hits, treat that as derived-index or credential unavailability, not raw capture loss.

If SSH fails:

```bash
ssh joel@dark-wizard 'hostname && python3 --version && find ~/.pi/agent/sessions -type f -name "*.jsonl" | head'
```

## 1. Check Typesense itself

```bash
KEY=$(secrets lease typesense_api_key)
curl -fsS http://localhost:8108/health | jq .
```

Healthy output:

```json
{ "ok": true }
```

If this fails, debug Typesense/k8s first:

```bash
kubectl -n joelclaw get pod typesense-0
kubectl -n joelclaw logs typesense-0 --tail=100
```

## 2. Check latest derived session docs

Latest Pi runs:

```bash
KEY=$(secrets lease typesense_api_key)
curl -fsS -G http://localhost:8108/collections/runs_dev/documents/search \
  -H "X-TYPESENSE-API-KEY: $KEY" \
  --data-urlencode 'q=*' \
  --data-urlencode 'filter_by=agent_runtime:=pi' \
  --data-urlencode 'per_page=8' \
  --data-urlencode 'sort_by=started_at:desc' \
  --data-urlencode 'include_fields=id,machine_id,started_at,tags' \
  | jq '[.hits[].document | {id,machine_id,started_at:(.started_at/1000|todateiso8601),session:((.tags // [])[]? | select(startswith("session:")) | sub("session:";""))}]'
```

Latest dark-wizard only:

```bash
KEY=$(secrets lease typesense_api_key)
curl -fsS -G http://localhost:8108/collections/runs_dev/documents/search \
  -H "X-TYPESENSE-API-KEY: $KEY" \
  --data-urlencode 'q=*' \
  --data-urlencode 'filter_by=agent_runtime:=pi && machine_id:=dark-wizard' \
  --data-urlencode 'per_page=8' \
  --data-urlencode 'sort_by=started_at:desc' \
  --data-urlencode 'include_fields=id,machine_id,started_at,tags' \
  | jq '[.hits[].document | {id,machine_id,started_at:(.started_at/1000|todateiso8601),session:((.tags // [])[]? | select(startswith("session:")) | sub("session:";""))}]'
```

Latest chunks:

```bash
KEY=$(secrets lease typesense_api_key)
curl -fsS -G http://localhost:8108/collections/run_chunks_dev/documents/search \
  -H "X-TYPESENSE-API-KEY: $KEY" \
  --data-urlencode 'q=*' \
  --data-urlencode 'filter_by=agent_runtime:=pi && machine_id:=dark-wizard' \
  --data-urlencode 'per_page=5' \
  --data-urlencode 'sort_by=started_at:desc' \
  --data-urlencode 'include_fields=id,run_id,machine_id,started_at,role,text' \
  | jq '[.hits[].document | {id,run_id,machine_id,started_at:(.started_at/1000|todateiso8601),role,text:(.text|gsub("[[:space:]]+";" ")|.[0:120])}]'
```

## 3. Check raw blobs

Raw blobs live here by default:

```bash
ls -lt ~/.joelclaw/runs-dev/joel/$(date -u +%Y-%m)/ | head -20
```

Compare fresh `.metadata.json` / `.jsonl` files with latest `runs_dev` timestamp.

If raw blobs are fresh but Typesense is old, capture works and the derived index is broken.

## 4. Check Inngest / worker health

```bash
joelclaw status
JOELCLAW_INNGEST_RUNS_GQL_TIMEOUT_MS=90000 joelclaw runs --count 20 --hours 1 --compact
JOELCLAW_INNGEST_RUNS_GQL_TIMEOUT_MS=90000 joelclaw runs --count 20 --hours 1 --status FAILED --compact
```

Look for:

- `memory/run.captured` stuck `QUEUED` / `RUNNING`
- `joelclaw runs` timing out
- Inngest logs showing stale queue jobs or trace insert `context canceled`

```bash
kubectl -n joelclaw logs inngest-0 --since=20m --tail=400 | rg 'memory/run.captured|context canceled|queue|failed|error' -C 2
```

Worker logs:

```bash
rg -n 'memory/run.captured|ollama|NaN|embed|Typesense search failed' \
  ~/.local/log/system-bus-worker.err ~/.local/log/system-bus-worker.log -C 3
```

## 5. Fix runtime wedge

Log first. Then restart Inngest and force worker registration:

```bash
kubectl -n joelclaw delete pod inngest-0 --grace-period=30
kubectl -n joelclaw wait --for=condition=Ready pod/inngest-0 --timeout=180s
curl -fsS -X PUT http://127.0.0.1:3111/api/inngest | jq .
```

Verify:

```bash
joelclaw runs --count 5 --hours 1 --compact
```

## 6. Fix worker code reload if embedding changed

The local system-bus worker runs under `worker-supervisor`. If code was patched but the process is still old, kill the Bun child and let supervisor restart it:

```bash
ps -eo pid,ppid,lstart,command | rg 'bun run src/serve.ts|worker-supervisor'
kill <bun-serve-pid>
sleep 8
curl -fsS http://127.0.0.1:3111/ | jq '{status,functionCount:(.functions|length // .functionCount)}'
curl -fsS -X PUT http://127.0.0.1:3111/api/inngest | jq .
```

## 7. Check Ollama embedding failure

Known failure:

```text
ollama embed failed: 500 Internal Server Error — {"error":"failed to encode response: json: unsupported value: NaN"}
```

Smoke test:

```bash
curl -s -o /tmp/embed.out -w '%{http_code}\n' \
  http://localhost:11434/api/embed \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3-embedding:8b","input":"hello","dimensions":768}'
```

`qwen3-embedding:8b` can fail on code-like snippets such as bare `import`. The inference router should retry and then embed `passage:\n<text>` as a fallback. If that code is missing, fix `packages/inference-router/src/embeddings.ts` before replay/backfill.

## 8. Backfill from raw blobs

Use the repo script. This writes directly to `runs_dev` and `run_chunks_dev` from raw blobs.

Dry run:

```bash
cd ~/Code/joelhooks/joelclaw
TYPESENSE_API_KEY=$(secrets lease typesense_api_key) \
  bun scripts/backfill-run-typesense.ts \
  --since 2026-05-20T15:00:00Z \
  --machine dark-wizard \
  --runtime pi \
  --limit 0 \
  --dry-run
```

Backfill:

```bash
cd ~/Code/joelhooks/joelclaw
TYPESENSE_API_KEY=$(secrets lease typesense_api_key) \
  bun scripts/backfill-run-typesense.ts \
  --since 2026-05-20T15:00:00Z \
  --machine dark-wizard \
  --runtime pi \
  --limit 0 \
  --sleep-ms 100
```

If you only need a safe canary:

```bash
TYPESENSE_API_KEY=$(secrets lease typesense_api_key) \
  bun scripts/backfill-run-typesense.ts \
  --since <stale-iso> \
  --machine dark-wizard \
  --runtime pi \
  --limit 3 \
  --sleep-ms 50
```

## 9. Verify recovery

Typesense latest dark-wizard should now be current:

```bash
KEY=$(secrets lease typesense_api_key)
curl -fsS -G http://localhost:8108/collections/runs_dev/documents/search \
  -H "X-TYPESENSE-API-KEY: $KEY" \
  --data-urlencode 'q=*' \
  --data-urlencode 'filter_by=agent_runtime:=pi && machine_id:=dark-wizard' \
  --data-urlencode 'per_page=3' \
  --data-urlencode 'sort_by=started_at:desc' \
  --data-urlencode 'include_fields=id,machine_id,started_at,tags' \
  | jq '[.hits[].document | {id,machine_id,started_at:(.started_at/1000|todateiso8601)}]'
```

Recent `memory/run.captured` should complete:

```bash
JOELCLAW_INNGEST_RUNS_GQL_TIMEOUT_MS=90000 joelclaw runs --count 20 --hours 1 --compact \
  | jq '.result.rows[] | select(.functionName=="memory/run.captured")'
```

## 10. Search bridge breadcrumb

Canonical CLI surface:

```bash
joelclaw sessions search "<query>" --source both --machine dark-wizard --ssh-target joel@dark-wizard
```

Use `--source local` on dark-wizard itself to bypass Typesense and scan raw Pi session files without SSH-to-self.

Use `--source ssh` from Panda to bypass Typesense and scan raw Pi session files on dark-wizard over SSH.

Use `--source typesense` to check only `run_chunks_dev`.

Use extraction before spelunking raw JSONL manually:

```bash
joelclaw sessions search "<query>" --source both --machine dark-wizard --limit 5 --extract
joelclaw sessions extract <session-id-or-path> --query "<topic>" --format markdown
joelclaw sessions inspect <session-id-or-path> --around "<regex>" --before 20 --after 80
```

## 11. pi-rag breadcrumb

If `rag_search_sessions` returns:

```text
Typesense config missing. Set TYPESENSE_HOST and TYPESENSE_API_KEY.
```

then the current Pi process probably loaded an old `pi-rag` extension or lacks env.

Check patched behavior outside the current Pi process:

```bash
cd ~/Code/joelhooks/pi-rag
bun run build
bun test
bun - <<'TS'
import { PiRagService } from './dist/core/service.js';
const svc = new PiRagService();
const hits = await svc.searchSessions('dark wizard typesense indexing', 3, { rerank: false });
console.log(JSON.stringify(hits, null, 2));
TS
```

If that works but the tool still fails, start a new Pi session or restart the long-lived Pi process so the extension reloads.
