# joelclaw Architecture

## Overview

joelclaw is a personal AI infrastructure monorepo built around event-driven workflows, always-on gateway services, and sandboxed agent execution. The system follows hexagonal architecture principles (ADR-0144), with heavy logic in standalone packages behind interfaces.

## Core Architecture Principles

1. **Hexagonal Architecture (ADR-0144)**: Heavy logic lives in standalone `@joelclaw/*` packages behind interfaces. Consumers (gateway, CLI) are thin composition roots that wire adapters together.

2. **Event-Driven**: Durable work now runs through a dual-runtime phase: Inngest remains the legacy/event-native backbone while Restate owns new DAG-style execution and queue-drainer pilots. Events remain the primary integration point between subsystems.

3. **CLI-First**: The `joelclaw` CLI is the primary operator interface. All commands return HATEOAS JSON envelopes for agent consumption.

4. **Single Source of Truth**: Never copy files across boundaries. Symlink. Skills live canonically in `skills/` and are symlinked to agent home directories.

5. **Observable by Default**: Every pipeline step emits structured telemetry via OTEL. Silent failures are bugs.

## System Components

### Infrastructure Layer

```
┌─ Mac Mini "Panda" (M4 Pro, 64GB, always-on) ──────────────────────┐
│                                                                     │
│  Colima VM (VZ framework, aarch64)                                  │
│    └─ Talos v1.12.4 container → k8s v1.35.0 (single node)         │
│        └─ namespace: joelclaw                                       │
│            ├─ inngest-0          (StatefulSet, ports 8288/8289)     │
│            ├─ redis-0            (StatefulSet, port 6379)          │
│            ├─ typesense-0        (StatefulSet, port 8108)          │
│            ├─ system-bus-worker  (Deployment, port 3111)           │
│            ├─ docs-api           (Deployment, port 3838)           │
│            ├─ livekit-server     (Deployment, ports 7880/7881)     │
│            └─ bluesky-pds        (Deployment, port 3000)           │
│                                                                     │
│  Gateway daemon (pi session, always-on, Redis event bridge)         │
│  NAS "three-body" (ASUSTOR, 10GbE NFS, 64TB RAID5 + 1.9TB NVMe)  │
│  Tailscale mesh (all devices)                                       │
└─────────────────────────────────────────────────────────────────────┘
```

### Package Architecture

The monorepo follows pnpm workspaces with strict package boundaries:

#### Core Packages

**@joelclaw/cli**
- Primary operator interface
- Built with `@effect/cli`
- Compiled to binary at `~/.bun/bin/joelclaw`
- Returns HATEOAS JSON envelopes
- Must never crash (lazy-load heavy dependencies)

**@joelclaw/sdk**
- Programmatic wrapper for CLI contracts
- Type-safe interface to joelclaw operations
- Used by other packages to invoke CLI commands

**@joelclaw/system-bus**
- 110+ Inngest durable functions
- Webhook gateway for external integrations
- Deployed to k8s as `system-bus-worker`
- Event processing backbone

**@joelclaw/gateway**
- Multi-channel message routing (Telegram, Slack, Discord, iMessage)
- Always-on pi session with Redis event bridge
- Priority queue management
- Sleep mode awareness

**@joelclaw/restate**
- Restate worker package for durable DAG/workflow execution
- Hosts deploy gate, DAG orchestrator, and the deterministic queue drainer
- Owns the execution-adjacent queue → Restate `/send` bridge for ADR-0217 Story 3
- The drainer now self-pulses immediately when backlog remains and a dispatch slot frees, so `QUEUE_DRAIN_INTERVAL_MS` is an idle poll heartbeat instead of a fixed per-message tax
- If Redis backlog remains but the drainer stops making progress for `QUEUE_DRAIN_STALL_AFTER_MS`, it emits `queue.drainer.stalled` and exits non-zero so launchd can restart the worker and replay the backlog instead of silently wedging pilot traffic behind a still-listening Bun process
- The canonical long-running host runtime is launchd service `com.joel.restate-worker` via `scripts/restate/start.sh`; ad-hoc `nohup bun run ...` launches are for short debugging only because opaque restarts contaminate queue soak evidence
- Provides the current operator-facing sandbox orchestration surface
- The repo-managed launchd service `com.joel.local-sandbox-janitor` now runs `joelclaw workload sandboxes janitor` at load and every 30 minutes so ADR-0221 retained local sandbox cleanup is scheduled instead of purely manual
- Hosts the pi-mono research/indexing sync that materializes GitHub docs/issues/PRs/comments/commits/releases into Typesense collection `pi_mono_artifacts` via a Restate DAG + host runner

