# @joelclaw/restate

ADR-0207 Restate package for production durable workflow execution.

## Current workflow surface

### Queue drainer

- Restate worker now starts a deterministic queue drainer beside the channel listener
- queue source: Redis stream `joelclaw:queue:events` + priority index `joelclaw:queue:priority`
- consumer group: `joelclaw:queue:restate`
- startup replay: claims pending/never-delivered messages via `getUnacked()`, reindexes them, then resumes draining
- dispatch path: queue registry target → Restate `dagOrchestrator/{workflowId}/run/send`
- current pilot handler bridge: queue events are re-emitted to their registered Inngest targets through a one-node Restate DAG request so the queue loop can prove deterministic drain/replay before full per-family Restate cutover
- OTEL: startup, replay, `queue.dispatch.started|completed|failed`, plus queue package `queue.lease|ack|replay`
- watchdog: if backlog remains in Redis but the drainer stops making progress for `QUEUE_DRAIN_STALL_AFTER_MS`, it emits `queue.drainer.stalled` and exits non-zero so launchd can restart the worker and replay the backlog instead of silently wedging

Tuning env:

- `QUEUE_DRAINER_ENABLED` — default enabled
- `QUEUE_DRAIN_INTERVAL_MS` — idle polling cadence / retry heartbeat (default `2000`)
- `QUEUE_DRAINER_CONCURRENCY` — max in-flight queue dispatches (default `1`)
- `QUEUE_DRAIN_FAILURE_BACKOFF_MS` — per-message retry cooldown after failed dispatch (default `30000`)
- `QUEUE_DRAIN_STALL_AFTER_MS` — watchdog threshold before the drainer self-terminates for supervisor recovery (default `45000`)

Throughput note:

- the drainer no longer pays the full `QUEUE_DRAIN_INTERVAL_MS` tax between successful dispatches when backlog exists
- after a dispatch finishes and a slot frees, it self-pulses immediately to claim the next ready message
- the interval now acts as the idle poll / retry heartbeat, not the per-message pacing knob
- this keeps default concurrency conservative while removing the dumb 2-second gap between fast successful sends

### Deploy gate workload

- `deployGate.run` — durable deploy pipeline for `system-bus-worker`
- `deployGate.approve` — resolve approval promise as approved
- `deployGate.reject` — resolve approval promise as rejected

### DAG workload

- `dagOrchestrator.run` — dependency-aware DAG execution with wave fan-out/fan-in
- `dagWorker.execute` — per-node durable execution service called by orchestrator
- `pi-mono-sync` — Restate DAG pipeline that syncs `badlogic/pi-mono` docs/issues/PRs/comments/commits/releases into Typesense collection `pi_mono_artifacts`

#### Handler types

Each DAG node specifies a `handler` that determines what real work it does:

| Handler | What it does | Config fields |
|---------|-------------|---------------|
| `noop` | Simulated delay (default) | `simulatedMs` |
| `shell` | Runs a bash command | `config.command` |
| `http` | Makes an HTTP request | `config.url`, `config.method`, `config.headers`, `config.body` |
| `infer` | LLM inference via pi | `config.prompt`, `config.model`, `config.system` |

#### Dependency output passing

Nodes receive outputs from their upstream dependencies via `{{nodeId}}` template interpolation. The `infer` handler replaces `{{dep-name}}` in the prompt with that dependency's output.

#### Example: real health check pipeline

```json
{
  "requestId": "health-1",
  "nodes": [
    { "id": "k8s", "task": "check pods", "handler": "shell",
      "config": { "command": "kubectl get pods -n joelclaw" } },
    { "id": "redis", "task": "ping redis", "handler": "shell",
      "config": { "command": "kubectl exec -n joelclaw redis-0 -- redis-cli ping" } },
    { "id": "report", "task": "synthesize", "handler": "infer",
      "dependsOn": ["k8s", "redis"],
      "config": { "prompt": "Health results:\n{{k8s}}\n{{redis}}\nSummarize." } }
  ]
}
```

## Canonical headless runtime

Repo-managed launchd is now the canonical long-running host runtime for the Restate worker:

- launch agent: `infra/launchd/com.joel.restate-worker.plist`
- start wrapper: `scripts/restate/start.sh`
- logs: `/tmp/joelclaw/restate.log`, `/tmp/joelclaw/restate.err`

The wrapper loads `~/.config/system-bus.env`, refuses headless `CHANNEL=console` by forcing `noop`, forwards SIGTERM to the Bun child so port `9080` is not orphaned, and opportunistically runs `scripts/restate/register-deployment.sh` when the Restate admin API is reachable. The queue drainer now also self-heals by exiting non-zero on a `queue.drainer.stalled` watchdog event so launchd can restart the worker and replay the Redis backlog instead of leaving queued pilot traffic stuck behind a superficially healthy Bun process.

