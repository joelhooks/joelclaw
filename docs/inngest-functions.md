# Inngest Functions

Canonical notes for `packages/system-bus/src/inngest/functions/`.

## Contract

- Durable workflows only (`step.run`, `step.sendEvent`, etc.).
- Retries are mandatory (`retries: 0` is forbidden unless explicitly justified in ADR).
- Every critical branch emits OTEL evidence.
- Health checks should route remediation via `system/self.healing.requested` and carry playbook context.
- Never use `Bun.spawnSync` for `joelclaw` CLI calls inside handlers that also depend on worker/HTTP probes; use async subprocesses with explicit timeouts to avoid worker event-loop deadlocks.
- For inference calls that must return machine-readable output, set `json: true` plus `requireJson: true` (and `requireTextOutput: true` where needed) so null/empty outputs are treated as failures, not successes.
- Worker code must not import `packages/cli/src/*` via relative paths. Keep recovery-runbook helpers local to `packages/system-bus` (or move them to a leaf package) and avoid introducing `@joelclaw/system-bus` ↔ `@joelclaw/sdk` dependency cycles that break Turbo/Vercel builds.

## Key reliability flows

### System health

- function: `system/check-system-health`
- file: `packages/system-bus/src/inngest/functions/check-system-health.ts`
- inputs:
  - cron heartbeat checks
  - `system/health.check.requested`
- checks include core services (`Inngest`, `Worker`, `Redis`, etc.) and mount probes.

### Self-healing router

- function: `system/self-healing.router`
- file: `packages/system-bus/src/inngest/functions/self-healing-router.ts`
- input event: `system/self.healing.requested`
- responsibility: apply retry/defer/escalate policy and emit target remediation events.

### Inngest runtime remediation (new)

- function: `system/self-healing.inngest-runtime`
- file: `packages/system-bus/src/inngest/functions/self-healing-inngest-runtime.ts`
- triggers:
  - cron: `TZ=America/Los_Angeles */10 * * * *`
  - `system/inngest.runtime.health.requested`
  - `system/self.healing.requested` (domain-filtered)
- behavior:
  1. probe runtime health (`joelclaw inngest status`)
  2. if degraded and not dry run, run `joelclaw inngest restart-worker --register --wait-ms 1500`
  3. re-probe and emit before/after OTEL evidence

### Host worker startup preflight + supervisor OTEL

- component: `infra/worker-supervisor/src/main.rs`
- applies to host worker launch path (`com.joel.system-bus-worker`)
- behavior:
  1. before spawning `bun run src/serve.ts`, supervisor runs a host-import preflight:
     - `bun --eval "await import('./src/inngest/functions/index.host.ts');"`
  2. if preflight fails (syntax/import regression), supervisor **does not spawn** worker, logs clipped Bun error, and retries with exponential backoff
  3. supervisor now emits explicit OTEL events through `joelclaw otel emit`:
     - `worker.supervisor.preflight.failed`
     - `worker.supervisor.worker_exit`
     - `worker.supervisor.health_check.restart`

Operational impact: startup regressions are surfaced immediately with structured telemetry instead of looking like generic flapping.

### Stale RUNNING run forensics (SDK outage fallout)

Observed failure mode during worker/runtime blips:

- Inngest server logs show `Unable to reach SDK URL` / `EOF writing request to SDK`.
- Historical runs can remain listed as `RUNNING` even when there is no live cancellable execution.
- `cancelRun` can return `not found` for those stale IDs.

Operational contract:

1. **Trust run detail over list**
   - use `joelclaw run <run-id>` to inspect trace/errors first.
2. **Use backup-first DB surgery only when needed**
   - runtime DB: `kubectl -n joelclaw exec inngest-0 -- sqlite3 /data/main.db`
   - backup first: `.backup /data/main.db.pre-sweep-<ts>.sqlite`
3. **Terminalize stale runs with full state updates**
   - ensure terminal history row exists (`FunctionCancelled`),
   - ensure `function_finishes` row exists,
   - then set `trace_runs.status=500` for stale candidates.
4. **Re-verify**
   - run detail should resolve terminal status,
   - `joelclaw runs --status RUNNING` should reflect only active runs.

Preferred operator path: `joelclaw inngest sweep-stale-runs` (preview by default; `--apply` performs backup + transactional terminalization).

Do **not** mutate `main.db` without a point-in-time backup.

### Task triage classification contract

- function: `tasks/triage`
- file: `packages/system-bus/src/inngest/functions/task-triage.ts`
- behavior:
  1. enforces strict JSON classification schema (`id`, `category`, `reason`) for every task ID
  2. retries once with a repair prompt when output is invalid
  3. returns `status: degraded` (not success) when classification remains invalid/null
  4. sets cooldown only when a gateway notification is actually pushed
  5. emits telemetry with `classificationValid`, `triageItemsCount`, `actionableCount`, and `outputFailureReason`

### Memory proposal triage review-task contract

