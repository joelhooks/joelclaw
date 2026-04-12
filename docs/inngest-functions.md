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
- `system/agent-dispatch` supports `executionMode: "host" | "sandbox"` (default: `"host"`). Host mode uses the existing shared-checkout path. Sandbox mode now has two backends: `sandboxBackend: "local" | "k8s"` (default local), plus a local runtime mode hint `sandboxMode: "minimal" | "full"` when the local backend is selected. The **local** backend remains the proved live path on the host worker: it materializes a clean checkout at `baseSha`, runs the requested agent inside that sandbox, exports patch/touched-file artifacts, and keeps the operator checkout clean. **Gate A** (non-coding vertical slice) is proven via `packages/agent-execution/__tests__/gate-a-smoke.test.ts`, and **Gate B** (minimal coding sandbox) is proven via `packages/agent-execution/__tests__/gate-b-smoke.test.ts`; the live dispatch path consumes those same repo-materialization and artifact-export primitives. Phase 4 now adds an opt-in **full local mode** that maps the requested sandbox `cwd` into the cloned checkout, discovers compose files relative to that workdir, reserves the sandbox-specific `COMPOSE_PROJECT_NAME`, and brings the compose project up before agent execution starts. Dogfood proved one more guardrail is necessary: sandboxed stage runs must not start nested workflow-rig runs from inside the sandbox, so the task contract now forbids `joelclaw workload run` / `scripts/verify-workload-full-mode.ts` recursion and the CLI blocks nested workload admission unless explicitly overridden for debugging. Current earned truth: guarded full-mode workflow-rig stage-2 dogfood now completes terminally (`WR_20260310_013158`), records the required `full-mode-ok|full|...` proof line inside the returned summary, and tears the compose runtime back down cleanly. The live host-worker path now also has a **non-LLM canary tool** (`tool: "canary"`) for deterministic verification only: it runs fixed scenario commands such as `sleep-timeout` and `orphan-stderr` through the same subprocess capture and terminal inbox/registry writeback path without involving Codex, Claude, or Pi. The canonical live timeout proof is `bun scripts/verify-agent-dispatch-timeout.ts`, the canonical on-demand operator surface is `joelclaw status --agent-dispatch-canary`, the default status envelope now surfaces `latestAgentDispatchCanary`, and the existing scheduled health pipeline can optionally include the same timeout proof when `HEALTH_AGENT_DISPATCH_CANARY_SCHEDULE=signals` is set in the live host-worker environment. Default remains `off`. The **k8s** backend has also landed as an opt-in control plane: `@joelclaw/agent-execution` owns Job spec generation, Job launch/status/log parsing, log-marker result extraction, and the `job-runner.ts` runtime contract; `system-bus` now accepts callback results at `/internal/agent-result` and preserves `InboxResult.sandboxBackend` plus optional Job metadata. For deterministic isolated k8s runs, `system/agent.requested` should now carry `workflowId`, `storyId`, `baseSha`, `repoUrl`, and `branch`. `pi` remains a local-backend story executor for now; the k8s runner is meant for runner-installed CLIs until host-routed pi-in-pod execution is designed.
- `packages/system-bus/src/lib/inference.ts` must not rely on pipe EOF when capturing `pi` output for tool-enabled background work. Tool subprocesses can inherit stdout/stderr, leaving `infer()` hung after the real `pi` child exits and freezing `system/agent-dispatch` in a false `running` state. Capture to temp files (or another exit-driven sink) and read them after `proc.exited` instead.
- `packages/system-bus/src/inngest/functions/agent-dispatch.ts` uses the same exit-driven temp-file capture rule for codex/claude/bash subprocesses and sandbox infra commands. Waiting on `Response(proc.stdout).text()` / pipe EOF here is a bug class: descendants can inherit the descriptors, block terminal inbox writeback, and strand sandbox runs in fake `running` state even after the real work already failed or finished.
- Explicit `infer({ timeout })` budgets are **overall request budgets**, not per-fallback-attempt budgets. Story 6 proved that clamping each attempt to 10 minutes produced three back-to-back SIGTERM kills (`exit 143`) and a misleading 30-minute failure chain. `inference.ts` now preserves up to a 1-hour request budget and spends the remaining deadline across fallback attempts instead of restarting a fresh timeout per attempt.
- Timed-out `pi` attempts must surface as `pi timed out after <ms>` instead of the useless `pi exited 143: empty output` message. If a subprocess timer fired, the timeout must be explicit in the thrown error and OTEL failure event.
- Long-form content-review inference (`content/review.submitted`) must set an explicit timeout budget on every `infer()` call instead of inheriting the shared 120s default. Current contract: rewrite/retry/verify all use a 300s budget so long posts do not die in `agent-edit` after the bookkeeping steps already succeeded.
- Post content-review cache invalidation must revalidate the markdown twin as well as the human page. Current contract for `post` content: tags `post:<slug>`, `article:<slug>`, `articles`; paths `/`, `/<slug>`, `/<slug>.md`, `/<slug>/md`, `/feed.xml`, `/sitemap.md`.
- VIP delivery functions (`vip/email-received`, `vip/email-brief`) now send the operator brief directly to Telegram via `packages/system-bus/src/lib/telegram.ts`. `vip/email-received` no longer pushes a duplicate gateway event for operator delivery, and the generic Front notifier skips VIP senders so one VIP email produces exactly one operator-facing notification. Strip relay-only instructions before direct delivery and return `telegramDelivered`/`telegramError` in function output so failures are visible in run traces.
- `vip/email-received` analysis/brief inference must stay inside bounded prompt and timeout budgets: compact the prompt to head+tail thread context plus clipped link/memory/repo/access-gap excerpts, include prompt-size metadata on the `infer()` calls, and use `maxAttempts: 1` when a caller-specific fallback plan is better than spending an overall request budget on a toothless router fallback chain.
- `vip/email-threads.backfill` is the one-shot Front history hydrator for Typesense `email_threads`: ensure the collection first, resolve VIP sender emails from `getVipSenders()`, walk `/contacts/alt:email:{email}/conversations` with `_pagination.next`, fetch each conversation's messages, and upsert canonical thread docs so narrative VIP briefs can refer to prior email arcs.
- For inference calls that must return machine-readable output, set `json: true` plus `requireJson: true` (and `requireTextOutput: true` where needed) so null/empty outputs are treated as failures, not successes.
- ADR pitch automation now has a closed funnel: `system-heartbeat` emits `adr/pitch.requested` once per local morning window (8:00–10:00 America/Los_Angeles) behind Redis key `adr:pitch:last-fired` with a 20h TTL; `adr-daily-pitch` emits OTEL `pitch.sent`; `telegram-callback` emits OTEL `pitch.responded`; `adr-pitch-execute` handles `adr/pitch.approved` by reading the ADR file from `~/Vault/docs/decisions`, running `codex exec --full-auto -C <repo> "<prompt>"` (prompt is positional; `-p` is Codex profile, not prompt), verifying `bunx tsc --noEmit`, storing rollback metadata at `adr:pitch:rollback:<adr_number>`, and sending Telegram success/failure notifications via `pushGatewayEvent`.
- Worker code must not import `packages/cli/src/*` via relative paths. Keep recovery-runbook helpers local to `packages/system-bus` (or move them to a leaf package) and avoid introducing `@joelclaw/system-bus` ↔ `@joelclaw/sdk` dependency cycles that break Turbo/Vercel builds.
- Agent-loop PRDs are preflight-normalized at runtime (`normalizePrdOrThrow`): accepts `acceptance_criteria` plus aliases (`acceptance`, `acceptanceCriteria`), defaults missing `passes`/`priority`, and fails fast with explicit errors when story shape is invalid.

