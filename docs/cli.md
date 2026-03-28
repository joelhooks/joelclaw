# joelclaw CLI

Canonical operator interface for joelclaw.

## Contract

- JSON envelope output (`ok`, `command`, `result`, `next_actions`)
- Deterministic error codes via `respondError`
- HATEOAS navigation in every command response
- Heavy dependencies loaded lazily when possible
- Capability adapter registry with typed command contracts (`packages/cli/src/capabilities/`; otel/recall/deploy/log/secrets/notify/mail/subscribe/heal adapter implementations live in `@joelclaw/sdk`)

## SDK surface (`@joelclaw/sdk`)

`@joelclaw/sdk` is the programmatic wrapper for software integrations that need CLI parity without rebuilding adapters.

Current contract:

- transport modes:
  - `subprocess` — shell to `joelclaw`
  - `inprocess` — run SDK capability adapters directly (no shell) for supported capabilities (`deploy`, `heal`, `log`, `mail`, `notify`, `otel`, `recall`, `secrets`, `subscribe`)
  - `hybrid` (default) — inprocess first, subprocess fallback
- parses canonical JSON envelopes (`ok`, `command`, `result`, `next_actions`)
- provides typed convenience methods for common routes:
  - `status()`
  - `deployWorker(options)`
  - `logWrite({ action, tool, detail, reason? })`
  - `notifySend({ message, channel?, priority?, context?, type?, source?, telegramOnly? })`
  - `secretsStatus/lease/revoke/audit/env`
  - `otelList/search/stats/emit`
  - `recall` / `recallRaw`
  - `vaultRead/search/ls/tree` + `vaultAdrList/collisions/audit/rank`
- exposes structured errors:
  - `JoelclawProcessError` (spawn/exit/parse failures)
  - `JoelclawEnvelopeError` (`ok:false` envelopes via `runOrThrow`)
  - `JoelclawCapabilityError` (inprocess capability failures)

Example:

```ts
import { createJoelclawClient } from "@joelclaw/sdk";

const client = createJoelclawClient({
  timeoutMs: 15_000,
  transport: "inprocess",
});
const otel = await client.otelSearch("gateway", { hours: 1, limit: 20 });
```

## Health endpoint fallback (ADR-0182)

CLI health probes for Inngest and worker resolve endpoints in this order:

1. `localhost`
2. discovered Colima VM IP (`JOELCLAW_COLIMA_VM_IP`, fallback `192.168.64.2`)
3. k8s service DNS (`*.joelclaw.svc.cluster.local`)

Probe detail strings include the selected endpoint class (`localhost|vm|svc_dns`) and skipped-candidate counts.

## Inngest status truth model (ADR-0187 + ADR-0159)

```bash
joelclaw inngest status [--heal] [--wait-ms 1500]
```

Semantics:

- reports both raw and normalized checks:
  - `checks_raw`: direct probe outcomes
  - `checks`: normalized truth surface used for `ok`
- worker truth is route-aware:
  - if direct worker endpoint probe fails but `deployment/system-bus-worker` is ready, worker is reported as healthy with `summary.route = "k8s-only"`
- k8s truth uses core workload readiness (not every pod phase):
  - `statefulset/inngest`, `statefulset/redis`, `statefulset/typesense`, `deployment/system-bus-worker`
- includes Talon watchdog health (`http://127.0.0.1:9999/health`) plus launchd state to guide escalation.

`--heal` performs targeted remediation before re-check:

1. enforce worker single-source binding
2. restart/register worker when worker checks fail
3. kickstart Talon + run `talon --check` when server/k8s checks fail
4. re-collect status and return before/after snapshots

## Inngest Connect WebSocket auth probe

```bash
joelclaw inngest connect-auth [--start-only] [--timeout-ms 8000] [--instance-id joelclaw-cli-probe] [--url http://localhost:8288]
```

Semantics:

- uses `INNGEST_SIGNING_KEY` as Bearer auth against `/v0/connect/start`.
- decodes the protobuf `StartResponse` (`connection_id`, `gateway_endpoint`, `gateway_group`, session/sync token presence).
- full mode runs the websocket handshake on the returned gateway endpoint:
  1. connects with subprotocol `v0.connect.inngest.com`
  2. expects `GATEWAY_HELLO`
  3. sends `WORKER_CONNECT` with `session_token` + `sync_token`
  4. expects `GATEWAY_CONNECTION_READY`
- output never includes raw tokens (metadata only: length/format/JWT timestamps).
- `--start-only` validates HTTP auth path without websocket handshake.

## Command roots

- `joelclaw status`
  - `--agent-dispatch-canary` runs the deterministic non-LLM timeout canary and folds its terminal truth into the status envelope
- `joelclaw summary [--hours N] [--format json|text]`
- `joelclaw runs`
- `joelclaw run`
- `joelclaw agent`
- `joelclaw content`
- `joelclaw gateway`
- `joelclaw loop`
- `joelclaw docs`
- `joelclaw vault`
- `joelclaw skills`
- `joelclaw mail`
- `joelclaw secrets`
- `joelclaw log`
- `joelclaw notify`
- `joelclaw otel`
- `joelclaw o11y`
- `joelclaw recall`
- `joelclaw memory`
- `joelclaw subscribe`
- `joelclaw webhook`
- `joelclaw inngest`
- `joelclaw restate`
- `joelclaw knowledge`
- `joelclaw capabilities`
- `joelclaw queue`
- `joelclaw workload`
- `joelclaw jobs`

## Docs command tree (ADR-0234 docs pipeline v2)

