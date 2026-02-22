---
type: adr
status: implemented
date: 2026-02-21
tags: [adr, inngest, k8s, system-bus, architecture]
deciders: [joel]
supersedes: []
related: ["0025-k3s-cluster-for-joelclaw-network", "0028-inngest-rig-alignment-with-sdk-skills", "0088-nas-backed-storage-tiering"]
---

# ADR-0089: Single-Source Inngest Worker Deployment (Retire Dual-Clone Sync)

## Status

implemented

## Context

Inngest function code currently exists in two working copies:

- Monorepo source: `~/Code/joelhooks/joelclaw/packages/system-bus/src`
- Runtime clone: `~/Code/system-bus-worker/packages/system-bus/src`

This creates operational drag and drift risk:

- Manual/automated rsync copy flow is required (`joelclaw inngest sync-worker`)
- Agent loop completion includes special clone sync/restart logic
- Startup scripts perform `git pull` + `bun install` at runtime
- Debugging requires checking which copy is actually live

The local cluster already runs Inngest server in connect mode and is the intended long-term runtime target for durable workflows.

### Drift Evidence (validated 2026-02-21)

- Gateway launch path is monorepo-based: `~/.joelclaw/scripts/gateway-start.sh` points at `~/Code/joelhooks/joelclaw/packages/gateway/src/daemon.ts`.
- Worker launch path is clone-based: `~/Library/LaunchAgents/com.joel.system-bus-worker.plist` runs `~/Code/system-bus-worker/packages/system-bus/start.sh`.
- Worker startup is mutable at runtime: `start.sh` executes `git pull --ff-only` and `bun install` on every restart.
- Live logs showed drift symptoms: repeated worker import failures for `../../observability/emit` during restart cycles while gateway/runtime behavior remained healthy enough to drain events.
- Result: deploy state is not derivable from a single git SHA in the monorepo.

## Decision

Adopt a **single source of truth** for Inngest worker code in the `joelclaw` monorepo and deploy workers as **immutable k8s workloads** built from that source.

### What changes

1. `packages/system-bus` in `joelclaw` becomes the only authoritative source for worker code.
2. The worker runtime moves from launchd + separate clone to k8s Deployment(s).
3. The rsync-based dual-copy workflow is removed.
4. Host-coupled functions are split explicitly from cluster-safe functions during migration.
5. Runtime `git pull`/`bun install` mutation is removed from worker boot paths.

### Runtime model

- **Primary worker (k8s)**: runs cluster-safe Inngest functions.
- **Host worker (temporary, optional)**: runs only functions that require host-only capabilities (local filesystem paths under `/Users/joel`, launchd interaction, host-only binaries/secrets flow).
- Both register against the same Inngest server in connect mode.

## Consequences

### Positive

- One place to edit functions; no copy/sync tax.
- Reproducible deploys via image tags instead of mutable local state.
- Fewer hidden failure modes from stale clones.
- Cleaner path to CI/CD and rollback.

### Negative

- Requires migration work to classify/split host-coupled functions.
- Secret management must be formalized for k8s worker pods.
- Short-term complexity while running dual workers during transition.

### Risks

- Moving all functions too quickly could break host-dependent behavior.
- If function ownership boundaries are unclear, duplicate registration may occur.

## Non-Goals

- No full rewrite of existing Inngest functions.
- No immediate elimination of all host-executed workflows on day one.
- No dependency on publishing NPM packages from k8s.

## Implementation Plan

### Phase 0: Stop further drift (immediate)

1. Mark `~/Code/system-bus-worker` as transitional runtime-only and block new feature edits there.
2. Add explicit warning in `packages/system-bus/start.sh` and related ops docs that dual-clone runtime is deprecated.
3. Record current launch points in docs:
   - `~/Library/LaunchAgents/com.joel.system-bus-worker.plist`
   - `~/.joelclaw/scripts/gateway-start.sh`
   - `packages/system-bus/start.sh`

### Phase 1: Define ownership boundaries