## Docs Pipeline v2 (ADR-0234)

- `docs-reindex-v2` is the staged reindex path for PDFs. It persists durable artifacts under `JOELCLAW_DOCS_ARTIFACTS_DIR` (default `/tmp/docs-artifacts`) as `{docId}.md`, `{docId}.meta.json`, and `{docId}.chunks.jsonl`.
- Keep the four durable steps stable: `convert-pdf` → `classify-summarize` → `chunk` → `index-typesense`. Re-runs should reuse artifacts whenever `skipExistingArtifacts` is true.
- Reuse `docs-ingest.ts` helpers for PDF extraction, taxonomy classification, chunk-record building, and Typesense schema setup instead of re-implementing classification logic in multiple places.
- `docs_chunks_v2` is the new retrieval collection. It uses Typesense auto-embedding with `ts/nomic-embed-text-v1.5`; leave `docs_chunks` intact until cutover is complete.
- Batch orchestration now flows through `docs-reindex-batch`, which resolves PDF targets (provided paths, collection records, or `/Volumes/three-body/books` scan) and dispatches `docs/reindex-v2.requested` in batches of 10.

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
  - `discovery/noted` now accepts routing metadata: `site` (`joelclaw|wizardshit|shared`) and `visibility` (`public|private|archived|migration-only`). The current default when omitted is `site=joelclaw`, `visibility=public`.
  - `runSubscriptionCheckSingleDirect()` now does the same for feed-published discovery items on the direct Restate/Dkron path, and this has been proved live with `publishMode: queue` on a real subscription check.
  - `QUEUE_PILOTS=discovery-captured` makes the `discovery-capture` function enqueue its follow-up `discovery/captured` event into the shared queue instead of using `step.sendEvent` directly.
  - `discovery-capture` now resolves routing metadata from the written note, computes a `finalLink`, and returns/forwards `site`, `visibility`, and `finalLink` in its completion payload.
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
  - edge clients (`joelclaw queue emit`, `joelclaw workload run`, `joelclaw discover`, queue-mode `joelclaw subscribe check`) post raw event intent to `POST /internal/queue/enqueue` so they stay thin and stop writing Redis directly.