```bash
joelclaw docs
├── add <path> [--title <title>] [--tags a,b,c] [--category <storage-category>]
├── search <query> [--limit <n>] [--category <category>] [--concept <concept-id>] [--chunk-type <section|snippet>] [--doc <doc-id>] [--semantic]
├── context <chunk-id> [--mode snippet-window|parent-section|section-neighborhood] [--before <n>] [--after <n>] [--neighbors <n>]
├── list [--category <category>] [--limit <n>]
├── show <doc-id>
├── markdown <doc-id>
├── summary <doc-id>
├── status
├── reconcile [--manifest <path>] [--sample <n>]
├── enrich <doc-id>
├── reindex [--doc <doc-id>]
├── reindex-v2 <path> [--title <title>] [--skip-existing]
└── batch-reindex [--from-collection] [--skip-existing]
```

Semantics:

- active chunk search collection is switchable via `DOCS_CHUNKS_COLLECTION` and now defaults to `docs_chunks_v2`
- markdown + summary read durable artifacts from `DOCS_ARTIFACTS_DIR` (default `/Volumes/three-body/docs-artifacts`)
- `docs status` reports both `docs_chunks` (v1) and `docs_chunks_v2` plus artifact directory availability
- agentic expansion flow is `docs search` → `docs context` → `docs markdown` / `docs summary`

## Skills command tree

```bash
joelclaw skills
├── ensure <skill>
│   [--source-root <repo>]
│   [--consumer all|agents|pi|claude]
└── audit [--deep] [--wait-ms <wait-ms>] [--poll-ms <poll-ms>]
```

`joelclaw skills ensure` semantics:

- canonical local-repo install/maintenance surface for skills that already live in a repo `skills/` directory
- resolves `skills/<name>/SKILL.md` from `--source-root`, cwd/ancestor repos, or the joelclaw repo fallback
- creates missing consumer symlinks and repairs wrong symlinks in `~/.agents/skills/`, `~/.pi/agent/skills/`, and `~/.claude/skills/`
- fails loudly if a consumer target exists as a real file/dir instead of a symlink
- returns the installed skill path so agents can `read` it immediately
- for external third-party skill packages, the CLI points at the upstream installer: `npx skills add -y -g <source>`

## Workload command tree

```bash
joelclaw workload
├── plan "<intent>"
│   [--preset docs-truth|research-compare|refactor-handoff]
│   [--kind auto|repo.patch|repo.refactor|repo.docs|repo.review|research.spike|runtime.proof|cross-repo.integration]
│   [--shape auto|serial|parallel|chained]
│   [--autonomy inline|supervised|afk|blocked]
│   [--proof none|dry-run|canary|soak|full]
│   [--risk reversible-only,host-okay]
│   [--artifacts patch,verification,summary]
│   [--acceptance "criterion one|criterion two"]
│   [--repo /abs/path/or/owner/repo]
│   [--paths docs/workloads.md,docs/cli.md]
│   [--paths-from status|head|recent:<n>]
│   [--stages-from /abs/path/to/stages.json]
│   [--write-plan ~/.joelclaw/workloads/]
│   [--requested-by Joel]
├── dispatch <plan-artifact>
│   [--stage <stage-id>]
│   [--to <to>]
│   [--from <from>]
│   [--send-mail]
│   [--write-dispatch ~/.joelclaw/workloads/]
├── run <plan-artifact>
│   [--stage <stage-id>]
│   [--tool pi|codex|claude]
│   [--execution-mode auto|host|sandbox]
│   [--sandbox-backend local|k8s]
│   [--sandbox-mode minimal|full]
│   [--skip-dep-check]
│   [--repo-url <repo-url>]
│   [--dry-run]
└── sandboxes
    ├── list [--state active|completed|failed|cancelled] [--mode minimal|full] [--expired] [--limit <n>]
    ├── cleanup [--request-id <id> | --sandbox-id <id> | --expired | --all-terminal] [--dry-run] [--force]
    └── janitor [--dry-run]
```

`joelclaw workload plan` semantics:

- planner surface for ADR-0217 Phase 4.3
- returns a canonical `request` + `plan` envelope using `docs/workloads.md`
- also returns `guidance` with:
  - `recommendedExecution` (`execute-inline-now`, `tighten-scope-first`, `dispatch-after-health-check`, etc.)
  - `operatorSummary` so the CLI says what to do next instead of shrugging
  - `adrCoverage` to show which ADRs likely govern the slice already; on fresh repo-local ADR clusters it remains best-effort guidance and may still need human reconciliation
  - `recommendedSkills` with install/read readiness, including `joelclaw skills ensure <name>` for local repo skills and `npx skills add -y -g <source>` for external skills
  - `executionExamples` for serial / parallel / chained coding workloads, including setup + execution few-shot patterns
  - `executionLoop` so the agent gets the honest plan → approve → execute/watch → summarize posture after the operator says yes
- infers `kind`, `shape`, `mode`, and `backend` when the caller leaves them open
- supports reusable planner presets for common docs/research/refactor shapes
- preserves `Acceptance:` clauses embedded in the prompt when `--acceptance` is omitted
- prefers implementation intent over docs follow-through, so mixed intents like `refactor ... then update docs` or `extend ... then update README` stay implementation-shaped
- validates known `risk` and `artifacts` values and emits warnings for unknown ones instead of silently inventing vocabulary
- mentioning sandboxes as the topic of a comparison does **not** force sandbox mode by itself; isolation has to be explicit or implied by AFK autonomy
- `deploy-allowed` is inferred only from explicit release/deploy intent; nouns like `published skills` do not count as deploy requests
- `proof=canary|soak` no longer forces supervised repo work onto `durable` / `restate` by itself
- `--paths-from` can seed file scope from local git activity, and `--write-plan` writes the full envelope to a reusable JSON artifact
- `--stages-from <file>` loads an explicit JSON stage DAG, validates dependencies/cycles, carries per-stage acceptance into plan verification, and adds DAG metadata to the plan result
- when `--shape auto` is still in effect, an explicit stage DAG now decides whether the plan is `serial`, `parallel`, or `chained`
- chained repo.patch/refactor work can decompose a `Goal:` section into explicit milestones and add a reflection/update stage when the prompt asks for it
- defaults `--repo` to the current working directory and infers `branch` / `baseSha` when that target is a local git repo; if the cwd is not a git repo, it warns and points the caller at `--repo`
- does **not** execute code or mutate repos

