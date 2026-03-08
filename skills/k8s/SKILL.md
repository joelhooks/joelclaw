---
name: k8s
displayName: K8s
description: >-
  Operate the joelclaw Kubernetes cluster — Talos Linux on Colima (Mac Mini).
  Deploy services, check health, debug pods, recover from restarts, add ports,
  manage Helm releases, inspect logs, fix networking. Triggers on: 'kubectl',
  'pods', 'deploy to k8s', 'cluster health', 'restart pod', 'helm install',
  'talosctl', 'colima', 'nodeport', 'flannel', 'port mapping', 'k8s down',
  'cluster not working', 'add a port', 'PVC', 'storage', any k8s/Talos/Colima
  infrastructure task. Also triggers on service-specific deploy: 'deploy redis',
  'redeploy inngest', 'livekit helm', 'pds not responding'.
version: 1.0.0
author: Joel Hooks
tags: [joelclaw, kubernetes, talos, colima, infrastructure]
---

# k8s Cluster Operations — joelclaw on Talos

## Architecture

```
Mac Mini (localhost ports)
  └─ Lima SSH mux (~/.colima/_lima/colima/ssh.sock) ← NEVER KILL
      └─ Colima VM (4 CPU, 8 GiB, 60 GiB, VZ framework, aarch64)
          └─ Docker 29.x
              └─ Talos v1.12.4 container (joelclaw-controlplane-1)
                  └─ k8s v1.35.0 (single node, Flannel CNI)
                      └─ joelclaw namespace (privileged PSA)
```

**⚠️ Talos has NO shell.** No bash, no /bin/sh, nothing. You cannot `docker exec` into the Talos container. Use `talosctl` for node operations and the Colima VM (`ssh lima-colima`) for host-level operations like `modprobe`.

For port mappings, recovery procedures, and cluster recreation steps, read [references/operations.md](references/operations.md).

## Quick Health Check

```bash
kubectl get pods -n joelclaw                          # all pods
curl -s localhost:3111/api/inngest                     # system-bus-worker → 200
curl -s localhost:7880/                                # LiveKit → "OK"
curl -s localhost:8108/health                          # Typesense → {"ok":true}
curl -s localhost:8288/health                          # Inngest → {"status":200}
curl -s localhost:9627/xrpc/_health                    # PDS → {"version":"..."}
kubectl exec -n joelclaw redis-0 -- redis-cli ping     # → PONG
joelclaw restate cron status                           # Dkron scheduler → healthy via temporary CLI tunnel
```

## Services

| Service | Type | Pod | Ports (Mac→NodePort) | Helm? |
|---------|------|-----|---------------------|-------|
| Redis | StatefulSet | redis-0 | 6379→6379 | No |
| Typesense | StatefulSet | typesense-0 | 8108→8108 | No |
| Inngest | StatefulSet | inngest-0 | 8288→8288, 8289→8289 | No |
| system-bus-worker | Deployment | system-bus-worker-* | 3111→3111 | No |
| LiveKit | Deployment | livekit-server-* | 7880→7880, 7881→7881 | Yes (livekit/livekit-server 1.9.0) |
| PDS | Deployment | bluesky-pds-* | 9627→**3000** | Yes (nerkho/bluesky-pds 0.4.2) |
| Dkron | StatefulSet | dkron-0 | in-cluster only (`dkron-svc:8080`) | No |
| AIStor Operator (`aistor` ns) | Deployments | adminjob-operator, object-store-operator | n/a | Yes (`minio/aistor-operator`) |
| AIStor ObjectStore (`aistor` ns) | StatefulSet | aistor-s3-pool-0-0 | 31000 (S3 TLS), 31001 (console) | Yes (`minio/aistor-objectstore`) |

**⚠️ PDS port trap**: Docker maps `9627→3000` (host→container). NodePort must be **3000** to match the container-side port. If set to 9627, traffic won't route.

**Rule**: NodePort value = Docker's container-side port, not host-side.

## Agent Runner (Cold k8s Jobs)

**Status**: local sandbox remains the default/live path; the k8s backend is now code-landed and opt-in, but still needs supervised rollout before calling it earned runtime.

The agent runner executes sandboxed story runs as isolated k8s Jobs. Jobs are created dynamically via `@joelclaw/agent-execution/job-spec` — no static manifests.

### Runtime Image Contract

See `k8s/agent-runner.yaml` for the full specification.

Required components:
- Git (checkout, diff, commit)
- Bun runtime
- runner-installed agent tooling (currently `claude` and/or other installed CLIs)
- `/workspace` working directory
- runtime entrypoint at `/app/packages/agent-execution/src/job-runner.ts`