- `joelclaw workload run` is now the canonical workload-to-runtime bridge: it normalizes a saved workload artifact into queue family `workload/requested`, and the static queue registry routes that family to the real runtime event `system/agent.requested`.
  - base triage remains opt-in via `QUEUE_TRIAGE_MODE=shadow|enforce` plus `QUEUE_TRIAGE_FAMILIES=discovery,content,subscriptions,github` (or exact event names).
  - `QUEUE_TRIAGE_ENFORCE_FAMILIES=discovery,github` is the narrow Story 4 override that upgrades only `discovery/noted` and `github/workflow_run.completed` into enforce while leaving other enabled families in shadow.
  - handler routing stays registry-derived even in enforce mode; triage only shapes bounded admission fields.
- Phase 2 Story 3 extends `joelclaw queue stats` into the triage operator surface:
  - the command now reads both Restate drainer OTEL and `queue.triage.*` OTEL in one window.
  - the triage block summarizes attempts, fallback counts by reason, disagreement counts, applied-vs-suggested deltas, route mismatches, latency percentiles, per-family rollups, and recent mismatch/fallback samples.
  - if Story 3 cannot explain queue-admission behavior from this one command, the operator surface is still unfinished.
- Phase 3 Story 1 now defines the bounded Sonnet observation contract in `packages/system-bus/src/lib/queue-observe.ts`:
  - the canonical queue snapshot builder produces `QueueObservationSnapshot` with totals, per-family rollups, triage summary, drainer summary, gateway reporting state, and current active deterministic pauses so resume suggestions are grounded in real control state.
  - Sonnet is the canonical observation model (`MODEL.SONNET`) for this layer and still goes through the shared `infer()` path.
  - the observer may only return the bounded action enum (`noop|pause_family|resume_family|reprioritize_family|batch_family|shed_family|escalate`), and families must already exist in the supplied snapshot queue families or active pause state.
  - canonical fallback reasons are `disabled|timeout|model_error|invalid_json|schema_error|unsafe_action`.
  - canonical OTEL vocabulary is `queue.observe.started|completed|failed|fallback` plus `queue.control.applied|expired|rejected`.
  - overly long Sonnet summaries are now trimmed instead of causing bogus schema fallbacks during live canaries.
  - Story 1 stops short of the deterministic pause/resume control plane: `finalActions` are safety-filtered, but no automatic queue mutation exists yet.
- Phase 3 Story 2 adds the dry-run operator surface on the installed CLI:
  - `joelclaw queue observe` builds the live snapshot from current queue state, recent drainer OTEL, recent triage OTEL, and gateway sleep/muted-channel state before calling the bounded Sonnet observer.
  - when the backlog is entirely explained by fresh active **manual** pauses and there are no recent drainer/triage failures, the shared observer contract now short-circuits to a deterministic `noop` instead of burning the full Sonnet timeout on an obvious operator hold state.
  - when queued work is entirely held behind a settled active **observer** pause and there are still no fresh drainer/triage failures, the shared observer now normalizes that self-imposed hold back to `downstreamState=healthy` and short-circuits to a deterministic `resume_family` instead of mistaking zero dispatch throughput for ongoing downstream failure.
  - the command returns the current `snapshot`, the current dry-run `decision`, `history` from `queue.observe.*` OTEL, and the current deterministic `control` block.
  - Story 2 keeps all automatic queue control mutations absent; `appliedCount` remains zero and the CLI must say so plainly.
