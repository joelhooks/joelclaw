# Inngest Functions

Canonical notes for `packages/system-bus/src/inngest/functions/`.

## Contract

- Durable workflows only (`step.run`, `step.sendEvent`, etc.).
- Retries are mandatory (`retries: 0` is forbidden unless explicitly justified in ADR).
- Every critical branch emits OTEL evidence.
- Health checks should route remediation via `system/self.healing.requested` and carry playbook context.
- Never use `Bun.spawnSync` for `joelclaw` CLI calls inside handlers that also depend on worker/HTTP probes; use async subprocesses with explicit timeouts to avoid worker event-loop deadlocks.
- `system/agent-dispatch` now supports `tool: "pi"` for real repo work. Pi dispatch must run from the requested `cwd` and enable tools when file work is requested; otherwise Restate PRD story runs inspect the wrong checkout or fail on file-access prompts.
- Host-only internal agent bridge requests must be idempotent by `requestId`. `/internal/agent-dispatch` should return the existing `running|completed|failed|cancelled` snapshot instead of emitting duplicate `system/agent.requested` events, and `system/agent-dispatch` should write a `running` inbox snapshot before long agent execution starts so operators do not see a useless forever-`pending` state.
- `system/agent-dispatch` implements requestId-level deduplication: if a terminal result (`completed|failed|cancelled`) already exists, the function returns that result without spawning a new execution. This prevents duplicate work on retries or repeated dispatches.
- Terminal snapshots (`completed|failed|cancelled`) always include `stdout`/`stderr` output in the `logs` field (truncated to 10KB each) for post-mortem debugging. These are surfaced via the inbox result and OTEL events.
- Cancellation is honored via `cancelOn` config: sending `system/agent.cancelled` with matching `requestId` kills the active subprocess and writes a `cancelled` inbox snapshot. The `onFailure` handler ensures terminal state is written even if the subprocess is killed mid-execution.
- `system/agent-dispatch` supports `executionMode: "host" | "sandbox"` (default: `"host"`). Host mode uses the existing shared-checkout path. Sandbox mode now routes through the proved local sandbox runner on the host worker: it materializes a clean repo checkout at `baseSha`, runs the requested agent inside that temp checkout, exports patch/touched-file artifacts, and keeps the operator checkout clean. **Gate A** (non-coding vertical slice) is proven via `packages/agent-execution/__tests__/gate-a-smoke.test.ts`, and **Gate B** (minimal coding sandbox) is proven via `packages/agent-execution/__tests__/gate-b-smoke.test.ts`; the live dispatch path now consumes those same repo-materialization and artifact-export primitives. Gate C (k8s Job launcher) is still next. `system/agent.requested` should carry `workflowId`, `storyId`, and `baseSha` for deterministic sandbox runs. The execution mode is captured in the `InboxResult.executionMode` field and logged for observability.
- `packages/system-bus/src/lib/inference.ts` must not rely on pipe EOF when capturing `pi` output for tool-enabled background work. Tool subprocesses can inherit stdout/stderr, leaving `infer()` hung after the real `pi` child exits and freezing `system/agent-dispatch` in a false `running` state. Capture to temp files (or another exit-driven sink) and read them after `proc.exited` instead.
- Explicit `infer({ timeout })` budgets are **overall request budgets**, not per-fallback-attempt budgets. Story 6 proved that clamping each attempt to 10 minutes produced three back-to-back SIGTERM kills (`exit 143`) and a misleading 30-minute failure chain. `inference.ts` now preserves up to a 1-hour request budget and spends the remaining deadline across fallback attempts instead of restarting a fresh timeout per attempt.
- Timed-out `pi` attempts must surface as `pi timed out after <ms>` instead of the useless `pi exited 143: empty output` message. If a subprocess timer fired, the timeout must be explicit in the thrown error and OTEL failure event.
- For inference calls that must return machine-readable output, set `json: true` plus `requireJson: true` (and `requireTextOutput: true` where needed) so null/empty outputs are treated as failures, not successes.
- Worker code must not import `packages/cli/src/*` via relative paths. Keep recovery-runbook helpers local to `packages/system-bus` (or move them to a leaf package) and avoid introducing `@joelclaw/system-bus` ↔ `@joelclaw/sdk` dependency cycles that break Turbo/Vercel builds.
- Agent-loop PRDs are preflight-normalized at runtime (`normalizePrdOrThrow`): accepts `acceptance_criteria` plus aliases (`acceptance`, `acceptanceCriteria`), defaults missing `passes`/`priority`, and fails fast with explicit errors when story shape is invalid.

