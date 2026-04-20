# Deploy

Canonical deployment notes for joelclaw runtime services.

## Kubernetes manifests

```bash
kubectl apply -f ~/Code/joelhooks/joelclaw/k8s/
```

## ClickHouse phase-1 substrate (ADR-0224)

Repo-managed manifest: `k8s/clickhouse.yaml`

Phase-1 rules:
- single-node `StatefulSet`
- `local-path` PVC (`5Gi`) for hot runtime data
- **no NAS mount in the live pod**
- NAS is backup/export only in this phase
- replace the placeholder password in `clickhouse-secret` before applying for real

Deploy + verify:

```bash
kubectl apply -f ~/Code/joelhooks/joelclaw/k8s/clickhouse.yaml
kubectl rollout status statefulset/clickhouse -n joelclaw
kubectl get svc,pvc -n joelclaw | rg clickhouse
kubectl logs -n joelclaw clickhouse-0 --tail=100
kubectl exec -n joelclaw clickhouse-0 -- clickhouse-client --query "SELECT version(), currentDatabase()"
```

Fast smoke checks:

```bash
kubectl exec -n joelclaw clickhouse-0 -- clickhouse-client --query "SELECT 1"
kubectl exec -n joelclaw clickhouse-0 -- clickhouse-client --query "CREATE DATABASE IF NOT EXISTS joelclaw"
kubectl exec -n joelclaw clickhouse-0 -- clickhouse-client --query "SHOW DATABASES"
```

## Restate runtime (k8s server + worker)

Current production topology:

- server manifest: `k8s/restate.yaml`
- worker manifest: `k8s/restate-worker.yaml`
- Firecracker PVC: `k8s/firecracker-pvc.yaml`
- publish script: `k8s/publish-restate-worker.sh`
- worker image: `ghcr.io/joelhooks/restate-worker:<tag>`
- server NodePorts: `8080` (ingress), `9070` (admin), `9071` (metrics)
- worker service URL: `http://restate-worker:9080`

Deploy + verify:

```bash
kubectl apply -f ~/Code/joelhooks/joelclaw/k8s/restate.yaml
kubectl apply -f ~/Code/joelhooks/joelclaw/k8s/firecracker-pvc.yaml
kubectl rollout status statefulset/restate -n joelclaw

~/Code/joelhooks/joelclaw/k8s/publish-restate-worker.sh
kubectl rollout status deployment/restate-worker -n joelclaw
kubectl get svc restate restate-worker -n joelclaw
curl -fsS http://localhost:9070/deployments
```

### Re-register Restate deployments after worker deploy

The Restate admin API is now reachable directly on `localhost:9070` via NodePort; no port-forward is required.

```bash
curl -fsS -X POST http://localhost:9070/deployments
curl -fsS http://localhost:9070/deployments
```

### Refresh the pi auth secret

The worker mounts `/root/.pi/agent/auth.json` from `secret/pi-auth`.

```bash
kubectl create secret generic pi-auth \
  -n joelclaw \
  --from-file=auth.json=$HOME/.pi/agent/auth.json \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl rollout restart deployment/restate-worker -n joelclaw
```

### Refresh the agent identity configmap

The worker image symlinks these files into `/root/.joelclaw/` at container start:

```bash
kubectl create configmap agent-identity \
  -n joelclaw \
  --from-file=IDENTITY.md=$HOME/.joelclaw/IDENTITY.md \
  --from-file=SOUL.md=$HOME/.joelclaw/SOUL.md \
  --from-file=ROLE.md=$HOME/.joelclaw/ROLE.md \
  --from-file=USER.md=$HOME/.joelclaw/USER.md \
  --from-file=TOOLS.md=$HOME/.joelclaw/TOOLS.md \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl rollout restart deployment/restate-worker -n joelclaw
```

### Populate the Firecracker PVC

`pvc/firecracker-images` is mounted at `/tmp/firecracker-test` inside `deployment/restate-worker`.
Seed it with the kernel, rootfs, and optional snapshot artifacts:

```bash
POD=$(kubectl get pod -n joelclaw -l app=restate-worker -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n joelclaw "$POD" -- sh -lc 'mkdir -p /tmp/firecracker-test/snapshots'

kubectl cp infra/firecracker/images/vmlinux-6.1.155 \
  "joelclaw/$POD:/tmp/firecracker-test/vmlinux"
kubectl cp infra/firecracker/images/agent-rootfs.ext4 \
  "joelclaw/$POD:/tmp/firecracker-test/agent-rootfs.ext4"

# Optional: seed snapshot restore inputs if you already created them locally
kubectl cp infra/firecracker/snapshots/. \
  "joelclaw/$POD:/tmp/firecracker-test/snapshots"
```

## PDS runtime (Helm)

Current production topology:

- values file: `infra/pds/values.yaml`
- Helm release: `bluesky-pds`
- service type: `NodePort`
- in-cluster service port / nodePort: `3000`
- host-published port: `9627`
- health endpoint: `http://localhost:9627/xrpc/_health`
- operator CLI surface: `joelclaw pds {health|describe|collections|records|write|delete|session}`

Deploy + verify:

```bash
JWT_SECRET=$(secrets lease pds_jwt_secret --ttl 10m)
ADMIN_PASSWORD=$(secrets lease pds_admin_password --ttl 10m)
PLC_ROTATION_KEY=$(secrets lease pds_plc_rotation_key --ttl 10m)

kubectl create secret generic bluesky-pds-secrets \
  -n joelclaw \
  --from-literal=jwtSecret="$JWT_SECRET" \
  --from-literal=adminPassword="$ADMIN_PASSWORD" \
  --from-literal=plcRotationKey="$PLC_ROTATION_KEY" \
  --from-literal=emailSmtpUrl='' \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install bluesky-pds nerkho/bluesky-pds \
  -n joelclaw \
  -f ~/Code/joelhooks/joelclaw/infra/pds/values.yaml

kubectl patch svc bluesky-pds -n joelclaw --type='json' \
  -p='[{"op":"replace","path":"/spec/ports/0/nodePort","value":3000}]'

kubectl rollout status deployment/bluesky-pds -n joelclaw
curl -fsS http://localhost:9627/xrpc/_health
```

Post-rebuild account recreation:

```bash
ADMIN_PASSWORD=$(secrets lease pds_admin_password --ttl 10m)
JOEL_PASSWORD=$(secrets lease pds_joel_password --ttl 10m)

INVITE_CODE=$(curl -fsS -u "admin:${ADMIN_PASSWORD}" \
  -H 'content-type: application/json' \
  -d '{"useCount":1}' \
  http://localhost:9627/xrpc/com.atproto.server.createInviteCode | jq -r '.code')

curl -fsS -X POST http://localhost:9627/xrpc/com.atproto.server.createAccount \
  -H 'content-type: application/json' \
  -d "$(jq -nc \
    --arg email 'joelhooks@gmail.com' \
    --arg handle 'joel.pds.panda.tail7af24.ts.net' \
    --arg password "$JOEL_PASSWORD" \
    --arg inviteCode "$INVITE_CODE" \
    '{email:$email,handle:$handle,password:$password,inviteCode:$inviteCode}')"
```

Gotchas:

- `bluesky-pds-secrets` must exist before the Helm release will come up.
- keep the service `nodePort` at `3000`; the host exposure is `9627`, but the in-cluster NodePort still has to match the container-side port.
- after a rebuild that wipes the PDS PVC, the repo is empty again; recreate Joel's account and update the stored `pds_joel_did` secret to the new DID returned by `createAccount`.
- PDS session creation is more reliable against the handle than the raw DID. `packages/system-bus/src/lib/pds.ts` now resolves the handle from `pds_joel_did` before calling `createSession`, so dual-write survives account recreation as long as the DID secret is current.

## Canonical launchd sources