- Phase 3 Story 3 adds the deterministic queue-control plane before any automatic Sonnet mutation:
  - `@joelclaw/queue` now owns Redis-backed family pause state plus deterministic `pauseQueueFamily`, `resumeQueueFamily`, `expireQueueFamilyPauses`, and `listActiveQueueFamilyPauses` helpers.
  - `packages/restate/src/queue-drainer.ts` reaps expired pauses, emits `queue.control.expired`, and filters paused families out of dispatch candidates without dropping queued work.
  - the installed CLI now exposes `joelclaw queue pause`, `joelclaw queue resume`, and `joelclaw queue control status`.
  - queue operator commands resolve Redis from the canonical CLI config (`~/.config/system-bus.env` → `REDIS_URL`) before ambient shell env so manual controls target the same localhost queue as the worker and drainer.
- Phase 3 Story 4 now has a live host-worker runtime path in `packages/system-bus/src/inngest/functions/queue-observer.ts`:
  - the durable cron controller stays on `queue/observer` (`TZ=America/Los_Angeles */1 * * * *`), while manual `queue/observer.requested` probes now run through a separate `queue/observer-requested` function so operator requests do not queue behind the cron pass.
  - runtime flags are `QUEUE_OBSERVER_MODE=off|dry-run|enforce`, `QUEUE_OBSERVER_FAMILIES=discovery,content,subscriptions,github`, `QUEUE_OBSERVER_AUTO_FAMILIES=content`, and `QUEUE_OBSERVER_INTERVAL_SECONDS` (currently clamped to 60s minimum on the durable cron path).
  - both paths build the same bounded snapshot and call Sonnet through `infer()`, but only the cron controller may auto-apply `pause_family`, `resume_family`, and `escalate`; manual probes are read-only even if the configured mode is `enforce`.
  - the shared observer short-circuits deterministic noops for both truly empty queues and empty queues that only still have active pauses hanging around, so the cron path does not waste a full model call on obvious nothing-to-do snapshots.
  - idle empty snapshots with no recent drainer failures or triage trouble now report `downstreamState=healthy` instead of inheriting a noisy degraded label from stale throughput/latency history.
  - settled observer-held backlogs now get the same treatment: if all queued work is already behind an active observer pause, that pause is at least one cadence old, and no fresh drainer/triage failures exist, the shared observer deterministically emits `resume_family` instead of treating its own hold as proof that downstream is still down.
  - manual probes use singleton-skip semantics so repeated operator requests do not pile up stale queued runs.
  - the prompt contract is now hardened for live canaries: `content/updated` explicitly prefers `pause_family`/`resume_family` over `batch_family`, and legacy model output that still sends `escalate.reason` is normalized to the required `{ severity, message }` shape instead of forcing a full schema fallback.
  - operator reports flow through `gateway/send.message`, while real queue mutations still emit `queue.control.applied|rejected`.
  - current live truth: the first supervised enforce canary anchored at `since=1772981290859` proved the cron observer can auto-apply a real `pause_family` on `content/updated` (`snapshotId=cca656f7-a9ce-4ca2-9f6d-0ed332f56a4d`). The follow-up supervised canary anchored at `since=1772985057594` then proved the patched host worker can auto-apply the matching `resume_family`: it paused on snapshot `1cb24e7b-f0cd-4e0c-ae5d-27cb4934b49a`, resumed on snapshot `151aa03a-fced-41f0-9a54-2f3d1a70856d` / run `01KK72HD0EMT3T34K8QP3SMEW9`, and drained the held `content/updated` item back to queue depth `0`. The worker was then rolled back to `QUEUE_OBSERVER_MODE=dry-run` as the conservative steady state.
- Do not migrate tier-2 cron candidates until the Dkron/Restate tier-1 soak shows clean execution and observable failure behavior.

### System health

- function: `system/check-system-health`
- file: `packages/system-bus/src/inngest/functions/check-system-health.ts`
- inputs:
  - cron heartbeat checks
  - `system/health.check.requested`