4. Classify every function in `packages/system-bus/src/inngest/functions/` as:
   - `cluster-safe`
   - `host-required`
5. Add explicit function group exports:
   - `packages/system-bus/src/inngest/functions/index.cluster.ts`
   - `packages/system-bus/src/inngest/functions/index.host.ts`
6. Ensure no function appears in both groups.

### Phase 2: Containerize system-bus worker

7. Add a production Dockerfile for `packages/system-bus` with deterministic install/build.
8. Add k8s manifests for `system-bus-worker` Deployment + Service in `k8s/`.
9. Move required env/secrets from launchd/start script assumptions into k8s Secret/config wiring.

### Phase 3: Route registrations by worker role

10. Update `packages/system-bus/src/serve.ts` to register function lists by worker role env:
   - `WORKER_ROLE=cluster` -> register `cluster` functions only
   - `WORKER_ROLE=host` -> register `host` functions only
11. Keep connect-mode registration behavior compatible with current Inngest server deployment.

### Phase 4: Remove dual-clone coupling

12. Remove rsync-based sync command from `packages/cli/src/commands/inngest.ts`:
   - delete `sync-worker` subcommand
   - delete hardcoded source/target clone paths
13. Remove worker-clone sync logic from `packages/system-bus/src/inngest/functions/agent-loop/complete.ts`.
14. Deprecate and then remove runtime `git pull` behavior from worker startup scripts.

### Phase 5: Operability hardening

15. Add health/readiness checks for worker Deployment.
16. Add a quick diagnostics command showing:
   - registered function count by worker role
   - last registration timestamp
   - duplicate function-id detection result
17. Document rollout and rollback playbook in k8s/inngest docs.

## Verification

- [x] New/updated function code is edited in exactly one repo path (`joelclaw` monorepo) before deployment.
- [x] `joelclaw inngest status` (or equivalent) reports healthy worker registration without rsync sync step.
- [ ] No code path references `~/Code/system-bus-worker` after migration completion.
- [x] Worker pods in k8s pass readiness and execute cluster-safe functions successfully.
- [x] Host-required functions continue to execute during transition without regressions.
- [x] Duplicate function IDs across worker roles are detected and blocked.
- [x] Gateway and worker are both running code derived from the same monorepo git SHA at deploy time.
- [x] A synthetic gateway event (`joelclaw gateway test` / `system.fatal` probe) lands in `otel_events` with `source=gateway` within the expected ingestion window.

## Implementation Outcome (2026-02-21)

### Shipped now

- Worker `launchd` runtime now points at monorepo `packages/system-bus/start.sh` instead of `~/Code/system-bus-worker`.
- Runtime startup mutation was removed from worker bootstrap (`git pull` / `bun install` no longer run at startup).
- Explicit worker role split was implemented:
  - `packages/system-bus/src/inngest/functions/index.host.ts`
  - `packages/system-bus/src/inngest/functions/index.cluster.ts`
  - `WORKER_ROLE` routing in `packages/system-bus/src/serve.ts`
- Worker diagnostics surface was added and wired:
  - `joelclaw inngest workers`
  - role counts, duplicate function-id detection, last registration timestamp.
- Dual-clone coupling was removed from primary operator paths:
  - `joelclaw inngest sync-worker` now acts as a compatibility alias for restart/register only (no file copy)
  - removed worker-clone sync/restart step from `agent-loop/complete.ts`.
- Live observability verification passed with this runtime:
  - gateway events drained
  - `source=gateway` events written into `otel_events`
  - immediate fatal escalation path recorded (`events.immediate_telegram`).

### Live verification snapshot (2026-02-21 18:06 UTC)

- `joelclaw gateway test` pushed `test.gateway-e2e` event id `67c7130c-de7a-4756-b67d-d0be4f6e0bc4`; gateway drained queue (`joelclaw gateway events` returned `totalCount: 0`).
- `joelclaw otel list --source gateway --hours 1 --limit 20` confirmed active gateway ingestion with `found: 124` and recent events including:
  - `redis-channel.events.triaged`
  - `redis-channel.events.dispatched`
  - `command-queue.queue.enqueued`
