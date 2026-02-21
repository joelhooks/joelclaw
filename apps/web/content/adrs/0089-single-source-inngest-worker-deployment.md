---
type: adr
status: proposed
date: 2026-02-21
tags: [adr, inngest, k8s, system-bus, architecture]
deciders: [joel]
supersedes: []
related: ["0025-k3s-cluster-for-joelclaw-network", "0028-inngest-rig-alignment-with-sdk-skills", "0088-nas-backed-storage-tiering"]
---

# ADR-0089: Single-Source Inngest Worker Deployment (Retire Dual-Clone Sync)

## Status

proposed

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
- [ ] Worker pods in k8s pass readiness and execute cluster-safe functions successfully.
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
  - removed `joelclaw inngest sync-worker` command
  - removed worker-clone sync/restart step from `agent-loop/complete.ts`.
- Live observability verification passed with this runtime:
  - gateway events drained
  - `source=gateway` events written into `otel_events`
  - immediate fatal escalation path recorded (`events.immediate_telegram`).

### Remaining for full completion

- Populate non-empty `cluster-safe` function ownership and move cluster role to k8s worker deployment.
- Remove all residual references to `~/Code/system-bus-worker`.
- Complete k8s worker deployment + readiness rollout/rollback runbook.

## Migration Trigger to Revisit

Revisit this ADR when host-required functions drop to zero; at that point, remove the host worker and run a single k8s worker role.