Host launchd assets that are part of joelclaw runtime behavior belong in `infra/launchd/`, not as hand-edited one-offs.

### Critical boot-safe system daemons (ADR-0240)

These repo-managed plists are the canonical source for the host control plane and are installed into `/Library/LaunchDaemons/` by the root installer:

- `infra/launchd/com.joel.colima.plist`
- `infra/launchd/com.joel.k8s-reboot-heal.plist`
- `infra/launchd/com.joel.agent-secrets.plist`
- `infra/launchd/com.joel.system-bus-worker.plist`
- `infra/launchd/com.joel.gateway.plist`
- `infra/launchd/com.joelclaw.agent-mail.plist`
- `infra/agent-mail-daemon.sh`

Canonical installer:

```bash
sudo ~/Code/joelhooks/joelclaw/infra/install-critical-launchdaemons.sh
```

Compatibility alias (same behavior, kept so old recovery notes do not brick):

```bash
sudo ~/Code/joelhooks/joelclaw/infra/install-headless-bootstrap.sh
```

What the installer does:
- copies the repo-managed plists into `/Library/LaunchDaemons/`
- removes the old `~/Library/LaunchAgents/<label>.plist` copies for the critical labels
- removes the superseded `/Library/LaunchDaemons/com.joel.headless-bootstrap.plist` bridge
- kills known manual `nohup` and stale `autossh` colima-tunnel fallbacks from reboot recovery
- removes the deprecated `com.joel.colima-tunnel` daemon instead of reinstalling it, because Colima/Lima already owns docker-published host ports for `joelclaw-controlplane-1`
- removes the deprecated `com.joel.typesense-portforward` daemon instead of reinstalling it, because Typesense is now exposed by the `typesense` NodePort service on stable host port `8108` and a separate `kubectl port-forward` daemon only adds churn
- removes stale manual kube operator tunnels on `16443` and `15000` before reinstalling the canonical daemon
- bootstraps the critical services directly into the `system` launchd domain, using `UserName=joel` where the process should run as Joel

Agent-mail note: `com.joelclaw.agent-mail` now goes through `infra/agent-mail-daemon.sh`, which resolves the joelclaw-managed `joelhooks/mcp_agent_mail` checkout instead of baking a third-party path into the plist. If the local checkout still lives under a legacy directory name, that is fine as long as the git `origin` remote is `joelhooks/mcp_agent_mail`.

This replaces the failed ADR-0239 bridge design. We no longer try to bounce LaunchAgents into `user/$UID` from a system daemon.

`com.joel.colima` is a boot/startup helper only. It should run `colima start ...` at load, then exit. It must **not** keep a `StartInterval` that re-runs `colima start` every few minutes against an already-running VM — that adds useless churn to an already fragile host path and obscures whether later Colima instability is real collapse or self-inflicted launchd hammering.

`com.joel.colima-tunnel` is no longer part of the critical boot path. The old autossh daemon was forwarding the same host ports that Colima/Lima already publishes for `joelclaw-controlplane-1` (`3838`, `6379`, `7880`, `7881`, `8288`, `8289`, `9627`) and it killed `ssh` listeners on those ports before binding them itself. That means it could kill Lima's own forwarders and create the exact kind of host-path churn we were trying to avoid. The canonical `infra/colima-tunnel.sh` file now exists only as a deprecated compatibility stub that exits cleanly; `install-critical-launchdaemons.sh` removes any installed `com.joel.colima-tunnel` daemon instead of reinstalling it.

`com.joel.typesense-portforward` is also no longer part of the critical boot path. Typesense now needs a real in-cluster service contract, not a stale port-forward myth: `k8s/typesense.yaml` exposes the service as NodePort `8108`, and Colima/Lima publishes that host port through the controlplane container. Keeping a separate `kubectl port-forward svc/typesense 8108:8108` daemon under launchd just adds failure churn (`EOF`, `connection refused`, `pod not found`) on a surface the cluster already owns.