#### Contract Packages

**@joelclaw/agent-execution** (NEW)
- **Canonical sandbox execution contract**
- Shared request/response types for sandboxed story execution
- Lifecycle states: `pending`, `running`, `completed`, `failed`, `cancelled`
- Agent identity tracking: name, variant, model, program
- Sandbox profiles: `workspace-write`, `danger-full-access`
- Artifact manifests: baseSha, headSha, touched files, verification results
- Runtime validation schemas and type guards
- **Repo materialization**: `materializeRepo()` for clean checkout at exact SHA
- **Artifact export**: `generatePatchArtifact()` for auditable patch bundles
- **Touched-file inventory**: `getTouchedFiles()` captures modified/untracked files
- **Verification helpers**: `verifyRepoState()` for SHA validation
- **Local sandbox primitives**: deterministic sandbox identity, path resolution, per-sandbox env materialization, terminal retention/cleanup policy, copy-first devcontainer materialization helpers, minimal/full mode contract, and JSON registry helpers for local host-worker isolation
- **Consumed by**: Restate workflows, system-bus functions, k8s Job launcher, runtime images

This package eliminates ad-hoc type duplication between Restate and system-bus. All sandboxed story execution must use these types to ensure contract stability. Story 3 added repo materialization and artifact export helpers for isolated sandbox runs. ADR-0221 phase 1 added the first explicit local-isolation primitives, and phase 2 now feeds those helpers into the real host-worker local sandbox path.

### Sandboxed Story Execution

**Current live path: local sandbox runner on the host worker**
- `executionMode: "sandbox"` is live in `system/agent-dispatch`
- Default `sandboxBackend` is still `"local"`
- Each local run now resolves a deterministic sandbox identity/path under `~/.joelclaw/sandboxes/`, preserves a request-derived hash in both `sandboxId` and `COMPOSE_PROJECT_NAME` so long shared request prefixes still diverge cleanly, materializes a per-sandbox `.sandbox.env`, injects that sandbox identity into the live agent process environment, writes sandbox state to the JSON registry, and persists artifact bundles into the sandbox directory
- Terminal local sandboxes now carry a retention decision (`cleanupAfter`) and the local backend opportunistically prunes expired retained sandboxes before starting a new run
- `@joelclaw/agent-execution` now includes copy-first `.devcontainer` materialization helpers with exclusion rules for env/secret junk, plus a concurrent package-level proof that two local sandboxes keep distinct `COMPOSE_PROJECT_NAME` values and isolated copied devcontainer state
- Repo materialization now treats abbreviated `baseSha` values as valid refs when they resolve to the checked-out commit, which matches how the live worker receives request payloads during dogfood runs
- `InboxResult` snapshots for local sandbox runs now carry `localSandbox` metadata so cancellation and operator follow-up can see the sandbox identity/path/env/registry surface, and `system/agent-dispatch` now overwrites those snapshots with a terminal `failed` state if execution crashes before the normal `write-inbox` step
- host-worker agent subprocess capture now uses exit-driven temp files instead of waiting on pipe EOF, because codex/claude/bash descendants can inherit stdout/stderr and otherwise block terminal inbox writeback long after the real parent process has already exited
- the installed CLI now has an ADR-0221 operator surface: `joelclaw workload sandboxes list|cleanup|janitor` reads the registry, reconciles it against each sandbox’s `sandbox.json` metadata before reporting or deleting, reports retention/filesystem truth, supports bounded manual cleanup, and runs the dedicated expired-sandbox janitor path instead of waiting for the next sandbox startup
- Narrow operator proof now lives at `bun scripts/verify-local-sandbox-dispatch.ts`; it dispatches one happy-path local sandbox run plus one intentional bad-SHA run and waits for truthful terminal inbox state
- The host-worker path now also has an opt-in **full local mode**: it maps the requested sandbox `cwd` into the cloned checkout, discovers compose files relative to that workdir, and can bring up a compose-backed runtime with the sandbox-specific `COMPOSE_PROJECT_NAME` before agent execution starts
- Workflow-rig dogfood proved the new front door can carry `sandboxMode=full` through `joelclaw workload run` → `workload/requested` → `system/agent.requested`, and it exposed one real upstream ops bug along the way: a stale long-running Restate worker can reject `workload/requested` as unregistered until it is restarted and reloads the queue registry
- Dogfood also exposed a second, more embarrassing failure mode: stage-2 agents could recurse by running `scripts/verify-workload-full-mode.ts` from inside the sandbox, and that verifier itself launches another `joelclaw workload run`. The runtime now blocks nested workflow-rig execution inside sandboxed stage runs unless explicitly overridden for debugging, and the sandbox task contract tells the agent to use direct local proof commands instead
- Guarded workflow-rig dogfood is now earned end-to-end for stage-2: `bun scripts/verify-workload-full-mode.ts` produced `WR_20260310_013158`, the stage completed terminally, the compose-backed runtime came up healthy, emitted the required `full-mode-ok|full|...` proof line inside the summary output, and tore itself back down with no remaining containers
- Gate A (non-coding) and Gate B (minimal coding) are proven, and a real ADR-0217 acceptance run completed on this path without dirtying the operator checkout
- This remains the current working isolation surface for autonomous story execution