Install it with a repo symlink instead of hand-rolled `nohup` shells:

```bash
ln -sfn ~/Code/joelhooks/joelclaw/infra/launchd/com.joel.restate-worker.plist \
  ~/Library/LaunchAgents/com.joel.restate-worker.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.joel.restate-worker.plist 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.joel.restate-worker.plist
```

## Run locally

For one-off foreground debugging only:

```bash
bun run packages/restate/src/index.ts
```

## Register deployment with Restate runtime

```bash
scripts/restate/register-deployment.sh
```

## Trigger workloads

```bash
# deploy gate
bun run packages/restate/src/trigger-deploy.ts -- --skip-approval

# DAG demo (noop nodes)
bun run packages/restate/src/trigger-dag.ts

# DAG system health check (real work)
bun run packages/restate/src/trigger-dag.ts -- --pipeline health

# DAG research (real work — web search + vault + memory → LLM synthesis)
bun run packages/restate/src/trigger-dag.ts -- --pipeline research --topic "Restate vs Temporal"

# pi-mono artifacts sync (Typesense corpus + maintainer profile)
bun run packages/restate/src/trigger-dag.ts -- --pipeline pi-mono-sync --repo badlogic/pi-mono --full-backfill

# PRD → DAG compilation (host pi planning + Restate orchestration + host agent bridge)
bun run packages/restate/src/trigger-prd.ts -- --prd ~/Vault/Projects/09-joelclaw/0217-phase-1-queue-execution-plan.md --cwd ~/Code/joelhooks/joelclaw

# Deterministic PRD execution (skip markdown planning; load a prebuilt JSON plan)
bun run packages/restate/src/trigger-prd.ts -- --plan ~/Vault/Projects/09-joelclaw/0217-phase-1-story-1-plan.json --cwd ~/Code/joelhooks/joelclaw
```

### PRD execution bridge

The Restate pod does **not** have `pi`, `codex`, `bun`, or a repo checkout. PRD execution therefore uses a host bridge:

1. `trigger-prd.ts` runs on the host and either:
   - compiles markdown PRD → DAG using `pi` with `gpt-5.4`, or
   - loads a deterministic JSON execution plan via `--plan`
2. Restate executes the DAG in-cluster
3. Story nodes call host worker internal endpoints on `127.0.0.1:3111` by default (override `PRD_AGENT_WORKER_URL` when the DAG worker runs somewhere else, such as an in-cluster runtime that needs `host.docker.internal:3111`). `x-otel-emit-token` is sent only when `OTEL_EMIT_TOKEN` is configured.
4. Headless host runs should start the Restate worker with `CHANNEL=noop`; `CHANNEL=console` binds stdin and exits immediately under `nohup`/background launch.
5. Host worker dispatches **`pi`** agent work from the requested `cwd` and short-polls `/internal/agent-result/:requestId` until completion. The internal bridge now writes a `running` snapshot immediately and dedupes duplicate `/internal/agent-dispatch` calls by `requestId`, so Restate retries do not spawn multiple story agents for the same request. Story execution now defaults to the dedicated roster agent `agents/story-executor.md` so Restate PRD runs use a tight system prompt instead of the generic background-agent path.
6. Terminal state guarantees: The agent-dispatch function ensures every execution lands in a terminal state (`completed|failed|cancelled`). Duplicate requests with the same `requestId` return the existing terminal result instead of spawning new work. Cancellation via `system/agent.cancelled` kills the active subprocess and writes a `cancelled` snapshot.
7. Log surfacing: All terminal results include `stdout`/`stderr` output (truncated to 10KB each) in the `logs` field for debugging. These are visible in the inbox file (`~/.joelclaw/workspace/inbox/{requestId}.json`) and surfaced via OTEL events.

Every generated story prompt prepends the joelclaw mail contract: announce work, reserve exact paths, send status updates, release locks, commit atomically, and fail closed if unrelated dirty paths would be scooped into the commit.

### Execution mode: host vs sandbox (ADR-0217 Story 4)

PRD story execution supports two modes controlled by `PRD_EXECUTION_MODE`:

- **`host`** (default): Execute on the shared host checkout. The current stable path.
- **`sandbox`**: Route to the proved local sandbox runner on the host worker. This path now materializes a clean temp checkout at `baseSha`, runs the agent inside that isolated repo, exports patch/touched-file artifacts, and tears the workspace down without dirtying the operator checkout. This is the current working isolation path while the k8s Job runner remains the next gate.

Set the mode before triggering a PRD:

```bash
# Host mode (default, stable)
bun run packages/restate/src/trigger-prd.ts -- --prd path/to/prd.md

# Sandbox mode (local sandbox runner on the host worker)
PRD_EXECUTION_MODE=sandbox bun run packages/restate/src/trigger-prd.ts -- --prd path/to/prd.md
```