`com.joel.kube-operator-access` **is** part of the critical boot path now. It is not a resurrection of `com.joel.colima-tunnel`: it does not compete for Lima-owned app ports. Instead it owns two dedicated operator-only loopback ports — `127.0.0.1:16443 -> 10.5.0.2:6443` for kube-apiserver and `127.0.0.1:15000 -> 10.5.0.2:50000` for the Talos API — using `ssh -F ~/.colima/_lima/colima/ssh.config -S none -o ControlPath=none -o ControlMaster=no -o ControlPersist=no`. That makes kubectl/talos access boring again after the rebuild proved the direct host-published 6443 path could still return TLS garbage while the in-VM control-plane endpoint itself was healthy. The installer also cancels any stale operator forwards that were accidentally grafted onto Lima's mux master, because launchd will otherwise thrash forever on `Address already in use`. The daemon refreshes `~/.talos/config` and `~/.kube/config` toward those stable local operator ports. See ADR-0245 for the contract.

`com.joel.k8s-reboot-heal` must follow the same rule: use `colima status --json`, not plain `colima status`, because the plain command has false-failed during warm recovery and force-cycled a healthy-enough VM. Even JSON is only advisory here — the healer should trust the Docker socket / Colima SSH path before deciding to cycle the VM. The healer also needs to restore the `192.168.1.0/24 via 192.168.64.1 dev col0` NAS route before calling reboot recovery healthy; otherwise gateway can come back while NFS-backed workloads are still cooked. Its recovery markers now persist in `~/.local/state/k8s-reboot-heal.env`, because launchd runs the script as a fresh process every interval and in-memory timestamps were not enough to suppress repeat flannel restarts from already-seen `subnet.env` events. That state file now also carries Colima escalation markers (`COLIMA_UNHEALTHY_STREAK`, `LAST_COLIMA_UNHEALTHY_EPOCH`, `LAST_COLIMA_FORCE_CYCLE_EPOCH`, `LAST_COLIMA_FAILED_RECOVERY_EPOCH`) so a single ugly tick cannot immediately panic-cycle the whole VM again and a post-restart regression can block repeated healer theatre. The second-stage escalation is faster now, but still earned: after the first unhealthy tick, the healer runs a short rapid-confirmation window before authorizing a force-cycle, and if host access is still down but no escalation is yet allowed it exits early instead of pretending downstream kube/NAS repairs are actionable. The durability rule is stricter now: a restart is not recovery, recovery only counts after a post-restart stability window keeps Docker, Colima SSH, Kubernetes API, Typesense, and Inngest healthy for repeated passes, and a regression during that window is recorded as a failed recovery that suppresses more force-cycles for a hold period. See ADR-0241 for escalation gates, ADR-0244 for the durable verification contract, and ADR-0245 for the operator access path.

`infra/colima-proof.sh` is the evidence-first companion to the healer. It captures incident-scoped Colima/Lima substrate artifacts under `~/.local/share/colima-proof/incidents/<incident_id>/` and emits structured OTEL under `source=infra`, `component=colima-proof`. The healer now calls it at the failure edge, on hold states, before/after force-cycles, after post-Colima invariant outcomes, and on post-restart verification regressions so recovery no longer destroys the evidence needed to prove root cause. The harness also has a non-destructive `recover-usernet` mode that resets Lima `user-v2` control state, writes pre/post snapshots, and emits an explicit verdict artifact for `H1-usernet` instead of pretending every restart proves something. See ADR-0242 for the proof contract.

Quick checks:

```bash
launchctl print system/com.joel.gateway | rg 'state =|pid =|last exit code'
launchctl print system/com.joel.system-bus-worker | rg 'state =|pid =|last exit code'
launchctl print system/com.joel.kube-operator-access | rg 'state =|pid =|last exit code'
launchctl print system/com.joel.agent-secrets | rg 'state =|pid =|last exit code'
launchctl print system/com.joelclaw.agent-mail | rg 'state =|pid =|last exit code'
kubectl get nodes
curl -k https://127.0.0.1:16443/readyz?verbose
joelclaw status
joelclaw gateway status
~/Code/joelhooks/joelclaw/infra/colima-proof.sh snapshot --phase manual-check --action infra.colima.snapshot --level info --success true --reason 'manual substrate probe'
~/Code/joelhooks/joelclaw/infra/colima-proof.sh recover-usernet --restart-mode none --verify-wait-secs 15 --reason 'manual usernet-only discriminator'
```