**Opt-in next gate now landed in code: cold k8s Jobs**
- `sandboxBackend: "k8s"` is now a real control-plane path in repo, but it is still meant for supervised rollout rather than broad default enablement
- Deterministic Job naming keyed by `requestId`
- Runtime image contract: Git, Bun, agent tooling, `/workspace` directory
- Environment-driven config: `WORKFLOW_ID`, `REQUEST_ID`, `STORY_ID`, `BASE_SHA`, `REPO_URL`, `REPO_BRANCH`, `TASK_PROMPT_B64`, optional verification commands, and callback settings
- Result callback path: runner posts `SandboxExecutionResult` to `/internal/agent-result`; the worker preserves `InboxResult.sandboxBackend` and optional Job metadata for operator visibility
- Log fallback path: Job logs include result markers so the host worker can still recover terminal truth if callback delivery fails
- Resource limits: 500m-2 CPU, 1-4Gi memory (configurable)
- TTL cleanup: auto-delete after 5 minutes (default)
- Active deadline: 1 hour max runtime (default)
- No automatic retries (`backoffLimit: 0`)
- Security: non-root (UID 1000), no privilege escalation, capabilities dropped
- Cancellation: delete Job resource (SIGTERM to container) plus host-worker cancellation cleanup
- Job spec generation via `@joelclaw/agent-execution/job-spec`, Job lifecycle helpers via `@joelclaw/agent-execution/k8s`, and runtime entrypoint in `packages/agent-execution/src/job-runner.ts`

**Runtime Image Contract**:
```
Required tools:
- Git (checkout, diff, commit)
- Bun runtime
- Runner-installed agent programs (currently `claude` and/or other installed CLIs; `pi` remains local-backend only for now)

Expected paths:
- `/workspace` (working directory)
- `/app/packages/agent-execution/src/job-runner.ts` (default runtime entrypoint in the current image contract)

Expected behavior:
1. Decode `TASK_PROMPT_B64` from env
2. Materialize repo at `BASE_SHA` from `REPO_URL`/`REPO_BRANCH` in sandbox-local workspace
3. Execute agent with task
4. Run verification commands (if `VERIFICATION_COMMANDS_B64` set)
5. Export patch artifact with touched files and verification results
6. Print terminal `SandboxExecutionResult` markers to stdout and POST the same result to `/internal/agent-result`
7. Exit `0` (success) or non-zero (failure)

Cancellation handling:
- Gracefully handle SIGTERM
- Emit a cancelled terminal result when possible
- Exit promptly
```

See `k8s/agent-runner.yaml` for the full runtime contract specification.

**Repo Materialization** (Story 3):
- `materializeRepo()`: Clone or checkout repo at exact SHA in sandbox-local workspace
- Fresh clone if target path doesn't exist, fetch + checkout otherwise
- SHA verification after checkout with automatic unshallow if needed
- Isolated from host worktree — no mutation of operator checkout
- Returns: `{ path, sha, freshClone, durationMs }`

**Artifact Export** (Story 3):
- `generatePatchArtifact()`: Export auditable patch from baseSha..headSha
- Captures touched-file inventory via `git status --porcelain`
- Generates git patch (format-patch for commits, diff for uncommitted)
- Includes verification summary: commands, success, output
- Includes log references: executionLog, verificationLog
- Serializable to JSON via `writeArtifactBundle()`
- **Promotion boundary**: Patch artifact is authoritative output; merge/push is operator decision

**Phase 1 Trade-Off**:
Sandbox runs produce patch bundles, not direct commits to main. This keeps runs isolated and reversible while we validate the story execution quality. Future phases may introduce automatic merge with approval gates.