- checks include core services (`Inngest`, `Worker`, `Redis`, etc.) and mount probes.
- current truth guards:
  - **Agent Secrets** health is based on `secrets status`, not `secrets health`; the latter can time out under load and falsely report the daemon as down even while leases and audit traffic still work.
  - **Webhooks** health probes the actual `/webhooks` route through the shared endpoint resolver (`localhost -> Colima VM IP -> service DNS`) instead of assuming the host worker localhost path is the only truthful surface.

### Self-healing router

- function: `system/self-healing.router`
- file: `packages/system-bus/src/inngest/functions/self-healing-router.ts`
- input event: `system/self.healing.requested`
- responsibility: apply retry/defer/escalate policy and emit target remediation events.

### Self-healing investigator

- function: `system/self-healing.investigator`
- file: `packages/system-bus/src/inngest/functions/self-healing-investigator.ts`
- current guardrails:
  - the initial `list-failed-runs` GraphQL scan now uses a longer timeout budget plus one bounded retry on abort-like failures; the investigator was tripping on the same slow-detail surface as `joelclaw run` and falsely timing out before it could inspect evidence.
  - downstream per-run inspection still shells through `joelclaw run`, so CLI detail timeout fixes directly improve investigator stability too.

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

The running host worker is launched by `com.joel.system-bus-worker` through `worker-supervisor`, and the current launchd/plist + supervisor config points at the main monorepo checkout:

- supervisor working dir: `~/Code/joelhooks/joelclaw/infra/worker-supervisor`
- worker dir: `~/Code/joelhooks/joelclaw/packages/system-bus`
- worker entry: `bun run src/serve.ts`

After changing host-role functions in the monorepo:

1. restart launchd: `launchctl kickstart -k gui/$(id -u)/com.joel.system-bus-worker`
2. re-register functions: `curl -X PUT http://127.0.0.1:3111/api/inngest`
3. verify with `joelclaw inngest status` or a targeted synthetic event

Reboot recovery gotchas that bit for real:

- `localhost:3111` belongs to the **host worker**, not the Talos container. If `docker inspect joelclaw-controlplane-1` still shows a stale `3111/tcp` port binding while `k8s/system-bus-worker.yaml` is `ClusterIP`, remove that Docker binding or the host worker cannot bind and Inngest runs fail with `Unable to reach SDK URL`.
- If the reboot lands in a headless/non-Aqua session and the `com.joel.system-bus-worker` LaunchAgent is unavailable, start `worker-supervisor` manually with the launchd env (`HOME`, `PATH`, `VAULT_PATH`, `WORKER_ROLE=host`, `INNGEST_DEV=0`) until the normal GUI launchd domain is back.

Do not rely on stale instructions about a separate `~/Code/system-bus-worker/` checkout unless the launchd plist/supervisor config has been deliberately changed back to that topology.

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
- `Unable to reach SDK URL` is not always a raw reachability outage. A real example from `check/o11y-triage` on 2026-03-08: nested `step.sendEvent(...)` calls inside `step.run(...)` produced `NESTING_STEPS` warnings, left a run stuck in `RUNNING` after early steps completed, and blocked newer runs behind the concurrency partition. If worker stderr shows `NESTING_STEPS`, fix the function shape before assuming the server/runtime is broken.

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

### Conversation thread intelligence (ADR-0237)

- files:
  - `packages/system-bus/src/inngest/functions/channel-message-classify.ts`
  - `packages/system-bus/src/inngest/functions/conversation-thread-aggregate.ts`
  - `packages/system-bus/src/inngest/functions/conversation-thread-enrich.ts`
  - `packages/system-bus/src/inngest/functions/conversation-thread-stale-sweep.ts`
- collections:
  - `channel_messages` now stores MiniLM embeddings plus workload taxonomy fields (`primary_concept_id`, `concept_ids`, `taxonomy_version`, `concept_source`)
  - `conversation_threads` stores lightweight thread aggregates and enrichment output (`summary`, `related_projects`, `related_contacts`, `vault_gap`, `needs_joel`)
- schema maintenance guard:
  - `ensureChannelMessagesCollection()` must never include Typesense field `id` in PATCH payloads. `id` is implicit/immutable there, and trying to re-patch it floods `channel-message-ingest` with `Field \`id\` cannot be altered.` failures plus pointless o11y escalations.
- event flow:
  1. `channel/message.received` → `channel-message-ingest`
  2. `channel/message.classify.requested` → `channel-message-classify`
  3. `conversation/thread.updated` → `conversation-thread-aggregate`
  4. `conversation/thread.enrichment.requested` → `conversation-thread-enrich`
  5. hourly cron → `conversation-thread-stale-sweep`
