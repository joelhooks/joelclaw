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
      └─ Colima VM (8 CPU, 16 GiB, 100 GiB, VZ framework, aarch64)
          └─ Docker 29.x + buildx (joelclaw-builder, docker-container driver)
              └─ Talos v1.12.4 container (joelclaw-controlplane-1)
                  └─ k8s v1.35.0 (single node, Flannel CNI)
                      └─ joelclaw namespace (privileged PSA)
```

**⚠️ Talos has NO shell.** No bash, no /bin/sh, nothing. You cannot `docker exec` into the Talos container. Use `talosctl` for node operations and the Colima VM (`ssh lima-colima`) for host-level operations like `modprobe`.

### Colima Stability Rules (2026-03-17 incident)

| Setting | Value | Reason |
|---------|-------|--------|
| CPU | 8 | Match k8s workload requests (~2.8 CPU, 72%) |
| Memory | 16 GiB | 32GB causes macOS memory pressure → VM kill |
| nestedVirtualization | **OFF by default** | Crashes VM under load (image builds, heavy scheduling). Toggle ON only for Firecracker testing |
| vmType | vz | Required for Apple Silicon |
| mountType | virtiofs | Fastest option with VZ |

**`nestedVirtualization: true` is unstable on M4 Pro under load.** It causes the Colima VM to silently crash during Docker builds/pushes. Each crash:
- Kills the Talos container mid-operation
- Corrupts Redis AOF (if caught mid-write) → crash-loop on restart
- Breaks Lima socket forwarding → `docker` CLI on macOS disconnects
- Creates stale k8s pods that re-pull images → amplifies pressure

**Recovery from Colima crash-loop:**
1. `colima stop && colima start` — basic restart
2. If Redis crash-loops: `redis-check-aof --fix` (see Redis AOF Recovery below)
3. If Restate has stuck invocations: purge PVC or kill via admin API
4. If native Docker socket dead: use SSH tunnel `ssh -L /tmp/docker.sock:/var/run/docker.sock`

**Docker image builds** should use the buildx container builder (`docker buildx build --builder joelclaw-builder`) to isolate build IO from k8s workloads.

### Redis AOF Recovery

If Redis crash-loops after a VM restart with `Bad file format reading the append only file`:
```bash
# 1. Scale down Redis (or use a temp pod if StatefulSet can't mount PVC concurrently)
kubectl -n joelclaw apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: redis-fix
  namespace: joelclaw
spec:
  tolerations:
    - key: node-role.kubernetes.io/control-plane
      operator: Exists
      effect: NoSchedule
  containers:
    - name: fix
      image: redis:7-alpine
      command: ["sh", "-c", "cd /data/appendonlydir && echo y | redis-check-aof --fix *.incr.aof && redis-check-aof *.incr.aof"]
      volumeMounts:
        - name: data
          mountPath: /data
  restartPolicy: Never
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: data-redis-0
EOF
# 2. Wait, check logs, then clean up
kubectl -n joelclaw logs redis-fix
kubectl -n joelclaw delete pod redis-fix --force
# 3. Restart Redis
kubectl -n joelclaw delete pod redis-0
```

For port mappings, recovery procedures, and cluster recreation steps, read [references/operations.md](references/operations.md).

### Kubeconfig Port Drift (2026-03-21 incident)

Docker port mappings for k8s API (6443) and Talos API (50000) are **not pinned** — they use random host ports assigned at container creation. All service ports (3111, 8288, 6379, etc.) ARE pinned 1:1.

When the Colima VM or Talos container restarts, Docker may reassign different random ports for 6443/50000. Kubeconfig goes stale, kubectl fails, and everything that depends on it (joelclaw CLI, health checks, pod inspection) breaks silently.

**Symptoms**: `kubectl` returns `tls: internal error` or `connection refused`. All pods are actually running — only the kubeconfig routing is wrong.

**Fix**:
```bash
# 1. Regenerate kubeconfig from talosctl (which has the correct port)
talosctl --talosconfig ~/.talos/config --nodes 127.0.0.1 kubeconfig --force

# 2. Switch to the new context
kubectl config use-context "$(kubectl config get-contexts -o name | grep joelclaw | head -1)"