**@joelclaw/inference-router**
- Model selection catalog
- Provider fallback chains
- Single source of truth for model→provider mappings

**@joelclaw/model-fallback**
- Provider fallback implementation
- Retry logic for failed inference calls

#### Infrastructure Packages

**@joelclaw/message-store**
- Redis message queue
- Priority-based draining
- Gateway message persistence

**@joelclaw/queue**
- Redis stream + sorted-set queue primitives
- Shared queue event envelope and static registry
- Replay, lease, ack, and operator inspection surfaces
- Envelope may carry optional trace (`correlationId`, `causationId`) and triage metadata, but the package remains model-free for correctness
- Used by CLI queue commands and the Restate queue drainer

**Queue admission triage boundary (ADR-0217 Phase 2)**
- bounded queue-admission triage lives in `packages/system-bus/src/lib/queue-triage.ts`
- canonical server-side admission helper lives in `packages/system-bus/src/lib/queue.ts`
- edge clients hit `POST /internal/queue/enqueue`; worker-local ingress paths call the helper directly
- canonical model is Haiku via the shared `infer()` path
- the model may only shape priority, dedup suggestion, and route confirmation/mismatch signal
- `QUEUE_TRIAGE_MODE` sets the base triage mode; `QUEUE_TRIAGE_ENFORCE_FAMILIES` is the narrow Story 4 override for the two earned families
- static registry routing remains authoritative in this phase; no dynamic handler invention
- canonical OTEL vocabulary for this layer is `queue.triage.started|completed|failed|fallback`
- canonical operator view for this layer is the `triage` block inside `joelclaw queue stats`

**Queue observation contract boundary (ADR-0217 Phase 3 Story 1-4)**
- bounded Sonnet observation now lives in `packages/system-bus/src/lib/queue-observe.ts`
- canonical queue-observation contracts (`QueueObservationSnapshot`, `QueueObservationDecision`, `QueueObserverAction`) plus deterministic queue-control state (`QueueFamilyPauseState`, `QueueControlMode`) live in `@joelclaw/queue`
- the observer consumes a deterministic server-built snapshot and may only return bounded action suggestions from the shared enum
- the snapshot now carries active deterministic pauses so resume suggestions are grounded in real control state, overlong Sonnet summaries are trimmed instead of causing bogus schema fallbacks during live probes, legacy `escalate.reason` output is normalized into the canonical `{ severity, message }` report shape, and settled observer-held backlog is normalized back to healthy so the observer can deterministically `resume_family` instead of poisoning its own downstream health signal
- canonical model is Sonnet via the shared `infer()` path
- canonical OTEL vocabulary for this layer is `queue.observe.started|completed|failed|fallback` plus `queue.control.applied|expired|rejected`
- Story 1 stops at contract/snapshot/fallback vocabulary; Story 2 adds the dry-run CLI surface `joelclaw queue observe`; Story 3 adds the deterministic pause/resume control plane and the dedicated CLI surface `joelclaw queue control status`; Story 4 adds the durable host-worker `queue/observer` runtime with cron + manual trigger support
- the Restate queue drainer now respects active deterministic pauses and only resumes dispatch after manual resume or TTL expiry
- queue operator commands resolve Redis from the canonical CLI/system-bus config (`~/.config/system-bus.env`) so manual control and live queue observation hit the same queue the worker drains
- current live posture is intentionally conservative: supervised enforce canaries have now earned one full observer-applied `pause_family` → `resume_family` cycle on `content/updated`, but the worker still sits back in `QUEUE_OBSERVER_MODE=dry-run` outside those canary windows until broader soak evidence says otherwise

**@joelclaw/vault-reader**
- Obsidian Vault context injection
- ADR reading
- PARA method navigation

**@joelclaw/telemetry**
- OTEL emission interface
- Typesense storage
- Langfuse integration for LLM tracking

**@joelclaw/markdown-formatter**
- Per-platform formatting (Telegram, Slack, Discord)
- Code block handling
- Link transformations

#### Extensions and Integrations

**@joelclaw/pi-extensions**
- Pi agent extensions
- Session lifecycle hooks
- Langfuse cost tracking
- Async runtime jobs monitor widget/report-back extension (transitional Restate + queue + Dkron + Inngest view)

**@joelclaw/email**
- Email processing
- Front webhook handling
- VIP email workflows

**@joelclaw/mdx-pipeline**
- MDX content processing
- Blog post transformations

**@joelclaw/lexicons**
- AT Protocol lexicons
- PDS record schemas