- Fatal escalation probe:
  - `joelclaw gateway push --type system.fatal ...` pushed event id `ed718c28-5475-439c-9865-51de1b55480f`.
  - `joelclaw otel search "events.immediate_telegram" --source gateway --hours 1 --limit 5` returned `found: 2` including fresh event id `ad68ee74-98f5-4568-a620-88e59a87d32e`.
- Canonical worker write-path probe:
  - `POST http://localhost:3111/observability/emit` with fatal event id `f2018c37-ca71-4393-a522-c9dc34c81cca` returned `typesense.written=true` and `convex.written=true`.
  - `joelclaw otel list --source verification --hours 1 --limit 5` returned the same fatal event with action `probe.convex.mirror`.
  - Direct Convex query to `contentResources.listByType(type=\"otel_event\")` returned `resourceId: otel:f2018c37-ca71-4393-a522-c9dc34c81cca` with `level: fatal`.

### Remaining for full completion

- Remove all residual references to `~/Code/system-bus-worker`.
- Expand cluster-safe ownership beyond the initial activation set and retire host role over time.
- Complete k8s worker deployment + readiness rollout/rollback runbook.

### Cluster activation update (2026-02-21)

- GHCR image published and deployed: `ghcr.io/joelhooks/system-bus-worker:20260221-110606`.
- K8s deployment manifest now uses:
  - `imagePullSecrets: ghcr-pull`
  - `WORKER_ROLE=cluster`
  - `INNGEST_APP_ID=system-bus-cluster` (role-specific app identity)
  - `INNGEST_SERVE_HOST=""` (connect-mode default)
- Publish/deploy flow is codified in:
  - `k8s/publish-system-bus-worker.sh` (build + push GHCR + apply + rollout wait)
- Live pod verification:
  - Running pod: `system-bus-worker-5f6ffd6999-ggxkp`
  - Health endpoint from inside pod: `status=200`, `count=9`
  - Worker role counts: `host=55`, `cluster=9`, `active=9`
  - Duplicate function IDs: none
- Initial cluster-safe function set activated:
  - `approvalRequest`, `approvalResolve`
  - `todoistCommentAdded`, `todoistTaskCompleted`, `todoistTaskCreated`
  - `frontMessageReceived`, `frontMessageSent`, `frontAssigneeChanged`
  - `todoistMemoryReviewBridge`
- Cluster boot logs no longer attempt local `secrets lease`:
  - `"[secrets] skipping local webhook secret leasing in cluster worker role"`

### Enforcement update (2026-02-22)

- Added hard runtime guard in `packages/system-bus/start.sh`:
  - worker startup exits non-zero when launched from legacy clone path `~/Code/system-bus-worker`.
- Added explicit source-verification surface in CLI:
  - `joelclaw inngest source [--repair]` inspects launchd binding and can re-install the monorepo plist.
- Added automatic source enforcement on worker lifecycle commands:
  - `joelclaw inngest restart-worker` and `joelclaw inngest sync-worker` now enforce ADR-0089 launchd binding before restart/register.
- Added runtime source telemetry:
  - worker health payload now includes `runtime.cwd`, `runtime.deploymentModel`, and `runtime.legacyCloneDetected`.
- Swept legacy clone wording from non-ADR historical artifacts:
  - marked `packages/system-bus/prd.json` and `packages/system-bus/prd-harden.json` as `[historical]` and removed `sync-worker-clone` references.
- Added CI policy guard for future drift (shared validators workflow):
  - `scripts/validate-no-legacy-worker-clone.ts`
  - `.github/workflows/agent-contracts.yml`
  - fails when `Code/system-bus-worker` appears outside ADR history and runtime guard allowlist.

## Migration Trigger to Revisit

Revisit this ADR when host-required functions drop to zero; at that point, remove the host worker and run a single k8s worker role.