# 3. Clean stale contexts (optional)
kubectl config delete-context admin@joelclaw  # if stale entry exists
```

**Self-heal**: `health.sh` now auto-detects and fixes this before running checks.

**Root cause**: Container was created without pinning these ports. To permanently fix, recreate the container with explicit port bindings for 6443:6443 and 50000:50000. This requires cluster recreation — a bigger operation.

## Quick Health Check

```bash
kubectl get pods -n joelclaw                          # all pods
curl -s localhost:3111/api/inngest                     # system-bus-worker → 200
curl -s localhost:7880/                                # LiveKit → "OK"
curl -s localhost:8108/health                          # Typesense → {"ok":true}
curl -s localhost:8288/health                          # Inngest → {"status":200}
curl -s localhost:9070/deployments                     # Restate admin → deployments list
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
| Restate | StatefulSet | restate-0 | 8080→8080, 9070→9070, 9071→9071 | No |
| system-bus-worker | Deployment | system-bus-worker-* | 3111→3111 | No |
| restate-worker | Deployment | restate-worker-* | in-cluster only (`restate-worker:9080`) | No |
| docs-api | Deployment | docs-api-* | 3838→3838 | No |
| LiveKit | Deployment | livekit-server-* | 7880→7880, 7881→7881 | Yes (livekit/livekit-server 1.9.0) |
| PDS | Deployment | bluesky-pds-* | 9627→**3000** | Yes (nerkho/bluesky-pds 0.4.2) |
| MinIO | StatefulSet | minio-0 | 30900→30900, 30901→30901 | No |
| Dkron | StatefulSet | dkron-0 | in-cluster only (`dkron-svc:8080`) | No |
| AIStor Operator (`aistor` ns) | Deployments | adminjob-operator, object-store-operator | n/a | Yes (`minio/aistor-operator`) |
| AIStor ObjectStore (`aistor` ns) | StatefulSet | aistor-s3-pool-0-0 | 31000 (S3 TLS), 31001 (console) | Yes (`minio/aistor-objectstore`) |

### Restate / Firecracker runtime notes

- `deployment/restate-worker` is intentionally **privileged** and mounts `/dev/kvm` (hostPath type `""` — optional).
- PVC `firecracker-images` at `/tmp/firecracker-test` stores kernel, rootfs, and snapshot artifacts.
- When `nestedVirtualization` is OFF: `/dev/kvm` absent, `microvm` DAG handler fails, but `shell`/`infer`/`noop` handlers work normally.
- When `nestedVirtualization` is ON: Firecracker one-shot exec works (create workspace ext4 → write command → boot VM → guest executes → poweroff → read results).
- **Restate retry caps**: dagWorker maxAttempts=5, dagOrchestrator maxAttempts=3. Prevents journal poisoning.
- **Restate journal purge** (if stuck invocations block work): scale down Restate, mount PVC with temp pod, `rm -rf /restate-data/*`, scale back up, re-register worker.
- Re-register worker: `curl -X POST http://localhost:9070/deployments -H 'content-type: application/json' -d '{"uri":"http://restate-worker:9080"}'`

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

## NAS NFS Access from k8s (ADR-0088 Phase 2.5)

k8s pods can mount NAS storage over NFS via a LAN route through the Colima bridge.

### How it works

```
k8s pod → Talos container (10.5.0.x) → Docker NAT → Colima VM
  → ip route 192.168.1.0/24 via 192.168.64.1 dev col0
  → macOS host (IP forwarding enabled) → LAN → NAS (192.168.1.163)
```

**Root cause of prior failures:** VZ framework's shared networking on eth0 doesn't properly forward LAN-bound traffic. The fix routes LAN traffic through col0 (Colima bridge → macOS host) instead.

### Route persistence

The LAN route is set in **two places** for reliability:
1. **Colima provision script** (`~/.colima/default/colima.yaml`) — runs on `colima start` (cold boot)
2. **colima-tunnel script** (`~/Code/joelhooks/joelclaw/infra/colima-tunnel.sh`) — canonical tunnel script for warm resume; `~/.local/bin/colima-tunnel` is compatibility glue only

Both execute: `ip route replace 192.168.1.0/24 via 192.168.64.1 dev col0`

### Tunnel false-fail after reboot (2026-04-14)

`com.joel.colima-tunnel` can look alive while being useless: if Colima reassigns its SSH port on reboot, a stale autossh process can keep localhost listeners on `6379` / `8288` and still forward to nowhere.

Rules:
- wait for Colima with `colima status --json`, not plain `colima status`
- derive the SSH port from `colima ssh-config` every start
- kill stale `ssh` / `autossh` listeners on the tunnel-owned ports before starting a fresh tunnel
- leave `8108` to `com.joel.typesense-portforward`; the tunnel should not own Typesense anymore
- leave `6443` to Caddy; the tunnel should not forward or compete for that port at all