`joelclaw workload dispatch` semantics:

- reads a saved plan artifact from `joelclaw workload plan --write-plan ...`
- turns it into a stage-specific dispatch/handoff contract with canonical `handoff` data plus a clawmail-ready subject/body
- also returns dispatch `guidance` so the CLI can say whether the right move is to execute the stage now, keep the slice inline, or pause for a health check/recipient clarification
- dispatch guidance also carries `executionLoop` so the receiving agent knows the approval, progress-reporting, and closeout posture instead of inventing workflow theatre
- defaults to the first stage, but `--stage` can target a later stage explicitly
- preserves scoped file boundaries through `selectedStage.reservedPaths` / `handoff.reservedPaths`
- carries forward ADR coverage + recommended skill setup/readiness for the receiving agent
- `--write-dispatch` writes the dispatch contract as a reusable JSON artifact
- `--send-mail --to <to> --from <from>` sends that contract through `joelclaw mail`
- does **not** execute code or mutate repos

`joelclaw workload run` semantics:

- reads a saved plan artifact and normalizes it into the canonical queue-backed runtime request
- emits the queue family `workload/requested`, which the registry maps to `system/agent.requested`
- current durable runtime path is `Redis queue → Restate dagOrchestrator → dagWorker`
- `dagWorker` handlers currently cover `shell`, `infer`, and `microvm`
- defaults to `--tool pi`, with `codex|claude` as explicit opt-ins
- supports `--sandbox-backend local|k8s` plus `--sandbox-mode minimal|full` when sandbox execution is the point
- explicit-stage plans now gate stage execution on dependency inbox truth; use `--skip-dep-check` only for deliberate manual recovery or replay
- supports `--dry-run` for request inspection before queue admission
- returns queue admission details once the request is enqueued
- if queue admission fails before the runtime request is accepted, `workload run` now writes a terminal inbox snapshot for that `requestId` immediately instead of leaving operators with no truth artifact to inspect
- `status|explain|cancel` remain planned, not shipped
- `joelclaw workload sandboxes` is now the operator surface for ADR-0221 local sandbox state:
  - `list` reconciles the registry against per-sandbox `sandbox.json` metadata before reporting retention + filesystem truth, so operator output stops lying about terminal state after older partial writeback failures
  - `cleanup` is the bounded manual deletion path with `--dry-run` and `--force`, and it performs the same reconciliation before deciding whether a sandbox is still active
  - `janitor` is the dedicated expired-sandbox cleanup path instead of waiting for startup-time opportunistic pruning, and it also reconciles registry drift before computing candidates
  - scheduled janitoring now lives in the repo-managed launchd service `com.joel.local-sandbox-janitor`, which runs `joelclaw workload sandboxes janitor` at load and every 30 minutes

## Restate command tree

```bash
joelclaw restate
├── status [--namespace <namespace>] [--admin-url <url>]
├── deployments [--admin-url <url>] [--cli-bin <bin>]
├── smoke [--script <path>]
├── enrich "<name>" [--github <user>] [--twitter <user>] [--depth quick|full] [--sync]
├── pi-mono-sync [--repo <owner/repo>] [--full-backfill] [--max-pages <n>] [--sync]
└── cron
    ├── status [--namespace <namespace>] [--service-name <service>] [--base-url <url>]
    ├── list [--namespace <namespace>] [--service-name <service>] [--base-url <url>]
    ├── enable-health [--schedule "0 7 * * * *"] [--run-now] [--restate-url <url>]
    └── delete <job>
```

`joelclaw restate smoke` semantics:

- resolves the smoke script path in this order:
  1. exact absolute path
  2. relative to current working directory
  3. relative to `JOELCLAW_ROOT`
  4. relative to `~/Code/joelhooks/joelclaw`
- runs `scripts/restate/test-workflow.sh` by default.
- default smoke validates `deployGate` end-to-end.
- DAG smoke is available via script override:
  - `joelclaw restate smoke --script scripts/restate/test-dag-workflow.sh`

`joelclaw restate pi-mono-sync` semantics:

- triggers the `pi-mono-sync` Restate DAG pipeline, which runs the host-side direct task runner `scripts/restate/run-tier1-task.ts --task pi-mono-artifacts-sync`.
- syncs repo docs, issues, issue comments, pull requests, pull-request review comments, commits, and releases into the Typesense collection `pi_mono_artifacts`.
- writes two materialized documents into the same collection:
  - maintainer profile (`kind=maintainer_profile`, currently for `badlogic`)
  - sync checkpoint (`kind=sync_state`) so later runs can stay incremental unless `--full-backfill` is set.
- default repo is `badlogic/pi-mono`.
- `--sync` waits for the DAG result; async mode returns a workflow ID and lets Restate finish in the background.
- the new collection is queryable through `joelclaw search --collection pi_mono_artifacts`.

`joelclaw restate cron` semantics:

- manages Dkron scheduler jobs for Restate pipelines.
- default access path is a **short-lived CLI-managed `kubectl port-forward`** to `svc/dkron-svc`.
- pass `--base-url` only when you already have a direct Dkron API endpoint.
- `enable-health` seeds the health proof job: `restate-health-check`.
- `sync-tier1` upserts the full ADR-0216 tier-1 set:
  - `restate-health-check`
  - `restate-skill-garden`
  - `restate-typesense-full-sync`
  - `restate-daily-digest`
  - `restate-subscription-check-feeds`