### User LaunchAgents still used for non-critical local surfaces

Examples that still belong under `~/Library/LaunchAgents/` via repo symlink:
- `infra/launchd/com.joel.content-sync-watcher.plist`
- `infra/launchd/com.joel.local-sandbox-janitor.plist`
- historical rollback/debug asset: `infra/launchd/com.joel.restate-worker.plist`

Historical fallback example for the Restate worker:

```bash
ln -sfn ~/Code/joelhooks/joelclaw/infra/launchd/com.joel.restate-worker.plist \
  ~/Library/LaunchAgents/com.joel.restate-worker.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.joel.restate-worker.plist 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.joel.restate-worker.plist
```

The primary Restate runtime is now the `restate-worker` k8s deployment. Keep `scripts/restate/start.sh` behind `com.joel.restate-worker` only as a rollback/debug wrapper; do not treat it as the normal production path.

Example for the content watcher:

```bash
ln -sfn ~/Code/joelhooks/joelclaw/infra/launchd/com.joel.content-sync-watcher.plist \
  ~/Library/LaunchAgents/com.joel.content-sync-watcher.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.joel.content-sync-watcher.plist 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.joel.content-sync-watcher.plist
```

Example for the local sandbox janitor:

```bash
ln -sfn ~/Code/joelhooks/joelclaw/infra/launchd/com.joel.local-sandbox-janitor.plist \
  ~/Library/LaunchAgents/com.joel.local-sandbox-janitor.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.joel.local-sandbox-janitor.plist 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.joel.local-sandbox-janitor.plist
launchctl print gui/$(id -u)/com.joel.local-sandbox-janitor
```

This service runs `scripts/local-sandbox-janitor.sh`, which calls `joelclaw workload sandboxes janitor` at load and every 30 minutes. It is the scheduled cleanup layer for ADR-0221 retained local sandboxes; bounded manual cleanup still goes through `joelclaw workload sandboxes cleanup ...`.

## Dkron phase-1 scheduler (ADR-0216)

Dkron now runs in-cluster as a single-node `StatefulSet` with a `ClusterIP` API service:

- manifest: `k8s/dkron.yaml`
- peer service: `dkron-peer` (headless)
- API service: `dkron-svc` (`ClusterIP`, port `8080`)
- storage: PVC `data-dkron-0`

### Why ClusterIP first

We are **not** adding a permanent host port mapping yet. The current phase uses short-lived CLI-managed tunnels for operator access so we don't add another long-lived port-forward footgun to the stack.

### Service-name gotcha

Do **not** name the API service `dkron`.

Kubernetes injects service env vars into pods. A bare `dkron` service would inject `DKRON_*` env vars, which collides with Dkron's own config/env parsing. Use `dkron-peer` / `dkron-svc` instead.

### Deploy / verify

```bash
kubectl apply -f k8s/dkron.yaml
kubectl rollout status statefulset/dkron -n joelclaw
kubectl get pods -n joelclaw -l app=dkron
joelclaw restate cron status
```

### Seed the tier-1 migration set

```bash
joelclaw restate cron sync-tier1 --run-now
joelclaw restate cron list
joelclaw otel search "dag.workflow.completed OR skill-garden.findings OR subscription.check_feeds.completed OR memory.digest.generate" --hours 24
```

This seeds the full ADR-0216 tier-1 set in Dkron:

- `restate-health-check`
- `restate-skill-garden`
- `restate-typesense-full-sync`
- `restate-daily-digest`
- `restate-subscription-check-feeds`