### Available PVs

| PV | NFS Path | Capacity | Access | Use |
|----|----------|----------|--------|-----|
| `nas-nvme` | `192.168.1.163:/volume2/data` | 1.5TB | RWX | NVMe RAID1: backups, snapshots, models, sessions |
| `nas-hdd` | `192.168.1.163:/volume1/joelclaw` | 50TB | RWX | HDD RAID5: books, docs-artifacts, archives, otel |
| `minio-nfs-pv` | `192.168.1.163:/volume1/joelclaw` | 1TB | RWO | HDD tier: MinIO object storage (same export) |

### Mounting NAS in a pod

```yaml
volumes:
  - name: nas
    persistentVolumeClaim:
      claimName: nas-nvme
containers:
  - volumeMounts:
      - name: nas
        mountPath: /nas
        # Optional: subPath for specific dir
        subPath: typesense
```

### Rules

- **Always use IP (192.168.1.163), never hostname (three-body).** DNS doesn't resolve from inside k8s.
- **Always use `nfsvers=3,tcp,resvport,noatime`** mount options. NFSv4 has issues with Asustor ADM.
- **NAS unavailability degrades gracefully** with `soft` mount option — returns errors, doesn't hang pods.
- **NFS write performance: ~660 MiB/s** over 10GbE with jumbo frames. Good for sequential I/O (backups, snapshots). Latency-sensitive workloads (Redis, active Typesense indexes) stay on local SSD.
- **If NFS mount fails after Colima restart:** verify the route exists: `colima ssh -- ip route | grep 192.168.1.0`

### Verify connectivity

```bash
# From Colima VM
colima ssh -- timeout 2 bash -c "echo > /dev/tcp/192.168.1.163/2049" && echo "NFS OK"

# From k8s pod
kubectl run nfs-test --image=busybox --restart=Never -n joelclaw \
  --overrides='{"spec":{"tolerations":[{"key":"node-role.kubernetes.io/control-plane","operator":"Exists","effect":"NoSchedule"}],"containers":[{"name":"t","image":"busybox","command":["sh","-c","ls /nas && echo OK"],"volumeMounts":[{"name":"n","mountPath":"/nas"}]}],"volumes":[{"name":"n","persistentVolumeClaim":{"claimName":"nas-nvme"}}]}}'
kubectl logs nfs-test -n joelclaw && kubectl delete pod nfs-test -n joelclaw --force
```

## Deploy Commands

