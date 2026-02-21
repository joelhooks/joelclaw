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

## Decision

Adopt a **single source of truth** for Inngest worker code in the `joelclaw` monorepo and deploy workers as **immutable k8s workloads** built from that source.

### What changes

1. `packages/system-bus` in `joelclaw` becomes the only authoritative source for worker code.
2. The worker runtime moves from launchd + separate clone to k8s Deployment(s).
3. The rsync-based dual-copy workflow is removed.
4. Host-coupled functions are split explicitly from cluster-safe functions during migration.

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

### Phase 1: Define ownership boundaries

1. Classify every function in `packages/system-bus/src/inngest/functions/` as:
   - `cluster-safe`
   - `host-required`
2. Add explicit function group exports:
   - `packages/system-bus/src/inngest/functions/index.cluster.ts`
   - `packages/system-bus/src/inngest/functions/index.host.ts`
3. Ensure no function appears in both groups.

### Phase 2: Containerize system-bus worker

4. Add a production Dockerfile for `packages/system-bus` with deterministic install/build.
5. Add k8s manifests for `system-bus-worker` Deployment + Service in `k8s/`.
6. Move required env/secrets from launchd/start script assumptions into k8s Secret/config wiring.

### Phase 3: Route registrations by worker role

7. Update `packages/system-bus/src/serve.ts` to register function lists by worker role env:
   - `WORKER_ROLE=cluster` -> register `cluster` functions only
   - `WORKER_ROLE=host` -> register `host` functions only
8. Keep connect-mode registration behavior compatible with current Inngest server deployment.

### Phase 4: Remove dual-clone coupling

9. Remove rsync-based sync command from `packages/cli/src/commands/inngest.ts`:
   - delete `sync-worker` subcommand
   - delete hardcoded source/target clone paths
10. Remove worker-clone sync logic from `packages/system-bus/src/inngest/functions/agent-loop/complete.ts`.
11. Deprecate and then remove runtime `git pull` behavior from worker startup scripts.

### Phase 5: Operability hardening

12. Add health/readiness checks for worker Deployment.
13. Add a quick diagnostics command showing:
   - registered function count by worker role
   - last registration timestamp
   - duplicate function-id detection result
14. Document rollout and rollback playbook in k8s/inngest docs.

## Verification

- [ ] New/updated function code is edited in exactly one repo path (`joelclaw` monorepo) before deployment.
- [ ] `joelclaw inngest status` (or equivalent) reports healthy worker registration without rsync sync step.
- [ ] No code path references `~/Code/system-bus-worker` after migration completion.
- [ ] Worker pods in k8s pass readiness and execute cluster-safe functions successfully.
- [ ] Host-required functions continue to execute during transition without regressions.
- [ ] Duplicate function IDs across worker roles are detected and blocked.

## Migration Trigger to Revisit

Revisit this ADR when host-required functions drop to zero; at that point, remove the host worker and run a single k8s worker role.