- `list` includes `migratedFrom`, `successCount`, `errorCount`, `lastSuccess`, and `lastError` so the soak is visible from the CLI without spelunking Dkron by hand.
- the jobs use Dkron's shell executor plus `wget`; it appends epoch seconds to each workflow ID prefix so every scheduled run is a fresh Restate workflow.
- Dkron cron expressions are **six-field** by default (`sec min hour dom month dow`), so hourly-at-minute-7 is `0 7 * * * *`, not `7 * * * *`.

## Discover command

```bash
joelclaw discover <url> [-c <context>] [--site <site>] [--visibility <visibility>]
```

Semantics:

- `--site` choices: `joelclaw`, `wizardshit`, `shared`
- `--visibility` choices: `public`, `private`, `archived`, `migration-only`
- sensible defaults when omitted: `site=joelclaw`, `visibility=public`
- default path still emits `discovery/noted` directly to Inngest.
- when `QUEUE_PILOTS=discovery`, `joelclaw discover` now posts raw event intent to the worker admission endpoint (`POST /internal/queue/enqueue`) instead of writing Redis directly:
  - the worker owns queue admission, static registry lookup, and bounded triage mode resolution
  - returns queue metadata (`streamId`, `eventId`, `priority`) instead of Inngest run ids
  - includes `triageMode` + `triage` metadata whenever the family is enabled for shadow or enforce
  - relies on the Restate queue drainer to forward the event onward
- this keeps discovery pilot clients thin while the server remains the only queue policy surface.
- `joelclaw discover` is the thin fire-and-forget shortcut. If you need the final link for the created piece in the same turn, use the canonical follow path instead:

```bash
joelclaw send discovery/noted --data '{"url":"<url>","context":"<optional>","site":"joelclaw","visibility":"public"}' --follow
```

The terminal result from `discovery-capture` now includes `finalLink`.

## Subscribe check queue pilot

```bash
joelclaw subscribe check [--id <id>]
```

Semantics:

- scoped checks (`--id <id>`) still emit `subscription/check.requested` directly to Inngest.
- all-subscription checks keep the legacy Inngest path by default.
- when `QUEUE_PILOTS=subscriptions`, `joelclaw subscribe check` without `--id` posts `subscription/check-feeds.requested` to the worker admission endpoint instead of writing Redis directly:
  - returns queue metadata (`streamId`, `eventId`, `priority`)
  - includes `triageMode` + `triage` metadata whenever the family is enabled for shadow or enforce
  - points next actions at `joelclaw queue inspect` / `joelclaw queue depth`
  - relies on the Restate queue drainer to forward the **actual** `subscription/check-feeds.requested` event name onward

## Jobs command tree (ADR-0217 runtime monitor)

```bash
joelclaw jobs
└── status [--hours <n>] [--count <n>] [--namespace <namespace>] [--restate-admin-url <url>] [--dkron-service-name <service>] [--dkron-base-url <url>]
```

Semantics:

- `jobs status` is the **first operator glance** for real workloads during the ADR-0217 transition. It aggregates the queue/Redis substrate, Restate runtime, Dkron scheduler, and still-live Inngest surfaces into one JSON snapshot.
- `overall.status` is a bounded truth surface (`healthy|degraded|down`) derived from those four components, not a raw dump of every underlying health probe.
- queue section:
  - reads the canonical Redis queue directly through `@joelclaw/queue`
  - reports depth, priority buckets, oldest age, and active deterministic pauses
- Restate section:
  - mirrors `joelclaw restate status` in-place so the operator can see statefulset readiness + admin health without command hopping
- Dkron section:
  - mirrors `joelclaw restate cron status` in-place and includes the count of Restate-tagged scheduler jobs when the API is reachable
- Inngest section:
  - stays visible during migration, but its status is scoped to the transitional job path that still matters here: server/worker health plus recent run outcomes
  - broad informational checks (for example unrelated k8s pod drift) stay in the payload without poisoning the top-level job monitor status
- next actions point directly at the management surfaces that actually move workload state: `queue control status`, `queue observe`, `queue resume`, `restate status`, `restate cron status`, and `runs`

## Pi async jobs monitor (`runtime_jobs_monitor`)

The loaded pi extension at `packages/pi-extensions/inngest-monitor/index.ts` now does two jobs:

1. tracks followed Inngest runs (`inngest_send`, `inngest_runs`)
2. exposes `runtime_jobs_monitor` for the ADR-0217 runtime substrate

`runtime_jobs_monitor` semantics:

- `action=start|status|stop` (default `start`)
- on `start`, it polls `joelclaw jobs status` in the background, paints a persistent widget, emits OTEL on severity changes and meaningful workload-state changes, and sends hidden follow-up messages for async report-back
- on `status`, it returns the latest runtime snapshot (overall status, queue depth, active pause count, Restate/Dkron/Inngest state)
- on `stop`, it stops the poller and sends a final follow-up summary
- widget posture is intentionally operator-first: current runtime state on top, active followed runs underneath

This is the canonical async monitoring path when you want a pi session to keep an eye on real workloads while you do other things.

## Queue command tree (ADR-0217 Phase 1)

```bash
joelclaw queue
├── emit <event> [-d <json>] [-p P0|P1|P2|P3]
├── depth
├── stats [--hours <n>] [--limit <n>]
├── observe [--hours <n>] [--limit <n>] [--since <iso|ms>]
├── pause <family> [--ttl <duration>] [--reason <text>]
├── resume <family> [--reason <text>]
├── control
│   └── status [--hours <n>] [--limit <n>] [--since <iso|ms>]
├── list [--limit <n>]
└── inspect <stream-id>
```

Semantics:

- all queue subcommands return a clean JSON envelope; read-oriented subcommands close their Redis client before exit and `emit` stays a thin worker client instead of writing Redis directly
- queue state/control commands resolve Redis from the canonical joelclaw CLI config (`~/.config/system-bus.env` → `REDIS_URL`) before considering ambient shell env so the installed operator surface stays pointed at the same localhost queue as the worker and Restate drainer
- `emit` posts queue admission intent to the worker endpoint (`POST /internal/queue/enqueue`).
  - accepts event name (e.g., `discovery/noted`, `content/updated`)
  - accepts optional JSON payload via `-d`
  - optional priority override via `-p` is normalized client-side, but static registry routing and bounded triage stay server-side
  - the worker generates the canonical `QueueEventEnvelope`, adds trace metadata, resolves shadow/enforce mode for the event family, evaluates bounded triage, and persists the queue record
  - returns the Redis stream ID, priority, and any `triageMode` / `triage` metadata from admission
- `depth` reports queue depth, priority distribution (P0/P1/P2/P3 counts), oldest/newest message timestamps
- `stats` summarizes recent Restate queue-drainer behavior plus Phase 2 triage behavior from OTEL over a lookback window.
  - dispatch section reports sampled/found dispatch events, live queue depth, started/completed/failed counts, success rate, queue wait-time percentiles (`p50`/`p95`), dispatch-duration percentiles, promotion count, top event families, and recent failures
  - triage section reports attempts, completed/failed/fallback counts, fallback counts by reason, disagreement count, applied-change count, suggested-not-applied count, route mismatches, latency percentiles, per-family rollups, and recent mismatch/fallback samples
  - uses `metadata.waitTimeMs` from `queue.dispatch.started` as the Story 5 queue-to-dispatch latency signal
  - uses `queue.triage.*` OTEL metadata as the Story 3 source of truth for queue-admission disagreements and fallback behavior
  - `--since <iso|ms>` overrides the lower bound so operators can anchor soak evidence to a known clean point (for example the supervised `queue.drainer.started` after a rollout) instead of mixing fresh traffic with a dirty pre-fix window
  - keeps the operator in CLI-land; no raw Redis keys or manual OTEL spelunking required for the first sanity pass
- `jobs status` is the first unified runtime view; drop to `queue` subcommands when the aggregated surface says the queue itself needs attention.
- `observe` is now the Phase 3 Story 2-4 dry-run Sonnet operator surface.
  - builds a canonical live snapshot from current queue depth + queued messages + recent drainer OTEL + recent triage OTEL + gateway sleep/muted-channel state + active deterministic pauses
  - runs the bounded Sonnet observer in `dry-run` mode only and returns the current `snapshot` plus the current `decision`
  - long Sonnet summaries are trimmed instead of turning otherwise-useful observations into schema-only fallbacks
  - if all queued work is intentionally held behind fresh active **manual** pauses and no recent failures suggest downstream trouble, it short-circuits to a deterministic `noop` instead of wasting a 60s Sonnet call on an obvious hold state
  - `history` summarizes recent `queue.observe.*` OTEL for the same window so operators can compare the latest dry-run against raw history without spelunking Typesense by hand
  - `control` now reflects the shipped deterministic queue-control plane: active manual pauses, `queue.control.applied|expired|rejected` counts, and recent control events come from the same Redis + OTEL truth the drainer uses
  - `--since <iso|ms>` anchors the related OTEL history window the same way `queue stats` does
- `pause` applies a deterministic manual family pause with bounded TTL and emits `queue.control.applied` telemetry
- `resume` clears a deterministic family pause and emits either `queue.control.applied` or `queue.control.rejected` when the family was not paused
- `control status` is the dedicated deterministic control-plane operator surface.
  - reports active pauses (family, reason, TTL, applied/expiry timestamps, actor)
  - summarizes `queue.control.applied|expired|rejected` OTEL for the same window
  - is the first CLI answer to “what queue controls are active right now?” before any automatic Sonnet mutation ships
- `list` lists recent messages in priority order (highest priority first), does not ack/remove
- `inspect` loads a message by Redis stream ID and returns full payload + metadata
  - if the message is already acked/expired, it now returns a structured `QUEUE_MESSAGE_MISSING` error envelope with queue-state next actions instead of crashing the CLI

Queue configuration:

- Stream key: `joelclaw:queue:events`
- Priority index: `joelclaw:queue:priority`
- Consumer group: `joelclaw:queue:cli`
- Phase 1 pilot events: `discovery/noted`, `discovery/captured`, `content/updated`, `subscription/check-feeds.requested`, `github/workflow_run.completed`

OTEL telemetry under `queue.*` namespace:

- CLI queue commands forward queue package telemetry to OTEL with `source=cli` and `component=queue`
- `queue.enqueue` — message enqueued
- `queue.lease` — message leased for processing (includes wait time, priority, promotion metadata)
- `queue.ack` — message acknowledged
- `queue.replay` — unacked messages loaded for replay

## Daily summary command

```bash
joelclaw summary [--hours 24] [--format json|text]
```

Semantics:

- aggregates recent git activity (joelclaw + Vault), Inngest run rollups, k8s pod health, OTEL stats, slog deploy/config events, and ADR churn into one response envelope.
- default output is JSON summary payload; `--format text` adds a compact text rendition under `result.text` for downstream chat/mobile surfaces.

## Memory command group

```bash
joelclaw memory write "<observation text>" [--type observation|lesson|pattern|failed_target] [--source cli]
joelclaw memory search "<query>"
```

Semantics:

- `memory write` sends `memory/observation.submitted` to Inngest with `{ text, type, source, ts }`.
- `memory search` is an alias surface for recall so read/write memory workflows live in one command group.

## Knowledge turn-write command

```bash
joelclaw knowledge note \
  --source gateway \
  --agent gateway-daemon \
  --session <session-id> \
  --turn <turn-number> \
  --summary "<what changed>"
```

Use `--skip-reason routine-heartbeat|duplicate-signal|no-new-information` when a turn is eligible but has no durable signal to capture.

## Gateway known issues / muted channels

```bash
joelclaw gateway known-issues
joelclaw gateway mute <channel> [--reason "<why muted>"]
joelclaw gateway unmute <channel>
```

Semantics:

- stores muted channel IDs at Redis key `gateway:health:muted-channels` (JSON array).
- stores optional mute reasons at Redis key `gateway:health:mute-reasons` (JSON object).
- muted channels remain in probe telemetry but are excluded from `gateway.channels.degraded` alerts.

Gateway process-layer diagnostics (`joelclaw gateway diagnose`) now inspect exact launchd state for `com.joel.gateway` and report disabled services explicitly. `joelclaw gateway restart` now re-enables the launch agent before bootstrap/kickstart to avoid restart failures when launchd has the service disabled.

Use `joelclaw gateway enable` for direct launch-agent recovery (enable + bootstrap + kickstart) without manual `launchctl` usage.

Gateway status/diagnose now separate **daemon availability** from **Redis bridge health**:

- `joelclaw gateway status` prefers daemon `/health` when available, so Redis loss no longer makes the gateway look fully dead.
- status now returns `mode` (`normal` or `redis_degraded`), `degradedCapabilities`, `sessionPressure` (context %, compaction age, session age, next action), and `guardrails` (current turn tool budget state + pending deploy verifications).
- `joelclaw gateway diagnose` treats `redis_degraded` as a degraded runtime, not a process failure, skips Redis-dependent E2E checks in that mode, and surfaces runtime guardrail findings when a checkpoint/deploy verification is active.

## Gateway behavior control plane (ADR-0211)

```bash
joelclaw gateway behavior add --type keep|more|less|stop|start --text "..."
joelclaw gateway behavior list
joelclaw gateway behavior promote --id <candidate-id>
joelclaw gateway behavior remove --id <directive-id>
joelclaw gateway behavior apply
joelclaw gateway behavior stats
```

Semantics:

- **Single write authority** is CLI. Extensions must call these commands; no direct Redis/Typesense writes.
- Active runtime contract lives in Redis key `joelclaw:gateway:behavior:contract`.
- Directive/candidate history lives in Typesense collection `gateway_behavior_history`.
- `add` normalizes directives, enforces conflict + dedupe + cap rules, and updates Redis + Typesense.
- `promote` moves a pending daily-review candidate into the active contract (manual gate; no auto-activation).
- `apply` re-runs governance over the active contract (dedupe, conflict cleanup, cap enforcement) and expires stale candidates.
- `stats` reports contract hash/version, candidate lifecycle counts, and governance settings.

## Run listing semantics

```bash
joelclaw runs [--status RUNNING|FAILED|COMPLETED|QUEUED|CANCELLED]
```

Semantics:

- applies backend status filtering and a local status guard so mixed-status payloads cannot leak through.
- for suspicious `RUNNING` rows (endedAt present while running, or long-running health checks), runs performs bounded detail reconciliation (max 5 lookups) to detect stale SDK-unreachable ghosts.
- runs with stale indicators include `staleSignal` with `likely`, `confidence`, and machine-readable `reasons`.
- response includes `staleSignals` summary (`detected`, `likely`, `detailChecked`) and suggests `joelclaw inngest sweep-stale-runs` when likely ghosts are present.
- `count` in response reflects post-filter rows (what the operator actually sees).

## Run inspection + cancellation

```bash
joelclaw run <run-id> [--cancel] [--wait-ms 3000]
```

Semantics:

- default mode returns run detail, trigger event, trace, and step errors.
- `--cancel` issues Inngest GraphQL `cancelRun` for active runs, then polls status up to `--wait-ms`.
- deterministic error envelopes:
  - `RUN_CANCEL_FAILED` when `cancelRun` mutation fails.
  - `RUN_CANCEL_TIMEOUT` when run remains `RUNNING|QUEUED` after the wait window.
  - `RUN_STALE_SDK_UNREACHABLE` when a run appears `RUNNING` but trace errors show `Unable to reach SDK URL` and cancellation has no live execution to target.
- terminal runs are never re-cancelled; response includes `cancellation.skipped = "already_terminal"`.

## Capability adapter config precedence (ADR-0169 phase 0)

Resolution order is deterministic:

1. CLI flags (e.g. `--adapter`)
2. Environment variables
3. Project config (`.joelclaw/config.toml`)
4. User config (`~/.joelclaw/config.toml`)
5. Built-in defaults

Current env keys:

- `JOELCLAW_CAPABILITY_<CAPABILITY>_ADAPTER`
- `JOELCLAW_CAPABILITY_<CAPABILITY>_ENABLED`

## Capability-backed command roots (ADR-0169 through phase 4)

```bash
joelclaw secrets status
joelclaw secrets lease <name> --ttl 15m
joelclaw secrets revoke <lease-id>
joelclaw secrets revoke --all
joelclaw secrets audit --tail 50
joelclaw secrets env --dry-run [--ttl 1h] [--force]

joelclaw log write --action <action> --tool <tool> --detail <detail> [--reason <reason>] [--session <session>] [--system <system>]

joelclaw notify send "<message>" [--priority low|normal|high|urgent] [--channel gateway|main|all] [--context '{"k":"v"}']

joelclaw heal {list|run}

joelclaw mail {status|register|send|inbox|read|reserve|renew|release|locks|search}

joelclaw otel {list|search|stats|emit}

joelclaw o11y {session|system}

joelclaw recall <query> [--limit N] [--min-score F] [--raw] [--include-hold] [--include-discard] [--budget auto|lean|balanced|deep] [--category <id|alias>]

joelclaw subscribe {list|add|remove|check|summary}
```

Semantics:

- `log` writes structured system entries (slog backend).
- `log write` now accepts explicit `--session` / `--system` provenance flags and also falls back to `SLOG_SESSION_ID` / `SLOG_SYSTEM_ID` env vars before handing off to the slog backend.
- `logs` reads/analyzes runtime logs.
- `notify` is the canonical operator alert command; `gateway push` remains transport/debug.
- `deploy`, `heal`, `log`, `notify`, `secrets`, `mail`, `otel`, `recall`, and `subscribe` keep their existing UX/envelopes while executing through capability registry adapters (`scripted-deploy`, `runbook-heal`, `slog-cli`, `gateway-redis`, `agent-secrets-cli`, `mcp-agent-mail`, `typesense-otel`, `typesense-recall`, `redis-subscriptions`).
- `typesense-otel`, `typesense-recall`, `scripted-deploy`, `runbook-heal`, `slog-cli`, `agent-secrets-cli`, `gateway-redis`, `mcp-agent-mail`, and `redis-subscriptions` adapter logic is canonical in `@joelclaw/sdk` (`packages/sdk/src/capabilities/adapters/*`); CLI adapter files are thin re-exports.
- `otel emit` accepts stdin JSON payloads (or convenience args/positional action), normalizes defaults (`id`, `timestamp`, `level=info`, `success=true`), and forwards to the worker ingest endpoint (`/observability/emit`).
- `otel list` and `otel search` accept exact `--session` / `--system` filters, mapped to `sessionId` / `systemId` in Typesense.
- `o11y session` / `o11y system` run a unified multi-search across `otel_events` and `system_log`, merge both timelines by `timestamp`, and tag each hit with its source collection.
- Software surfaces should route OTEL through this command contract (or shared CLI ingest helper), not ad-hoc raw HTTP calls.
- `mail search` auto-falls back to `/mail/api/unified-inbox` filtering when MCP `search_messages` returns transient DB/tool errors, so steering signals remain usable.
- `mail reserve` now sends explicit lease TTL (`--ttl-seconds`, default `900`) and enforces a minimum of 60s.
- `mail renew` extends active file reservations without releasing/reacquiring (`--extend-seconds`, default `900`, optional `--paths`).
- `mail locks` now prefers the local git-mailbox `file_reservations/` artifact store when available because `/mail/api/locks` can under-report advisory file reservations while still reporting mailbox internals like archive/commit locks. Responses expose `source` and `fallback_reason` when artifact fallback was required.
- `subscribe check` emits Inngest request events for scoped checks and for all-subscription checks when the queue pilot is off; `response.ids` are event/request IDs (inspect via `joelclaw event <event-id>`), not run IDs unless explicitly returned as `runIds`.
- when `QUEUE_PILOTS=subscriptions`, unscoped `subscribe check` returns queue metadata instead of Inngest response ids because the request first lands in Redis and is forwarded by the Restate drainer.
- `recall` rewrite telemetry now exposes `rewrite.strategy` (`disabled|skipped|haiku|openai|fallback`) and `rewrite.reason` so low-ROI rewrite skips/fallbacks are queryable; short/literal/direct-id queries skip LLM rewrite by design.

## Webhook command tree (ADR-0185)

```bash
joelclaw webhook
├── subscribe <provider> <event>
│   [--repo <owner/repo>] [--workflow <name>] [--branch <name>] [--conclusion <status>]
│   [--session <session-id>] [--ttl <duration>] [--stream] [--timeout <seconds>] [--replay <count>]
├── unsubscribe <subscription-id>
├── list [--provider <provider>] [--event <event>] [--session <session-id>]
└── stream <subscription-id> [--timeout <seconds>] [--replay <count>]
```

Semantics:

- Subscriptions are Redis-backed and session-scoped (`joelclaw:webhook:*`).
- `subscribe --stream` starts an NDJSON stream immediately after creation.
- `stream` emits ADR-0058 NDJSON (`start`, `log`, `event`, terminal `result|error`).
- Default session target is `gateway` for central gateway role, otherwise `pid-<ppid>`.
- TTL defaults to `24h` and is enforced at match time.

## Skills command tree (ADR-0179)

```bash
joelclaw skills
└── audit [--deep] [--wait-ms <wait-ms>] [--poll-ms <poll-ms>]
```

### `joelclaw skills audit` purpose

- triggers the `skill-garden/check` event on-demand
- waits for the corresponding run and returns the findings report in-envelope
- supports `--deep` for LLM staleness checks

## Agent command tree (ADR-0180 phases 2-4)

```bash
joelclaw agent
├── list
├── show <name>
├── run <name> <task> [--cwd <cwd>] [--timeout <seconds>]
├── chain <steps> --task <task> [--cwd <cwd>] [--fail-fast]
└── watch <id> [--timeout <seconds>]
```

Semantics:

- `run` emits `agent/task.run` for single roster agent execution and returns `taskId` plus `eventIds` from the Inngest send response.
- `run` `next_actions` are truthful: use `joelclaw event <event-id>` when an event ID exists (or `joelclaw events ...` fallback), and never assume `taskId` is a run ID.
- `chain` emits `agent/chain.run` with comma-separated sequential steps and `+` parallel groups (e.g. `scout,planner+reviewer,coder`).
- `watch` streams NDJSON progress for a task (`at-...`) or chain (`ac-...`) by subscribing to `joelclaw:notify:gateway`, replaying `joelclaw:events:gateway`, and falling back to Inngest polling.
- `watch` default timeout is 300 seconds for tasks and 900 seconds for chains; terminal events always include `next_actions` on completion, timeout, or interrupt.
- Runtime-proof recipe (ADR-0180):
  1. `joelclaw agent list` (expect builtin `coder/designer/ops/story-executor`)
  2. `joelclaw agent run coder "reply with OK" --timeout 20`
  3. `joelclaw event <event-id>` (expect `Agent Task Run` status `COMPLETED` with output payload)
- If `Unknown agent roster entry: coder` appears, treat it as worker-runtime drift: deploy latest `system-bus-worker`, restart the host worker, then rerun the three-step proof.

## Vault command tree

```bash
joelclaw vault
├── read <ref>
├── search <query> [--semantic] [--limit <limit>]
├── ls [section]
├── tree
└── adr
    ├── list [--status <status>] [--limit <limit>]
    ├── collisions
    ├── audit
    ├── locate <query> [--limit <limit>]
    ├── refs <query>
    ├── prompt <text>
    └── rank [--band <band>] [--unscored] [--all]
```