## Key reliability flows

### Restate dual-run Phase-1 (ADR-0207)

Restate is introduced as a **new-workload durable runtime** while Inngest remains primary for existing workflows.

Implemented Phase-1 surfaces:

- k8s runtime manifest: `k8s/restate.yaml`
  - StatefulSet `restate` with pinned image `restatedev/restate:1.6.2`
  - ClusterIP service exposing ingress/admin/metrics ports (`8080/9070/9071`)
  - startup/readiness/liveness probes configured
- Restate service package: `packages/restate/`
  - demonstrates step chain (`ctx.run`), fan-out/fan-in (`ctx.serviceClient`), approval signal workflow (`ctx.promise`), and MinIO artifact persistence
- deployment registration script: `scripts/restate/register-deployment.sh`
  - registers service endpoint via `restate deployments register`
  - lists deployments post-registration
- smoke test script: `scripts/restate/test-workflow.sh`
  - runs end-to-end Restate workflow invocation against k8s runtime
  - verifies MinIO object write/read round-trip from workflow output
  - defaults to `joelclaw/minio`; auto-falls back to `aistor/aistor-s3-api` when MinIO is unavailable
- CLI visibility: `joelclaw restate`
  - `joelclaw restate status` checks runtime/statefulset/service/admin probe
  - `joelclaw restate deployments` shells to Restate CLI listing
  - `joelclaw restate smoke` runs end-to-end workflow+MinIO smoke test

Operational boundary for Phase 1:

- Selected ADR-0216 tier-1 cron ownership has now moved off Inngest and onto Dkron → Restate:
  - `check/system-health-signals-schedule`
  - `skill-garden`
  - `typesense/full-sync`
  - `memory/digest-daily`
  - `subscription/check-feeds`
- Those Inngest functions keep manual/on-demand event triggers where useful, but they no longer own the recurring cron schedule.
- The tier-1 Restate jobs run host-side direct task runners via `scripts/restate/run-tier1-task.ts` so soak results reflect actual work execution.
- The same host-runner pattern now powers `pi-mono-sync`: a Restate DAG that calls `--task pi-mono-artifacts-sync` to materialize repo docs/issues/PRs/comments/commits/releases into Typesense collection `pi_mono_artifacts`, plus `maintainer_profile` and `sync_state` documents.
- Discovery-family pilot cutover has started behind two reversible flags:
  - `QUEUE_PILOTS=discovery` makes `joelclaw discover` enqueue `discovery/noted` into the shared queue instead of sending directly to Inngest.
  - `runSubscriptionCheckSingleDirect()` now does the same for feed-published discovery items on the direct Restate/Dkron path, and this has been proved live with `publishMode: queue` on a real subscription check.
  - `QUEUE_PILOTS=discovery-captured` makes the `discovery-capture` function enqueue its follow-up `discovery/captured` event into the shared queue instead of using `step.sendEvent` directly.
  - the legacy Inngest `subscription/check-single` path still uses `step.sendEvent` for now, so pilot cutover remains incremental and reversible.
- Subscription-request pilot cutover has now started behind `QUEUE_PILOTS=subscriptions`:
  - unscoped `joelclaw subscribe check` enqueues `subscription/check-feeds.requested` into the shared queue instead of posting directly to Inngest.
  - the queue registry now stores the concrete Inngest event name (`subscription/check-feeds.requested`) as the drainer target; using function ids like `subscription/check-feeds` is wrong because the drainer posts events, not function identifiers.