```bash
# Manifests (redis, typesense, inngest, dkron)
kubectl apply -f ~/Code/joelhooks/joelclaw/k8s/

# Restate runtime
kubectl apply -f ~/Code/joelhooks/joelclaw/k8s/restate.yaml
kubectl apply -f ~/Code/joelhooks/joelclaw/k8s/firecracker-pvc.yaml
kubectl rollout status statefulset/restate -n joelclaw
~/Code/joelhooks/joelclaw/k8s/publish-restate-worker.sh
curl -fsS http://localhost:9070/deployments

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
5. **`firecracker-images` is stateful runtime data.** Treat it like a real runtime PVC: kernel, rootfs, and snapshot loss will break the microVM path.
6. **Colima VM disk is limited (19GB).** Monitor with `colima ssh -- df -h /`. Alert at >80%.
7. **All launchd plists MUST set PATH including `/opt/homebrew/bin`.** Colima shells to `limactl`, kubectl/talosctl live in homebrew. launchd's default PATH is `/usr/bin:/bin:/usr/sbin:/sbin` — no homebrew. The canonical PATH for infra plists is: `/opt/homebrew/bin:/Users/joel/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`. Discovered Feb 2026: missing PATH caused 6 days of silent recovery failures.
8. **Shell scripts run by launchd MUST export PATH at the top.** Even if the plist sets EnvironmentVariables, belt-and-suspenders — add `export PATH="/opt/homebrew/bin:..."` to the script itself.

### Current Probe Gaps (fix when touching these services)
- Typesense: missing liveness probe (hangs won't be detected)
- Bluesky PDS: missing readiness and startup probes
- system-bus-worker: missing startup probe

## Danger Zones

1. **Stale SSH mux socket after Colima restart** — When Colima restarts (disk resize, crash recovery, `colima stop && start`), the SSH port changes but the mux socket (`~/.colima/_lima/colima/ssh.sock`) caches the old connection. Symptoms: `kubectl port-forward` fails with "tls: internal error", `kubectl get nodes` may intermittently work then fail. **Fix**: `rm -f ~/.colima/_lima/colima/ssh.sock && pkill -f "ssh.*colima"`, then re-establish tunnels with `ssh -o ControlPath=none`. Always verify SSH port with `colima ssh-config | grep Port` after restart.
2. **Adding Docker port mappings** — can be hot-added without cluster recreation via `hostconfig.json` edit. See [references/operations.md](references/operations.md) for the procedure.
3. **Inngest legacy host alias in manifests** — old container-host alias may still appear in legacy configs. Worker uses connect mode, so it usually still works, but prefer explicit Talos/Colima hostnames.
4. **Colima zombie state** — `colima status` reports "Running" but docker socket / SSH tunnels are dead. All k8s ports unresponsive. `colima start` is a no-op. Only `colima restart` recovers. Detect with: `ssh -F ~/.colima/_lima/colima/ssh.config lima-colima "docker info"` — if that fails while `colima status` passes, it's a zombie. The heal script handles this automatically.
5. **Talos container has NO shell** — No bash, no /bin/sh. Cannot `docker exec` into it. Kernel modules like `br_netfilter` must be loaded at the Colima VM level: `ssh lima-colima "sudo modprobe br_netfilter"`.
6. **AIStor service-name collision** — if AIStor objectstore is deployed in `joelclaw`, it can claim `svc/minio` and break legacy MinIO assumptions. Keep AIStor objectstore in isolated namespace (`aistor`) unless intentionally cutting over.
7. **AIStor operator webhook SSA conflict** — repeated `helm upgrade` can fail on `MutatingWebhookConfiguration` `caBundle` ownership conflict. Current mitigation in this cluster: set `operators.object-store.webhook.enabled=false` in `k8s/aistor-operator-values.yaml`.
8. **MinIO pinned tag trap** — `minio/minio:RELEASE.2025-10-15T17-29-55Z` is not available on Docker Hub in this environment (ErrImagePull). Legacy fallback currently relies on `minio/minio:latest`.
9. **`restate-worker` privilege is intentional.** Do not “harden” away `/dev/kvm`, `privileged: true`, or the unconfined seccomp profile unless you are simultaneously changing the Firecracker runtime contract.
10. **Dkron service-name collision** — never create a bare `svc/dkron`. Kubernetes injects `DKRON_*` env vars into pods, which collides with Dkron's own config parsing. Use `dkron-peer` and `dkron-svc`.
11. **Dkron PVC permissions** — upstream `dkron/dkron:latest` currently needs root on the local-path PVC. Non-root hardening caused `permission denied` under `/data/raft/snapshots/permTest` and CrashLoopBackOff.

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
| `~/Code/joelhooks/joelclaw/infra/launchd/com.joel.colima-tunnel.plist` | Boot-safe launchd wrapper for the Colima tunnel |
| `~/Code/joelhooks/joelclaw/infra/launchd/com.joel.k8s-reboot-heal.plist` | launchd timer for reboot auto-heal |
| `~/Code/joelhooks/joelclaw/skills/k8s/references/operations.md` | Cluster operations + recovery notes |
| `~/.talos/config` | Talos client config |
| `~/.kube/config` | Kubeconfig (context: `admin@joelclaw-1`) |
| `~/.colima/default/colima.yaml` | Colima VM config |
| `~/Code/joelhooks/joelclaw/infra/colima-tunnel.sh` | Canonical persistent SSH tunnel + NAS route script |
| `~/.local/bin/colima-tunnel` | Compatibility wrapper for the canonical tunnel script |
| `~/.local/caddy/Caddyfile` | Caddy HTTPS proxy (Tailscale) |
| `~/Code/joelhooks/joelclaw/k8s/nas-nvme-pv.yaml` | NAS NVMe NFS PV/PVC (1.5TB) |
| `~/Code/joelhooks/joelclaw/k8s/nas-hdd-pv.yaml` | NAS HDD NFS PV/PVC (50TB) |

## Troubleshooting

Read [references/operations.md](references/operations.md) for:
- Recovery after Colima restart
- Recovery after Mac reboot
- Flannel br_netfilter crash fix
- Full cluster recreation (nuclear option)
- Caddy/Tailscale HTTPS proxy details
- All port mapping details with explanation