- current scope:
  - thread aggregation/enrichment is enabled for `slack` and `email`
  - email uses the Front conversation id as both `channelId` and `threadId`
  - `channel-message-classify` now accepts `email` messages and emits workload concept metadata
  - classifier JSON parsing must tolerate markdown-fenced or prose-wrapped model output before failing; strict raw-JSON-only parsing was too brittle and produced false `classification response was not valid JSON` failures even when the model returned usable structured content
  - if classifier output is still malformed after parsing attempts, the function must degrade to heuristic fallback classification (`conceptSource: "fallback"`) and emit `channel.message.classify_fallback` instead of failing the workflow
  - `channel-message-classify` must upsert a full `channel_messages` document (including `timestamp` and the base message fields), not just classification deltas; Typesense rejects partial upserts when the collection's `default_sorting_field` is missing
- debounce contract:
  - enrich immediately for new threads
  - re-enrich after `5` new messages
  - re-enrich after a `30m` gap when new messages arrive
  - mark threads `stale` after `48h` idle without re-running enrichment

### Conversation annotation pipeline (ADR-0225)

- function: `conversation/annotate`
- file: `packages/system-bus/src/inngest/functions/conversation-annotate.ts`
- trigger event: `conversation/annotate.requested`
- host-only runtime reason: shells to `joelclaw email read`, uses `infer()` for structured JSON summarization, pushes gateway notifications, and persists markdown notes under `~/Vault/Resources/conversations/`
- contract:
  1. fetches the Front conversation via CLI and emits `conversation.annotate.triggered|fetched` OTEL
  2. skips unchanged threads via Redis key `conversation:annotate:{conversationId}:last_count` with 4h TTL and emits `conversation.annotate.dedup_skip` when unchanged
  3. summarizes into strict JSON (participants, decisions, action items, links, urgency, Joel input) and emits `conversation.annotate.summarized`
  4. pushes summary + Joel-action notifications through the gateway and persists a Vault markdown note, with OTEL at every step and `conversation.annotate.failed` on failure

### Task triage classification contract

- function: `tasks/triage`
- file: `packages/system-bus/src/inngest/functions/task-triage.ts`
- behavior:
  1. scopes review to the human-facing task surface only (`Joel's Tasks` + `Questions for Joel`) and excludes machine backlog by default
  2. resolves Todoist project IDs to names before filtering so triage can work against real API payloads
  3. enforces strict JSON classification schema (`id`, `category`, `reason`) for every visible task ID
  4. retries once with a repair prompt when output is invalid
  5. returns `status: degraded` (not success) when classification remains invalid/null
  6. sets cooldown only when a gateway notification is actually pushed
  7. emits telemetry with `classificationValid`, `triageItemsCount`, `actionableCount`, `outputFailureReason`, and excluded-task counts

### O11y triage singleton contract

- function: `check/o11y-triage`
- file: `packages/system-bus/src/inngest/functions/o11y-triage.ts`
- behavior:
  1. uses `singleton: { key: '"global"', mode: "skip" }` in addition to concurrency so duplicate cron/manual scans do not pile up stale queued runs behind one long active triage pass
  2. manual triggers may therefore be skipped while another triage run is already active; that is intentional because this function scans current state rather than processing an irreplaceable payload
  3. if operators see queued build-up again, treat it as a regression in singleton or runtime truth rather than expected behavior

### Email triage + nag contract

- functions:
  - `check/email-triage` (`packages/system-bus/src/inngest/functions/check-email.ts`)
  - `email-nag` (`packages/system-bus/src/inngest/functions/email-nag.ts`)
- behavior:
  1. triage is **nag-first** for human senders (`reply-needed` default for real-person emails)
  2. `interesting` is a first-class escalation action (never silently archived)
  3. escalation notifications include direct Front deep links (`https://app.frontapp.com/open/<conversationId>`)
  4. `email-nag` runs on cron `0 17,22 * * *` (9am/2pm PST), leases `front_api_token`, and only nags for inbound-last conversations waiting `>4h`
  5. Front list/search responses may return `_pagination.next: null`; the Front adapter must tolerate that shape and treat `unread: true` as Front's supported `is:unreplied` query instead of the invalid `is:unread` filter
  6. nag digests are sorted oldest-first and delivered through `pushGatewayEvent`