**@joelclaw/discord-ui**
- Discord components
- Interaction handlers

**@joelclaw/things-cloud**
- Things task integration
- Task sync workflows

## Deployment Model

### Local Development
- All packages run locally via `bun`
- Inngest dev server for function development
- Local k8s cluster via Colima + Talos

### Production

**Web App** (`apps/web/`)
- Next.js 16 with App Router, RSC, PPR
- Deployed to Vercel
- Post-push verification required (ADR-0144)

**System Bus Worker** (`packages/system-bus/`)
- Docker image built for ARM64
- Pushed to GitHub Container Registry
- Deployed to k8s via `k8s/publish-system-bus-worker.sh`
- Verifies rollout completion

**CLI Binary** (`packages/cli/`)
- Compiled to standalone binary
- Installed at `~/.bun/bin/joelclaw`
- Rebuild after any CLI changes

## Data Flow

### Event Flow

```
External Event
  ↓
Webhook Gateway (system-bus)
  ↓
Inngest Event Emission
  ↓
Function Execution (system-bus-worker)
  ↓
OTEL Telemetry → Typesense
  ↓
Gateway Notification (if needed)
  ↓
Channel Delivery (Telegram, etc.)
```

### Sandboxed Story Execution Flow

```
PRD Plan (Restate workflow)
  ↓
SandboxExecutionRequest (@joelclaw/agent-execution)
  ↓
system-bus function OR k8s Job
  ↓
Agent execution (codex, claude, pi)
  ↓
SandboxExecutionResult (@joelclaw/agent-execution)
  ↓
Restate workflow continues
```

The canonical contract in `@joelclaw/agent-execution` ensures that all participants in sandboxed execution (Restate, system-bus, k8s Jobs) use the same type shapes for requests, results, and lifecycle states.

### Memory Flow

```
Agent Observation
  ↓
Memory Write Gate (quality filter)
  ↓
Vector Embedding
  ↓
Typesense Storage
  ↓
Semantic Recall (`joelclaw recall`)
```

## Observability

All subsystems emit structured telemetry:

- **OTEL Events** → Typesense `otel_events` collection
- **Langfuse Traces** → LLM call tracking, cost attribution
- **Inngest Runs** → Legacy/event-native durable function execution history
- **Restate Runs** → DAG/workflow execution history and queue-drainer evidence
- **Gateway Logs** → Pi session transcripts, Redis queue depth
- **pi-mono Corpus** → Typesense `pi_mono_artifacts` collection (repo docs, issues, PRs, comments, commits, releases, materialized maintainer profile)

Access via:
```bash
joelclaw otel list --hours 24
joelclaw otel search "error" --hours 24
joelclaw otel stats --hours 24
joelclaw runs --count 50
joelclaw run <run-id>
```

## Package Import Rules (ADR-0144)

✅ **Correct:**
```typescript
import { persist } from "@joelclaw/message-store";
import type { TelemetryEmitter } from "@joelclaw/telemetry";
import { SandboxExecutionRequest } from "@joelclaw/agent-execution";
```

❌ **Wrong:**
```typescript
import { persist } from "../../message-store/src/store";
```

- Import via `@joelclaw/*`, never via relative paths across package boundaries
- DI via interfaces in library packages
- Only composition roots do concrete wiring
- New heavy logic → new package if >100 lines and reusable

## Validation

After any code change:
```bash
bunx tsc --noEmit
pnpm biome check packages/ apps/
bun test <package>
```

After `git push` affecting `apps/web/`:
```bash
# Wait 60-90s, then:
vercel ls --yes 2>&1 | head -10
# If ● Error → STOP and fix before pushing more
# If ● Ready → Continue
```

## Related Documentation

- [CLI Commands](./cli.md) — Full command reference
- [Inngest Functions](./inngest-functions.md) — Function catalog and patterns
- [Gateway](./gateway.md) — Multi-channel routing architecture
- [Deployment](./deploy.md) — Deploy procedures and verification
- [Webhooks](./webhooks.md) — External integration patterns
- [Skills](../skills/) — Canonical agent skills directory

## Architecture Decision Records

Key ADRs:
- **ADR-0144**: Hexagonal architecture and package boundaries
- **ADR-0088**: NAS-backed storage tiering
- **ADR-0127**: Feed subscriptions and resource monitoring
- **ADR-0140**: Inference router
- **ADR-0155**: Three-stage story pipeline (PRD → stories → execution)
- **ADR-0156**: Graceful worker restart

Full ADR index: `~/Vault/docs/decisions/`