Configuration via environment variables:
- Request metadata: `WORKFLOW_ID`, `REQUEST_ID`, `STORY_ID`, `SANDBOX_PROFILE`, `BASE_SHA`, `EXECUTION_BACKEND`, `JOB_NAME`, `JOB_NAMESPACE`
- Repo materialization: `REPO_URL`, `REPO_BRANCH`, optional `HOST_REQUESTED_CWD`
- Agent identity: `AGENT_NAME`, `AGENT_MODEL`, `AGENT_VARIANT`, `AGENT_PROGRAM`
- Execution config: `SESSION_ID`, `TIMEOUT_SECONDS`
- Task prompt: `TASK_PROMPT_B64` (base64-encoded)
- Verification: `VERIFICATION_COMMANDS_B64` (base64-encoded JSON array)
- Callback path: `RESULT_CALLBACK_URL`, `RESULT_CALLBACK_TOKEN`

Expected behavior:
1. Decode task from `TASK_PROMPT_B64`
2. Materialize repo from `REPO_URL` / `REPO_BRANCH` at `BASE_SHA`
3. Execute the requested `AGENT_PROGRAM`
4. Run verification commands (if set)
5. Print `SandboxExecutionResult` markers to stdout and POST the same result to `/internal/agent-result`
6. Exit 0 (success) or non-zero (failure)

Current truthful limit:
- `pi` remains local-backend only for now; do not pretend the pod runner can execute pi story runs yet.

### Job Lifecycle

```typescript
import { generateJobSpec, generateJobDeletion } from "@joelclaw/agent-execution";

// 1. Generate Job spec
const spec = generateJobSpec(request, {
  runtime: {
    image: "ghcr.io/joelhooks/agent-runner:latest",
    imagePullPolicy: "Always",
    command: ["bun", "run", "/app/packages/agent-execution/src/job-runner.ts"],
  },
  namespace: "joelclaw",
  imagePullSecret: "ghcr-pull",
  resultCallbackUrl: "http://host.docker.internal:3111/internal/agent-result",
  resultCallbackToken: process.env.OTEL_EMIT_TOKEN,
});

// 2. Apply to cluster (via kubectl or k8s client library)
// 3. Job runs → Pod materializes repo, executes agent, posts SandboxExecutionResult callback
// 4. Host worker can recover the same terminal result from log markers if callback delivery fails
// 5. Job auto-deletes after TTL (default: 5 minutes)

// Cancel a running Job
const deletion = generateJobDeletion("req-xyz");
// kubectl delete job ${deletion.name} -n ${deletion.namespace}
```

### Resource Defaults

- CPU: `500m` request, `2` limit
- Memory: `1Gi` request, `4Gi` limit
- Active deadline: `1 hour`
- TTL after completion: `5 minutes`
- Backoff limit: `0` (no retries)

### Security

- Non-root execution (UID 1000, GID 1000)
- No privilege escalation
- All capabilities dropped
- RuntimeDefault seccomp profile
- Control plane toleration for single-node cluster

### Verification Commands

```bash
# List agent runner Jobs
kubectl get jobs -n joelclaw -l app.kubernetes.io/name=agent-runner

# Check Job status
kubectl describe job <job-name> -n joelclaw

# View logs
kubectl logs job/<job-name> -n joelclaw

# Check for stale Jobs (should be auto-deleted by TTL)
kubectl get jobs -n joelclaw --show-all
```

### Current State

- ✅ Job spec generator (`packages/agent-execution/src/job-spec.ts`)
- ✅ Runtime contract (`k8s/agent-runner.yaml`)
- ✅ Tests (`packages/agent-execution/__tests__/job-spec.test.ts`)
- ⏳ Runtime image not yet built (Story 3)
- ⏳ Hot-image CronJob not yet implemented (Story 4)
- ⏳ Warm-pool scheduler not yet implemented (Story 5)
- ⏳ Restate integration not yet wired (Story 6)

## Deploy Commands

