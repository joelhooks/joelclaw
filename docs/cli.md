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
import { createJoelclawClient } from "@joelclaw/sdk"

const client = createJoelclawClient({ timeoutMs: 15_000, transport: "inprocess" })
const otel = await client.otelSearch("gateway", { hours: 1, limit: 20 })
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
- `joelclaw recall`
- `joelclaw memory`
- `joelclaw subscribe`
- `joelclaw webhook`
- `joelclaw inngest`
- `joelclaw knowledge`
- `joelclaw capabilities`

## Restate command tree

```bash
joelclaw restate
├── status [--namespace <namespace>] [--admin-url <url>]
├── deployments [--admin-url <url>] [--cli-bin <bin>]
├── smoke [--script <path>]
├── enrich "<name>" [--github <user>] [--twitter <user>] [--depth quick|full] [--sync]
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

joelclaw log write --action <action> --tool <tool> --detail <detail> [--reason <reason>]

joelclaw notify send "<message>" [--priority low|normal|high|urgent] [--channel gateway|main|all] [--context '{"k":"v"}']

joelclaw heal {list|run}

joelclaw mail {status|register|send|inbox|read|reserve|renew|release|locks|search}

joelclaw otel {list|search|stats|emit}

joelclaw recall <query> [--limit N] [--min-score F] [--raw] [--include-hold] [--include-discard] [--budget auto|lean|balanced|deep] [--category <id|alias>]

joelclaw subscribe {list|add|remove|check|summary}
```

Semantics:

- `log` writes structured system entries (slog backend).
- `logs` reads/analyzes runtime logs.
- `notify` is the canonical operator alert command; `gateway push` remains transport/debug.
- `deploy`, `heal`, `log`, `notify`, `secrets`, `mail`, `otel`, `recall`, and `subscribe` keep their existing UX/envelopes while executing through capability registry adapters (`scripted-deploy`, `runbook-heal`, `slog-cli`, `gateway-redis`, `agent-secrets-cli`, `mcp-agent-mail`, `typesense-otel`, `typesense-recall`, `redis-subscriptions`).
- `typesense-otel`, `typesense-recall`, `scripted-deploy`, `runbook-heal`, `slog-cli`, `agent-secrets-cli`, `gateway-redis`, `mcp-agent-mail`, and `redis-subscriptions` adapter logic is canonical in `@joelclaw/sdk` (`packages/sdk/src/capabilities/adapters/*`); CLI adapter files are thin re-exports.
- `otel emit` accepts stdin JSON payloads (or convenience args/positional action), normalizes defaults (`id`, `timestamp`, `level=info`, `success=true`), and forwards to the worker ingest endpoint (`/observability/emit`).
- Software surfaces should route OTEL through this command contract (or shared CLI ingest helper), not ad-hoc raw HTTP calls.
- `mail search` auto-falls back to `/mail/api/unified-inbox` filtering when MCP `search_messages` returns transient DB/tool errors, so steering signals remain usable.
- `mail reserve` now sends explicit lease TTL (`--ttl-seconds`, default `900`) and enforces a minimum of 60s.
- `mail renew` extends active file reservations without releasing/reacquiring (`--extend-seconds`, default `900`, optional `--paths`).
- `subscribe check` emits Inngest request events; `response.ids` are event/request IDs (inspect via `joelclaw event <event-id>`), not run IDs unless explicitly returned as `runIds`.
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
  1. `joelclaw agent list` (expect builtin `coder/designer/ops`)
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
    └── rank [--band <band>] [--unscored] [--all]
```

### `joelclaw vault adr` purpose

- `list` — inventory ADR metadata with optional status filter
- `collisions` — detect duplicate ADR numeric prefixes
- `audit` — full ADR hygiene check:
  - missing/non-canonical status values
  - number collisions
  - missing `superseded-by` targets
  - README index alignment against ADR files
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

## Build and verify

```bash
bunx tsc --noEmit
pnpm biome check packages/ apps/
bun test packages/cli/src/commands/*.test.ts
bun build packages/cli/src/cli.ts --compile --outfile ~/.bun/bin/joelclaw
joelclaw status
joelclaw vault
joelclaw vault adr audit
```

## Add a command

1. Create command module in `packages/cli/src/commands/`.
2. Return envelopes with `respond`/`respondError` only.
3. Include useful `next_actions` with param hints.
4. Wire command in `packages/cli/src/cli.ts`.
5. Add/extend tests in `packages/cli/src/commands/*.test.ts`.
6. Update this file when command tree or contracts change.