Each job uses Dkron's shell executor plus `wget` to call the Restate DAG ingress. The wrapper appends epoch seconds to the workflow ID prefix so each scheduled run is a fresh Restate workflow.

For the tier-1 migrations, the Restate shell nodes run host-side direct task runners at `scripts/restate/run-tier1-task.ts` so the scheduled job outcome reflects real work, not just event dispatch.

### Current trade-off

Dkron's upstream image still runs as root against the local-path PVC. A non-root hardening attempt failed with:

- `file snapshot store: permissions test failed`
- `open /data/raft/snapshots/permTest: permission denied`

So phase-1 keeps the pod running as-is for reliability. Harden later with either an init-permissions step, image override, or a custom image.

## Agent Runner (Cold k8s Jobs)

The agent runner executes sandboxed story runs as isolated k8s Jobs.

### Runtime Image Contract

See `k8s/agent-runner.yaml` for the full specification. Required:

- Git (checkout, diff, commit)
- Bun runtime
- Agent tooling (codex, pi, etc.)
- `/workspace` working directory
- Environment-driven configuration

### Job Generation

Jobs are created dynamically via `@joelclaw/agent-execution/job-spec`:

```typescript
import { generateJobSpec } from "@joelclaw/agent-execution";

const request: SandboxExecutionRequest = {
  workflowId: "wf-abc",
  requestId: "req-xyz",
  storyId: "story-1",
  task: "Implement feature X with tests",
  agent: { name: "story-executor", program: "claude", model: "claude-3-7-sonnet" },
  sandbox: "workspace-write",
  backend: "k8s",
  baseSha: "abc123",
  repoUrl: "git@github.com:joelhooks/joelclaw.git",
  branch: "main",
};

const options: JobSpecOptions = {
  runtime: {
    image: "ghcr.io/joelhooks/agent-runner:latest",
    imagePullPolicy: "Always",
    command: ["bun", "run", "/app/packages/agent-execution/src/job-runner.ts"],
  },
  namespace: "joelclaw",
  imagePullSecret: "ghcr-pull",
  resultCallbackUrl: "http://host.docker.internal:3111/internal/agent-result",
  resultCallbackToken: process.env.OTEL_EMIT_TOKEN,
};

const jobManifest = generateJobSpec(request, options);
// Apply with kubectl or k8s client library
```

### Job Lifecycle

1. **Creation**: Restate workflow or system-bus function generates Job spec
2. **Execution**: k8s schedules Pod and runs the agent runner image
3. **Completion**: runner prints `SandboxExecutionResult` markers to logs and POSTs the same result to `http://host.docker.internal:3111/internal/agent-result`
4. **Fallback truth**: host worker can recover terminal state from Job status + log markers if callback delivery fails
5. **Cleanup**: Job auto-deletes after TTL (default: 5 minutes)

### Resource Defaults

- CPU Request: `500m`
- CPU Limit: `2`
- Memory Request: `1Gi`
- Memory Limit: `4Gi`
- Active Deadline: `1 hour`
- TTL After Completion: `5 minutes`
- Backoff Limit: `0` (no retries)

### Cancellation

To cancel a running Job:

```typescript
import { generateJobDeletion } from "@joelclaw/agent-execution";

const deletion = generateJobDeletion("req-xyz");
// kubectl delete job ${deletion.name} -n ${deletion.namespace} --propagation-policy=${deletion.propagationPolicy}
```

### Security

- Non-root execution (UID 1000, GID 1000)
- No privilege escalation
- All capabilities dropped
- RuntimeDefault seccomp profile
- Control plane toleration for single-node cluster

### Verification

After Job completion, check:

```bash
# List recent agent runner Jobs
kubectl get jobs -n joelclaw -l app.kubernetes.io/name=agent-runner

# Check Job status
kubectl describe job <job-name> -n joelclaw

# View logs
kubectl logs job/<job-name> -n joelclaw

# Check for stale Jobs (should be auto-deleted by TTL)
kubectl get jobs -n joelclaw -l app.kubernetes.io/name=agent-runner --show-all
```