- function: `memory/proposal-triage`
- file: `packages/system-bus/src/inngest/functions/memory/proposal-triage.ts`
- behavior:
  1. proposal triage result (`auto-reject|auto-merge|needs-review|llm-pending`) is authoritative; Todoist task creation is a downstream side effect
  2. Todoist create failures (including `HTTP 403 Forbidden` auth issues) **must not fail the function run**
  3. for `needs-review`, the worker attempts project targets in order:
     - `MEMORY_REVIEW_TODOIST_PROJECT` (default `Agent Work`)
     - `MEMORY_REVIEW_TODOIST_FALLBACK_PROJECT` (default `Joel's Tasks`)
  4. task-create outcomes are persisted on the proposal hash (`reviewTaskStatus`, `reviewTaskId`, `reviewTaskProjectId`, `reviewTaskError`, `reviewTaskLastAttemptAt`)
  5. emits explicit task-create telemetry:
     - `proposal-triage.review-task.created` (includes `projectId`, `projectFallbackUsed`, `attempts`)
     - `proposal-triage.review-task.failed` (includes attempted project list + attempts)

### Content sync ADR frontmatter resilience

- library: `packages/system-bus/src/lib/convex-content-sync.ts` (`upsertAdr`)
- behavior:
  1. malformed ADR frontmatter no longer blocks ADR publication into Convex
  2. on frontmatter parse failure, sync falls back to body-only parsing (`data = {}` + frontmatter block stripped from content)
  3. warning is logged with file path + parse error for operator visibility
- impact: transient YAML/frontmatter edits no longer leave new ADRs missing from `/adrs`; they degrade to default metadata (`status: proposed`, empty rubric) until frontmatter is fixed

### Knowledge turn-write contract (ADR-0202)

- function: `knowledge-turn-write`
- file: `packages/system-bus/src/inngest/functions/knowledge-turn-write.ts`
- trigger: `knowledge/turn.write.requested`
- behavior:
  1. validates turn payload shape and skip-reason enum
  2. enforces summary-or-skip policy (`summary` required unless explicit skip reason)
  3. writes `turn_note` documents into `system_knowledge`
  4. emits OTEL lifecycle events:
     - `knowledge.turn_write.started`
     - `knowledge.turn_write.completed`
     - `knowledge.turn_write.skipped`
     - `knowledge.turn_write.failed`

Watchdog extension:

- `knowledge-watchdog` now checks drift between `knowledge.turn_write.eligible` and accounted outcomes (`completed + skipped + failed`) and alerts on mismatch.

## Backup hardening

### Typesense backup + snapshot retention

- function: `system/backup.typesense`
- file: `packages/system-bus/src/inngest/functions/nas-backup.ts`
- snapshot creation supports primary→fallback root selection.
- backup transport now uses a three-tier write policy:
  1. local NAS mount (`/Volumes/three-body`)
  2. direct remote copy over SSH/SCP to NAS
  3. local deferred queue spool (when both NAS paths are unavailable)
- after successful sync/defer:
  - delete just-created snapshot dir in pod
  - prune old snapshot dirs by retention count

Environment variables:

- `TYPESENSE_SNAPSHOT_ROOT` (default: `/data/snapshots`)
- `TYPESENSE_SNAPSHOT_FALLBACK_ROOT` (default: `/data/snapshots`)
- `TYPESENSE_SNAPSHOT_RETENTION_COUNT` (default: `2`, min `1`)
- `NAS_BACKUP_QUEUE_ROOT` (default: `/tmp/joelclaw/nas-queue`)

Kubernetes note:

- `k8s/typesense.yaml` keeps `typesense-0` NAS-independent at runtime (no hard NFS mount). Snapshot durability is handled by the backup transport flow above, not by pod startup dependencies.

## Webhook subscription dispatch (ADR-0185)

### GitHub workflow completion fan-out

- function: `webhook-subscription-dispatch-github-workflow-run-completed`
- file: `packages/system-bus/src/inngest/functions/webhook-subscription-dispatch.ts`
- trigger: `github/workflow_run.completed`
- responsibilities:
  1. match Redis-backed session subscriptions (`joelclaw:webhook:*`)
  2. prune expired/invalid subscriptions
  3. best-effort fetch workflow artifacts from GitHub Actions API
  4. dedupe delivery per subscription
  5. publish match payloads to subscription NDJSON channels
  6. push `webhook.subscription.matched` to gateway with `originSession` for immediate follow-up turns

## Verification

```bash
bunx tsc --noEmit
bun test packages/system-bus/src/inngest/functions/check-system-health.test.ts
bun test packages/system-bus/src/lib/webhook-subscriptions.test.ts
bun test packages/gateway/src/knowledge-turn.test.ts
joelclaw inngest status
joelclaw otel search "webhook.subscription.dispatch" --hours 1
joelclaw otel search "knowledge.turn_write" --hours 1
```

## Deploy

```bash
./k8s/publish-system-bus-worker.sh
joelclaw inngest restart-worker --register
joelclaw inngest status
```

## Related ADRs

- `docs/decisions/0010-system-loop-gateway.md`
- `~/Vault/docs/decisions/0088-nas-backed-storage-tiering.md`
- `~/Vault/docs/decisions/0187-nas-degradation-local-temp-queue-fallback-contract.md`
- `~/Vault/docs/decisions/0194-inngest-runtime-sqlite-forensics-and-stale-run-sweep.md`