```bash
# Manifests (redis, typesense, inngest, dkron)
kubectl apply -f ~/Code/joelhooks/joelclaw/k8s/

# Dkron phase-1 scheduler (ClusterIP API + CLI-managed short-lived tunnel access)
kubectl apply -f ~/Code/joelhooks/joelclaw/k8s/dkron.yaml
kubectl rollout status statefulset/dkron -n joelclaw
joelclaw restate cron status
joelclaw restate cron sync-tier1        # seed/update ADR-0216 tier-1 jobs

# system-bus worker (build + push GHCR + apply + rollout wait)
~/Code/joelhooks/joelclaw/k8s/publish-system-bus-worker.sh

# LiveKit (Helm + reconcile patches)
~/Code/joelhooks/joelclaw/k8s/reconcile-livekit.sh joelclaw

# AIStor (Helm operator + objectstore)
# Defaults to isolated `aistor` namespace to avoid service-name collisions with legacy `joelclaw/minio`.
# Cutover override (explicit only): AISTOR_OBJECTSTORE_NAMESPACE=joelclaw AISTOR_ALLOW_JOELCLAW_NAMESPACE=true
~/Code/joelhooks/joelclaw/k8s/reconcile-aistor.sh

# PDS (Helm) — always patch NodePort to 3000
# (export current values first if the release already exists)
helm get values bluesky-pds -n joelclaw > /tmp/pds-values-live.yaml 2>/dev/null || true
helm upgrade --install bluesky-pds nerkho/bluesky-pds \
  -n joelclaw -f /tmp/pds-values-live.yaml
kubectl patch svc bluesky-pds -n joelclaw --type='json' \
  -p='[{"op":"replace","path":"/spec/ports/0/nodePort","value":3000}]'
```

## Auto Deploy (GitHub Actions)

- Workflow: `.github/workflows/system-bus-worker-deploy.yml`
- Trigger: push to `main` touching `packages/system-bus/**` or worker deploy files
- Behavior:
  - builds/pushes `ghcr.io/joelhooks/system-bus-worker:${GITHUB_SHA}` + `:latest`
  - runs deploy job on `self-hosted` runner
  - updates k8s deployment image + waits for rollout + probes worker health
- If deploy job is queued forever, check that a `self-hosted` runner is online on the Mac Mini.

### GHCR push 403 Forbidden

**Cause:** `GITHUB_TOKEN` (default Actions token) does not have `packages:write` scope for this repo. A dedicated PAT is required.

**Fix already applied:** Workflow uses `secrets.GHCR_PAT` (not `secrets.GITHUB_TOKEN`) for the GHCR login step. The PAT is stored in:
- GitHub repo secrets as `GHCR_PAT` (set via GitHub UI)
- agent-secrets as `ghcr_pat` (`secrets lease ghcr_pat`)

**If this breaks again:** PAT may have expired. Regenerate at github.com → Settings → Developer settings → PATs, update both stores.

**Local fallback (bypass GHA entirely):**
```bash
DOCKER_CONFIG_DIR=$(mktemp -d)
echo '{"credsStore":""}' > "$DOCKER_CONFIG_DIR/config.json"
export DOCKER_CONFIG="$DOCKER_CONFIG_DIR"
secrets lease ghcr_pat | docker login ghcr.io -u joelhooks --password-stdin
~/Code/joelhooks/joelclaw/k8s/publish-system-bus-worker.sh
```
Note: `publish-system-bus-worker.sh` uses `gh auth token` internally — if `gh auth` is stale, use the Docker login above before running the script, or patch it to use `secrets lease ghcr_pat` directly.

## Resilience Rules (ADR-0148)

1. **NEVER use `kubectl port-forward` for persistent service exposure.** All long-lived operator surfaces MUST use NodePort + Docker port mappings. The narrow exception is a CLI-managed, short-lived tunnel for an otherwise in-cluster-only control surface (for example `joelclaw restate cron *` tunneling to `dkron-svc`). Port-forwards silently die on idle/restart/pod changes, so do not leave them running.
2. **All workloads MUST have liveness + readiness + startup probes.** Missing probes = silent hangs that never recover.
3. **After any Docker/Colima/node restart**: remove control-plane taint, **uncordon node**, verify flannel, check all pods reach Running.
4. **PVC reclaimPolicy is Delete** — deleting a PVC = permanent data loss. Never delete PVCs without backup.
5. **Colima VM disk is limited (19GB).** Monitor with `colima ssh -- df -h /`. Alert at >80%.
6. **All launchd plists MUST set PATH including `/opt/homebrew/bin`.** Colima shells to `limactl`, kubectl/talosctl live in homebrew. launchd's default PATH is `/usr/bin:/bin:/usr/sbin:/sbin` — no homebrew. The canonical PATH for infra plists is: `/opt/homebrew/bin:/Users/joel/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`. Discovered Feb 2026: missing PATH caused 6 days of silent recovery failures.
7. **Shell scripts run by launchd MUST export PATH at the top.** Even if the plist sets EnvironmentVariables, belt-and-suspenders — add `export PATH="/opt/homebrew/bin:..."` to the script itself.