### VIP email brief contract

- function: `vip/email-brief`
- file: `packages/system-bus/src/inngest/functions/vip-morning-brief.ts`
- triggers:
  - cron: `30 13 * * 1-5` (13:30 UTC weekdays; ~6:30am PT during DST)
  - cron: `0 17 * * 1-5` (17:00 UTC weekdays; ~10:00am PT during DST)
  - cron: `0 22 * * 1-5` (22:00 UTC weekdays; ~3:00pm PT during DST)
  - cron: `0 2 * * 2-6` (02:00 UTC Tue-Sat; ~7:00pm PT on the prior weekday during DST)
- behavior:
  1. ensures the `email_threads` Typesense collection exists, queries non-archived VIP thread cache entries sorted by `last_message_at:desc`, and degrades to `noop` if Typesense is unavailable or the cache is empty
  2. classifies up to 20 cached VIP threads into priority buckets: `dangling` (Joel owes a reply), `new activity` (recently active but not dangling), and `stale` (open with 7+ days of inactivity)
  3. returns `{ status: "noop", reason: "no-signal" }` without notifying the gateway when all three buckets are empty
  4. generates a Telegram-ready VIP email brief through `infer()` with a deterministic fallback formatter if model generation fails
  5. relays the final brief to the gateway as `vip.email.brief` with operator instructions to deliver it to Joel unchanged

### VIP email contextual analysis contract

- function: `vip/email-received`
- file: `packages/system-bus/src/inngest/functions/vip-email-received.ts`
- behavior:
  1. keeps newsletter detection + auto-archive unchanged for low-signal VIP senders
  2. fetches the full Front thread via pagination (up to 50 messages) with sender + timestamp + full text, then caches the thread in Typesense `email_threads`
  3. follows up to 5 interesting links from the latest email via `defuddle` and persists extracted content into `followed_links_json`
  4. compacts prompt-only context before `infer()` runs: head/tail thread sampling, clipped message/link/memory/repo/access-gap excerpts, and prompt-budget omission markers keep VIP analysis inside realistic `pi` latency bounds without changing cached source data
  5. uses quality-first default budgets (90s overall, 20s brief window, 45s Opus window) while still honoring env-var overrides
  6. pins each `infer()` call to a single router attempt because the function already has deterministic fallbacks (`buildFallbackOperatorBrief`, empty-analysis degradation) and should not burn the full budget on hidden router retries
  7. sends a direct Telegram operator brief as concise narrative prose with calibrated urgency (`🔴🟠🟡🟢✅`), explicit reply-state language, and a direct Front deep link; the relay now suppresses `vip.email.received` so the direct send stays single-delivery, and timing data stays in function output for observability only
  8. preserves Todoist task extraction and memory `echo-fizzle` dispatch after analysis

### VIP email thread backfill contract

- function: `vip/email-threads.backfill`
- file: `packages/system-bus/src/inngest/functions/vip-email-backfill.ts`
- trigger: `vip/email-threads.backfill`
- behavior:
  1. ensures Typesense `email_threads` exists before any Front fetches
  2. resolves configured VIP senders to concrete sender emails (defaults now include Alex Hillman's `alex@indyhall.org` alias so the backfill can find the canonical Front contact)
  3. paginates Front contact conversations via `GET /contacts/alt:email:{email}/conversations`
  4. fetches each conversation's messages via `GET /conversations/{id}/messages`, normalizes sender/text/timestamps, and derives Joel reply state
  5. upserts each thread into `email_threads` with the shared cache-document builder so live VIP email ingestion and historical backfill use the same schema

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
     - `MEMORY_REVIEW_TODOIST_FALLBACK_PROJECT` only if it resolves to another machine-facing project; human-facing projects are rejected
  4. `Joel's Tasks` and `Questions for Joel` are blocked as machine-review fallback targets under ADR-0238
  5. task-create outcomes are persisted on the proposal hash (`reviewTaskStatus`, `reviewTaskId`, `reviewTaskProjectId`, `reviewTaskError`, `reviewTaskLastAttemptAt`)
  6. emits explicit task-create telemetry:
     - `proposal-triage.review-task.created` (includes `projectId`, `projectFallbackUsed`, `attempts`)
     - `proposal-triage.review-task.failed` (includes attempted project list + any blocked human-facing projects)

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