### Repo Materialization and Artifact Export

**Story 3 additions:**

The agent execution package now provides clean repo materialization and auditable patch export:

#### Repo Materialization

```typescript
import { materializeRepo } from "@joelclaw/agent-execution";

// Clone or checkout repo at exact SHA in sandbox-local workspace
const result = await materializeRepo(
  "/sandbox/workspace/joelclaw",
  "abc123def456",
  {
    remoteUrl: "https://github.com/joelhooks/joelclaw.git",
    branch: "main",
    depth: 1,
    timeoutSeconds: 300,
  }
);

// result.path: materialized repo path
// result.sha: verified checkout SHA
// result.freshClone: true if cloned, false if fetched
// result.durationMs: timing data
```

**Key behaviors:**
- Fresh clone if target path doesn't exist
- Fetch + checkout if target path exists
- SHA verification after checkout
- Automatic unshallow if SHA not in shallow clone
- Isolated sandbox-local workspace (host checkout untouched)

#### Artifact Export

```typescript
import { generatePatchArtifact } from "@joelclaw/agent-execution";

// Export auditable patch artifact from sandbox run
const artifacts = await generatePatchArtifact({
  repoPath: "/sandbox/workspace/joelclaw",
  baseSha: "abc123",
  headSha: "def456", // optional, defaults to HEAD
  includeUntracked: true,
  verificationCommands: ["bun test", "bunx tsc --noEmit"],
  verificationSuccess: true,
  verificationOutput: "All checks passed",
  executionLogPath: "/tmp/execution.log",
  verificationLogPath: "/tmp/verification.log",
});

// artifacts.headSha: final SHA after execution
// artifacts.touchedFiles: list of modified/untracked files
// artifacts.patch: git patch content (format-patch or diff)
// artifacts.verification: { commands, success, output }
// artifacts.logs: { executionLog, verificationLog }
```

**Artifact contract:**
- Patch generated from baseSha..headSha range
- Touched-file inventory from `git status --porcelain`
- Verification summary and log references
- Optional untracked file inclusion
- Serializable to JSON via `writeArtifactBundle()`

#### Promotion Boundary (Phase 1)

**Authoritative output is patch bundle + metadata.**

The runtime **does not** merge to main or push to remote. Promotion is a separate decision:
- Restate workflow receives `ExecutionArtifacts`
- Operator reviews patch + verification
- Operator applies patch to host repo (or discards)
- Operator commits and pushes (if approved)

This keeps sandbox runs isolated and reversible.

### Current State

As of 2026-03-08:

- ✅ Local sandbox runner is live on the host worker via `system/agent-dispatch`
- ✅ Repo materialization helpers implemented and consumed by the live sandbox path
- ✅ Patch artifact export implemented and consumed by the live sandbox path
- ✅ Touched-file inventory capture
- ✅ Verification summary and log references in artifacts
- ✅ Gate A (non-coding) and Gate B (minimal coding) proven
- ✅ Real ADR-0217 Story 2 acceptance run completed on the local sandbox path and was promoted after host-truth review
- ✅ Cold k8s Job **control plane** landed in repo: `SandboxExecutionRequest.backend`, Job lifecycle helpers, runner image Dockerfile, `job-runner.ts`, `/internal/agent-result` callback path, and log-marker fallback recovery
- ✅ `system/agent-dispatch` now understands `sandboxBackend: "local" | "k8s"` with local as the default safe path
- ⏳ Broad enablement and live proof for the k8s backend still need supervised rollout
- ⏳ `pi` remains local-backend only; k8s runner support is currently for runner-installed CLIs until host-routed pi-in-pod execution is designed
- ⏳ Hot-image CronJob and warm-pool scheduler remain follow-on work

Current earned truth: the host-worker local sandbox runner is still the default/live isolation surface. The k8s Job runner is now an opt-in code path with a real control plane, but it should be rolled out and proved under supervision before we call it fully earned runtime reality.