### Current Probe Gaps (fix when touching these services)
- Typesense: missing liveness probe (hangs won't be detected)
- Bluesky PDS: missing readiness and startup probes
- system-bus-worker: missing startup probe

## Danger Zones

1. **Never kill Lima SSH mux** — it handles ALL tunnels. Killing anything on the SSH socket kills all port access.
2. **Adding Docker port mappings** — can be hot-added without cluster recreation via `hostconfig.json` edit. See [references/operations.md](references/operations.md) for the procedure.
3. **Inngest legacy host alias in manifests** — old container-host alias may still appear in legacy configs. Worker uses connect mode, so it usually still works, but prefer explicit Talos/Colima hostnames.
4. **Colima zombie state** — `colima status` reports "Running" but docker socket / SSH tunnels are dead. All k8s ports unresponsive. `colima start` is a no-op. Only `colima restart` recovers. Detect with: `ssh -F ~/.colima/_lima/colima/ssh.config lima-colima "docker info"` — if that fails while `colima status` passes, it's a zombie. The heal script handles this automatically.
5. **Talos container has NO shell** — No bash, no /bin/sh. Cannot `docker exec` into it. Kernel modules like `br_netfilter` must be loaded at the Colima VM level: `ssh lima-colima "sudo modprobe br_netfilter"`.
6. **AIStor service-name collision** — if AIStor objectstore is deployed in `joelclaw`, it can claim `svc/minio` and break legacy MinIO assumptions. Keep AIStor objectstore in isolated namespace (`aistor`) unless intentionally cutting over.
7. **AIStor operator webhook SSA conflict** — repeated `helm upgrade` can fail on `MutatingWebhookConfiguration` `caBundle` ownership conflict. Current mitigation in this cluster: set `operators.object-store.webhook.enabled=false` in `k8s/aistor-operator-values.yaml`.
8. **MinIO pinned tag trap** — `minio/minio:RELEASE.2025-10-15T17-29-55Z` is not available on Docker Hub in this environment (ErrImagePull). Legacy fallback currently relies on `minio/minio:latest`.
9. **Dkron service-name collision** — never create a bare `svc/dkron`. Kubernetes injects `DKRON_*` env vars into pods, which collides with Dkron's own config parsing. Use `dkron-peer` and `dkron-svc`.
10. **Dkron PVC permissions** — upstream `dkron/dkron:latest` currently needs root on the local-path PVC. Non-root hardening caused `permission denied` under `/data/raft/snapshots/permTest` and CrashLoopBackOff.

## Key Files

| Path | What |
|------|------|
| `~/Code/joelhooks/joelclaw/k8s/*.yaml` | Service manifests |
| `~/Code/joelhooks/joelclaw/k8s/livekit-values.yaml` | LiveKit Helm values (source controlled) |
| `~/Code/joelhooks/joelclaw/k8s/reconcile-livekit.sh` | LiveKit Helm deploy + post-upgrade reconcile |
| `~/Code/joelhooks/joelclaw/k8s/aistor-operator-values.yaml` | AIStor operator Helm values |
| `~/Code/joelhooks/joelclaw/k8s/aistor-objectstore-values.yaml` | AIStor objectstore Helm values |
| `~/Code/joelhooks/joelclaw/k8s/reconcile-aistor.sh` | AIStor deploy + upgrade reconcile script |
| `~/Code/joelhooks/joelclaw/k8s/dkron.yaml` | Dkron scheduler StatefulSet + services |
| `~/Code/joelhooks/joelclaw/k8s/publish-system-bus-worker.sh` | Build/push/deploy system-bus worker to k8s |
| `~/Code/joelhooks/joelclaw/infra/k8s-reboot-heal.sh` | Reboot auto-heal script for Colima/Talos/taint/flannel |
| `~/Code/joelhooks/joelclaw/infra/launchd/com.joel.k8s-reboot-heal.plist` | launchd timer for reboot auto-heal |
| `~/Code/joelhooks/joelclaw/skills/k8s/references/operations.md` | Cluster operations + recovery notes |
| `~/.talos/config` | Talos client config |
| `~/.kube/config` | Kubeconfig (context: `admin@joelclaw-1`) |
| `~/.colima/default/colima.yaml` | Colima VM config |
| `~/.local/caddy/Caddyfile` | Caddy HTTPS proxy (Tailscale) |

## Troubleshooting

Read [references/operations.md](references/operations.md) for:
- Recovery after Colima restart
- Recovery after Mac reboot
- Flannel br_netfilter crash fix
- Full cluster recreation (nuclear option)
- Caddy/Tailscale HTTPS proxy details
- All port mapping details with explanation