The execution mode flag routes at the `agent-dispatch` boundary:
- Host mode: uses the existing Inngest function to spawn agents on the shared host checkout
- Sandbox mode: uses the proved local sandbox runner on the host worker — materialize a clean temp repo at `baseSha`, run the agent inside that isolated checkout, export patch/touched-file artifacts, then clean up the temp workspace

Both modes preserve stable `requestId`, `workflowId`, `storyId`, and agent identity end-to-end. Sandbox requests should also carry `baseSha` so the isolated checkout is deterministic. The result polling contract (`/internal/agent-result/:requestId`) works for both paths.

#### Sandbox runtime implementation gates

The sandbox runtime is being built incrementally through a series of proof gates:

**Gate A: Non-coding vertical slice** ✅ **PROVEN**
- Proves the sandbox runtime can execute a simple task end-to-end
- Local executor (not k8s) reads one file, writes one temp artifact, exits cleanly
- Truthful state transitions: `running` → `completed`
- Zero host dirt (operator checkout stays clean)
- Observable log capture
- Failure states handled honestly
- Tests: `packages/agent-execution/__tests__/gate-a-smoke.test.ts`
- What's proven: contract validity, state machine, artifact generation, serialization
- Known gaps: no k8s, no real git operations, no network isolation, no resource limits, no cancellation

**Gate B: Minimal coding sandbox** ✅ **PROVEN**
- Proves the sandbox runtime can execute a minimal coding task end-to-end
- Local executor (not k8s) materializes a repo at baseSha, makes a code change, commits, generates patch
- Real git operations: clone/fetch, checkout, add, commit, format-patch
- At least one verification command (bunx tsc --noEmit)
- Clean patch artifact export with full commit metadata
- Truthful verification summary (success/failure, commands, output)
- Touched-file reporting from sandbox-local checkout
- Zero host dirt (operator checkout remains untouched)
- Tests: `packages/agent-execution/__tests__/gate-b-smoke.test.ts`
- What's proven: repo materialization, git operations, patch generation, verification capture, isolation
- Known gaps: no k8s, no network isolation, no resource limits, no cancellation, no multi-story orchestration

**Gate C: k8s Job launcher + multi-story orchestration** (not yet implemented)
- Keep the current sandbox contract, but swap the local host-worker runner for real isolated k8s Jobs
- Restate DAG orchestrator launches deterministic Job-backed story runs by request/workflow/story identity
- Wave-based parallel execution
- Dependency-aware scheduling

**Gate D: Cancellation and timeout** (not yet implemented)
- Job termination via k8s Job API
- Graceful shutdown with artifact preservation
- Timeout enforcement at Job level

To run the gate smoke tests:

```bash
# Gate A: Non-coding vertical slice
bun test packages/agent-execution/__tests__/gate-a-smoke.test.ts

# Gate B: Minimal coding sandbox
bun test packages/agent-execution/__tests__/gate-b-smoke.test.ts
```

## Dkron scheduler proof (ADR-0216 phase 1)

The tier-1 scheduled Restate workloads now run through Dkron:

```bash
joelclaw restate cron status
joelclaw restate cron sync-tier1 --run-now
joelclaw restate cron list
```

This seeds the ADR-0216 tier-1 set in Dkron:

- `restate-health-check`
- `restate-skill-garden`
- `restate-typesense-full-sync`
- `restate-daily-digest`
- `restate-subscription-check-feeds`

Each job uses Dkron's shell executor plus `wget` against `http://restate:8080/...` from inside the cluster. The shell wrapper appends epoch seconds to the workflow ID prefix so each scheduled run gets a unique Restate workflow ID.

For the tier-1 migrations, Restate shell nodes call `scripts/restate/run-tier1-task.ts` on the host so a green scheduled run means the underlying task actually ran. Non-zero shell exits now fail the Restate node instead of returning fake success.

The same host-runner path now backs `pi-mono-sync`. The direct task:

- creates/updates Typesense collection `pi_mono_artifacts`
- ingests repo docs, issues, issue comments, pull requests, pull-request review comments, commits, and releases
- writes a materialized `maintainer_profile` document (currently for `badlogic`)
- writes a `sync_state` checkpoint document so later runs can stay incremental unless `--full-backfill` is requested

Dkron uses **six-field** cron expressions. Hourly-at-minute-7 is:

```bash
0 7 * * * *
```

## Smoke tests

### Deploy gate smoke

```bash
scripts/restate/test-workflow.sh
# or
joelclaw restate smoke
```

### DAG smoke

```bash
scripts/restate/test-dag-workflow.sh
# or
joelclaw restate smoke --script scripts/restate/test-dag-workflow.sh
```