- GitHub webhook ingress is now the third pilot family behind `QUEUE_PILOTS=github`:
  - `POST /webhooks/github` keeps direct emission as the default path.
  - when the flag is enabled, normalized `workflow_run.completed` webhook events are persisted into the shared queue first and the Restate drainer forwards the concrete `github/workflow_run.completed` event onward.
  - `github/package.published` remains on the legacy direct-to-Inngest path for now.
- `content/updated` is the remaining launchd-backed pilot family behind `QUEUE_PILOTS=content`:
  - canonical watcher source now lives in `infra/launchd/com.joel.content-sync-watcher.plist` and `scripts/content-sync-watcher.sh`.
  - the watcher reads `~/.config/system-bus.env` on each trigger and chooses `joelclaw queue emit content/updated` when the `content` pilot is enabled, otherwise it falls back to legacy `joelclaw send content/updated`.
  - this keeps the queue cutover reversible without leaving an untracked plist in `~/Library/LaunchAgents` as the only source of truth.
- Story 5 operator surface now starts from `joelclaw queue stats` instead of ad-hoc Redis/OTEL spelunking:
  - the command queries `queue.dispatch.started|completed|failed` OTEL from the Restate drainer and summarizes sample coverage, success/failure counts, queue wait-time percentiles, dispatch durations, promotion count, top event families, and recent failures.
  - `metadata.waitTimeMs` from `queue.dispatch.started` is the canonical Phase-1 queue-to-dispatch latency signal.
  - `joelclaw queue stats --since <iso|ms>` can pin the lower bound to a known-clean moment (for example the supervised Restate `queue.drainer.started` after rollout) so Story 5 soak evidence does not mix fresh traffic with a dirty pre-fix window.
  - this is the first human sanity-pass tool for the "Joel can inspect queue state from CLI only" Story 5 acceptance gate.
- Phase 2 Story 1 now defines the bounded queue-triage contract in `packages/system-bus/src/lib/queue-triage.ts`:
  - Haiku is the canonical triage model (`MODEL.HAIKU`) for this queue-admission layer.
  - the model may only shape `priority`, `dedupKey`, and `routeCheck` (`confirm|mismatch`). It may not invent handler targets or override the registry route.
  - canonical fallback reasons are `disabled|timeout|model_error|invalid_json|schema_error|unsafe_override`.
  - canonical OTEL vocabulary is `queue.triage.started|completed|failed|fallback` with `eventId`, `correlationId`, `family`, `mode`, and latency metadata.
  - the queue envelope can now carry optional `trace.correlationId|causationId` plus optional `triage` metadata without making the deterministic queue core depend on model output for correctness.
- Phase 2 Story 2 now routes queue admission through one canonical server-side surface in `packages/system-bus/src/lib/queue.ts`:
  - worker-local ingress paths (`discovery-capture`, direct subscription discovery publish, GitHub webhook queueing) call `enqueueRegisteredQueueEvent()` directly.
  - edge clients (`joelclaw queue emit`, `joelclaw discover`, queue-mode `joelclaw subscribe check`) post raw event intent to `POST /internal/queue/enqueue` so they stay thin and stop writing Redis directly.
  - shadow triage is opt-in via `QUEUE_TRIAGE_MODE=shadow` and `QUEUE_TRIAGE_FAMILIES=discovery,content,subscriptions,github` (or exact event names).
  - Story 2 still clamps admission to static registry routing and shadow-mode final decisions; enforcement has not earned a runtime path yet.
- Do not migrate tier-2 cron candidates until the Dkron/Restate tier-1 soak shows clean execution and observable failure behavior.

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

### Host worker rollout reality