### `joelclaw vault adr` purpose

- `list` — inventory ADR metadata with optional status filter
- `collisions` — detect duplicate ADR numeric prefixes
- `audit` — full ADR hygiene check:
  - missing/non-canonical status values
  - number collisions
  - missing `superseded-by` targets
  - broken or ambiguous wiki links inside ADR bodies (skips custom directive tags like `[[tts:text]]`)
  - README index alignment against ADR files
- `locate` — section/file lookup across the ADR corpus using ADR numbers, slugs, titles, and heading names
- `refs` — backlink discovery for a resolved ADR file or section id
- `prompt` — expand `[[ADR refs]]` in prompt text into canonical ids and append an `<adr-context>` block for agents
- `rank` — score + rank ADRs by NRC+novelty rubric for daily prioritization:
  - default scope: open ADRs (`accepted` + `proposed`)
  - `--all` includes shipped/superseded/deprecated/rejected ADRs
  - `--band <band>` filters ranked rows (`do-now|do-next|de-risk|park`; alias `next` → `do-next`)
  - `--unscored` returns ADRs missing `priority-score`
  - required axes: `priority-need`, `priority-readiness`, `priority-confidence`
  - novelty facet: `priority-novelty` (or alias `priority-interest`), defaults to neutral `3` when missing
  - score formula: `clamp(round(20*(0.5*Need + 0.3*Readiness + 0.2*Confidence)) + round((Novelty-3)*5), 0, 100)`
  - bands: `do-now` (80-100), `do-next` (60-79), `de-risk` (40-59), `park` (0-39)
  - emits CLI OTEL via `component=vault-cli`:
    - `vault.adr.rank.started`
    - `vault.adr.rank.completed`
    - `vault.adr.rank.failed`

Canonical statuses:

- `proposed`
- `accepted`
- `shipped`
- `superseded`
- `deprecated`
- `rejected`

## Content command tree (ADR-0168)

```bash
joelclaw content
├── seed
├── verify
└── prune [--apply]
```

Semantics:

- `seed` — full Vault ADR sync to Convex for canonical ADR filenames only (`NNNN-*.md`).
- `verify` — strict ADR drift check against canonical ADR files (fails healthy state on both missing and extra ADR records in Convex).
- `prune` — dry-run report of Convex ADR extras (`status: dry_run`).
- `prune --apply` — removes ADR extras from Convex (`status: pruned`) and should be followed by `joelclaw content verify`.

## Inngest source guard (ADR-0089)

```bash
joelclaw inngest source [--repair]
```

Semantics:

- Verifies launchd binding for `com.joel.system-bus-worker` against the canonical `infra/launchd/com.joel.system-bus-worker.plist` values (program + working directory).
- `--repair` copies canonical plist into `~/Library/LaunchAgents`, performs `launchctl bootout`, then `bootstrap` with retry for transient `Bootstrap failed: 5` launchd races.
- Use before `joelclaw inngest restart-worker` when host runtime/source drift is suspected.

## Inngest stale-run sweep (ADR-0194)

```bash
joelclaw inngest sweep-stale-runs
joelclaw inngest sweep-stale-runs --apply
```

Semantics:

- preview-first by default (`--apply` required for mutation).
- scope defaults to stale health checks older than 30 minutes:
  - `check/o11y-triage`
  - `check/system-health`
- runtime target defaults:
  - namespace `joelclaw`
  - pod `inngest-0`
  - sqlite path `/data/main.db`
- apply mode safety gates:
  - refuses if age threshold is too young (`<5m`)
  - refuses when candidate count exceeds `--max-apply-candidates`
  - refuses when `function_runs` rows are missing (cannot insert terminal history safely)
  - always creates and verifies point-in-time backup before transaction:
    - `/data/main.db.pre-sweep-<UTC-stamp>.sqlite`
- terminalization contract (single transaction):
  1. insert missing `history.type = FunctionCancelled`
  2. insert missing `function_finishes`
  3. set `trace_runs.status = 500` + terminal `ended_at`

This command exists for cases where Inngest API cancellation returns `not found` for stale RUNNING ghosts after SDK reachability failures.

## Status command

```bash
joelclaw status [--agent-dispatch-canary]
```

Semantics:

- default `joelclaw status` remains the fast base worker/server health surface
- default output now also includes `latestAgentDispatchCanary` when a persisted deterministic canary snapshot exists, so operators can see the last proof result without spelunking runs or inbox files
- `--agent-dispatch-canary` runs `scripts/verify-agent-dispatch-timeout.ts` and folds the deterministic non-LLM `system/agent-dispatch` timeout proof into the returned envelope
- when requested, the command only reports healthy if both the base health probes and the canary pass
- this is the canonical on-demand proof surface for the live outer-timeout closeout path; it exists so operators do not have to run the verifier script manually

## Build and verify

```bash
bunx tsc --noEmit
pnpm biome check packages/ apps/
bun test packages/cli/src/commands/*.test.ts
bun build packages/cli/src/cli.ts --compile --outfile ~/.bun/bin/joelclaw
joelclaw status
joelclaw vault
joelclaw vault adr audit
joelclaw vault adr locate "gateway guardrails"
joelclaw vault adr refs 0189-gateway-guardrails
joelclaw vault adr prompt "compare [[0189-gateway-guardrails]] with [[0218-gateway-availability-lifecycle-qol-improvements]]"
```

## Add a command

1. Create command module in `packages/cli/src/commands/`.
2. Return envelopes with `respond`/`respondError` only.
3. Include useful `next_actions` with param hints.
4. Wire command in `packages/cli/src/cli.ts`.
5. Add/extend tests in `packages/cli/src/commands/*.test.ts`.
6. Update this file when command tree or contracts change.