The running host worker is sourced from the separate checkout at `~/Code/system-bus-worker/`, launched by `com.joel.system-bus-worker` via `~/Code/system-bus-worker/packages/system-bus/start.sh`.

After changing host-role functions in the monorepo:

1. push to `origin`
2. `cd ~/Code/system-bus-worker && git pull --ff-only`
3. `launchctl kickstart -k gui/$(id -u)/com.joel.system-bus-worker`
4. `curl -X PUT http://127.0.0.1:3111/api/inngest`

Do not assume the live host worker reloads directly from `~/Code/joelhooks/joelclaw/`.

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

### Email triage + nag contract

- functions:
  - `check/email-triage` (`packages/system-bus/src/inngest/functions/check-email.ts`)
  - `email-nag` (`packages/system-bus/src/inngest/functions/email-nag.ts`)
- behavior:
  1. triage is **nag-first** for human senders (`reply-needed` default for real-person emails)
  2. `interesting` is a first-class escalation action (never silently archived)
  3. escalation notifications include direct Front deep links (`https://app.frontapp.com/open/<conversationId>`)
  4. `email-nag` runs on cron `0 17,22 * * *` (9am/2pm PST), leases `front_api_token`, and only nags for inbound-last conversations waiting `>4h`
  5. nag digests are sorted oldest-first and delivered through `pushGatewayEvent`

### Channel intelligence triage to Todoist

- function: `channel-intelligence-todoist`
- file: `packages/system-bus/src/inngest/functions/channels/channel-intelligence-todoist.ts`
- trigger: `channel/intelligence.triage.requested`
- behavior:
  1. scans Front unreplied inbox via `joelclaw email inbox -q "is:open is:unreplied" -n 50`
  2. leases `slack_user_token` and searches VIP channels + Joel mentions over configurable lookback window
  3. extracts concrete verb-first action items using `infer()` with strict JSON output
  4. creates Todoist tasks via `todoist-cli add` with priority map `p2→3`, `p3→2`, `p4→1`
  5. returns summary payload with `tasksCreated`, per-source scan counts, and task outcomes

### Channel intelligence garden

- function: `channel-intelligence-garden`
- file: `packages/system-bus/src/inngest/functions/channels/channel-intelligence-garden.ts`
- triggers:
  - cron: `0 */6 * * *`
  - `channel/intelligence.garden.requested`
- behavior:
  1. pulls active Todoist tasks (`todoist-cli list --json`) plus inbox snapshot (`todoist-cli inbox --json`)
  2. scopes to channel-intelligence tasks (email/slack source markers) and computes duplicate/consolidation plans
  3. checks email-linked tasks against Front (`joelclaw email read --id <conversationId>`) and auto-completes archived/replied threads
  4. evaluates stale low-priority tasks (>3 days, no progress) via `infer()` for keep/escalate/complete/delete decisions
  5. applies actions (complete/delete/priority update/description consolidation) and returns `{ reviewed, completed, deleted, escalated, duplicatesRemoved }`

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

## Swarm DAG spike (ADR-0060 follow-up)

- function: `swarm-orchestrator`
- file: `packages/system-bus/src/inngest/functions/swarm-orchestrator.ts`
- trigger: `swarm/started`
- behavior:
  1. parse + validate swarm YAML (`packages/system-bus/src/swarm/schema.ts`)
  2. build dependency graph + detect cycles + compute execution waves (`packages/system-bus/src/swarm/dag.ts`)
  3. execute each wave in parallel via `step.invoke()` of `swarm-agent-exec`
  4. emit `swarm/completed` with `completed|failed` status

- function: `swarm-agent-exec`
- file: `packages/system-bus/src/inngest/functions/swarm-agent-exec.ts`
- invocation: `step.invoke()` from orchestrator (spike wiring)
- behavior:
  1. receive agent config + workspace + wave
  2. spawn agent tool (codex/claude/pi) with codex using `codex exec --full-auto -m <model>` pattern
  3. return structured success/failure summary

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
